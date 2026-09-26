import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Checkpoint } from '../../src/checkpoint/checkpoint.ts';
import { RunClosedError } from '../../src/checkpoint/errors.ts';
import type { ScopeFile, ScopeRequest, ScopeState } from '../../src/checkpoint/events.ts';
import { locateCheckpoint } from '../../src/checkpoint/locate.ts';
import { sha256Hex } from '../../src/evidence/store.ts';
import { captureScope, freezeLimitBytes, maxScopeFiles, validateScopePath } from '../../src/scope/capture.ts';
import { CaptureRacedError, InvalidScopeRequestError, ScopeAlreadyCapturedError } from '../../src/scope/errors.ts';
import * as gitApi from '../../src/scope/git.ts';
import { commitAll, createRepository, git, link, remove, repositoryWith, write } from '../helpers/repository.ts';

const noRequest: ScopeRequest = { paths: [] };

describe('captureScope', () => {
  let sandbox: string;
  const opened: Checkpoint[] = [];
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'deep-review-capture-'));
  });
  afterEach(() => {
    for (const checkpoint of opened.splice(0)) checkpoint.close();
    rmSync(sandbox, { recursive: true, force: true });
  });

  /** A checkpoint for the repository and a run started from its worktree. */
  const start = (repo: string): { checkpoint: Checkpoint; runId: string } => {
    const checkpoint = Checkpoint.open(locateCheckpoint(repo).root, { engine: '0.0.0-test' });
    opened.push(checkpoint);
    return { checkpoint, runId: checkpoint.createRun({ worktree: repo }).id };
  };
  const capture = (repo: string, request: ScopeRequest = noRequest): { checkpoint: Checkpoint; scope: ScopeState; runId: string } => {
    const { checkpoint, runId } = start(repo);
    const state = captureScope(checkpoint, runId, request);
    assert.ok(state.scope !== null);
    return { checkpoint, scope: state.scope, runId };
  };
  const bytesOf = (checkpoint: Checkpoint, frozen: ScopeFile['before']): string | null => {
    if (frozen === null) return null;
    if (!('blob' in frozen)) return `oversized:${frozen.oversized.sha256}:${String(frozen.oversized.size)}`;
    return checkpoint.evidence.read(frozen.blob).toString('utf8');
  };
  const summary = (checkpoint: Checkpoint, scope: ScopeState): [string, string, boolean, string | null, string | null][] =>
    scope.files.map((file) => [file.path, file.status, file.symlink, bytesOf(checkpoint, file.before), bytesOf(checkpoint, file.after)]);

  describe('modes', () => {
    it('captures the last commit of a clean tree against its parent', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'keep.txt': 'same\n', 'change.txt': 'old\n', 'gone.txt': 'bye\n' });
      const base = git(repo, 'rev-parse', 'HEAD');
      write(repo, 'change.txt', 'new\n');
      write(repo, 'added.txt', 'hello\n');
      remove(repo, 'gone.txt');
      const head = commitAll(repo, 'second');
      const { checkpoint, scope } = capture(repo);
      assert.equal(scope.mode, 'last-commit');
      assert.equal(scope.base, base);
      assert.equal(scope.head, head);
      assert.deepEqual(summary(checkpoint, scope), [
        ['added.txt', 'added', false, null, 'hello\n'],
        ['change.txt', 'modified', false, 'old\n', 'new\n'],
        ['gone.txt', 'deleted', false, 'bye\n', null],
      ]);
      const patch = checkpoint.evidence.read(scope.patch).toString('utf8');
      assert.match(patch, /^diff --git a\/added\.txt b\/added\.txt/m);
      assert.match(patch, /-old\n\+new/);
      assert.match(patch, /deleted file mode/);
    });

    it('captures a root commit against the empty tree', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'only.txt': 'first\n' });
      const { checkpoint, scope } = capture(repo);
      assert.equal(scope.mode, 'last-commit');
      assert.equal(scope.base, gitApi.emptyTree(repo));
      assert.deepEqual(summary(checkpoint, scope), [['only.txt', 'added', false, null, 'first\n']]);
    });

    it('captures a dirty worktree: staged, unstaged and untracked together, against HEAD', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'staged.txt': 'a\n', 'unstaged.txt': 'b\n', 'both.txt': 'c\n', 'untouched.txt': 'u\n' });
      const head = git(repo, 'rev-parse', 'HEAD');
      write(repo, 'staged.txt', 'a2\n');
      git(repo, 'add', 'staged.txt');
      write(repo, 'unstaged.txt', 'b2\n');
      write(repo, 'both.txt', 'c-staged\n');
      git(repo, 'add', 'both.txt');
      write(repo, 'both.txt', 'c-worktree\n');
      write(repo, 'new/untracked.txt', 'n\n');
      const { checkpoint, scope } = capture(repo);
      assert.equal(scope.mode, 'worktree');
      assert.equal(scope.base, head);
      assert.equal(scope.head, head);
      assert.deepEqual(summary(checkpoint, scope), [
        ['both.txt', 'modified', false, 'c\n', 'c-worktree\n'],
        ['new/untracked.txt', 'added', false, null, 'n\n'],
        ['staged.txt', 'modified', false, 'a\n', 'a2\n'],
        ['unstaged.txt', 'modified', false, 'b\n', 'b2\n'],
      ]);
      const patch = checkpoint.evidence.read(scope.patch).toString('utf8');
      assert.match(patch, /\+c-worktree/);
      assert.match(patch, /new\/untracked\.txt[\s\S]*\+n\n/);
    });

    it('captures everything since a ref, including uncommitted work', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': '1\n' });
      const start = git(repo, 'rev-parse', 'HEAD');
      write(repo, 'a.txt', '2\n');
      commitAll(repo, 'second');
      write(repo, 'a.txt', '3\n');
      write(repo, 'b.txt', 'untracked\n');
      const { checkpoint, scope } = capture(repo, { ref: 'HEAD~1', paths: [] });
      assert.equal(scope.mode, 'ref');
      assert.equal(scope.base, start);
      assert.deepEqual(scope.request, { ref: 'HEAD~1', paths: [] });
      assert.deepEqual(summary(checkpoint, scope), [
        ['a.txt', 'modified', false, '1\n', '3\n'],
        ['b.txt', 'added', false, null, 'untracked\n'],
      ]);
    });

    it('captures a range ending at HEAD, with or without the merge base', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'shared.txt': 'base\n' });
      const fork = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'checkout', '-q', '-b', 'feature');
      write(repo, 'feature.txt', 'f\n');
      const head = commitAll(repo, 'feature work');
      git(repo, 'checkout', '-q', 'main');
      write(repo, 'main.txt', 'm\n');
      const mainTip = commitAll(repo, 'main moved on');
      git(repo, 'checkout', '-q', 'feature');
      const merged = capture(repo, { range: { from: 'main', to: 'HEAD', mergeBase: true }, paths: [] });
      assert.equal(merged.scope.mode, 'range');
      assert.equal(merged.scope.base, fork);
      assert.equal(merged.scope.head, head);
      assert.deepEqual(summary(merged.checkpoint, merged.scope), [['feature.txt', 'added', false, null, 'f\n']]);
      const plain = capture(repo, { range: { from: 'main', to: 'feature', mergeBase: false }, paths: [] });
      assert.equal(plain.scope.base, mainTip);
      assert.deepEqual(summary(plain.checkpoint, plain.scope), [
        ['feature.txt', 'added', false, null, 'f\n'],
        ['main.txt', 'deleted', false, 'm\n', null],
      ]);
    });

    it('refuses a range whose end is not HEAD, naming both commits', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': '1\n' });
      const first = git(repo, 'rev-parse', 'HEAD');
      write(repo, 'a.txt', '2\n');
      const second = commitAll(repo, 'second');
      write(repo, 'a.txt', '3\n');
      commitAll(repo, 'third');
      const { checkpoint, runId } = start(repo);
      assert.throws(
        () => captureScope(checkpoint, runId, { range: { from: first, to: second, mergeBase: false }, paths: [] }),
        (error: unknown) => error instanceof InvalidScopeRequestError && error.message.includes(second) && error.message.includes('HEAD'),
      );
      assert.equal(checkpoint.fold(runId).scope, null);
    });

    it('refuses a ref and a range together', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': '1\n' });
      const { checkpoint, runId } = start(repo);
      assert.throws(() => captureScope(checkpoint, runId, { ref: 'HEAD', range: { from: 'HEAD', to: 'HEAD', mergeBase: false }, paths: [] }), InvalidScopeRequestError);
    });
  });

  describe('files', () => {
    it('records a rename as a delete and an add', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'old-name.txt': 'moved content\n' });
      git(repo, 'mv', 'old-name.txt', 'new-name.txt');
      commitAll(repo, 'rename');
      const { checkpoint, scope } = capture(repo);
      assert.deepEqual(summary(checkpoint, scope), [
        ['new-name.txt', 'added', false, null, 'moved content\n'],
        ['old-name.txt', 'deleted', false, 'moved content\n', null],
      ]);
      assert.match(checkpoint.evidence.read(scope.patch).toString('utf8'), /rename from old-name\.txt/);
    });

    it('freezes an empty file, a binary file and a non-ASCII path', () => {
      const binary = Buffer.from([0, 1, 2, 255, 10, 13, 0]);
      const repo = repositoryWith(join(sandbox, 'repo'), { 'empty.txt': '', 'blob.bin': Buffer.from('x'), 'dir/\u00fcber-caf\u00e9.txt': 'accent\n' });
      write(repo, 'blob.bin', binary);
      write(repo, 'dir/\u00fcber-caf\u00e9.txt', 'accent 2\n');
      write(repo, 'empty.txt', '');
      git(repo, 'add', '-A');
      write(repo, 'empty-new.txt', '');
      const { checkpoint, scope } = capture(repo);
      const byPath = new Map(scope.files.map((file) => [file.path, file]));
      assert.deepEqual([...byPath.keys()], ['blob.bin', 'dir/\u00fcber-caf\u00e9.txt', 'empty-new.txt']);
      const frozenBinary = byPath.get('blob.bin')!.after;
      assert.ok(frozenBinary !== null && 'blob' in frozenBinary);
      assert.deepEqual(checkpoint.evidence.read(frozenBinary.blob), binary);
      assert.equal(bytesOf(checkpoint, byPath.get('empty-new.txt')!.after), '');
      assert.equal(byPath.get('empty-new.txt')!.before, null);
      assert.equal(bytesOf(checkpoint, byPath.get('dir/\u00fcber-caf\u00e9.txt')!.before), 'accent\n');
      assert.match(checkpoint.evidence.read(scope.patch).toString('utf8'), /GIT binary patch/);
    });

    it('reads before bytes through checkout filters so a CRLF checkout compares like for like', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'text.txt': 'a\nb\n' }, { autocrlf: true });
      git(repo, 'checkout', '--', 'text.txt');
      write(repo, 'text.txt', 'a\r\nb\r\nc\r\n');
      const { checkpoint, scope } = capture(repo);
      assert.deepEqual(summary(checkpoint, scope), [['text.txt', 'modified', false, 'a\r\nb\r\n', 'a\r\nb\r\nc\r\n']]);
      assert.equal(gitApi.blobRaw(repo, git(repo, 'rev-parse', 'HEAD:text.txt')).toString('utf8'), 'a\nb\n', 'the blob itself stays LF');
    });

    it('freezes a symlink as its target text', (t) => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'target.txt': 't\n' });
      if (!link(repo, 'to-target', 'target.txt')) return t.skip('symlinks are not permitted here');
      commitAll(repo, 'add link');
      remove(repo, 'to-target');
      link(repo, 'to-target', 'elsewhere.txt');
      const { checkpoint, scope } = capture(repo);
      assert.deepEqual(summary(checkpoint, scope), [['to-target', 'modified', true, 'target.txt', 'elsewhere.txt']]);
    });

    it('records a file over the limit by hash and size, in either state, storing no blob', () => {
      const big = Buffer.alloc(freezeLimitBytes + 1, 0x61);
      const repo = repositoryWith(join(sandbox, 'repo'), { 'big.bin': big, 'small.txt': 's\n' });
      write(repo, 'small.txt', Buffer.alloc(freezeLimitBytes + 2, 0x62));
      write(repo, 'big.bin', 'now small\n');
      const { checkpoint, scope } = capture(repo);
      assert.deepEqual(summary(checkpoint, scope), [
        ['big.bin', 'modified', false, `oversized:${sha256Hex(big)}:${String(big.length)}`, 'now small\n'],
        ['small.txt', 'modified', false, 's\n', `oversized:${sha256Hex(Buffer.alloc(freezeLimitBytes + 2, 0x62))}:${String(freezeLimitBytes + 2)}`],
      ]);
      assert.equal(checkpoint.evidence.has({ sha256: sha256Hex(big), bytes: big.length }), false);
    });

    it('limits the inventory and the patch to the requested literal paths', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'src/a.txt': '1\n', 'src/b.txt': '1\n', 'docs/c.txt': '1\n', 'src/a.txt.bak': '1\n' });
      for (const path of ['src/a.txt', 'src/b.txt', 'docs/c.txt', 'src/a.txt.bak']) write(repo, path, '2\n');
      write(repo, 'src/new.txt', 'n\n');
      const directory = capture(repo, { paths: ['src'] });
      assert.deepEqual(directory.scope.files.map((file) => file.path), ['src/a.txt', 'src/a.txt.bak', 'src/b.txt', 'src/new.txt']);
      assert.doesNotMatch(directory.checkpoint.evidence.read(directory.scope.patch).toString('utf8'), /docs\/c\.txt/);
      const single = capture(repo, { paths: ['src/a.txt', 'docs\\c.txt'] });
      assert.deepEqual(single.scope.files.map((file) => file.path), ['docs/c.txt', 'src/a.txt']);
      assert.deepEqual(single.scope.request.paths, ['src/a.txt', 'docs/c.txt']);
    });

    it('refuses a requested path that names nothing in the change', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': '1\n', 'b.txt': '1\n' });
      write(repo, 'a.txt', '2\n');
      const { checkpoint, runId } = start(repo);
      assert.throws(() => captureScope(checkpoint, runId, { paths: ['b.txt'] }), /names nothing in the change: b\.txt/);
      assert.throws(() => captureScope(checkpoint, runId, { paths: ['absent'] }), InvalidScopeRequestError);
    });
  });

  describe('refusals', () => {
    it('refuses unsafe scope paths', () => {
      for (const path of ['', '/abs', 'C:/abs', '../up', 'a/../../b', '.git/config', 'nested/.GIT/x', 'nul\0byte']) {
        assert.throws(() => validateScopePath(path), InvalidScopeRequestError, JSON.stringify(path));
      }
      assert.doesNotThrow(() => validateScopePath('src/a.git.txt'));
    });

    it('refuses unmerged paths', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'c.txt': 'base\n' });
      git(repo, 'checkout', '-q', '-b', 'other');
      write(repo, 'c.txt', 'theirs\n');
      commitAll(repo, 'theirs');
      git(repo, 'checkout', '-q', 'main');
      write(repo, 'c.txt', 'ours\n');
      commitAll(repo, 'ours');
      assert.throws(() => git(repo, 'merge', 'other'));
      const { checkpoint, runId } = start(repo);
      assert.throws(() => captureScope(checkpoint, runId, noRequest), /unmerged paths.*c\.txt/);
    });

    it('refuses a submodule', () => {
      const inner = repositoryWith(join(sandbox, 'inner'), { 'i.txt': 'i\n' });
      const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': '1\n' });
      git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub');
      commitAll(repo, 'add submodule');
      const { checkpoint, runId } = start(repo);
      assert.throws(() => captureScope(checkpoint, runId, noRequest), /Submodules are unsupported: sub/);
    });

    it('refuses an embedded repository', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': '1\n' });
      write(repo, 'a.txt', '2\n');
      createRepository(join(repo, 'embedded'));
      write(repo, 'embedded/e.txt', 'e\n');
      const { checkpoint, runId } = start(repo);
      assert.throws(() => captureScope(checkpoint, runId, noRequest), /Embedded repositories are unsupported: embedded\//);
    });

    it('refuses more paths than the limit, naming the count', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'seed.txt': 's\n' });
      for (let index = 0; index <= maxScopeFiles; index += 1) write(repo, `many/${String(index)}.txt`, 'x');
      const { checkpoint, runId } = start(repo);
      assert.throws(() => captureScope(checkpoint, runId, noRequest), new RegExp(`touches ${String(maxScopeFiles + 1)} paths`));
    });

    it('refuses a run that is abandoned, already captured, or started elsewhere', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': '1\n' });
      const { checkpoint, runId } = start(repo);
      captureScope(checkpoint, runId, noRequest);
      assert.throws(() => captureScope(checkpoint, runId, noRequest), ScopeAlreadyCapturedError);
      const abandoned = checkpoint.createRun({ worktree: repo });
      checkpoint.append(abandoned.id, abandoned.lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'x' } }]);
      assert.throws(() => captureScope(checkpoint, abandoned.id, noRequest), RunClosedError);
      const elsewhere = repositoryWith(join(sandbox, 'elsewhere'), { 'b.txt': '1\n' });
      const foreign = checkpoint.createRun({ worktree: elsewhere });
      assert.throws(() => captureScope(checkpoint, foreign.id, noRequest), /different checkpoint/);
    });
  });

  describe('race guard', () => {
    it('refuses and writes nothing when a scope file changes during capture', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': '1\n' });
      write(repo, 'a.txt', '2\n');
      const { checkpoint, runId } = start(repo);
      // Change the file from inside the evidence store's put, which runs between the read and the guard.
      const original = checkpoint.evidence.put.bind(checkpoint.evidence);
      let raced = false;
      checkpoint.evidence.put = (value) => {
        if (!raced) {
          raced = true;
          write(repo, 'a.txt', '3\n');
        }
        return original(value);
      };
      assert.throws(() => captureScope(checkpoint, runId, noRequest), /a\.txt changed while the scope was being captured/);
      assert.equal(checkpoint.fold(runId).scope, null);
      checkpoint.evidence.put = original;
      const state = captureScope(checkpoint, runId, noRequest);
      assert.equal(bytesOf(checkpoint, state.scope!.files[0]!.after), '3\n');
    });

    it('refuses when HEAD moves during capture', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': '1\n' });
      write(repo, 'a.txt', '2\n');
      const { checkpoint, runId } = start(repo);
      const original = checkpoint.evidence.put.bind(checkpoint.evidence);
      let raced = false;
      checkpoint.evidence.put = (value) => {
        if (!raced) {
          raced = true;
          write(repo, 'other.txt', 'o\n');
          git(repo, 'add', 'other.txt');
          git(repo, 'commit', '-q', '-m', 'moved');
        }
        return original(value);
      };
      assert.throws(() => captureScope(checkpoint, runId, noRequest), CaptureRacedError);
      assert.equal(checkpoint.fold(runId).scope, null);
    });
  });

  it('folds the scope back from a reopened checkpoint', () => {
    const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': '1\n' });
    write(repo, 'a.txt', '2\n');
    const { checkpoint, scope, runId } = capture(repo);
    checkpoint.close();
    opened.splice(0);
    const reopened = Checkpoint.open(locateCheckpoint(repo).root, { engine: '0.0.1-test' });
    opened.push(reopened);
    assert.deepEqual(reopened.fold(runId).scope, scope);
    mkdirSync(join(sandbox, 'unused'));
  });
});
