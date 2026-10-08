import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.ts';

/**
 * Run git in a test repository and return its trimmed text output, without
 * the variables that would make it act on another repository (see git.ts).
 * Importing this module also deletes them from `process.env`.
 */
export { git };

export interface RepositoryOptions {
  /** core.autocrlf for the repository; false unless a test asks for a CRLF checkout, whatever the machine's global setting. */
  readonly autocrlf?: boolean;
}

/** A fresh repository on `main` with a deterministic identity and no commits. */
export function createRepository(directory: string, options: RepositoryOptions = {}): string {
  mkdirSync(directory, { recursive: true });
  git(directory, 'init', '-q', '-b', 'main');
  git(directory, 'config', 'user.name', 'Test');
  git(directory, 'config', 'user.email', 'test@example.invalid');
  git(directory, 'config', 'commit.gpgsign', 'false');
  git(directory, 'config', 'core.autocrlf', String(options.autocrlf ?? false));
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
