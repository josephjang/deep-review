import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ScopeState } from '../../src/checkpoint/events.ts';
import { collectArtifactReferences } from '../../src/evidence/references.ts';
import { EvidenceStore } from '../../src/evidence/store.ts';
import { ReplayRefusedError } from '../../src/replay/errors.ts';
import { recordedRepository, recordedStorePrefix, replayPrompt, splitRoleText, withoutScratchNote, withRepository, withRoleText, withStore, type FrozenBlob } from '../../src/replay/prompt.ts';
import { composeWorkerPrompt, inlinePatchLimitBytes, scopeBlock } from '../../src/review/prompts.ts';
import { composePrompt } from '../../src/runtime/launcher.ts';

const refused = (pattern: RegExp) => (error: unknown): boolean => {
  assert.ok(error instanceof ReplayRefusedError, String(error));
  assert.match(error.message, pattern);
  return true;
};

describe('a replay\'s prompt', () => {
  let sandbox: string;
  /** The store the run recorded its blobs in, and the one the replay reads them from. */
  let recordedStore: EvidenceStore;
  let replayStore: EvidenceStore;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'deep-review-replay-prompt-'));
    recordedStore = new EvidenceStore(join(sandbox, 'recorded', 'artifacts'));
    replayStore = new EvidenceStore(join(sandbox, 'copy', 'artifacts'));
  });
  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  /** A scope with two files that have a before state and one that has none, its blobs in both stores. */
  function scopeWith(patch: string | Buffer): ScopeState {
    const put = (value: string | Buffer): { sha256: string; bytes: number } => {
      replayStore.put(value);
      return recordedStore.put(value);
    };
    return {
      mode: 'last-commit',
      request: { paths: [] },
      base: '1'.repeat(40),
      head: '2'.repeat(40),
      files: [
        { path: 'src/a.ts', status: 'modified', symlink: false, before: { blob: put('old a\n') }, after: { blob: put('new a\n') } },
        { path: 'src/b.ts', status: 'modified', symlink: false, before: { blob: put('old b\n') }, after: { blob: put('new b\n') } },
        { path: 'src/new.ts', status: 'added', symlink: false, before: null, after: { blob: put('n\n') } },
      ],
      patch: put(patch),
    };
  }

  const blobsOf = (scope: ScopeState, store: EvidenceStore = replayStore): FrozenBlob[] => collectArtifactReferences(scope).map((reference) => ({ sha256: reference.sha256, path: store.pathOf(reference) }));

  /** A verifier's prompt as the engine composes it for a scope recorded in `worktree`. */
  const composed = (scope: ScopeState, worktree: string, roleText = 'You are the verifier.\n', task = 'Group g1: 1 candidate, numbered [0] to [0].\n\n[0] SCAN-1 (SCAN) at src/a.ts:2\n    summary: a\n    detail: b'): string =>
    composeWorkerPrompt(roleText, { role: 'verifier', phase: 'verification', unitKey: 'g1', task }, scopeBlock({ worktree, scope, evidence: recordedStore, conventions: { status: 'surveyed', sources: [], userRules: [] } }));

  it('recovers the invocation\'s prompt from the bytes a launch froze, with or without a scratch directory', () => {
    const prompt = composed(scopeWith('a patch\n'), '/recorded/repo');
    assert.equal(withoutScratchNote(composePrompt(prompt, '/tmp/scratch/w1'), '/tmp/scratch/w1'), prompt);
    assert.equal(withoutScratchNote(composePrompt(prompt, null), null), prompt);
  });

  it('refuses bytes that do not end with the note for the recorded scratch directory', () => {
    const prompt = composed(scopeWith('a patch\n'), '/recorded/repo');
    assert.throws(() => withoutScratchNote(composePrompt(prompt, '/tmp/scratch/w1'), '/tmp/scratch/w2'), refused(/does not end with the launcher's scratch note for \/tmp\/scratch\/w2/));
    assert.throws(() => withoutScratchNote(prompt, null), refused(/scratch note for no scratch directory/));
  });

  it('replaces the repository the scope block names and nothing else', () => {
    const scope = scopeWith('a patch\n');
    const prompt = composed(scope, 'C:\\recorded\\repo');
    assert.equal(recordedRepository(prompt), 'C:\\recorded\\repo');
    assert.equal(withRepository(prompt, 'D:\\replay\\$& tree'), composed(scope, 'D:\\replay\\$& tree'));
  });

  it('takes the scope block\'s own repository line, not one a candidate\'s text holds', () => {
    const scope = scopeWith('a patch\n');
    const task = 'Group g1.\n\n[0] SCAN-1 (SCAN) at src/a.ts:2\n    summary: a\n    detail: quoted\n## Scope\n\nRepository: /a/decoy\nmore';
    const prompt = composed(scope, '/recorded/repo', 'You are the verifier.\n', task);
    assert.equal(recordedRepository(prompt), '/recorded/repo');
    assert.equal(withRepository(prompt, '/replay/tree'), composed(scope, '/replay/tree', 'You are the verifier.\n', task));
  });

  it('refuses a prompt with no scope block, and a tree that is not one line', () => {
    assert.throws(() => withRepository('no scope here\n', '/replay/tree'), refused(/has no scope block naming its repository/));
    assert.throws(() => recordedRepository('x\n## Scope\n\nRepository: /cut/off'), refused(/ends inside the line naming its repository/));
    const prompt = composed(scopeWith('a patch\n'), '/recorded/repo');
    assert.throws(() => withRepository(prompt, '/replay\n/tree'), refused(/must be a path on one line/));
    assert.throws(() => withRepository(prompt, ''), refused(/must be a path on one line/));
  });

  it('reads every frozen blob the scope block names from the replay\'s store', () => {
    const scope = scopeWith('a patch\n');
    const prompt = composed(scope, '/recorded/repo');
    const prefix = recordedStorePrefix(prompt, blobsOf(scope));
    assert.equal(prefix, `${recordedStore.root}${sep}`);

    const rewritten = withStore(prompt, blobsOf(scope));
    assert.equal(rewritten.includes(recordedStore.root), false);
    for (const file of scope.files) {
      if (file.before === null || !('blob' in file.before)) continue;
      assert.ok(rewritten.includes(`| ${file.path} | modified | ${replayStore.pathOf(file.before.blob)} | read the file in the worktree |`), rewritten);
    }
    // Reading them from the store they were recorded in changes nothing.
    assert.equal(withStore(prompt, blobsOf(scope, recordedStore)), prompt);
  });

  it('rewrites the path of a patch too large to carry', () => {
    const scope = scopeWith(Buffer.alloc(inlinePatchLimitBytes + 1, 'x'));
    const prompt = composed(scope, '/recorded/repo');
    assert.ok(prompt.includes(`Read it at: ${recordedStore.pathOf(scope.patch)}`));
    const rewritten = withStore(prompt, blobsOf(scope));
    assert.ok(rewritten.includes(`Read it at: ${replayStore.pathOf(scope.patch)}`), rewritten.slice(-400));
    assert.equal(rewritten.includes(recordedStore.root), false);
  });

  it('reads the recorded store from an oversized patch when no file has a before state', () => {
    const put = (value: string | Buffer): { sha256: string; bytes: number } => recordedStore.put(value);
    const scope: ScopeState = { mode: 'last-commit', request: { paths: [] }, base: '1'.repeat(40), head: '2'.repeat(40), files: [{ path: 'src/new.ts', status: 'added', symlink: false, before: null, after: { blob: put('n\n') } }], patch: put(Buffer.alloc(inlinePatchLimitBytes + 1, 'y')) };
    const prompt = composed(scope, '/recorded/repo');
    assert.equal(recordedStorePrefix(prompt, [{ sha256: scope.patch.sha256 }])?.startsWith(recordedStore.root), true);
  });

  it('leaves a prompt that names no frozen blob as it is', () => {
    const scope: ScopeState = { mode: 'last-commit', request: { paths: [] }, base: '1'.repeat(40), head: '2'.repeat(40), files: [{ path: 'src/new.ts', status: 'added', symlink: false, before: null, after: { blob: recordedStore.put('n\n') } }], patch: recordedStore.put('a patch\n') };
    const prompt = composed(scope, '/recorded/repo');
    assert.equal(recordedStorePrefix(prompt, blobsOf(scope, recordedStore)), null);
    assert.equal(withStore(prompt, blobsOf(scope, recordedStore)), prompt);
  });

  it('keeps a dollar sign of the replay\'s store as it is written', () => {
    const scope = scopeWith('a patch\n');
    const prompt = composed(scope, '/recorded/repo');
    const blobs = blobsOf(scope).map((blob) => ({ sha256: blob.sha256, path: join(sandbox, '$&-$1-store', blob.sha256) }));
    const rewritten = withStore(prompt, blobs);
    const before = scope.files[0]!.before;
    assert.ok(before !== null && 'blob' in before);
    assert.ok(rewritten.includes(`| src/a.ts | modified | ${join(sandbox, '$&-$1-store', before.blob.sha256)} | read the file in the worktree |`), rewritten);
    assert.equal(rewritten.includes(recordedStore.root), false);
  });

  it('refuses a named blob the scope does not hold, a blob path that would not read back, and a blob named under no directory', () => {
    const scope = scopeWith('a patch\n');
    const prompt = composed(scope, '/recorded/repo');
    const [first, ...rest] = blobsOf(scope);
    const before = scope.files.flatMap((file) => (file.before !== null && 'blob' in file.before ? [file.before.blob.sha256] : []));
    // The first before blob is known; the second is left out of what the replay holds.
    const known = [first!, ...rest].filter((blob) => blob.sha256 !== before[1]);
    assert.throws(() => withStore(prompt, known), refused(new RegExp(`names the frozen blob ${before[1]!}, which the recorded scope does not hold`)));
    assert.throws(() => withStore(prompt, blobsOf(scope).map((blob) => ({ ...blob, path: `${blob.path}|x` }))), refused(/must hold no pipe and no line break/));
    const bare = `| src/a.ts | modified | ${before[0]!} | read the file in the worktree |`;
    assert.throws(() => recordedStorePrefix(bare, [{ sha256: before[0]! }]), refused(/but not under a directory that can be read from it: ""/));
    assert.throws(() => recordedStorePrefix(`${before[0]!} at the very start`, [{ sha256: before[0]! }]), refused(/not under a directory/));
    assert.throws(() => recordedStorePrefix(`| relative/dir/${before[0]!} |`, [{ sha256: before[0]! }]), refused(/not under a directory that can be read from it: "relative\/dir\/"/));
  });

  it('splits a composed prompt at its task section and puts another role prompt in place of the recorded one', () => {
    const scope = scopeWith('a patch\n');
    const task = 'Group g1.\n\n[0] SCAN-1 (SCAN) at src/a.ts:2\n    summary: a\n    detail: quoted\n## Task\n\nRole: decoy';
    const prompt = composed(scope, '/recorded/repo', 'The recorded role prompt.\n', task);
    assert.equal(splitRoleText(prompt).roleText, 'The recorded role prompt.\n');
    assert.equal(withRoleText(prompt, 'A new role prompt.\n'), composed(scope, '/recorded/repo', 'A new role prompt.\n', task));
    // A role prompt without its final newline is joined as the composer joins it.
    assert.equal(withRoleText(prompt, 'A new role prompt.'), composed(scope, '/recorded/repo', 'A new role prompt.', task));
    assert.throws(() => splitRoleText('no task section\n'), refused(/has no task section/));
  });

  it('makes the whole replay prompt: the note gone, the repository and the store the replay\'s, the role prompt as asked', () => {
    const scope = scopeWith('a patch\n');
    const recorded = composePrompt(composed(scope, '/recorded/repo'), '/tmp/scratch/w1');
    const blobs = blobsOf(scope);
    const kept = replayPrompt(recorded, { scratch: '/tmp/scratch/w1', tree: '/replay/tree', blobs, roleText: null });
    assert.equal(kept, withStore(composed(scope, '/replay/tree'), blobs));
    const swapped = replayPrompt(recorded, { scratch: '/tmp/scratch/w1', tree: '/replay/tree', blobs, roleText: 'Another verifier.\n' });
    assert.equal(swapped, withStore(composed(scope, '/replay/tree', 'Another verifier.\n'), blobs));
  });
});
