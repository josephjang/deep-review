import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Checkpoint } from '../../src/checkpoint/checkpoint.ts';
import type { ScopeState } from '../../src/checkpoint/events.ts';
import { locateCheckpoint } from '../../src/checkpoint/locate.ts';
import { captureScope, freezeLimitBytes } from '../../src/scope/capture.ts';
import { compareScopeFiles, compareWorktree } from '../../src/scope/compare.ts';
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
