/**
 * A fixer's snapshot of the tree after one finding (R6, R23, PD14, PD21,
 * TD14, TD20 of the fix pass): `deep-review snapshot --finding <n> --into
 * <dir>`, run by the fixer, copies every path that changed since the
 * worker was launched, and every path the run expects, into `<dir>/<n>/`,
 * and writes `<dir>/<n>.json`, the listing with each path's hash and size
 * or `absent`. What changed it learns from `<dir>/manifest.json`, which
 * the engine writes at launch with every file git does not ignore and its
 * size and time, and the directories git ignores: the command starts no
 * process, since in Codex's unelevated Windows sandbox a Node process
 * cannot start one whose output it captures, as asking git does. The
 * engine reads the snapshots when it records the answer and
 * freezes what it needs; the directory is the fixer's scratch, never
 * evidence and never inside the reviewed tree.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { isInside } from '../paths.ts';
import * as gitApi from '../scope/git.ts';
import { InvalidScopeRequestError } from '../scope/errors.ts';
import { validateScopePath } from '../scope/capture.ts';
import { readTreeEntry, type TreeEntry, type TreeReader } from './tree.ts';

/** The file under the snapshot directory in which the engine describes the tree at launch for every snapshot to compare with. */
export const snapshotManifestFileName = 'manifest.json';

/** The directory under a fixer's scratch its snapshots go to. */
export const snapshotsDirectoryName = 'snapshots';

const listedFileSchema = z.union([
  z.literal('absent'),
  z.strictObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative(), symlink: z.boolean() }),
]);

/** A snapshot's listing: every path it looked at, with what it found there. */
export const snapshotListingSchema = z.strictObject({
  finding: z.number().int().nonnegative(),
  paths: z.record(z.string(), listedFileSchema),
});
export type SnapshotListing = z.infer<typeof snapshotListingSchema>;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A path a snapshot may copy: relative to the repository, inside it, never the git directory, so a copy never lands outside `<dir>/<n>/`. */
function safePath(path: string): boolean {
  try {
    validateScopePath(path);
    return !path.includes('\\') && !path.split('/').some((part) => part === '' || part === '.');
  } catch (error) {
    if (error instanceof InvalidScopeRequestError) return false;
    throw error;
  }
}

/** A file's size and modification time as the manifest records them, or null where there is no file or symlink. */
const fileStatSchema = z.tuple([z.number().int().nonnegative(), z.number()]).nullable();

/**
 * The tree as the engine saw it when it launched the worker: the worktree,
 * the paths the run expects, every file git does not ignore with its size
 * and time, and what git ignores, a directory with a trailing slash.
 */
export const snapshotManifestSchema = z.strictObject({
  worktree: z.string().min(1),
  expected: z.array(z.string()),
  files: z.record(z.string(), fileStatSchema),
  ignored: z.array(z.string()),
});
export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;

/** The manifest the engine wrote under a snapshot directory, or null when it wrote none; one that is not a manifest is an error. */
export function readManifest(into: string): SnapshotManifest | null {
  const file = join(into, snapshotManifestFileName);
  if (!existsSync(file)) return null;
  const parsed = snapshotManifestSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`${file} is not a snapshot manifest: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** A path's size and time from `lstat`, or null for no entry, a directory, or a path through a file. */
export function statOf(worktree: string, path: string): [number, number] | null {
  let stat;
  try {
    stat = lstatSync(join(worktree, ...path.split('/')), { throwIfNoEntry: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw error;
  }
  return stat !== undefined && (stat.isFile() || stat.isSymbolicLink()) ? [stat.size, stat.mtimeMs] : null;
}

/** Each path a snapshot may copy among `paths`, with its size and time, as a manifest records them. */
function statMapOf(worktree: string, paths: readonly string[]): SnapshotManifest['files'] {
  return Object.fromEntries(paths.filter(safePath).map((path) => [path, statOf(worktree, path)]));
}

/**
 * The paths that changed since the manifest was taken: a file it lists
 * whose size or time differs, or that is gone; and a file it does not
 * list, found by walking the worktree past `.git` and everything git
 * ignored then. Reads the file system only.
 */
function changedSince(manifest: SnapshotManifest): string[] {
  const ignoredDirectories = new Set(manifest.ignored.filter((entry) => entry.endsWith('/')).map((entry) => entry.slice(0, -1)));
  const ignoredFiles = new Set(manifest.ignored.filter((entry) => !entry.endsWith('/')));
  const changed: string[] = [];
  const found = new Set<string>();
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(manifest.worktree, ...relative.split('/').filter((part) => part !== '')), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.name === '.git') continue;
      // A symlink, to a directory or not, is an entry of its own and is never followed.
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (!ignoredDirectories.has(path)) walk(path);
        continue;
      }
      if (ignoredFiles.has(path) || !(entry.isFile() || entry.isSymbolicLink())) continue;
      found.add(path);
      const before = manifest.files[path];
      const now = statOf(manifest.worktree, path);
      if (before === undefined || before === null || now === null || before[0] !== now[0] || before[1] !== now[1]) changed.push(path);
    }
  };
  walk('');
  for (const [path, before] of Object.entries(manifest.files)) if (before !== null && !found.has(path)) changed.push(path);
  return changed;
}

export interface SnapshotRequest {
  /** The root of the worktree the fixer edits; the manifest's, when there is one. */
  readonly worktree: string;
  readonly finding: number;
  /** The snapshot directory; it must not be inside the worktree. */
  readonly into: string;
}

/**
 * Take the snapshot of one finding, replacing one taken before for the
 * same index. The listing is written last, under a temporary name and
 * renamed, so a listing that exists names a complete copy.
 */
export function takeSnapshot(request: SnapshotRequest): SnapshotListing {
  if (isInside(request.worktree, request.into)) throw new InvalidScopeRequestError(`The snapshot directory ${request.into} is inside the worktree ${request.worktree}; a snapshot there would be a stray file of the review`);
  const copies = join(request.into, String(request.finding));
  const listingFile = join(request.into, `${String(request.finding)}.json`);
  rmSync(listingFile, { force: true });
  rmSync(copies, { recursive: true, force: true });
  mkdirSync(copies, { recursive: true });
  // What changed since the worker's launch, read from the file system against the engine's manifest; without one, only nothing.
  const manifest = readManifest(request.into);
  const paths = [...new Set([...(manifest === null ? [] : changedSince(manifest)), ...(manifest?.expected ?? [])])].filter(safePath).sort();
  const listed = paths.map((path): [string, SnapshotListing['paths'][string]] => {
    const entry = readTreeEntry(request.worktree, path);
    if (entry === null) return [path, 'absent'];
    const copy = join(copies, ...path.split('/'));
    mkdirSync(dirname(copy), { recursive: true });
    // A symlink is copied as its target text, as the scope freezes it.
    writeFileSync(copy, entry.bytes);
    return [path, { sha256: sha256(entry.bytes), size: entry.bytes.length, symlink: entry.symlink }];
  });
  // fromEntries defines each path as an own property, so no path name can reach the object's prototype.
  const listing: SnapshotListing = { finding: request.finding, paths: Object.fromEntries(listed) };
  const temporary = `${listingFile}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(listing)}\n`);
  renameSync(temporary, listingFile);
  return listing;
}

/**
 * The snapshot of one finding as a tree reader, or null when the fixer
 * took none (or left a listing that is not one). A path the listing names
 * absent reads as absent; one it names reads as the copy, provided the
 * copy still has the listed hash and size; any other path, or a copy that
 * changed since, reads as unknown, for a later snapshot or the worktree
 * to answer.
 */
export function readSnapshot(into: string, finding: number): TreeReader | null {
  const listing = readListing(into, finding);
  if (listing === null) return null;
  return (path): TreeEntry | null | undefined => {
    if (!Object.hasOwn(listing.paths, path) || !safePath(path)) return undefined;
    const listed = listing.paths[path]!;
    if (listed === 'absent') return null;
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(into, String(finding), ...path.split('/')));
    } catch {
      return undefined;
    }
    return bytes.length === listed.size && sha256(bytes) === listed.sha256 ? { bytes, symlink: listed.symlink } : undefined;
  };
}

/** One finding's snapshot listing, or null when the fixer took none or left one that is not a listing of that finding. */
function readListing(into: string, finding: number): SnapshotListing | null {
  const listingFile = join(into, `${String(finding)}.json`);
  if (!existsSync(listingFile)) return null;
  try {
    const parsed = snapshotListingSchema.safeParse(JSON.parse(readFileSync(listingFile, 'utf8')));
    return parsed.success && parsed.data.finding === finding ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Every path the snapshots of findings 0 to `count - 1` under `into` listed, sorted, each a path a snapshot may name; none when the directory holds no listing. */
export function snapshotPaths(into: string, count: number): string[] {
  const paths = new Set<string>();
  for (let finding = 0; finding < count; finding += 1) {
    for (const path of Object.keys(readListing(into, finding)?.paths ?? {})) if (safePath(path)) paths.add(path);
  }
  return [...paths].sort();
}

/** Write a manifest into a directory, creating it. */
export function writeManifest(into: string, manifest: SnapshotManifest): void {
  mkdirSync(into, { recursive: true });
  writeFileSync(join(into, snapshotManifestFileName), `${JSON.stringify(manifest)}\n`);
}

/**
 * The tracked files whose size or time differ from the manifest's, or
 * that are gone, sorted: what changed since it was taken among the files
 * it lists, and nothing it does not list, so a file new since is not one
 * (PD9 of commit series integrity). Reads the file system only.
 */
export function changedListed(manifest: SnapshotManifest): string[] {
  return Object.entries(manifest.files)
    .filter(([path, before]) => {
      const now = statOf(manifest.worktree, path);
      return before === null ? now !== null : now === null || before[0] !== now[0] || before[1] !== now[1];
    })
    .map(([path]) => path)
    .sort();
}

/**
 * Write the manifest a check that may write the tree is compared with
 * after it runs (PD9 of commit series integrity): every tracked file with
 * its size and time, taken just before the check, into `into`, never the
 * worktree; and return it.
 */
export function prepareCheckManifest(into: string, worktree: string): SnapshotManifest {
  const manifest: SnapshotManifest = { worktree, expected: [], files: statMapOf(worktree, gitApi.trackedFiles(worktree)), ignored: [] };
  writeManifest(into, manifest);
  return manifest;
}

/**
 * Write the manifest every snapshot under `into` compares with, from
 * outside the worker's sandbox (TD20): the worktree, the paths the run
 * expects, so one changed and changed back is still compared, every file
 * git does not ignore with its size and time, and what git ignores.
 */
export function prepareSnapshots(into: string, worktree: string, expected: Iterable<string>): void {
  writeManifest(into, { worktree, expected: [...new Set(expected)].sort(), files: statMapOf(worktree, gitApi.filesNotIgnored(worktree)), ignored: gitApi.ignoredEntries(worktree) });
}
