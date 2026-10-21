import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { git } from './git.ts';

/**
 * Run git in a test repository and return its trimmed text output, without
 * the variables that would make it act on another repository (see git.ts).
 * Importing this module also deletes them from `process.env`.
 */
export { git };

/** A new temporary directory named from `prefix`, by its real path, removed when the test `t` ends. */
export function temporaryDirectory(t: TestContext, prefix: string): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => {
    // A process the real runner killed may hold a file a moment after it is gone, which Windows refuses to remove until it lets go.
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return directory;
}

export interface RepositoryOptions {
  /** core.autocrlf for the repository; false unless a test asks for a CRLF checkout, whatever the machine's global setting. */
  readonly autocrlf?: boolean;
}

/**
 * The settings of every test repository, as lines of a git config file:
 * the deterministic identity, no signing, the line endings the test asks
 * for, and no automatic maintenance.
 */
const repositorySettings = (options: RepositoryOptions): string =>
  [
    '[user]',
    '\tname = Test',
    '\temail = test@example.invalid',
    '[commit]',
    '\tgpgsign = false',
    '[core]',
    `\tautocrlf = ${String(options.autocrlf ?? false)}`,
    '[maintenance]',
    '\tauto = false',
    '[gc]',
    '\tauto = 0',
    '',
  ].join('\n');

/**
 * A fresh repository on `main` with a deterministic identity and no
 * commits. Git's automatic maintenance is off: a commit would otherwise
 * start it detached, and its lock under `.git/objects` would come and go
 * while a test compares the repository's files. The settings are appended
 * to the config file `git init` wrote, in one write rather than a git call
 * per setting, since the suite makes hundreds of repositories and each git
 * start is costly on Windows; git reads a section that appears twice, such
 * as `[core]`, as one. `git init` copies no template, so a machine's
 * init.templateDir puts no config of its own there, and each setting has
 * exactly one value, which a test's `git config <key> <value>` can replace.
 * The `info` and `hooks` directories a template would bring are made here,
 * for a test that writes `.git/info/exclude` or a hook.
 */
export function createRepository(directory: string, options: RepositoryOptions = {}): string {
  mkdirSync(directory, { recursive: true });
  git(directory, 'init', '-q', '-b', 'main', '--template=');
  mkdirSync(join(directory, '.git', 'info'), { recursive: true });
  mkdirSync(join(directory, '.git', 'hooks'), { recursive: true });
  appendFileSync(join(directory, '.git', 'config'), repositorySettings(options));
  return realpathSync.native(directory);
}

/** Write a file (bytes exactly as given) at a forward-slash path, creating directories. */
export function write(repo: string, path: string, content: Buffer | string): void {
  const absolute = join(repo, ...path.split('/'));
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
}

export function remove(repo: string, path: string): void {
  rmSync(join(repo, ...path.split('/')), { recursive: true, force: true });
}

/** Create a symlink at `path` pointing at `target`; returns false where the platform forbids it. */
export function link(repo: string, path: string, target: string): boolean {
  try {
    symlinkSync(target, join(repo, ...path.split('/')));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
}

/** Stage everything and commit; returns the commit id. */
export function commitAll(repo: string, message: string): string {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/** A repository with one commit holding the given files. */
export function repositoryWith(directory: string, files: Record<string, Buffer | string>, options: RepositoryOptions = {}): string {
  const repo = createRepository(directory, options);
  for (const [path, content] of Object.entries(files)) write(repo, path, content);
  commitAll(repo, 'initial');
  return repo;
}
