import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { commitMessages, emptyTree } from '../../src/scope/git.ts';
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
