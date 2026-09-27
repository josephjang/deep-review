/**
 * The rules files that govern a change (R12, PD11, TD11 of the read-only
 * review): the user-level `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`,
 * and `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md` at the repository root
 * and in every ancestor directory of a changed file. The engine lists the
 * ones that exist; the `CONVENTIONS` worker verifies the list itself.
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';

/** The rules files a directory may hold, in the order they are listed. */
export const conventionFileNames = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md'] as const;

/** The user-level rules files, relative to the home directory. */
export const userConventionFiles = ['.claude/CLAUDE.md', '.codex/AGENTS.md'] as const;

export interface ConventionFile {
  /** `user` for a file under the home directory, `repository` for one under the worktree. */
  readonly level: 'user' | 'repository';
  /** Absolute for a user file; repository-relative with forward slashes for a repository file, as a worker's working directory is the worktree. */
  readonly path: string;
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Every directory from the repository root down to each changed file's own, repository-relative, root first as ``, sorted and without repeats. */
export function ancestorDirectories(changedPaths: readonly string[]): string[] {
  const directories = new Set<string>(['']);
  for (const path of changedPaths) {
    const parts = path.split('/').slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth += 1) directories.add(parts.slice(0, depth).join('/'));
  }
  return [...directories].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The rules files that exist among the user-level ones and those in the
 * root and every ancestor directory of a changed path, user level first,
 * then by depth and path.
 */
export function conventionFiles(worktree: string, changedPaths: readonly string[], home: string = homedir()): ConventionFile[] {
  const found: ConventionFile[] = [];
  for (const relative of userConventionFiles) {
    const absolute = join(home, ...relative.split('/'));
    if (isFile(absolute)) found.push({ level: 'user', path: absolute });
  }
  for (const directory of ancestorDirectories(changedPaths)) {
    for (const name of conventionFileNames) {
      const relative = directory === '' ? name : posix.join(directory, name);
      if (isFile(join(worktree, ...relative.split('/')))) found.push({ level: 'repository', path: relative });
    }
  }
  return found;
}
