import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { NotInRepositoryError } from '../../src/checkpoint/errors.ts';
import { checkpointDirectoryName, locateCheckpoint } from '../../src/checkpoint/locate.ts';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

/** A repository with one commit, so worktrees can be added. */
const initRepository = (root: string): void => {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'README.md'), 'hello\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'init');
};

describe('locateCheckpoint', () => {
  let sandbox: string;
  beforeEach(() => {
    // Native, so an 8.3 temp path (GitHub's Windows runner uses RUNNER~1) becomes its long form, as the locator reports it.
    sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-locate-')));
  });
  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  it('finds the checkpoint under .git for the main worktree, from the root and from a subdirectory', () => {
    const repository = join(sandbox, 'repo');
    mkdirSync(repository);
    initRepository(repository);
    mkdirSync(join(repository, 'src', 'deep'), { recursive: true });
    const expected = { root: join(repository, '.git', checkpointDirectoryName), worktree: repository, commonDir: join(repository, '.git') };
    assert.deepEqual(locateCheckpoint(repository), expected);
    assert.deepEqual(locateCheckpoint(join(repository, 'src', 'deep')), expected);
    assert.equal(existsSync(expected.root), false, 'locating creates nothing');
  });

  it('points a linked worktree at the same checkpoint as the main worktree', () => {
    const repository = join(sandbox, 'repo');
    mkdirSync(repository);
    initRepository(repository);
    const linked = join(sandbox, 'linked');
    git(repository, 'worktree', 'add', '-q', linked, '-b', 'feature');
    const main = locateCheckpoint(repository);
    const fromLinked = locateCheckpoint(linked);
    assert.equal(fromLinked.root, main.root);
    assert.equal(fromLinked.commonDir, main.commonDir);
    assert.equal(fromLinked.worktree, realpathSync.native(linked));
    assert.notEqual(fromLinked.worktree, main.worktree);
  });

  it('reports the long name when called through an 8.3 alias', (t) => {
    if (process.platform !== 'win32') return t.skip('8.3 aliases exist only on Windows');
    const repository = join(sandbox, 'a-name-long-enough-to-get-an-alias');
    mkdirSync(repository);
    initRepository(repository);
    const alias = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${repository}').ShortPath`],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
    if (alias === repository) return t.skip('8.3 name generation is disabled on this volume');
    assert.notEqual(realpathSync(alias), repository, 'the JavaScript realpath keeps the alias, which is why the locator must not use it');
    assert.deepEqual(locateCheckpoint(alias), locateCheckpoint(repository));
    assert.equal(locateCheckpoint(alias).worktree, repository);
  });

  it('refuses a directory outside any repository', () => {
    const outside = join(sandbox, 'plain');
    mkdirSync(outside);
    assert.throws(() => locateCheckpoint(outside), NotInRepositoryError);
  });

  it('refuses a bare repository, which has no worktree to review', () => {
    const bare = join(sandbox, 'bare.git');
    mkdirSync(bare);
    git(bare, 'init', '-q', '--bare');
    assert.throws(() => locateCheckpoint(bare), NotInRepositoryError);
  });

  it('refuses a directory that does not exist', () => {
    assert.throws(() => locateCheckpoint(join(sandbox, 'absent')), NotInRepositoryError);
  });
});
