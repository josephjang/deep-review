import type { FrozenFile, ScopeState } from '../checkpoint/events.ts';
import { sha256Hex } from '../evidence/store.ts';
import { readWorktree } from './capture.ts';
import * as gitApi from './git.ts';

/** How one scope file in the worktree relates to its frozen after state. */
export type FileOutcome = 'unchanged' | 'modified' | 'deleted' | 'restored';

export interface WorktreeComparison {
  readonly files: readonly { readonly path: string; readonly outcome: FileOutcome }[];
  /** Paths git reports as changed or untracked that the scope does not cover. */
  readonly outside: readonly string[];
}

/**
 * Compare each scope file in the worktree with its frozen after state, in
 * scope order. Reads only the scope's files and runs no git command, so it
 * is cheap enough to run before every answer is recorded.
 */
export function compareScopeFiles(scope: ScopeState, worktree: string): WorktreeComparison['files'] {
  return scope.files.map((file) => {
    const now = readWorktree(worktree, file.path);
    if (file.after === null) return { path: file.path, outcome: now === null ? ('unchanged' as const) : ('restored' as const) };
    if (now === null) return { path: file.path, outcome: 'deleted' as const };
    return { path: file.path, outcome: matchesFrozen(file.after, now.bytes, now.symlink, file.symlink) ? ('unchanged' as const) : ('modified' as const) };
  });
}

/**
 * Compare the worktree with a captured scope, file by file, and name the
 * changed or untracked paths git reports outside it. Reports only: whether
 * a difference matters is the caller's decision (D9).
 */
export function compareWorktree(scope: ScopeState, worktree: string): WorktreeComparison {
  const files = compareScopeFiles(scope, worktree);
  const covered = new Set(scope.files.map((file) => file.path));
  const outside = gitApi
    .status(worktree)
    .map((entry) => entry.path)
    .filter((path) => !covered.has(path))
    .sort();
  return { files, outside };
}

/**
 * Whether bytes read at a path are the frozen state: the same kind of
 * entry (a symlink's target text is never a file's bytes) and the same
 * size and hash, for a blob and an oversized file alike. Shared with the
 * fix pass's expected tree, which compares revised files the same way.
 */
export function matchesFrozen(frozen: FrozenFile, bytes: Buffer, symlink: boolean, frozenSymlink: boolean): boolean {
  if (symlink !== frozenSymlink) return false;
  if ('blob' in frozen) return frozen.blob.bytes === bytes.length && frozen.blob.sha256 === sha256Hex(bytes);
  return frozen.oversized.size === bytes.length && frozen.oversized.sha256 === sha256Hex(bytes);
}
