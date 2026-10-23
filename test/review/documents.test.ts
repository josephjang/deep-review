import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { planPathOf } from '../../src/review/documents.ts';
import { write } from '../helpers/repository.ts';

// R2 and TD8 of the documentation step.
describe('planPathOf', () => {
  let directory: string;
  let worktree: string;
  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-documents-')));
    worktree = join(directory, 'repo');
    write(worktree, 'docs/Testing.md', 'x');
    write(worktree, 'CHANGES.md', 'x');
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('reads a drift line\'s path as the repository path the worktree spells, however the fixer wrote it', () => {
    const resolve = planPathOf(worktree);
    assert.equal(resolve('docs/Testing.md'), 'docs/Testing.md');
    assert.equal(resolve('./docs/Testing.md'), 'docs/Testing.md', 'a leading ./');
    assert.equal(resolve('docs\\Testing.md'), 'docs/Testing.md', 'a backslash');
    assert.equal(resolve('DOCS/testing.md'), 'docs/Testing.md', 'another case');
    assert.equal(resolve(join(worktree, 'CHANGES.md')), 'CHANGES.md', 'an absolute path inside the worktree');
    assert.equal(resolve('docs/new.md'), 'docs/new.md', 'a document the worktree does not hold keeps the path as written');
  });

  it('refuses a path outside the worktree, through .., or into the git directory, which stays an item with no path', () => {
    const resolve = planPathOf(worktree);
    assert.equal(resolve('../outside.md'), null);
    assert.equal(resolve('docs/../../outside.md'), null);
    assert.equal(resolve(join(directory, 'outside.md')), null, 'an absolute path outside the worktree');
    assert.equal(resolve('.git/config'), null);
    assert.equal(resolve('docs/.GIT/x'), null);
    assert.equal(resolve('a\0b'), null, 'a NUL');
    assert.equal(resolve(''), null, 'no path at all');
  });
});
