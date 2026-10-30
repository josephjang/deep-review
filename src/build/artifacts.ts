import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * One runtime's installed artifact: a source directory that the build copies
 * byte for byte to a destination under `dist/`. Both paths are relative to
 * the repository root and use forward slashes.
 */
export interface ArtifactTarget {
  /** Short runtime name, also the staging directory name. */
  readonly name: string;
  /** Directory whose files are the artifact's sources. */
  readonly source: string;
  /** Directory the built artifact is committed to. */
  readonly destination: string;
}

/** The directory every artifact destination must sit under. */
export const distRoot = 'dist';

/** Every runtime this repository ships an artifact for. */
export const artifactTargets: readonly ArtifactTarget[] = [
  { name: 'claude', source: 'skill/claude', destination: 'dist/claude' },
  { name: 'codex', source: 'skill/codex', destination: 'dist/codex' },
];

/** Every file below a directory: forward-slash relative path to SHA-256 hex, sorted by path. */
export type TreeDigest = ReadonlyMap<string, string>;

/** How one path differs between an expected tree and an actual tree. */
export interface TreeDifference {
  readonly path: string;
  /** `missing`: expected but absent. `extra`: present but not expected. `changed`: bytes differ. */
  readonly kind: 'missing' | 'extra' | 'changed';
}

/**
 * Hash every regular file below `root`. Directories are walked; anything that
 * is neither a regular file nor a directory (a symlink, a socket) is refused,
 * because the build cannot promise what such an entry would be after install.
 */
export function digestTree(root: string): TreeDigest {
  if (!existsSync(root)) throw new Error(`Tree root does not exist: ${root}`);
  const digest = new Map<string, string>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, `${path}/`);
      else if (entry.isFile()) digest.set(path, createHash('sha256').update(readFileSync(absolute)).digest('hex'));
      else throw new Error(`Unsupported entry in tree: ${absolute}`);
    }
  };
  walk(root, '');
  return new Map([...digest].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Differences between two digests, sorted by path, empty when the trees match. */
export function compareTrees(expected: TreeDigest, actual: TreeDigest): TreeDifference[] {
  const differences: TreeDifference[] = [];
  for (const [path, hash] of expected) {
    const actualHash = actual.get(path);
    if (actualHash === undefined) differences.push({ path, kind: 'missing' });
    else if (actualHash !== hash) differences.push({ path, kind: 'changed' });
  }
  for (const path of actual.keys()) if (!expected.has(path)) differences.push({ path, kind: 'extra' });
  return differences.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Copy a target's sources into `stagingRoot/<name>` and return that directory.
 * The staging directory must not exist yet, so two assemblies never mix.
 */
export function assembleArtifact(repositoryRoot: string, target: ArtifactTarget, stagingRoot: string): string {
  const source = join(repositoryRoot, target.source);
  if (!existsSync(source)) throw new Error(`Artifact source does not exist: ${source}`);
  const staged = join(stagingRoot, target.name);
  if (existsSync(staged)) throw new Error(`Staging directory already exists: ${staged}`);
  mkdirSync(stagingRoot, { recursive: true });
  cpSync(source, staged, { recursive: true, errorOnExist: true, dereference: false });
  return staged;
}

/**
 * Replace the committed artifact at `repositoryRoot/<target.destination>` with a
 * staged tree, removing whatever was there. The destination has to sit under
 * `dist/` inside the repository, so a wrong path can never delete anything else.
 * Staging may sit on another filesystem, which a rename cannot cross, so the
 * staged tree is first copied beside the destination; only then is the old
 * tree moved aside and the copy renamed into its place. A rename that fails
 * puts the old tree back, so a failed publish leaves the artifact as it was.
 * Should putting it back fail too, both errors are thrown together, naming
 * the hidden directory beside the destination where the old tree was left.
 * `rename` stands in for the file system's in tests.
 */
export function publishArtifact(repositoryRoot: string, target: ArtifactTarget, staged: string, rename: (from: string, to: string) => void = renameSync): void {
  const destination = resolve(repositoryRoot, target.destination);
  assertUnderDist(repositoryRoot, destination);
  if (!existsSync(staged)) throw new Error(`Staged artifact does not exist: ${staged}`);
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(join(parent, `.${target.name}-publish-`));
  const incoming = join(work, 'incoming');
  const outgoing = join(work, 'outgoing');
  try {
    cpSync(staged, incoming, { recursive: true, errorOnExist: true, dereference: false });
    if (existsSync(destination)) rename(destination, outgoing);
    rename(incoming, destination);
  } catch (error) {
    if (existsSync(outgoing) && !existsSync(destination)) {
      try {
        rename(outgoing, destination);
      } catch (restoreError) {
        // `work` is kept: it holds the only copy of the old tree.
        throw new AggregateError([error, restoreError], `Publishing ${destination} failed and its old tree could not be put back; it is at ${outgoing}`);
      }
    }
    removeTreeIfAble(work);
    throw error;
  }
  removeTreeIfAble(work);
}

/**
 * Remove a publish's work directory, leaving it where the file system
 * refuses: it only tidies, so its removal must not turn a publish into a
 * failure nor hide why a publish failed.
 */
function removeTreeIfAble(work: string): void {
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Left behind beside the destination.
  }
}

/** Throw unless `destination` is strictly inside `<repositoryRoot>/dist`. */
export function assertUnderDist(repositoryRoot: string, destination: string): void {
  const dist = resolve(repositoryRoot, distRoot);
  const inside = relative(dist, destination);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside) || inside.split(sep).includes('..')) {
    throw new Error(`Artifact destination must be a directory under ${dist}: ${destination}`);
  }
}
