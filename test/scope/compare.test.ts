import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Checkpoint } from '../../src/checkpoint/checkpoint.ts';
import type { ScopeRequest, ScopeState } from '../../src/checkpoint/events.ts';
import { locateCheckpoint } from '../../src/checkpoint/locate.ts';
import { captureScope, freezeLimitBytes } from '../../src/scope/capture.ts';
import { compareScopeFiles, compareWorktree, scopeMatches } from '../../src/scope/compare.ts';
import { commitAll, git, remove, repositoryWith, write } from '../helpers/repository.ts';

describe('compareWorktree', () => {
  let sandbox: string;
  let repo: string;
  let checkpoint: Checkpoint;
  let scope: ScopeState;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'deep-review-compare-'));
    repo = repositoryWith(join(sandbox, 'repo'), { 'keep.txt': 'k\n', 'edit.txt': 'e\n', 'gone.txt': 'g\n', 'big.bin': Buffer.alloc(freezeLimitBytes + 1, 1) });
    write(repo, 'edit.txt', 'e2\n');
    remove(repo, 'gone.txt');
    write(repo, 'new.txt', 'n\n');
    write(repo, 'big.bin', Buffer.alloc(freezeLimitBytes + 1, 2));
    checkpoint = Checkpoint.open(locateCheckpoint(repo).root, { engine: '0.0.0-test' });
    const run = checkpoint.createRun({ worktree: repo });
    scope = captureScope(checkpoint, run.id, { paths: [] }).scope!;
  });
  afterEach(() => {
    checkpoint.close();
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('reports every scope file unchanged and nothing outside right after capture', () => {
    assert.deepEqual(compareWorktree(scope, repo), {
      files: [
        { path: 'big.bin', outcome: 'unchanged' },
        { path: 'edit.txt', outcome: 'unchanged' },
        { path: 'gone.txt', outcome: 'unchanged' },
        { path: 'new.txt', outcome: 'unchanged' },
      ],
      outside: [],
    });
  });

  it('classifies modified, deleted and restored files, comparing an oversized file by hash', () => {
    write(repo, 'edit.txt', 'e3\n');
    remove(repo, 'new.txt');
    write(repo, 'gone.txt', 'back\n');
    write(repo, 'big.bin', Buffer.alloc(freezeLimitBytes + 1, 3));
    assert.deepEqual(compareWorktree(scope, repo).files, [
      { path: 'big.bin', outcome: 'modified' },
      { path: 'edit.txt', outcome: 'modified' },
      { path: 'gone.txt', outcome: 'restored' },
      { path: 'new.txt', outcome: 'deleted' },
    ]);
  });

  it('treats a file restored to its frozen bytes as unchanged, and a same-size change as modified', () => {
    write(repo, 'edit.txt', 'e3\n');
    assert.equal(compareWorktree(scope, repo).files.find((file) => file.path === 'edit.txt')?.outcome, 'modified');
    write(repo, 'edit.txt', 'e2\n');
    assert.equal(compareWorktree(scope, repo).files.find((file) => file.path === 'edit.txt')?.outcome, 'unchanged');
  });

  it('lists changes outside the scope separately, and does not count committing the scope as a change', () => {
    write(repo, 'keep.txt', 'k2\n');
    write(repo, 'stray.log', 'log\n');
    write(repo, 'nested/deep.txt', 'd\n');
    const comparison = compareWorktree(scope, repo);
    assert.deepEqual(comparison.outside, ['keep.txt', 'nested/deep.txt', 'stray.log']);
    assert.ok(comparison.files.every((file) => file.outcome === 'unchanged'));
    remove(repo, 'stray.log');
    remove(repo, 'nested');
    git(repo, 'checkout', '--', 'keep.txt');
    commitAll(repo, 'commit the reviewed change');
    assert.deepEqual(compareWorktree(scope, repo), { files: compareWorktree(scope, repo).files, outside: [] });
    assert.ok(compareWorktree(scope, repo).files.every((file) => file.outcome === 'unchanged'), 'the worktree bytes are what was frozen');
  });

  it('writes nothing to the checkpoint', () => {
    const before = checkpoint.ledger.lastSequence(checkpoint.foldRuns()[0]!.id);
    write(repo, 'edit.txt', 'e3\n');
    compareWorktree(scope, repo);
    assert.equal(checkpoint.ledger.lastSequence(checkpoint.foldRuns()[0]!.id), before);
  });
  it('compares the scope files as compareWorktree does, reading only them, so a copy of the tree outside its repository compares too', () => {
    write(repo, 'edit.txt', 'e3\n');
    write(repo, 'stray.log', 'log\n');
    assert.deepEqual(compareScopeFiles(scope, repo), compareWorktree(scope, repo).files);
    // A copy of the tree without its repository: only the scope files are read.
    const copy = join(sandbox, 'copy');
    cpSync(repo, copy, { recursive: true, filter: (source) => !source.split(/[\/]/).includes('.git') });
    assert.deepEqual(compareScopeFiles(scope, copy), [
      { path: 'big.bin', outcome: 'unchanged' },
      { path: 'edit.txt', outcome: 'modified' },
      { path: 'gone.txt', outcome: 'unchanged' },
      { path: 'new.txt', outcome: 'unchanged' },
    ]);
  });
});

// R2, PD3, TD4 of fix pass continuation: whether a request names the change a scope captured, unchanged since.
describe('scopeMatches', () => {
  let sandbox: string;
  let repo: string;
  const opened: Checkpoint[] = [];
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'deep-review-matches-'));
    repo = repositoryWith(join(sandbox, 'repo'), { 'keep.txt': 'k\n', 'src/edit.txt': 'e\n', 'docs/other.txt': 'o\n' });
  });
  afterEach(() => {
    for (const checkpoint of opened.splice(0)) checkpoint.close();
    rmSync(sandbox, { recursive: true, force: true });
  });

  const captured = (request: ScopeRequest): ScopeState => {
    const checkpoint = Checkpoint.open(locateCheckpoint(repo).root, { engine: '0.0.0-test' });
    opened.push(checkpoint);
    return captureScope(checkpoint, checkpoint.createRun({ worktree: repo }).id, request).scope!;
  };
  /** The scope's files that differ from what it froze, by raw bytes: the run's own comparison asks git, which these tests do not need. */
  const rawChanges = (scope: ScopeState): string[] => compareScopeFiles(scope, repo).filter((file) => file.outcome !== 'unchanged').map((file) => file.path);
  const matches = (request: ScopeRequest, scope: ScopeState): string | null => scopeMatches(request, scope, repo, rawChanges);

  it('matches the request that captured the scope, in the tree it left', () => {
    write(repo, 'src/edit.txt', 'e2\n');
    write(repo, 'src/new.txt', 'n\n');
    const scope = captured({ paths: ['src'] });
    assert.equal(matches({ paths: ['src'] }, scope), null);
    assert.equal(matches({ paths: ['src\\'] }, scope), null, 'spelled as the capture spells it');
    assert.equal(matches({ paths: ['src/edit.txt', 'src/new.txt'] }, scope), null, 'other flags that name the same paths');
  });

  it('names a scope of another mode or base first', () => {
    write(repo, 'src/edit.txt', 'e2\n');
    const scope = captured({ paths: [] });
    const head = git(repo, 'rev-parse', 'HEAD');
    assert.equal(matches({ ref: 'HEAD~0', paths: [] }, scope), `its scope is worktree ${head}..${head}, not the one named`, 'ref mode against a worktree scope');
    git(repo, 'checkout', '--', 'src/edit.txt');
    write(repo, 'src/edit.txt', 'e2\n');
    commitAll(repo, 'commit the change');
    assert.equal(matches({ paths: [] }, scope), `its scope is worktree ${head}..${head}, not the one named`, 'the change committed since is last-commit mode, against another base');
  });

  it('names a file added to a worktree scope since, and one no longer changed', () => {
    write(repo, 'src/edit.txt', 'e2\n');
    write(repo, 'docs/other.txt', 'o2\n');
    const scope = captured({ paths: [] });
    write(repo, 'notes.txt', 'n\n');
    assert.equal(matches({ paths: [] }, scope), 'its files are not the change named: notes.txt changed since and not in it');
    git(repo, 'checkout', '--', 'docs/other.txt');
    assert.equal(matches({ paths: [] }, scope), 'its files are not the change named: notes.txt changed since and not in it; docs/other.txt in it and no longer changed');
  });

  it('names how many of its files changed since, comparing them by the caller\'s rule', () => {
    write(repo, 'src/edit.txt', 'e2\n');
    write(repo, 'docs/other.txt', 'o2\n');
    const scope = captured({ paths: [] });
    write(repo, 'src/edit.txt', 'e3\n');
    assert.equal(matches({ paths: [] }, scope), '1 of its files changed since: src/edit.txt');
    assert.equal(scopeMatches({ paths: [] }, scope, repo, () => []), null, 'the caller decides what counts as changed');
    write(repo, 'src/edit.txt', 'e2\n');
    assert.equal(matches({ paths: [] }, scope), null, 'restored to the bytes the scope froze');
  });

  it('names HEAD when it moved and the change named holds the same files with the same contents', () => {
    git(repo, 'checkout', '-q', '-b', 'feature');
    write(repo, 'src/edit.txt', 'e2\n');
    const first = commitAll(repo, 'the change');
    const scope = captured({ ref: 'main', paths: [] });
    git(repo, 'commit', '-q', '--amend', '-m', 'the change, reworded');
    const moved = git(repo, 'rev-parse', 'HEAD');
    assert.notEqual(moved, first);
    assert.equal(matches({ ref: 'main', paths: [] }, scope), `HEAD is ${moved}, not ${first}`);
  });

  it('gives the first reason in order: another base before other files, other files before changed bytes', () => {
    write(repo, 'src/edit.txt', 'e2\n');
    const scope = captured({ paths: [] });
    write(repo, 'src/edit.txt', 'e3\n');
    write(repo, 'notes.txt', 'n\n');
    assert.match(matches({ paths: [] }, scope)!, /^its files are not the change named/);
    assert.match(matches({ ref: 'HEAD', paths: [] }, scope)!, /^its scope is worktree/);
  });

  it('throws what the capture throws for a request the tree refutes, writing nothing', () => {
    write(repo, 'src/edit.txt', 'e2\n');
    const scope = captured({ paths: [] });
    assert.throws(() => matches({ paths: ['missing'] }, scope), /Scope path names nothing in the change: missing/);
  });
});
