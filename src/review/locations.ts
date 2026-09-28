/**
 * Where a candidate points (R8, PD12 of the read-only review): a finder's
 * `file` is matched to one canonical path of the repository, a changed path
 * of the scope or the worktree's own spelling of an unchanged file, and its
 * `line` is checked against that file: a changed file's after state, or an
 * unchanged file's bytes in the worktree. A candidate whose file names no
 * single file of the repository, or whose line lies past that file's end,
 * keeps its own spelling with `located: false`. No candidate is dropped here.
 */
import { closeSync, lstatSync, openSync, readdirSync, readlinkSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { ScopeState } from '../checkpoint/events.ts';

/** Where a candidate points: a checked file and line, in the change or outside it, or nowhere the repository holds. */
export type Location =
  | {
      /** The canonical repository path: the scope path of a changed file, or the worktree's spelling of an unchanged one. */
      readonly file: string;
      /** The line, at most the file's line count. */
      readonly line: number;
      readonly located: true;
      /** Whether `file` is a changed path of the scope. */
      readonly inScope: boolean;
    }
  | { readonly file: null; readonly line: null; readonly located: false; readonly inScope: false };

const unlocated: Location = { file: null, line: null, located: false, inScope: false };

/** The canonical path a finder's file was matched to, and whether it is a changed path of the scope. */
export interface PathMatch {
  readonly path: string;
  readonly inScope: boolean;
}

/** The file's name with backslashes as slashes, no `./` at the start and no run of slashes, as a scope path is spelled. */
export function normalizeFileName(file: string): string {
  return file.replaceAll('\\', '/').replaceAll(/\/{2,}/g, '/').replace(/^(\.\/)+/, '');
}

/**
 * Every spelling under which the repository holds an entry (a file, a
 * directory or a link) at a repo-relative path, compared without regard to
 * case: a finder may spell a path as a case-insensitive file system shows
 * it. Empty when the repository holds nothing there; more than one when a
 * case-sensitive file system holds entries that differ only in case.
 */
export type RepoLookup = (path: string) => readonly string[];

/**
 * A lookup over the worktree, reading each directory at most once, that
 * gives each entry in the worktree's own spelling. A directory that does
 * not exist, or a path that runs through a file, holds nothing; any other
 * failure to read a directory is thrown.
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
  const spellings = (parent: readonly string[], rest: readonly string[]): string[] => {
    const [segment, ...below] = rest;
    if (segment === undefined) return [parent.join('/')];
    return list(parent)
      .filter((name) => name.toLowerCase() === segment.toLowerCase())
      .flatMap((name) => spellings([...parent, name], below));
  };
  return (path) => spellings([], path.split('/'));
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
 * The one canonical repository path the finder's file names, or null. The
 * file's tails are tried longest first (`lib/src/a.ts` beats `src/a.ts` for
 * `/repo/lib/src/a.ts`), so an absolute or otherwise prefixed spelling is
 * found. A tail that is a scope path matches that changed path. A tail that
 * is not a scope path but that `inRepo` finds is an unchanged entry of the
 * repository and matches it, in the worktree's own spelling and out of
 * scope; its shorter tails are spellings of other files, so `src/index.ts`
 * is never pinned to a changed root `index.ts`. Failing both, a file that
 * is itself the tail of exactly one scope path (`a.ts` for `src/a.ts`)
 * matches it. A path is compared exactly, then without regard to case,
 * since a finder may spell a path as its file system shows it rather than
 * as git does; a name that matches two paths without regard to case, and
 * neither exactly, matches nothing, and no shorter tail is tried.
 */
export function matchRepositoryPath(scopePaths: readonly string[], file: string, inRepo: RepoLookup): PathMatch | null {
  const tails = relativeTails(normalizeFileName(file));
  const whole = tails[0];
  if (whole === undefined) return null;
  const sameTail = (tail: string) => (path: string, fold: (text: string) => string): boolean => fold(path) === fold(tail);
  for (const tail of tails) {
    // A changed path is tried before the worktree, which on a case-insensitive file system may spell the same file differently.
    const changed = scopePaths.filter((path) => path.toLowerCase() === tail.toLowerCase());
    if (changed.length > 0) {
      const path = onlyPath(changed, sameTail(tail));
      return path === null ? null : { path, inScope: true };
    }
    const held = [...new Set(inRepo(tail))];
    if (held.length > 0) {
      const path = onlyPath(held, sameTail(tail));
      return path === null ? null : { path, inScope: false };
    }
  }
  const path = onlyPath(scopePaths, (candidate, fold) => fold(candidate).endsWith(`/${fold(whole)}`));
  return path === null ? null : { path, inScope: true };
}

/** How many lines `bytes` hold: one per line feed, plus one for a last line without one. */
export function countLines(bytes: Uint8Array): number {
  return countLinesOf([bytes]);
}

/** How many lines the concatenation of `chunks` holds, counted as `countLines` counts them. */
function countLinesOf(chunks: Iterable<Uint8Array>): number {
  let lines = 0;
  let last: number | undefined;
  for (const chunk of chunks) {
    for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, at + 1)) lines += 1;
    if (chunk.length > 0) last = chunk[chunk.length - 1];
  }
  if (last !== undefined && last !== 0x0a) lines += 1;
  return lines;
}

/** A file's bytes, read in chunks so a file of any size is counted without holding it whole. */
function* fileChunks(path: string): Generator<Uint8Array> {
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (let read = readSync(descriptor, buffer); read > 0; read = readSync(descriptor, buffer)) yield buffer.subarray(0, read);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * How many lines the worktree's entry at a repo-relative path holds: a
 * file's lines, or a link's target read as text, as the scope freezes a
 * link. Null when the worktree holds no file or link there, such as for a
 * directory, which no line can point into.
 */
function worktreeLines(worktree: string, path: string): number | null {
  const absolute = join(worktree, ...path.split('/'));
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (stat === undefined) return null;
  if (stat.isSymbolicLink()) return countLines(Buffer.from(readlinkSync(absolute)));
  if (stat.isFile()) return countLinesOf(fileChunks(absolute));
  return null;
}

/**
 * Normalize every candidate's location against the scope and the worktree,
 * counting a file's lines from the worktree. For a changed file the
 * controller's drift check, run just before it records an answer, has
 * confirmed the worktree equals the frozen after state, and the worktree is
 * the one place an oversized file's lines can be counted; an unchanged file
 * is read as the worktree holds it, since the scope froze nothing of it. A
 * candidate on no file the repository holds, on a file the change deletes,
 * or on a line past the file's end is unlocated.
 */
export function normalizeLocations<C extends { readonly file: string; readonly line: number }>(scope: ScopeState, worktree: string, candidates: readonly C[]): Location[] {
  const paths = scope.files.map((file) => file.path);
  const inRepo = worktreeLookup(worktree);
  const lineCounts = new Map<string, number | null>();
  const linesOf = (match: PathMatch): number | null => {
    let count = lineCounts.get(match.path);
    if (count === undefined) {
      const deleted = match.inScope && scope.files.find((file) => file.path === match.path)!.after === null;
      count = deleted ? null : worktreeLines(worktree, match.path);
      lineCounts.set(match.path, count);
    }
    return count;
  };
  return candidates.map((candidate): Location => {
    const match = matchRepositoryPath(paths, candidate.file, inRepo);
    if (match === null) return unlocated;
    const lines = linesOf(match);
    if (lines === null || candidate.line > lines) return unlocated;
    return { file: match.path, line: candidate.line, located: true, inScope: match.inScope };
  });
}
