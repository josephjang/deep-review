/**
 * A fixer's snapshot of the tree after one finding (R6, PD14, TD14 of the
 * fix pass): `deep-review snapshot --finding <n> --into <dir>`, run by the
 * fixer from the worktree, copies every path git reports changed, and
 * every path the engine listed in `<dir>/paths.json` (the paths the run
 * expects), into `<dir>/<n>/`, and writes `<dir>/<n>.json`, the listing
 * with each path's hash and size or `absent`. The engine reads it when it
 * records the answer and freezes what it needs; the directory is the
 * fixer's scratch, never evidence and never inside the reviewed tree.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { isInside } from '../paths.ts';
import * as gitApi from '../scope/git.ts';
import { InvalidScopeRequestError } from '../scope/errors.ts';
import { validateScopePath } from '../scope/capture.ts';
import { readTreeEntry, type TreeEntry, type TreeReader } from './tree.ts';

/** The file under the snapshot directory in which the engine lists the paths every snapshot copies besides git's changes. */
export const snapshotPathsFileName = 'paths.json';

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

/** The paths the engine asked every snapshot of this directory to copy, or none when it listed none. */
function listedPaths(into: string): string[] {
  const file = join(into, snapshotPathsFileName);
  if (!existsSync(file)) return [];
  const parsed = z.array(z.string()).safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`${file} is not a list of paths`);
  return parsed.data;
}

export interface SnapshotRequest {
  /** The root of the worktree the fixer edits. */
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
  const changed = gitApi.status(request.worktree).map((entry) => entry.path);
  const paths = [...new Set([...changed, ...listedPaths(request.into)])].filter(safePath).sort();
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
  const listingFile = join(into, `${String(finding)}.json`);
  if (!existsSync(listingFile)) return null;
  let listing: SnapshotListing;
  try {
    const parsed = snapshotListingSchema.safeParse(JSON.parse(readFileSync(listingFile, 'utf8')));
    if (!parsed.success || parsed.data.finding !== finding) return null;
    listing = parsed.data;
  } catch {
    return null;
  }
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

/** Write the paths every snapshot under `into` copies besides git's changes: the paths the run expects, so one changed and changed back is still compared. */
export function prepareSnapshots(into: string, paths: Iterable<string>): void {
  mkdirSync(into, { recursive: true });
  writeFileSync(join(into, snapshotPathsFileName), `${JSON.stringify([...new Set(paths)].sort())}\n`);
}
