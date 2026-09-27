/**
 * Where a candidate points (R8, PD12 of the read-only review): a finder's
 * `file` is matched to one path of the scope, its `line` is checked against
 * the after state of that file, and a candidate that matches nothing keeps
 * its own spelling with `located: false`. No candidate is dropped here.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
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
 * Whether the repository holds an entry (a file, a directory or a link) at
 * a repo-relative path, compared without regard to case: a finder may
 * spell a path as a case-insensitive file system shows it, and a spelling
 * that differs only in case from an unchanged file still names that file
 * rather than a changed one.
 */
export type RepoLookup = (path: string) => boolean;

/**
 * A lookup over the worktree, reading each directory at most once. A
 * directory that does not exist, or a path that runs through a file, holds
 * nothing; any other failure to read a directory is thrown.
 */
export function worktreeLookup(worktree: string): RepoLookup {
  const listings = new Map<string, readonly string[]>();
  const list = (segments: readonly string[]): readonly string[] => {
    const key = segments.join('/');
    let names = listings.get(key);
    if (names === undefined) {
      try {
        names = readdirSync(join(worktree, ...segments));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
        names = [];
      }
      listings.set(key, names);
    }
    return names;
  };
  // Every spelling the directory holds is followed, since without regard to case a directory may hold two that match.
  const holds = (parent: readonly string[], rest: readonly string[]): boolean => {
    const [segment, ...below] = rest;
    if (segment === undefined) return true;
    return list(parent).some((name) => name.toLowerCase() === segment.toLowerCase() && holds([...parent, name], below));
  };
  return (path) => holds([], path.split('/'));
}

/**
 * The repo-relative paths a normalized file name could spell, longest
 * first: its tails, each starting at a segment, after any root (`/`, a
 * drive such as `C:`) and after the last `.` or `..` segment, which no
 * repo-relative path holds. `/repo/src/a.ts` gives `repo/src/a.ts`,
 * `src/a.ts` and `a.ts`.
 */
function relativeTails(name: string): string[] {
  const segments = name.split('/');
  let start = 0;
  segments.forEach((segment, index) => {
    if (segment === '' || segment === '.' || segment === '..' || (index === 0 && /^[A-Za-z]:$/.test(segment))) start = index + 1;
  });
  return segments.slice(start).map((_, offset) => segments.slice(start + offset).join('/'));
}

/** The one path of `paths` that `pick` selects exactly, else the one it selects without regard to case; null when there is none or more than one. */
function onlyPath(paths: readonly string[], pick: (path: string, fold: (text: string) => string) => boolean): string | null {
  for (const fold of [(text: string): string => text, (text: string): string => text.toLowerCase()]) {
    const picked = paths.filter((path) => pick(path, fold));
    if (picked.length > 1) return null;
    if (picked.length === 1) return picked[0]!;
  }
  return null;
}

/**
 * The one scope path the finder's file names, or null. The file's tails
 * are tried longest first (`lib/src/a.ts` beats `src/a.ts` for
 * `/repo/lib/src/a.ts`): a tail that is a scope path matches it, so an
 * absolute or otherwise prefixed spelling of a changed file is found. A
 * tail that is not a scope path but that `inRepo` finds is a different,
 * unchanged file of the repository, and the file matches nothing: its
 * shorter tails are spellings of other files, so `src/index.ts` is never
 * pinned to a changed root `index.ts`. Failing both, a file that is
 * itself the tail of exactly one scope path (`a.ts` for `src/a.ts`)
 * matches it. A scope path is compared exactly, then without regard to
 * case, since a finder may spell a path as its file system shows it
 * rather than as git does; a name that matches two scope paths without
 * regard to case matches neither.
 */
export function matchScopePath(scopePaths: readonly string[], file: string, inRepo: RepoLookup): string | null {
  const tails = relativeTails(normalizeFileName(file));
  const whole = tails[0];
  if (whole === undefined) return null;
  for (const tail of tails) {
    const candidates = scopePaths.filter((path) => path.toLowerCase() === tail.toLowerCase());
    if (candidates.length > 0) return onlyPath(candidates, (path, fold) => fold(path) === fold(tail));
    if (inRepo(tail)) return null;
  }
  return onlyPath(scopePaths, (path, fold) => fold(path).endsWith(`/${fold(whole)}`));
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
 * lines can be counted. The worktree also tells which unchanged files the
 * repository holds, so a path naming one is not taken for a changed path it
 * ends with. A candidate on a file the scope does not hold, on a deleted
 * file, or on a line past the file's end is unlocated.
 */
export function normalizeLocations<C extends { readonly file: string; readonly line: number }>(scope: ScopeState, worktree: string, candidates: readonly C[]): Location[] {
  const paths = scope.files.map((file) => file.path);
  const inRepo = worktreeLookup(worktree);
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
    const file = matchScopePath(paths, candidate.file, inRepo);
    if (file === null) return { file: null, line: null, located: false };
    const lines = linesOf(file);
    if (lines === null || candidate.line > lines) return { file: null, line: null, located: false };
    return { file, line: candidate.line, located: true };
  });
}
