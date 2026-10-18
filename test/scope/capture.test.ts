import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Checkpoint } from '../../src/checkpoint/checkpoint.ts';
import { RunClosedError } from '../../src/checkpoint/errors.ts';
import type { ScopeFile, ScopeRequest, ScopeState } from '../../src/checkpoint/events.ts';
import { ledgerFileName } from '../../src/checkpoint/ledger.ts';
import { locateCheckpoint } from '../../src/checkpoint/locate.ts';
import { sha256Hex } from '../../src/evidence/store.ts';
import { captureScope, freezeLimitBytes, maxScopeFiles, resolveScopeRequest, scopeBase, scopeEnds, validateScopePath } from '../../src/scope/capture.ts';
import { CaptureRacedError, EmptyChangeError, InvalidScopeRequestError, ScopeAlreadyCapturedError, UnsupportedRepositoryStateError } from '../../src/scope/errors.ts';
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
  const capture = (repo: string, request: ScopeRequest = noRequest, exclude: readonly string[] = []): { checkpoint: Checkpoint; scope: ScopeState; runId: string } => {
    const { checkpoint, runId } = start(repo);
    const state = captureScope(checkpoint, runId, request, { exclude });
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
      assert.deepEqual(scope.request, { ref: 'HEAD~1', paths: [], exclude: [] });
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

    it('reads a symlink\'s target as git records it, so an untouched link with a slash in its target is no change', (t) => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'dir/target.txt': 't\n', 'other.txt': 'o\n' });
      if (!link(repo, 'pointer', 'dir/target.txt')) return t.skip('symlinks are not permitted here');
      commitAll(repo, 'add link');
      // Windows stores the link's target with a backslash; git records it with the slash.
      assert.equal(git(repo, 'cat-file', '-p', 'HEAD:pointer'), 'dir/target.txt');
      write(repo, 'other.txt', 'changed\n');
      const { checkpoint, scope } = capture(repo);
      assert.deepEqual(summary(checkpoint, scope), [['other.txt', 'modified', false, 'o\n', 'changed\n']]);
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

  // R10 of the configuration: the paths scope.exclude leaves out.
  describe('paths left out', () => {
    const patchText = (checkpoint: Checkpoint, scope: ScopeState): string => checkpoint.evidence.read(scope.patch).toString('utf8');

    it('leaves out tracked, untracked and deleted paths a pattern matches, from the files and the patch, and names them', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'src/a.ts': '1\n', 'dist/a.js': 'built 1\n', 'dist/old.js': 'old\n', 'test/fixtures/checkpoints/x/ledger': 'l1\n' });
      write(repo, 'src/a.ts', '2\n');
      write(repo, 'dist/a.js', 'built 2\n');
      remove(repo, 'dist/old.js');
      write(repo, 'dist/new.js', 'new\n');
      write(repo, 'test/fixtures/checkpoints/x/ledger', 'l2\n');
      const { checkpoint, scope } = capture(repo, noRequest, ['dist/**', 'test/fixtures/checkpoints/**']);
      assert.deepEqual(scope.files.map((file) => file.path), ['src/a.ts']);
      assert.deepEqual(scope.request, { paths: [], exclude: ['dist/**', 'test/fixtures/checkpoints/**'] });
      assert.deepEqual(scope.excluded, { paths: ['dist/a.js', 'dist/new.js', 'dist/old.js', 'test/fixtures/checkpoints/x/ledger'], count: 4 });
      const patch = patchText(checkpoint, scope);
      assert.match(patch, /src\/a\.ts/);
      assert.doesNotMatch(patch, /dist\/|test\/fixtures/, 'no excluded file is in the patch');
    });

    it('reads a rename out of a pattern as an addition, and names the old path as left out', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'dist/a.js': 'export const moved = 1;\n'.repeat(20), 'src/keep.ts': 'k\n' });
      git(repo, 'mv', 'dist/a.js', 'src/a.js');
      const { checkpoint, scope } = capture(repo, noRequest, ['dist/**']);
      assert.deepEqual(scope.files.map((file) => [file.path, file.status]), [['src/a.js', 'added']]);
      assert.deepEqual(scope.excluded, { paths: ['dist/a.js'], count: 1 });
      const patch = patchText(checkpoint, scope);
      assert.match(patch, /new file mode/);
      assert.doesNotMatch(patch, /rename from/);
      assert.doesNotMatch(patch, /dist\/a\.js/);
    });

    it('keeps everything when no pattern matches, and records no path left out', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': '1\n' });
      write(repo, 'a.txt', '2\n');
      const { scope } = capture(repo, noRequest, ['dist/**']);
      assert.deepEqual(scope.files.map((file) => file.path), ['a.txt']);
      assert.deepEqual(scope.excluded, { paths: [], count: 0 });
    });

    it('refuses a --path whose changes the patterns all leave out, naming the setting and its patterns', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'dist/a.js': '1\n', 'src/a.ts': '1\n' });
      write(repo, 'dist/a.js', '2\n');
      write(repo, 'src/a.ts', '2\n');
      assert.throws(() => resolveScopeRequest(repo, { paths: ['dist'] }, ['dist/**']), /Scope path names only changes that scope\.exclude \(dist\/\*\*\) leaves out: dist/);
      assert.throws(() => resolveScopeRequest(repo, { paths: ['docs'] }, ['dist/**']), /Scope path names nothing in the change: docs/);
      assert.deepEqual(resolveScopeRequest(repo, { paths: ['src'] }, ['dist/**']).changes.map((change) => change.path), ['src/a.ts']);
    });

    it('refuses a pattern that git would read as magic, that leaves the repository, or that is absolute', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': '1\n' });
      write(repo, 'a.txt', '2\n');
      for (const pattern of [':(top)a.txt', '../a.txt', 'x/../a.txt', '/a.txt', 'C:/a.txt', '', 'a\0b']) {
        assert.throws(() => resolveScopeRequest(repo, noRequest, [pattern]), InvalidScopeRequestError, JSON.stringify(pattern));
      }
      assert.throws(() => resolveScopeRequest(repo, noRequest, Array.from({ length: 65 }, (_, index) => `p${String(index)}/**`)), /more than the 64/);
    });

    it('counts maxScopeFiles after the exclusion, so a large rebuild left out stays under the limit', () => {
      const files: Record<string, string> = { 'src/a.ts': '1\n' };
      for (let index = 0; index <= maxScopeFiles; index += 1) files[`dist/${String(index)}.js`] = '1\n';
      const repo = repositoryWith(join(sandbox, 'repo'), files);
      for (let index = 0; index <= maxScopeFiles; index += 1) write(repo, `dist/${String(index)}.js`, '2\n');
      write(repo, 'src/a.ts', '2\n');
      assert.throws(() => resolveScopeRequest(repo, noRequest), UnsupportedRepositoryStateError, 'over the limit with nothing left out');
      const resolved = resolveScopeRequest(repo, noRequest, ['dist/**']);
      assert.deepEqual(resolved.changes.map((change) => change.path), ['src/a.ts']);
      assert.equal(resolved.excluded.length, maxScopeFiles + 1);
      const { scope } = capture(repo, noRequest, ['dist/**']);
      assert.equal(scope.excluded.count, maxScopeFiles + 1);
      assert.equal(scope.excluded.paths.length, maxScopeFiles, 'the record names 2000 paths and counts the rest');
    });

    it('refuses an empty change, and a change the patterns leave empty, before it records anything', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'dist/a.js': '1\n' });
      const { checkpoint, runId } = start(repo);
      assert.throws(() => captureScope(checkpoint, runId, { range: { from: 'HEAD', to: 'HEAD', mergeBase: false }, paths: [] }), (error: unknown) => error instanceof EmptyChangeError && /The change is empty/.test(error.message));
      write(repo, 'dist/a.js', '2\n');
      assert.throws(() => captureScope(checkpoint, runId, noRequest, { exclude: ['dist/**'] }), (error: unknown) => error instanceof EmptyChangeError && /scope\.exclude \(dist\/\*\*\) leaves out all 1 of its changed paths/.test(error.message));
      assert.equal(checkpoint.fold(runId).scope, null);
    });

    it('refuses a capture whose base is not the one the configuration was read at, recording nothing', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': '1\n' });
      write(repo, 'a.txt', '2\n');
      const { checkpoint, runId } = start(repo);
      assert.throws(() => captureScope(checkpoint, runId, noRequest, { base: '0'.repeat(40) }), (error: unknown) => error instanceof CaptureRacedError && /HEAD moved since; run the command again/.test(error.message));
      assert.equal(checkpoint.fold(runId).scope, null);
      assert.ok(captureScope(checkpoint, runId, noRequest, { base: git(repo, 'rev-parse', 'HEAD') }).scope !== null);
    });
  });

  // TD4 of fix pass continuation: the capture's first half, which the comparison with a captured scope calls too.
  describe('resolveScopeRequest', () => {
    it('resolves a request to the mode, base, head, spelled request and paths the capture then records, writing nothing', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'src/a.txt': '1\n', 'src/b.txt': '1\n', 'docs/c.txt': '1\n' });
      write(repo, 'src/a.txt', '2\n');
      remove(repo, 'src/b.txt');
      write(repo, 'src/new.txt', 'n\n');
      write(repo, 'docs/c.txt', '2\n');
      const request: ScopeRequest = { paths: ['src\\'] };
      const resolved = resolveScopeRequest(repo, request);
      assert.deepEqual(resolved.changes, [
        { path: 'src/a.txt', status: 'modified', untracked: false },
        { path: 'src/b.txt', status: 'deleted', untracked: false },
        { path: 'src/new.txt', status: 'added', untracked: true },
      ]);
      assert.equal(existsSync(join(locateCheckpoint(repo).root, ledgerFileName)), false, 'no checkpoint was written');
      const { scope } = capture(repo, request);
      assert.deepEqual({ mode: resolved.mode, base: resolved.base, head: resolved.guard.head, request: resolved.request, paths: resolved.changes.map((change) => change.path) }, { mode: scope.mode, base: scope.base, head: scope.head, request: scope.request, paths: scope.files.map((file) => file.path) });
      assert.deepEqual(scope.request, { paths: ['src'], exclude: [] }, 'the spelling the capture records');
    });

    it('lists no untracked file in last-commit mode, and the commit it diffs to', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': '1\n' });
      write(repo, 'a.txt', '2\n');
      const head = commitAll(repo, 'second');
      const resolved = resolveScopeRequest(repo, noRequest);
      assert.equal(resolved.mode, 'last-commit');
      assert.equal(resolved.target, head);
      assert.deepEqual(resolved.changes, [{ path: 'a.txt', status: 'modified', untracked: false }]);
    });

    // R4 of the configuration: the base the repository's file is read at is the base the capture records.
    it('gives through scopeBase the base resolveScopeRequest gives, for each mode, listing no path', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': '1\n' });
      const root = git(repo, 'rev-parse', 'HEAD');
      write(repo, 'a.txt', '2\n');
      const second = commitAll(repo, 'second');
      git(repo, 'checkout', '-q', '-b', 'side', root);
      write(repo, 'b.txt', 'b\n');
      commitAll(repo, 'side');
      git(repo, 'checkout', '-q', 'main');
      write(repo, 'a.txt', '3\n');
      commitAll(repo, 'third');
      const requests: Record<string, ScopeRequest> = {
        'last-commit': noRequest,
        ref: { ref: second, paths: [] },
        range: { range: { from: 'side', to: 'HEAD', mergeBase: false }, paths: [] },
        'range with merge base': { range: { from: 'side', to: 'HEAD', mergeBase: true }, paths: [] },
      };
      for (const [mode, request] of Object.entries(requests)) assert.equal(scopeBase(repo, request), resolveScopeRequest(repo, request).base, mode);
      // Both ends, as the capture chooses them, for each mode (R11 of the skill surface corrections).
      for (const [mode, request] of Object.entries(requests)) {
        const resolved = resolveScopeRequest(repo, request);
        assert.deepEqual(scopeEnds(repo, request), { base: resolved.base, target: resolved.target }, mode);
      }
      assert.equal(scopeBase(repo, requests['range with merge base']!), root, 'the merge base of the side branch and HEAD');
      write(repo, 'a.txt', '4\n');
      assert.equal(scopeBase(repo, noRequest), git(repo, 'rev-parse', 'HEAD'), 'a dirty tree is reviewed from HEAD');
      assert.equal(scopeBase(repo, noRequest), resolveScopeRequest(repo, noRequest).base);
      assert.deepEqual(scopeEnds(repo, noRequest), { base: git(repo, 'rev-parse', 'HEAD'), target: null }, 'a dirty tree\'s change ends at the working tree');
      // A path that names nothing is not looked at: scopeBase lists no path.
      assert.equal(scopeBase(repo, { paths: ['missing'] }), git(repo, 'rev-parse', 'HEAD'));
      assert.throws(() => scopeBase(repo, { ref: 'HEAD', range: { from: 'HEAD', to: 'HEAD', mergeBase: false }, paths: [] }), InvalidScopeRequestError);
    });

    it('gives the empty tree as the base of the last commit of a root commit', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': '1\n' });
      assert.equal(scopeBase(repo, noRequest), gitApi.emptyTree(repo));
    });

    it('refuses what the capture refuses: a path that names nothing in the change, and a ref and a range together', () => {
      const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': '1\n' });
      write(repo, 'a.txt', '2\n');
      assert.throws(() => resolveScopeRequest(repo, { paths: ['missing'] }), /Scope path names nothing in the change: missing/);
      assert.throws(() => resolveScopeRequest(repo, { ref: 'HEAD', range: { from: 'HEAD', to: 'HEAD', mergeBase: false }, paths: [] }), InvalidScopeRequestError);
    });
  });
});
