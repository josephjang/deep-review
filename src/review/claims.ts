/**
 * A fixer's claims on the files no cluster owns (R1, R2, R3, R12 of commit
 * series integrity): `deep-review claim --path <path> --unit <key> --in
 * <dir>`, run by a fixer before its first edit of such a file, claims it for
 * the fixer's cluster by creating one marker file exclusively under the
 * round's claims directory. The engine prepares the directory at every
 * editing launch of the fixes phase and again once each of its units
 * settles: `held.json` says which cluster owns
 * which file, which batch belongs to which cluster, which clusters have
 * settled and whether the worktree's file system folds case, and the claims
 * the ledger holds are seeded back as markers when the directory lost them.
 *
 * A marker is `<sha256 of the path>.<n>.json`, holding `{ path, cluster,
 * unit, claimedAt }`; the path is hashed as the file system compares it,
 * folded by `pathKey` when it folds case, so two spellings of one file
 * meet one name. Generation `n` counts from 1, the highest is the path's holder, and
 * a holder `held.json` lists as settled holds nothing any more, so the next
 * claim creates `n + 1`. Exclusive creation is the whole lock: two claims of
 * one path in one instant aim at one name, and one of them is refused. The
 * command reads no ledger and starts no process, so it runs under every
 * sandbox the snapshot command runs under; the engine never deletes a
 * marker. A marker still not whole `tornMarkerAfterMs` after it was last
 * written is torn, its claimant killed before it wrote, and holds nothing.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { createFileExclusive, writeFileAtomic } from '../atomic-write.ts';
import { EngineError } from '../errors.ts';
import { canonicalPath, isInside } from '../paths.ts';
import { validateScopePath } from '../scope/capture.ts';
import { InvalidScopeRequestError } from '../scope/errors.ts';

/** The directory under a checkpoint's scratch that holds every run's claims directories. */
export const claimsDirectoryName = 'claims';

/** The file in a claims directory in which the engine describes the round for the command. */
export const heldFileName = 'held.json';

/** The claims directory of one round of one run: beside the workers' scratch directories, outside the worktree and the checkpoint. */
export function claimsDirectoryFor(scratchBase: string, runId: string, round: 1 | 2): string {
  return join(scratchBase, claimsDirectoryName, runId, `round-${String(round)}`);
}

/** The claims directory the engine prepared is gone: claims made since are lost with it, and the run must not go on editing under it (R12). */
export class ClaimsDirectoryLostError extends EngineError {
  override readonly name = 'ClaimsDirectoryLostError';
  readonly directory: string;
  constructor(directory: string) {
    super(`the claims directory ${directory} is gone: stop editing and answer`);
    this.directory = directory;
  }
}

/** A claim the command cannot weigh: a unit the round does not have, or a claims directory that is not one. */
export class ClaimRequestError extends EngineError {
  override readonly name = 'ClaimRequestError';
}

/**
 * The round as the engine describes it at a launch or a settle: the worktree, each
 * cluster's owned files as the plan spells them, the cluster of each batch,
 * the clusters whose every batch has settled, and whether the worktree's
 * file system folds case.
 */
export const heldSchema = z.strictObject({
  worktree: z.string().min(1),
  clusters: z.record(z.string(), z.array(z.string())),
  units: z.record(z.string(), z.string()),
  settled: z.array(z.string()),
  caseInsensitive: z.boolean(),
});
export type Held = z.infer<typeof heldSchema>;

/** The longest path a marker records, the ledger's cap for a claimed path; the command refuses a longer one rather than make a marker never whole. */
const claimedPathMax = 1000;

/**
 * One claim as its marker records it: the path as the fixer spelled it,
 * once normalized, the claiming cluster and batch, and when it was made;
 * null for a late claim the ledger recorded at an answer, which the engine
 * seeds back when it prepares the directory.
 */
export const markerSchema = z.strictObject({
  // The caps are the ledger's for a claim the engine records or leaves out, so a marker past them is no claim.
  path: z.string().min(1).max(claimedPathMax),
  cluster: z.string().min(1).max(200),
  unit: z.string().min(1).max(200),
  claimedAt: z.iso.datetime().nullable(),
});
export type Marker = z.infer<typeof markerSchema>;

/** A marker in the directory: whole, with what it records, or not yet whole, a sibling still writing it, known only by its name. */
export type LiveClaim =
  | ({ readonly whole: true; readonly hash: string; readonly generation: number } & Marker)
  | { readonly whole: false; readonly hash: string; readonly generation: number };

/**
 * How long a marker may stay not whole before it is torn: a claimant on a
 * file system without hard links writes its marker the moment it creates it
 * under `wx`, so a marker still not whole a minute after it was last written
 * was left by a claimant killed between the two, and nobody will finish it.
 */
export const tornMarkerAfterMs = 60_000;

/** A marker as its name is read: live, or torn, which holds nothing and only keeps its generation's name taken. */
type ReadMarker = LiveClaim | 'torn';

const markerNamePattern = /^([0-9a-f]{64})\.([1-9][0-9]{0,8})\.json$/;

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * A path as the file system compares it: where it folds case, composed
 * (NFC), uppercased and then lowercased, so the spellings NTFS and APFS
 * take for one name meet one key: NFC and NFD forms, a final and a medial
 * sigma, the Kelvin sign and `k`. The key may merge names such a file
 * system keeps apart (`ß` and `ss`), which only refuses a claim, the safe
 * side for a lock.
 */
export function pathKey(path: string, caseInsensitive: boolean): string {
  return caseInsensitive ? path.normalize('NFC').toUpperCase().toLowerCase() : path;
}

/** The hash a path's markers are named by. */
export function markerHash(path: string, caseInsensitive: boolean): string {
  return sha256(pathKey(path, caseInsensitive));
}

/** The name of a path's marker of one generation. */
export function markerName(path: string, generation: number, caseInsensitive: boolean): string {
  return `${markerHash(path, caseInsensitive)}.${String(generation)}.json`;
}

/**
 * A claimed path in the repository's spelling: backslashes as slashes and
 * `.` segments dropped, then refused unless it is relative, inside the
 * repository, outside `.git` and free of empty segments, as a snapshot's
 * path must be, and no longer than a marker records.
 */
export function normalizeClaimPath(raw: string): string {
  const path = raw.replaceAll('\\', '/').split('/').filter((part) => part !== '.').join('/');
  // A path of nothing but `.` segments is empty here, which the scope check refuses.
  validateScopePath(path);
  if (path.split('/').some((part) => part === '' || part === '.')) throw new InvalidScopeRequestError(`A claimed path must name a file: ${raw}`);
  if (path.length > claimedPathMax) throw new InvalidScopeRequestError(`A claimed path must not be longer than ${String(claimedPathMax)} characters, and this one has ${String(path.length)}`);
  return path;
}

/** Whether a spelling with slashes for backslashes is rooted, at `/` or at a drive such as `C:`, as an answer's reported path is judged. */
const rooted = (name: string): boolean => name.startsWith('/') || /^[A-Za-z]:(\/|$)/.test(name) || isAbsolute(name);

/**
 * The repository path a fixer's spelling names, as `resolveReportedPath`
 * resolves the same spelling in its answer, so a claim and the answer name
 * one file: trimmed, and an absolute path inside the worktree taken
 * relative to it; then normalized by `normalizeClaimPath`. An absolute path
 * outside the worktree, or one the file system cannot resolve, is refused.
 */
function resolveClaimPath(worktree: string, raw: string): string {
  const trimmed = raw.trim();
  const slashed = trimmed.replaceAll('\\', '/');
  if (!rooted(slashed)) return normalizeClaimPath(trimmed);
  if (slashed.includes('\0')) throw new InvalidScopeRequestError(`A claimed path must not hold a NUL: ${JSON.stringify(raw)}`);
  let inside: string;
  try {
    inside = relative(canonicalPath(worktree), canonicalPath(slashed));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code !== 'string') throw error;
    throw new InvalidScopeRequestError(`A claimed path cannot be resolved: ${raw}: ${code}`, { cause: error });
  }
  // Judged by whole segments, as `isInside` does, so a child named `..tmp` is inside while `..` is not.
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new InvalidScopeRequestError(`A claimed path must be inside the worktree ${worktree}: ${raw}`);
  return normalizeClaimPath(inside);
}

/** A name with the case of its ASCII letters flipped: each has one letter of the other case, which every file system that folds case folds back, where `ß` uppercases to `SS`. */
const flipCase = (text: string): string => text.replaceAll(/[A-Za-z]/g, (letter) => (letter <= 'Z' ? letter.toLowerCase() : letter.toUpperCase()));

/** What the case probe asks of the file system; tests stand in for one whose entries all report inode 0. */
export interface CaseProbeFileSystem {
  readonly list: (directory: string) => readonly string[];
  readonly stat: (path: string) => Stats | undefined;
}

const caseProbeFileSystem: CaseProbeFileSystem = {
  list: (directory) => readdirSync(directory),
  stat: (path) => statSync(path, { throwIfNoEntry: false }),
};

/**
 * Whether `name`, listed in `listing` of `directory`, is also found by its
 * flipped spelling, so the file system folds case. A listing that holds
 * both spellings has two entries, which no file system that folds case
 * holds; the entries' inodes are never compared, since some volumes report
 * 0 for every one.
 */
function foldsCase(fs: CaseProbeFileSystem, directory: string, listing: readonly string[], name: string): boolean {
  const flipped = flipCase(name);
  if (listing.includes(name) && listing.includes(flipped)) return false;
  return fs.stat(join(directory, flipped)) !== undefined;
}

/** A directory's entries, or undefined when the engine may pass through it but not read it, as under a parent of mode 0711 another user owns. */
function readableListing(fs: CaseProbeFileSystem, directory: string): readonly string[] | undefined {
  try {
    return fs.list(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') return undefined;
    throw error;
  }
}

/**
 * Whether the worktree's file system folds case: the worktree root looked
 * up with the case of its last segment's ASCII letters flipped, or, when
 * that segment has none or the root's parent cannot be listed, the first
 * entry under the root that has one (`.git` always does). Where nothing can
 * be probed, the platform's default. One answer for the whole worktree
 * (TD4), though Windows can make a single directory case-sensitive.
 */
export function caseInsensitiveFileSystem(worktree: string, fs: CaseProbeFileSystem = caseProbeFileSystem): boolean {
  const name = basename(worktree);
  if (flipCase(name) !== name) {
    const parent = dirname(worktree);
    const siblings = readableListing(fs, parent);
    if (siblings !== undefined) return foldsCase(fs, parent, siblings, name);
  }
  const listing = fs.list(worktree);
  const entry = listing.find((candidate) => flipCase(candidate) !== candidate);
  if (entry !== undefined) return foldsCase(fs, worktree, listing, entry);
  return process.platform === 'win32' || process.platform === 'darwin';
}

/**
 * Whether a claims directory is intact: its `held.json` is there. A
 * directory gone, or emptied in place, has lost its markers with it, so
 * the engine judges a prepared directory lost by this test (R12), as the
 * command does when `readHeld` finds no `held.json`.
 */
export function claimsDirectoryIntact(dir: string): boolean {
  return existsSync(join(dir, heldFileName));
}

/** The round `held.json` describes; a missing directory or file means the directory was lost, as `claimsDirectoryIntact` judges it. */
export function readHeld(dir: string): Held {
  const file = join(dir, heldFileName);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') throw new ClaimsDirectoryLostError(dir);
    throw error;
  }
  let parsed;
  try {
    parsed = heldSchema.safeParse(JSON.parse(text));
  } catch (error) {
    throw new ClaimRequestError(`${file} is not the round's description: ${(error as Error).message}`);
  }
  if (!parsed.success) throw new ClaimRequestError(`${file} is not the round's description: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/**
 * One marker read by its name: whole, or not yet whole when it is empty,
 * not JSON, not a marker, or a marker whose path is not one the command
 * writes or does not hash to its name, which no claim made; torn when it is
 * not whole `tornMarkerAfterMs` after it was last written, as of `now`;
 * undefined when there is no such file.
 */
function readMarker(dir: string, hash: string, generation: number, caseInsensitive: boolean, now: Date): ReadMarker | undefined {
  const file = join(dir, `${hash}.${String(generation)}.json`);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const parsed = markerSchema.safeParse(JSON.parse(text));
    if (parsed.success && namesItsPath(parsed.data.path, hash, caseInsensitive)) return { whole: true, hash, generation, ...parsed.data };
  } catch {
    // Not whole JSON: a sibling on a file system without hard links created it under `wx` and is still writing it, or was killed before it wrote.
  }
  const written = statSync(file, { throwIfNoEntry: false })?.mtimeMs;
  if (written !== undefined && now.getTime() - written >= tornMarkerAfterMs) return 'torn';
  return { whole: false, hash, generation };
}

/** Whether a marker's path is one the command writes, normalized, and hashes to the marker's name. */
function namesItsPath(path: string, hash: string, caseInsensitive: boolean): boolean {
  try {
    return normalizeClaimPath(path) === path && markerHash(path, caseInsensitive) === hash;
  } catch (error) {
    if (error instanceof InvalidScopeRequestError) return false;
    throw error;
  }
}

/** A path's markers, from generation 1 up to the first missing one, read by name as of `now`, a torn one in its generation's place. */
function markersOf(dir: string, hash: string, caseInsensitive: boolean, now: Date): ReadMarker[] {
  const markers: ReadMarker[] = [];
  for (let generation = 1; ; generation += 1) {
    const marker = readMarker(dir, hash, generation, caseInsensitive, now);
    if (marker === undefined) return markers;
    markers.push(marker);
  }
}

/** Create a marker exclusively and whole, so a claimant killed while writing it leaves no marker that holds the path for the round; false when a marker of that name exists already. */
function createMarker(dir: string, hash: string, generation: number, marker: Marker): boolean {
  return createFileExclusive(join(dir, `${hash}.${String(generation)}.json`), `${JSON.stringify(marker)}\n`);
}

/**
 * Every marker in the directory, by hash then generation, judged whole as
 * `claimFile` judges it on a file system that folds case or not, as of
 * `now`. A torn marker is left out, since it holds nothing, so a settle
 * leaves its path pending no longer. A directory that is gone throws
 * `ClaimsDirectoryLostError`; a file whose name is not a marker's,
 * `held.json` included, is not a claim.
 */
export function readClaims(dir: string, caseInsensitive: boolean, now: () => Date = () => new Date()): LiveClaim[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') throw new ClaimsDirectoryLostError(dir);
    throw error;
  }
  const time = now();
  const claims: LiveClaim[] = [];
  for (const name of names) {
    const match = markerNamePattern.exec(name);
    if (match === null) continue;
    const marker = readMarker(dir, match[1]!, Number(match[2]), caseInsensitive, time);
    if (marker !== undefined && marker !== 'torn') claims.push(marker);
  }
  return claims.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : a.generation - b.generation));
}

/** A claim the ledger holds, to seed back into a directory that lost it. */
export interface RecordedMarker {
  readonly path: string;
  readonly cluster: string;
  readonly unit: string;
  readonly claimedAt: string | null;
}

/**
 * Prepare the round's directory at an editing launch or a settle: create it, write
 * `held.json` afresh (whole, so the command never reads half of it, and
 * retried while a command reading it keeps Windows from replacing it), and
 * seed the ledger's latest claim of each path at the path's next
 * generation when no marker of the path records it, so that claim is the
 * path's holder again after a cleaning. An earlier claim
 * of the path holds nothing once a later one exists, and seeding it would
 * put a cluster above the holder. A marker records a claim when its
 * cluster, unit and time are the claim's. Nothing is removed.
 * `expectExisting` says this engine prepared the directory before, so a
 * directory no longer intact, gone or without its `held.json`, is a loss
 * (R12) and throws `ClaimsDirectoryLostError` without writing anything.
 */
export function prepareClaims(dir: string, held: Held, recorded: readonly RecordedMarker[], expectExisting: boolean): void {
  if (expectExisting && !claimsDirectoryIntact(dir)) throw new ClaimsDirectoryLostError(dir);
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, heldFileName), `${JSON.stringify(held)}\n`);
  const latest = new Map<string, RecordedMarker>();
  for (const claim of recorded) latest.set(markerHash(claim.path, held.caseInsensitive), claim);
  for (const [hash, claim] of latest) {
    const markers = markersOf(dir, hash, held.caseInsensitive, new Date());
    if (markers.some((marker) => marker !== 'torn' && marker.whole && marker.cluster === claim.cluster && marker.unit === claim.unit && marker.claimedAt === claim.claimedAt)) continue;
    const marker: Marker = { path: claim.path, cluster: claim.cluster, unit: claim.unit, claimedAt: claim.claimedAt };
    let generation = markers.length + 1;
    while (!createMarker(dir, hash, generation, marker)) generation += 1;
  }
}

/** What a claim came to. */
export type ClaimOutcome =
  /** The path is one of the unit's own cluster's files. */
  | { readonly kind: 'owned'; readonly path: string; readonly cluster: string }
  /** The unit's cluster holds the path by a claim: made now, or before. */
  | { readonly kind: 'claimed'; readonly path: string; readonly cluster: string; readonly generation: number; readonly created: boolean }
  /** Another cluster owns the path or holds it by a claim. */
  | { readonly kind: 'refused'; readonly path: string; readonly holder: string; readonly by: 'plan' | 'claim' }
  /** A sibling is still writing the path's latest marker, so its cluster is not known yet. */
  | { readonly kind: 'held-by-unknown'; readonly path: string };

/** The cluster holding a path by the plan, compared as the file system compares paths. */
function ownerOf(held: Held, path: string): string | null {
  const key = pathKey(path, held.caseInsensitive);
  for (const [cluster, files] of Object.entries(held.clusters)) if (files.some((file) => pathKey(file, held.caseInsensitive) === key)) return cluster;
  return null;
}

/** What a holding marker means for a claim by `cluster`: one not yet whole, and not yet torn, is a sibling's still being written. */
function judged(path: string, cluster: string, marker: LiveClaim, created: boolean): ClaimOutcome {
  if (!marker.whole) return { kind: 'held-by-unknown', path };
  return marker.cluster === cluster ? { kind: 'claimed', path, cluster, generation: marker.generation, created } : { kind: 'refused', path, holder: marker.cluster, by: 'claim' };
}

/**
 * Claim one path for the cluster of `unit` (R1, R2), read as the fixer's
 * answer reads it (`resolveClaimPath`): `owned` for a file of
 * its own cluster, refused naming the owner for another cluster's file;
 * else the path's latest marker decides. The unit's own cluster's marker is
 * `claimed`; no marker, or one of a cluster `held.json` lists as settled,
 * makes the next generation exclusively, and a sibling that made the same
 * one first refuses the claim naming that sibling; a marker not yet whole
 * is `held-by-unknown`; any other is refused naming its cluster. A torn
 * marker holds nothing: the latest marker that is not torn decides, and a
 * claim goes on above a torn one. A
 * directory or `held.json` that is gone throws `ClaimsDirectoryLostError`,
 * a directory inside the worktree and a path outside the repository
 * `InvalidScopeRequestError`, a unit the round lacks or one whose cluster
 * has settled `ClaimRequestError`.
 */
export function claimFile(dir: string, rawPath: string, unit: string, now: () => Date = () => new Date()): ClaimOutcome {
  const held = readHeld(dir);
  if (isInside(held.worktree, dir)) throw new InvalidScopeRequestError(`The claims directory ${dir} is inside the worktree ${held.worktree}; a claim there would be a stray file of the review`);
  if (!Object.hasOwn(held.units, unit)) throw new ClaimRequestError(`unit ${unit} is no batch of this round`);
  const cluster = held.units[unit]!;
  // A settled cluster runs no batch, and a marker it made now would read as one that holds nothing.
  if (held.settled.includes(cluster)) throw new ClaimRequestError(`unit ${unit}'s cluster ${cluster} has settled, so it claims nothing more`);
  const path = resolveClaimPath(held.worktree, rawPath);
  const owner = ownerOf(held, path);
  if (owner === cluster) return { kind: 'owned', path, cluster };
  if (owner !== null) return { kind: 'refused', path, holder: owner, by: 'plan' };
  const hash = markerHash(path, held.caseInsensitive);
  const time = now();
  const markers = markersOf(dir, hash, held.caseInsensitive, time);
  const latest = markers.findLast((read) => read !== 'torn');
  if (latest !== undefined && !(latest.whole && held.settled.includes(latest.cluster))) return judged(path, cluster, latest, false);
  const marker: Marker = { path, cluster, unit, claimedAt: time.toISOString() };
  for (let generation = markers.length + 1; ; generation += 1) {
    if (createMarker(dir, hash, generation, marker)) return { kind: 'claimed', path, cluster, generation, created: true };
    // A sibling created the same generation first: its marker holds the path, whole or still being written, unless it is torn.
    const raced = readMarker(dir, hash, generation, held.caseInsensitive, time);
    if (raced !== 'torn') return judged(path, cluster, raced ?? { whole: false, hash, generation }, false);
  }
}
