import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FrozenFile, ScopeState } from '../../src/checkpoint/events.ts';
import { EvidenceStore, sha256Hex } from '../../src/evidence/store.ts';
import { compareExpected, expectedAt, expectedTree, headMoved, headStates, matchesExpected, noBase, readTreeEntry, reviseFrom, revisionsFromSnapshots, straysOf, unfinishedRevisions, worktreeReader, type ExpectedTree, type RevisedFile, type TreeEntry, type TreeReader } from '../../src/review/tree.ts';
import { freezeLimitBytes } from '../../src/scope/capture.ts';
import { commitAll, git, link, repositoryWith, write } from '../helpers/repository.ts';

const blob = (text: string): FrozenFile => ({ blob: { sha256: sha256Hex(Buffer.from(text)), bytes: Buffer.byteLength(text) } });
const file = (text: string): TreeEntry => ({ bytes: Buffer.from(text), symlink: false });
/** A revised file from one state to another, null where nothing is. */
const entry = (path: string, before: FrozenFile | null, after: FrozenFile | null): RevisedFile => ({ path, status: before === null ? 'created' : after === null ? 'deleted' : 'modified', before, beforeSymlink: false, symlink: false, after });
/** A reader over an in-memory tree; a path it does not name reads as unknown unless `complete`, which reads it as absent. */
const reader = (entries: Record<string, string | null>, complete = true): TreeReader => (path) => (Object.hasOwn(entries, path) ? (entries[path] === null ? null : file(entries[path]!)) : complete ? null : undefined);

const scope: Pick<ScopeState, 'files'> = {
  files: [
    { path: 'src/a.ts', status: 'modified', symlink: false, before: blob('a0'), after: blob('a1') },
    { path: 'src/gone.ts', status: 'deleted', symlink: false, before: blob('g'), after: null },
    { path: 'link', status: 'added', symlink: true, before: null, after: blob('target') },
  ],
};

describe('expectedTree', () => {
  it('is the scope\'s after states alone before any revision, a deleted file expected absent', () => {
    assert.deepEqual([...expectedTree(scope, [])], [
      ['src/a.ts', { frozen: blob('a1'), symlink: false }],
      ['src/gone.ts', null],
      ['link', { frozen: blob('target'), symlink: true }],
    ]);
  });

  it('overlays each revision in order: a later revision of a path wins, and a path outside the scope enters', () => {
    const tree = expectedTree(scope, [
      { files: [entry('src/a.ts', blob('a1'), blob('a2')), entry('test/a.test.ts', null, blob('t1'))] },
      { files: [entry('src/a.ts', blob('a2'), blob('a3')), entry('src/gone.ts', null, blob('back'))] },
      { files: [entry('test/a.test.ts', blob('t1'), null)] },
    ]);
    assert.deepEqual(tree.get('src/a.ts'), { frozen: blob('a3'), symlink: false });
    assert.deepEqual(tree.get('src/gone.ts'), { frozen: blob('back'), symlink: false });
    assert.equal(tree.get('test/a.test.ts'), null, 'expected absent, and still named');
    assert.equal(tree.has('test/a.test.ts'), true);
  });
});

describe('matchesExpected', () => {
  it('compares kind, size and hash, and reads an unnamed path as expected absent', () => {
    assert.equal(matchesExpected({ frozen: blob('x'), symlink: false }, file('x')), true);
    assert.equal(matchesExpected({ frozen: blob('x'), symlink: true }, file('x')), false, 'a file is not a symlink with the same text');
    assert.equal(matchesExpected({ frozen: blob('x'), symlink: false }, file('y')), false);
    assert.equal(matchesExpected({ frozen: blob('x'), symlink: false }, null), false);
    assert.equal(matchesExpected(null, null), true);
    assert.equal(matchesExpected(undefined, null), true);
    assert.equal(matchesExpected(null, file('x')), false);
    const big = Buffer.alloc(freezeLimitBytes + 1, 7);
    assert.equal(matchesExpected({ frozen: { oversized: { sha256: sha256Hex(big), size: big.length } }, symlink: false }, { bytes: big, symlink: false }), true);
  });
});

describe('compareExpected', () => {
  const tree: ExpectedTree = expectedTree(scope, [{ files: [entry('test/new.ts', null, blob('n'))] }]);

  it('names each expected path that differs, in path order, with the state the run expected', () => {
    const drifted = compareExpected(tree, reader({ 'src/a.ts': 'edited', 'src/gone.ts': 'back', link: null, 'test/new.ts': 'n' }));
    assert.deepEqual(drifted, [
      { path: 'link', outcome: 'deleted', expected: blob('target') },
      { path: 'src/a.ts', outcome: 'modified', expected: blob('a1') },
      { path: 'src/gone.ts', outcome: 'restored', expected: null },
    ]);
  });

  it('leaves out the excluded paths and the ones the reader cannot speak for', () => {
    assert.deepEqual(compareExpected(tree, reader({ 'src/a.ts': 'edited', 'src/gone.ts': 'back' }, false), new Set(['src/a.ts'])), [{ path: 'src/gone.ts', outcome: 'restored', expected: null }]);
    assert.deepEqual(compareExpected(tree, reader({ 'src/a.ts': 'a1', link: 'target', 'test/new.ts': 'n' })), [{ path: 'link', outcome: 'modified', expected: blob('target') }], 'a file where a symlink was expected');
  });
});

describe('reviseFrom', () => {
  let directory: string;
  let evidence: EvidenceStore;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'deep-review-tree-'));
    evidence = new EvidenceStore(join(directory, 'evidence'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('freezes each path that differs, as created, modified or deleted, with the state before it, in path order, and nothing for a path that matches', () => {
    const tree = expectedTree(scope, []);
    const revised = reviseFrom(evidence, reader({ 'src/a.ts': 'fixed', 'src/gone.ts': 'recreated', link: null, 'test/a.test.ts': 'test', 'src/same.ts': null }), tree, noBase, ['test/a.test.ts', 'src/a.ts', 'src/gone.ts', 'link', 'src/same.ts', 'src/a.ts']);
    assert.deepEqual(revised, [
      { path: 'link', status: 'deleted', before: blob('target'), beforeSymlink: true, symlink: false, after: null },
      { path: 'src/a.ts', status: 'modified', before: blob('a1'), beforeSymlink: false, symlink: false, after: blob('fixed') },
      { path: 'src/gone.ts', status: 'created', before: null, beforeSymlink: false, symlink: false, after: blob('recreated') },
      { path: 'test/a.test.ts', status: 'created', before: null, beforeSymlink: false, symlink: false, after: blob('test') },
    ]);
    assert.equal(evidence.read((revised[1]!.after as { blob: { sha256: string; bytes: number } }).blob).toString(), 'fixed');
    assert.deepEqual(reviseFrom(evidence, reader({ 'src/a.ts': 'a1' }), tree, noBase, ['src/a.ts']), []);
  });

  it('takes a path the expected tree does not name as the base holds it: unchanged is no revision, edited is a modification of it', () => {
    const base = (path: string) => (path === 'src/caller.ts' ? { frozen: blob('caller'), symlink: false } : null);
    const tree = expectedTree(scope, []);
    assert.deepEqual(reviseFrom(evidence, reader({ 'src/caller.ts': 'caller' }), tree, base, ['src/caller.ts']), []);
    assert.deepEqual(reviseFrom(evidence, reader({ 'src/caller.ts': 'fixed caller', 'src/new.ts': 'new' }), tree, base, ['src/caller.ts', 'src/new.ts']), [
      { path: 'src/caller.ts', status: 'modified', before: blob('caller'), beforeSymlink: false, symlink: false, after: blob('fixed caller') },
      { path: 'src/new.ts', status: 'created', before: null, beforeSymlink: false, symlink: false, after: blob('new') },
    ]);
    assert.deepEqual(expectedAt(tree, base, 'src/a.ts'), { frozen: blob('a1'), symlink: false }, 'the expected tree wins over the base where it names a path');
  });

  it('records a file above the freeze limit by hash and size only', () => {
    const big = Buffer.alloc(freezeLimitBytes + 1, 1);
    const revised = reviseFrom(evidence, () => ({ bytes: big, symlink: false }), expectedTree(scope, []), noBase, ['assets/big.bin']);
    assert.deepEqual(revised, [{ path: 'assets/big.bin', status: 'created', before: null, beforeSymlink: false, symlink: false, after: { oversized: { sha256: sha256Hex(big), size: big.length } } }]);
  });

  describe('revisionsFromSnapshots', () => {
    const tree = expectedTree(scope, []);
    const paths = ['src/a.ts', 'test/a.test.ts'];
    /** Sources whose snapshots are the given in-memory trees by index, each listing only the paths it names. */
    const sources = (snapshots: (Record<string, string | null> | null)[], worktree: Record<string, string | null>) => ({
      snapshot: (index: number): TreeReader | null => (snapshots[index] === null || snapshots[index] === undefined ? null : reader(snapshots[index], false)),
      worktree: reader(worktree),
    });

    it('gives one revision per finding when the fixer snapshotted after each, the last read from the worktree', () => {
      const revisions = revisionsFromSnapshots(evidence, sources([{ 'src/a.ts': 'one' }, { 'src/a.ts': 'two', 'test/a.test.ts': 't' }, { 'src/a.ts': 'stale snapshot' }], { 'src/a.ts': 'three', 'test/a.test.ts': 't' }), tree, noBase, paths, ['A-1', 'A-2', 'A-3']);
      assert.deepEqual(revisions.map((revision) => [revision.findings, revision.files.map((entry) => [entry.path, entry.status, entry.after])]), [
        [['A-1'], [['src/a.ts', 'modified', blob('one')]]],
        [['A-2'], [['src/a.ts', 'modified', blob('two')], ['test/a.test.ts', 'created', blob('t')]]],
        [['A-3'], [['src/a.ts', 'modified', blob('three')]]],
      ]);
    });

    it('carries a finding with no snapshot into the next revision, which names both', () => {
      const revisions = revisionsFromSnapshots(evidence, sources([{ 'src/a.ts': 'one' }, null, null], { 'src/a.ts': 'three' }), tree, noBase, paths, ['A-1', 'A-2', 'A-3']);
      assert.deepEqual(revisions.map((revision) => revision.findings), [['A-1'], ['A-2', 'A-3']]);
    });

    it('gives one revision from the worktree, naming every finding, when the fixer took no snapshot', () => {
      const revisions = revisionsFromSnapshots(evidence, sources([], { 'src/a.ts': 'all', 'test/a.test.ts': 't' }), tree, noBase, paths, ['A-1', 'A-2', 'A-3']);
      assert.deepEqual(revisions.map((revision) => [revision.findings, revision.files.length]), [[['A-1', 'A-2', 'A-3'], 2]]);
    });

    it('folds a snapshot that changed nothing forward, and leaves findings after the last change without a revision', () => {
      const revisions = revisionsFromSnapshots(evidence, sources([{ 'src/a.ts': 'a1' }, { 'src/a.ts': 'two' }, null], { 'src/a.ts': 'two' }), tree, noBase, paths, ['A-1', 'A-2', 'A-3']);
      assert.deepEqual(revisions.map((revision) => revision.findings), [['A-1', 'A-2']]);
    });

    describe('of an attempt that did not finish', () => {
      it('gives each snapshotted finding its own revision, carries none forward, and closes with what the worktree adds, naming no finding', () => {
        const revisions = unfinishedRevisions(evidence, sources([{ 'src/a.ts': 'one' }, null, { 'src/a.ts': 'three' }], { 'src/a.ts': 'three', 'test/a.test.ts': 't' }), tree, noBase, paths, ['A-1', 'A-2', 'A-3']);
        assert.deepEqual(revisions.map((revision) => [revision.findings, revision.files.map((entry) => [entry.path, entry.status, entry.after])]), [
          [['A-1'], [['src/a.ts', 'modified', blob('one')]]],
          // A-2 has no snapshot, so nothing says the attempt finished it: its edits, if any, are the next snapshot's.
          [['A-3'], [['src/a.ts', 'modified', blob('three')]]],
          [[], [['test/a.test.ts', 'created', blob('t')]]],
        ]);
      });

      it('gives only the closing revision when it took no snapshot, or its scratch is gone', () => {
        const revisions = unfinishedRevisions(evidence, sources([], { 'src/a.ts': 'half done' }), tree, noBase, paths, ['A-1', 'A-2']);
        assert.deepEqual(revisions.map((revision) => [revision.findings, revision.files.map((entry) => entry.path)]), [[[], ['src/a.ts']]]);
      });

      it('gives no revision for a snapshot that changed nothing, and none at all when the attempt left the tree as it was', () => {
        assert.deepEqual(unfinishedRevisions(evidence, sources([{ 'src/a.ts': 'a1' }, { 'src/a.ts': 'two' }], { 'src/a.ts': 'two' }), tree, noBase, paths, ['A-1', 'A-2']).map((revision) => revision.findings), [['A-2']]);
        assert.deepEqual(unfinishedRevisions(evidence, sources([], { 'src/a.ts': 'a1' }), tree, noBase, paths, ['A-1']), []);
        assert.deepEqual(unfinishedRevisions(evidence, sources([], {}), tree, noBase, [], []), []);
      });
    });

    it('takes a path a snapshot did not list from the next reader that has it', () => {
      // The first snapshot does not list the test file; the second lists it absent, which is no change; the worktree has it.
      const revisions = revisionsFromSnapshots(evidence, sources([{ 'src/a.ts': 'one' }, { 'test/a.test.ts': null }], { 'src/a.ts': 'one', 'test/a.test.ts': 'late' }), tree, noBase, paths, ['A-1', 'A-2', 'A-3']);
      assert.deepEqual(revisions.map((revision) => [revision.findings, revision.files.map((entry) => entry.path)]), [[['A-1'], ['src/a.ts']], [['A-2', 'A-3'], ['test/a.test.ts']]]);
    });

    it('gives nothing for no finding, and nothing when no path changed', () => {
      assert.deepEqual(revisionsFromSnapshots(evidence, sources([], {}), tree, noBase, paths, []), []);
      assert.deepEqual(revisionsFromSnapshots(evidence, sources([], { 'src/a.ts': 'a1' }), tree, noBase, paths, ['A-1']), []);
    });
  });
});

describe('the worktree as the tree reads it', () => {
  let directory: string;
  let repo: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'deep-review-tree-git-'));
    repo = repositoryWith(join(directory, 'repo'), { 'src/a.ts': 'a\n', '.gitignore': 'build/\n' });
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('reads a file, a symlink\'s target text, and nothing for a directory, a path through a file or no entry', () => {
    assert.deepEqual(readTreeEntry(repo, 'src/a.ts'), file('a\n'));
    assert.equal(readTreeEntry(repo, 'src'), null);
    assert.equal(readTreeEntry(repo, 'src/a.ts/inner'), null);
    assert.equal(readTreeEntry(repo, 'missing.ts'), null);
    if (link(repo, 'pointer', 'src/a.ts')) assert.deepEqual(worktreeReader(repo)('pointer'), { bytes: Buffer.from('src/a.ts'), symlink: true });
  });

  it('lists as strays the untracked files the run does not expect, leaving out expected and ignored ones', () => {
    write(repo, 'scratch.txt', 'x');
    write(repo, 'test/new.test.ts', 'x');
    mkdirSync(join(repo, 'build'));
    writeFileSync(join(repo, 'build', 'out.js'), 'x');
    const tree = new Map([['test/new.test.ts', { frozen: blob('x'), symlink: false }]]);
    assert.deepEqual(straysOf(repo, tree), ['scratch.txt']);
  });

  it('lists as strays the tracked files changed outside what the run expects, a tool\'s leftovers, and not one it expects (PD9 of commit series integrity)', () => {
    write(repo, '.gitignore', 'build/\nout/\n');
    write(repo, 'src/a.ts', 'changed\n');
    const tree = new Map([['src/a.ts', { frozen: blob('a\n'), symlink: false }]]);
    assert.deepEqual(straysOf(repo, tree), ['.gitignore'], 'src/a.ts is expected, so it is compared, never a stray');
  });

  it('reads the base of a path as the scope\'s head commit holds it, whatever the worktree holds now, and nothing where it holds none', () => {
    const evidence = new EvidenceStore(join(directory, 'evidence'));
    const head = git(repo, 'rev-parse', 'HEAD');
    write(repo, 'src/a.ts', 'edited after the head\n');
    const base = headStates(repo, head, evidence);
    assert.deepEqual(base('src/a.ts'), { frozen: blob('a\n'), symlink: false });
    assert.equal(base('src/missing.ts'), null);
    assert.equal(evidence.read((base('src/a.ts')!.frozen as { blob: { sha256: string; bytes: number } }).blob).toString(), 'a\n', 'the head\'s bytes are frozen as evidence');
  });

  it('names HEAD when it moved from the head the scope captured, and nothing while it has not', () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    assert.equal(headMoved(repo, head), null);
    write(repo, 'src/a.ts', 'b\n');
    const moved = commitAll(repo, 'a commit during the run');
    assert.deepEqual(headMoved(repo, head), { expected: head, actual: moved });
  });
});
