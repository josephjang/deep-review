import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
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

  it('gives each setting one value that a test can replace, whatever config the machine\'s init.templateDir holds', (t) => {
    const directory = temporaryDirectory(t);
    write(directory, 'template/config', '[core]\n\tautocrlf = input\n[user]\n\temail = me@x\n');
    write(directory, 'global', `[init]\n\ttemplateDir = ${join(directory, 'template').replaceAll('\\', '/')}\n`);
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = join(directory, 'global');
    t.after(() => {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before;
    });
    const repo = createRepository(join(directory, 'repo'));
    assert.equal(git(repo, 'config', '--local', '--get-all', 'core.autocrlf'), 'false');
    assert.equal(git(repo, 'config', '--local', '--get-all', 'user.email'), 'test@example.invalid');
    git(repo, 'config', 'core.autocrlf', 'true');
    git(repo, 'config', 'user.email', 'a@b');
    assert.equal(git(repo, 'config', '--get', 'core.autocrlf'), 'true');
    assert.ok(existsSync(join(repo, '.git', 'info')) && existsSync(join(repo, '.git', 'hooks')), 'the directories a test writes an exclude or a hook in');
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
    // file where the copy changes that data. Every system's copy does once it is made later than the template: on POSIX it gets new inodes
    // and times, and on Windows a new creation time, which Git for Windows reads as the ctime. So this guards the refresh on every runner.
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
