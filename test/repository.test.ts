import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { createRepository, git, write } from './helpers/repository.ts';
import { sandboxRepository } from './helpers/review-sandbox.ts';

/** A new temporary directory by its real path, removed when the test `t` ends. */
function temporaryDirectory(t: TestContext): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'repository-helper-')));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

describe('createRepository', () => {
  it('makes a repository on main whose config holds every setting of a test repository', (t) => {
    const repo = createRepository(join(temporaryDirectory(t), 'repo'));
    assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
    const settings = { 'user.name': 'Test', 'user.email': 'test@example.invalid', 'commit.gpgsign': 'false', 'core.autocrlf': 'false', 'maintenance.auto': 'false', 'gc.auto': '0' };
    for (const [key, value] of Object.entries(settings)) assert.equal(git(repo, 'config', '--local', '--get', key), value, key);
  });

  it('sets core.autocrlf to true when a test asks for a CRLF checkout, read once though init wrote a [core] section too', (t) => {
    const repo = createRepository(join(temporaryDirectory(t), 'repo'), { autocrlf: true });
    assert.equal(git(repo, 'config', '--local', '--get-all', 'core.autocrlf'), 'true');
    assert.equal(git(repo, 'config', '--local', '--get', 'core.bare'), 'false', 'the [core] section git init wrote is still read');
  });

  it('commits with the identity it set', (t) => {
    const repo = createRepository(join(temporaryDirectory(t), 'repo'));
    write(repo, 'a.txt', 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'first');
    assert.equal(git(repo, 'log', '-1', '--format=%an <%ae>'), 'Test <test@example.invalid>');
  });
});

describe('sandboxRepository', () => {
  it('gives each sandbox the change under review on top of its first commit, with a clean tree', (t) => {
    const repo = sandboxRepository(join(temporaryDirectory(t), 'repo'));
    assert.deepEqual(git(repo, 'log', '--format=%s').split('\n'), ['the change under review', 'initial']);
    assert.deepEqual(git(repo, 'diff', '--name-status', 'HEAD~1', 'HEAD').split('\n'), ['M\tsrc/a.ts', 'A\tsrc/b.ts', 'D\tsrc/gone.ts']);
    assert.equal(git(repo, 'status', '--porcelain'), '');
  });

  it('leaves no file of a copy stat-dirty in its index, as a freshly made repository has none', (t) => {
    const repo = sandboxRepository(join(temporaryDirectory(t), 'repo'));
    // diff-files compares the files' stat data with the index without refreshing it, so a copied index that was not refreshed lists every
    // file where the copy changes that data: on POSIX, whose copies get new inodes and times. On Windows the copy keeps each file's write
    // time and git compares no inode, so this guards the POSIX runners.
    assert.equal(git(repo, 'diff-files', '--name-only'), '');
  });

  it('copies a repository of its own to each sandbox, so a change to one leaves another as it was', (t) => {
    const directory = temporaryDirectory(t);
    const first = sandboxRepository(join(directory, 'first'));
    const second = sandboxRepository(join(directory, 'second'));
    write(first, 'src/c.ts', 'export const c = 1;\n');
    git(first, 'add', '-A');
    git(first, 'commit', '-q', '-m', 'only in the first');
    assert.equal(git(second, 'log', '-1', '--format=%s'), 'the change under review');
    assert.equal(git(second, 'status', '--porcelain'), '');
    assert.notEqual(git(first, 'rev-parse', 'HEAD'), git(second, 'rev-parse', 'HEAD'));
  });
});
