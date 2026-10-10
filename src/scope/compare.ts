import type { FrozenFile, ScopeRequest, ScopeState } from '../checkpoint/events.ts';
import { sha256Hex } from '../evidence/store.ts';
import { readWorktree, resolveScopeRequest } from './capture.ts';
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

/** The most paths a reason names before it counts the rest. */
const namedPaths = 3;

/** Paths as a reason names them: the first few, and how many more. */
const pathList = (paths: readonly string[]): string => `${paths.slice(0, namedPaths).join(', ')}${paths.length > namedPaths ? `, and ${String(paths.length - namedPaths)} more` : ''}`;

/**
 * Whether a request names, in the repository as it is now, the change a
 * scope captured and left unchanged since (R2, PD3, TD4 of fix pass
 * continuation): null when it does, else the first reason it does not, as
 * one sentence, in this order. The request, resolved as the capture
 * resolves it (`resolveScopeRequest`), has another mode or base; it names
 * other paths, a file added since or one no longer changed; one of the
 * scope's files differs from what the scope froze, by `changedSince`,
 * which the caller gives so the files are compared as the run compares
 * them before every phase, as git would store them (R22 of the fix
 * pass); or `HEAD` moved from the scope's head. A request the tree
 * refutes throws what the capture would.
 */
export function scopeMatches(request: ScopeRequest, scope: ScopeState, worktree: string, changedSince: (scope: ScopeState) => readonly string[]): string | null {
  const resolved = resolveScopeRequest(worktree, request);
  if (resolved.mode !== scope.mode || resolved.base !== scope.base) return `its scope is ${scope.mode} ${scope.base}..${scope.head}, not the one named`;
  const captured = new Set(scope.files.map((file) => file.path));
  const named = new Set(resolved.changes.map((change) => change.path));
  const added = [...named].filter((path) => !captured.has(path));
  const gone = [...captured].filter((path) => !named.has(path));
  if (added.length > 0 || gone.length > 0) {
    const differences = [...(added.length === 0 ? [] : [`${pathList(added)} changed since and not in it`]), ...(gone.length === 0 ? [] : [`${pathList(gone)} in it and no longer changed`])];
    return `its files are not the change named: ${differences.join('; ')}`;
  }
  const changed = changedSince(scope);
  if (changed.length > 0) return `${String(changed.length)} of its files changed since: ${pathList(changed)}`;
  if (resolved.guard.head !== scope.head) return `HEAD is ${resolved.guard.head}, not ${scope.head}`;
  return null;
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
