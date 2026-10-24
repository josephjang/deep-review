import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { commitCount, commitMessages, emptyTree, isEmptyTree } from '../../src/scope/git.ts';
import { commitAll, createRepository, git, write } from '../helpers/repository.ts';

describe('commitMessages (R6 of the brief of a run)', () => {
  let sandbox: string;
  let repo: string;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'deep-review-commit-messages-'));
    repo = createRepository(join(sandbox, 'repo'));
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  /** Commit one more change with `message`, which may span lines. */
  const commit = (message: string): string => {
    write(repo, 'file.txt', `${message}\n`);
    return commitAll(repo, message);
  };

  it('lists the commits of a range oldest first, each with its whole message', () => {
    const base = commit('base');
    const first = commit('feat: Add a parser\n\nThe body says why.\nOn two lines.');
    const second = commit('fix: Guard the empty input');
    assert.deepEqual(commitMessages(repo, base, second), [
      { commit: first, message: 'feat: Add a parser\n\nThe body says why.\nOn two lines.' },
      { commit: second, message: 'fix: Guard the empty input' },
    ]);
  });

  it('lists the one commit of a change of one commit against its parent', () => {
    const parent = commit('base');
    const head = commit('docs: Say what the flag does');
    assert.deepEqual(commitMessages(repo, parent, head), [{ commit: head, message: 'docs: Say what the flag does' }]);
  });

  it('lists the root commit alone when the base is the empty tree', () => {
    const root = commit('chore: Start the repository\n\nWith a file.');
    assert.deepEqual(commitMessages(repo, emptyTree(repo), root), [{ commit: root, message: 'chore: Start the repository\n\nWith a file.' }]);
    const head = commit('second');
    assert.deepEqual(commitMessages(repo, emptyTree(repo), head), [{ commit: head, message: 'second' }], 'the empty tree as the base names the head alone');
  });

  it('lists none for a change of the working tree, whose base is its head', () => {
    const head = commit('base');
    write(repo, 'file.txt', 'edited, not committed\n');
    assert.deepEqual(commitMessages(repo, head, head), []);
  });

  it('lists the commits a merge brings when the base is the merge\'s first parent', () => {
    commit('base');
    git(repo, 'checkout', '-q', '-b', 'topic');
    const topic = commit('feat: Work on a branch');
    git(repo, 'checkout', '-q', 'main');
    write(repo, 'other.txt', 'main\n');
    const mainline = commitAll(repo, 'main moves on');
    git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge the topic', 'topic');
    const merge = git(repo, 'rev-parse', 'HEAD');
    assert.deepEqual(commitMessages(repo, mainline, merge).map((entry) => entry.commit), [topic, merge]);
  });

  it('keeps a message\'s own lines and characters, and drops only the blank lines at its end', () => {
    const base = commit('base');
    const head = commit('feat: Accept "quotes", `ticks` and ünïcode\n\n- one\n- two\n\n\n');
    assert.deepEqual(commitMessages(repo, base, head), [{ commit: head, message: 'feat: Accept "quotes", `ticks` and ünïcode\n\n- one\n- two' }]);
  });
});

describe('commitCount (R12 of the questions in the chat)', () => {
  let sandbox: string;
  let repo: string;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'deep-review-commit-count-'));
    repo = createRepository(join(sandbox, 'repo'));
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });
  const commit = (path: string, text: string): string => {
    write(repo, path, `${text}\n`);
    return commitAll(repo, text);
  };

  it('counts the commits of a range, none for a range that ends at its start', () => {
    const base = commit('a.txt', 'base');
    commit('a.txt', 'one');
    const head = commit('b.txt', 'two');
    assert.equal(commitCount(repo, base, head), 2);
    assert.equal(commitCount(repo, head, head), 0);
  });

  it('counts a merge as one commit, on the first parent', () => {
    const base = commit('a.txt', 'base');
    git(repo, 'checkout', '-q', '-b', 'topic');
    commit('t.txt', 'topic one');
    commit('t.txt', 'topic two');
    git(repo, 'checkout', '-q', 'main');
    commit('a.txt', 'main one');
    git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge the topic', 'topic');
    assert.equal(commitCount(repo, base, git(repo, 'rev-parse', 'HEAD')), 2, 'main one and the merge');
  });

  it('counts only the commits that change a path it is given, a path with glob characters literally', () => {
    const base = commit('a.txt', 'base');
    commit('a.txt', 'one');
    commit('b.txt', 'two');
    commit('a1.txt', 'three');
    const head = commit('a[1].txt', 'four');
    assert.equal(commitCount(repo, base, head, ['a.txt']), 1);
    assert.equal(commitCount(repo, base, head, ['a.txt', 'b.txt']), 2);
    assert.equal(commitCount(repo, base, head, ['a[1].txt']), 1, 'the file named a[1].txt, not a1.txt, which the glob would match too');
  });

  it('leaves out a commit that changes only paths a pattern of scope.exclude leaves out', () => {
    const base = commit('a.txt', 'base');
    commit('a.txt', 'one');
    commit('dist/out.js', 'rebuilt');
    write(repo, 'a.txt', 'both\n');
    write(repo, 'dist/out.js', 'both\n');
    const head = commitAll(repo, 'both');
    assert.equal(commitCount(repo, base, head), 3);
    assert.equal(commitCount(repo, base, head, [], ['dist/**']), 2, 'one and both, not the commit that rebuilds dist/ alone');
    assert.equal(commitCount(repo, base, head, ['dist/out.js'], ['dist/**']), 0, 'a path the patterns leave out is not reviewed');
  });

  it('counts every commit up to the head from the empty tree', () => {
    commit('a.txt', 'root');
    const head = commit('a.txt', 'second');
    assert.equal(commitCount(repo, emptyTree(repo), head), 2);
  });

  it('gives null for a revision that does not exist', () => {
    const head = commit('a.txt', 'base');
    assert.equal(commitCount(repo, 'f'.repeat(40), head), null);
    assert.equal(commitCount(repo, head, 'no-such-branch'), null);
  });
});

describe('isEmptyTree', () => {
  it('knows the empty tree of each object format, and no other id', () => {
    assert.equal(isEmptyTree('4b825dc642cb6eb9a060e54bf8d69288fbee4904'), true);
    assert.equal(isEmptyTree('6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'), true);
    assert.equal(isEmptyTree('4b825dc6'), false);
    assert.equal(isEmptyTree('1'.repeat(40)), false);
  });

  it('matches the empty tree that git gives for this repository', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'deep-review-empty-tree-'));
    try {
      assert.equal(isEmptyTree(emptyTree(createRepository(join(sandbox, 'repo')))), true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
