/**
 * Where a candidate points (R8, PD12 of the read-only review): a finder's
 * `file` is matched to one path of the scope, its `line` is checked against
 * the after state of that file, and a candidate that matches nothing keeps
 * its own spelling with `located: false`. No candidate is dropped here.
 */
import type { ScopeState } from '../checkpoint/events.ts';
import { readWorktree } from '../scope/capture.ts';

export interface Location {
  /** The scope path, or null when unlocated. */
  readonly file: string | null;
  /** The line, at most the after state's line count, or null when unlocated. */
  readonly line: number | null;
  readonly located: boolean;
}

/** The file's name with backslashes as slashes, no `./` at the start and no run of slashes, as a scope path is spelled. */
export function normalizeFileName(file: string): string {
  return file.replaceAll('\\', '/').replaceAll(/\/{2,}/g, '/').replace(/^(\.\/)+/, '');
}

/**
 * The one scope path the finder's file names, or null. A scope path matches
 * when it is the file, or the file ends with it after a slash (the finder
 * gave an absolute or otherwise prefixed path), and the longest such path
 * wins, so `lib/src/a.ts` beats `src/a.ts` for `/repo/lib/src/a.ts`.
 * Failing that, a file that is itself the tail of exactly one scope path
 * (`a.ts` for `src/a.ts`) matches it. Each rule is tried exactly, then
 * without regard to case, since a finder may spell a path as its file
 * system shows it rather than as git does.
 */
export function matchScopePath(scopePaths: readonly string[], file: string): string | null {
  const wanted = normalizeFileName(file);
  if (wanted.length === 0) return null;
  for (const fold of [(text: string): string => text, (text: string): string => text.toLowerCase()]) {
    const target = fold(wanted);
    const suffixes = scopePaths.filter((path) => target === fold(path) || target.endsWith(`/${fold(path)}`));
    if (suffixes.length > 0) return suffixes.reduce((longest, path) => (path.length > longest.length ? path : longest));
    const tails = scopePaths.filter((path) => fold(path).endsWith(`/${target}`));
    if (tails.length === 1) return tails[0]!;
  }
  return null;
}

/** How many lines `bytes` hold: one per line feed, plus one for a last line without one. */
export function countLines(bytes: Uint8Array): number {
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines += 1;
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) lines += 1;
  return lines;
}

/**
 * Normalize every candidate's location against the scope, counting a file's
 * lines from the worktree, which the drift check has just confirmed equals
 * the frozen after state and which is the one place an oversized file's
 * lines can be counted. A candidate on a file the scope does not hold, on a
 * deleted file, or on a line past the file's end is unlocated.
 */
export function normalizeLocations<C extends { readonly file: string; readonly line: number }>(scope: ScopeState, worktree: string, candidates: readonly C[]): Location[] {
  const paths = scope.files.map((file) => file.path);
  const lineCounts = new Map<string, number | null>();
  const linesOf = (path: string): number | null => {
    let count = lineCounts.get(path);
    if (count === undefined) {
      const file = scope.files.find((candidate) => candidate.path === path)!;
      const entry = file.after === null ? null : readWorktree(worktree, path);
      count = entry === null ? null : countLines(entry.bytes);
      lineCounts.set(path, count);
    }
    return count;
  };
  return candidates.map((candidate) => {
    const file = matchScopePath(paths, candidate.file);
    if (file === null) return { file: null, line: null, located: false };
    const lines = linesOf(file);
    if (lines === null || candidate.line > lines) return { file: null, line: null, located: false };
    return { file, line: candidate.line, located: true };
  });
}
