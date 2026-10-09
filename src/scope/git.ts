import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** The bytes a git command may print before the capture gives up: a binary patch of a large scope. */
const maxOutputBytes = 512 * 1024 * 1024;

export interface GitOptions {
  /** Exit codes other than 0 that mean success; `git diff --no-index` exits 1 when files differ. */
  readonly okExitCodes?: readonly number[];
  /** Bytes for git's stdin; without them stdin is closed. */
  readonly input?: Buffer;
}

/** Run git in `cwd` and return its stdout as bytes. Every call passes `--no-optional-locks` so a capture never writes the index. */
export function git(cwd: string, args: readonly string[], options: GitOptions = {}): Buffer {
  try {
    return execFileSync('git', ['--no-optional-locks', ...args], {
      cwd,
      maxBuffer: maxOutputBytes,
      windowsHide: true,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(options.input === undefined ? {} : { input: options.input }),
    });
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: Buffer; stderr?: Buffer; message: string };
    if (failure.status !== undefined && failure.status !== null && options.okExitCodes?.includes(failure.status) && failure.stdout !== undefined) {
      return failure.stdout;
    }
    const detail = failure.stderr?.toString('utf8').trim() || failure.message;
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

/** Run git and return its stdout as UTF-8 text. */
export function gitText(cwd: string, args: readonly string[], options: GitOptions = {}): string {
  return git(cwd, args, options).toString('utf8');
}

/** Split NUL-separated output into its non-empty records. */
export function records(output: string): string[] {
  return output.split('\0').filter((record) => record.length > 0);
}

/** The commit a revision names, or an error naming the revision. */
export function resolveCommit(repo: string, revision: string): string {
  return gitText(repo, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]).trim();
}

export function head(repo: string): string {
  return resolveCommit(repo, 'HEAD');
}

/** The first parent of a commit, or `null` for a root commit. */
export function firstParent(repo: string, commit: string): string | null {
  const [, parent] = gitText(repo, ['rev-list', '--parents', '-n', '1', commit]).trim().split(' ');
  return parent ?? null;
}

/** The id of the empty tree in this repository's object format, the base of a root commit. */
export function emptyTree(repo: string): string {
  return gitText(repo, ['hash-object', '-t', 'tree', '--stdin'], { okExitCodes: [] }).trim();
}

export function mergeBase(repo: string, a: string, b: string): string {
  return gitText(repo, ['merge-base', a, b]).trim();
}

/** SHA-256 of the index listing: changes when anything is staged, unstaged or its mode flips. */
export function indexDigest(repo: string): string {
  return createHash('sha256').update(git(repo, ['ls-files', '--stage', '-z'])).digest('hex');
}

export function unmergedPaths(repo: string): string[] {
  return records(gitText(repo, ['ls-files', '--unmerged', '-z'])).map((record) => record.split('\t').at(-1) ?? record);
}

/** Paths whose index entry is a gitlink: a submodule the capture cannot fingerprint. */
export function gitlinkPaths(repo: string): string[] {
  return records(gitText(repo, ['ls-files', '--stage', '-z']))
    .filter((record) => record.startsWith('160000 '))
    .map((record) => record.split('\t').at(-1) ?? record);
}

export interface StatusEntry {
  /** Two-character porcelain code, such as ` M`, `A `, `??`. */
  readonly code: string;
  readonly path: string;
}

/** `git status` without rename detection, every untracked file listed individually. */
export function status(repo: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  for (const record of records(gitText(repo, ['-c', 'status.renames=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']))) {
    entries.push({ code: record.slice(0, 2), path: record.slice(3) });
  }
  return entries;
}

/** A pathspec that matches exactly this path, never a glob. */
export const literal = (path: string): string => `:(literal)${path}`;

export interface NameStatusEntry {
  /** `A`, `M`, `D` or `T` (type change). */
  readonly code: string;
  readonly path: string;
}

/**
 * Changed paths between `base` and either `target` or the worktree, without
 * rename detection so every path stands alone.
 */
export function diffNameStatus(repo: string, base: string, target: string | null, paths: readonly string[]): NameStatusEntry[] {
  const selectors = target === null ? [base] : [base, target];
  const output = gitText(repo, ['diff', '--no-renames', '--name-status', '-z', ...selectors, '--', ...paths.map(literal)]);
  const parts = records(output);
  const entries: NameStatusEntry[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    entries.push({ code: parts[index]!.charAt(0), path: parts[index + 1]! });
  }
  if (parts.length % 2 !== 0) throw new Error(`Incomplete git name-status output: ${JSON.stringify(output)}`);
  return entries;
}

/** The unified patch between `base` and either `target` or the worktree, with binary content and git's rename detection. */
export function diffPatch(repo: string, base: string, target: string | null, paths: readonly string[]): Buffer {
  const selectors = target === null ? [base] : [base, target];
  return git(repo, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '-M', ...selectors, '--', ...paths.map(literal)]);
}

/** The patch that adds an untracked file from nothing. */
export function untrackedPatch(repo: string, path: string): Buffer {
  return git(repo, ['diff', '--no-index', '--binary', '--no-ext-diff', '--no-textconv', '--', '/dev/null', path], { okExitCodes: [1] });
}

/** Untracked, non-ignored entries. An embedded repository appears as `dir/`. */
export function untrackedEntries(repo: string, paths: readonly string[]): string[] {
  return records(gitText(repo, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths.map(literal)]));
}

export interface TreeEntry {
  readonly mode: string;
  readonly objectId: string;
  readonly path: string;
}

/** Every blob under `commit`, limited to `paths`, keyed by path. */
export function treeEntries(repo: string, commit: string, paths: readonly string[]): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (const record of records(gitText(repo, ['ls-tree', '-r', '-z', commit, '--', ...paths.map(literal)]))) {
    const match = /^([0-7]+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    if (match === null) throw new Error(`Unexpected ls-tree record: ${record}`);
    entries.set(match[4]!, { mode: match[1]!, objectId: match[3]!, path: match[4]! });
  }
  return entries;
}

/** A blob's bytes as a checkout would write them: end-of-line conversion and smudge filters applied. */
export function blobThroughFilters(repo: string, commit: string, path: string): Buffer {
  return git(repo, ['cat-file', '--filters', `${commit}:${path}`]);
}

/** A blob's raw bytes, for a symlink's target text. */
export function blobRaw(repo: string, objectId: string): Buffer {
  return git(repo, ['cat-file', 'blob', objectId]);
}

/**
 * The object id git would store these bytes under at `path`, through the
 * clean conversion the path's configuration and attributes ask for (line
 * endings under `core.autocrlf`, `text`, `eol`), writing nothing.
 */
export function storedBlobId(repo: string, path: string, bytes: Buffer): string {
  return gitText(repo, ['hash-object', `--path=${path}`, '--stdin'], { input: bytes }).trim();
}

/** Store these bytes as git would at `path`, through the same conversion, and return the object id; the blob is unreferenced until something names it. */
export function writeStoredBlob(repo: string, path: string, bytes: Buffer): string {
  return gitText(repo, ['hash-object', '-w', `--path=${path}`, '--stdin'], { input: bytes }).trim();
}

/**
 * The paths whose content differs from `HEAD` as git compares it, after
 * its clean conversion, and the untracked ones, ignored ones excepted,
 * sorted. Unlike `git status`, a file that differs from its checkout only
 * in what the conversion undoes is not listed.
 */
export function changedAgainstHead(repo: string): string[] {
  const changed = records(gitText(repo, ['diff', '--name-only', '--no-renames', '-z', 'HEAD']));
  const untracked = records(gitText(repo, ['ls-files', '--others', '--exclude-standard', '-z']));
  return [...new Set([...changed, ...untracked])].sort();
}

/** Every file git tracks, once each, sorted: what a check that writes the tree can rewrite and the commit series can carry (PD9 of commit series integrity). */
export function trackedFiles(repo: string): string[] {
  return [...new Set(records(gitText(repo, ['ls-files', '-z', '--cached'])))].sort();
}

/** Every file git does not ignore, tracked or untracked, once each, sorted. */
export function filesNotIgnored(repo: string): string[] {
  return [...new Set(records(gitText(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])))].sort();
}

/** What git ignores in the worktree, a wholly ignored directory once with a trailing slash, sorted. */
export function ignoredEntries(repo: string): string[] {
  return records(gitText(repo, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])).sort();
}

/** The paths among `paths` that git ignores, sorted; `check-ignore` exits 1 when there is none. */
export function ignoredPaths(repo: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  return records(gitText(repo, ['check-ignore', '-z', '--stdin'], { okExitCodes: [1], input: Buffer.from(`${paths.join('\0')}\0`) })).sort();
}

/** The hash the repository names its objects with: `sha1`, or `sha256` for a repository created with that format. */
export function objectFormat(repo: string): 'sha1' | 'sha256' {
  const format = gitText(repo, ['rev-parse', '--show-object-format']).trim();
  if (format !== 'sha1' && format !== 'sha256') throw new Error(`git reports an object format this engine does not know: ${format}`);
  return format;
}
