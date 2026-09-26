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
 * Compare the worktree with a captured scope, file by file. Reports only:
 * whether a difference matters is the caller's decision (D9).
 */
export function compareWorktree(scope: ScopeState, worktree: string): WorktreeComparison {
  const files = scope.files.map((file) => {
    const now = readWorktree(worktree, file.path);
    if (file.after === null) return { path: file.path, outcome: now === null ? ('unchanged' as const) : ('restored' as const) };
    if (now === null) return { path: file.path, outcome: 'deleted' as const };
    return { path: file.path, outcome: matchesFrozen(file.after, now.bytes, now.symlink, file.symlink) ? ('unchanged' as const) : ('modified' as const) };
  });
  const covered = new Set(scope.files.map((file) => file.path));
  const outside = gitApi
    .status(worktree)
    .map((entry) => entry.path)
    .filter((path) => !covered.has(path))
    .sort();
  return { files, outside };
}

function matchesFrozen(frozen: FrozenFile, bytes: Buffer, symlink: boolean, frozenSymlink: boolean): boolean {
  if (symlink !== frozenSymlink) return false;
  if ('blob' in frozen) return frozen.blob.bytes === bytes.length && frozen.blob.sha256 === sha256Hex(bytes);
  return frozen.oversized.size === bytes.length && frozen.oversized.sha256 === sha256Hex(bytes);
}
