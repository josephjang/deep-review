import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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
 */
export function publishArtifact(repositoryRoot: string, target: ArtifactTarget, staged: string): void {
  const destination = resolve(repositoryRoot, target.destination);
  assertUnderDist(repositoryRoot, destination);
  if (!existsSync(staged)) throw new Error(`Staged artifact does not exist: ${staged}`);
  mkdirSync(resolve(repositoryRoot, distRoot), { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  renameSync(staged, destination);
}

/** Throw unless `destination` is strictly inside `<repositoryRoot>/dist`. */
export function assertUnderDist(repositoryRoot: string, destination: string): void {
  const dist = resolve(repositoryRoot, distRoot);
  const inside = relative(dist, destination);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside) || inside.split(sep).includes('..')) {
    throw new Error(`Artifact destination must be a directory under ${dist}: ${destination}`);
  }
}
