/**
 * Questions about paths on the file system, shared across the engine.
 *
 * Containment judged on canonical paths, for every check that must tell
 * whether one directory lies within another however either is spelled: the
 * scratch directory against the reviewed tree and the checkpoint
 * (`src/runtime/scratch.ts`), and the role prompts' output against the roles
 * directory (`scripts/roles.ts`).
 *
 * A symlink's target as git records it, for every reader of the worktree's
 * links: the scope capture (`src/scope/capture.ts`), the fix pass's tree
 * (`src/review/tree.ts`) and the location check's line count
 * (`src/review/locations.ts`).
 *
 * Whether a path names a regular file, for every lookup that must skip what
 * is not one: the runtime executable on PATH (`src/review/executable.ts`)
 * and the rules files that govern a change (`src/review/conventions.ts`).
 *
 * Whether two worktree paths name one directory, for every command that
 * acts on a run recorded in another invocation: a review resuming it
 * (`src/review/controller.ts`) and the commit command
 * (`src/review/commit.ts`).
 */
import { readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * The path with every symlink, junction and short name of its longest
 * existing ancestor resolved and the rest appended as written, so two
 * spellings of one directory compare equal even before it exists. A path
 * none of whose ancestors can be resolved comes back absolute but otherwise
 * as written. Any failure other than a missing entry is thrown.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const rest: string[] = [];
  for (let current = absolute; ; current = dirname(current)) {
    try {
      return join(realpathSync.native(current), ...rest);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    if (dirname(current) === current) return absolute;
    rest.unshift(basename(current));
  }
}

/**
 * Whether `child` is `parent` or beneath it. Both are canonical first, so an
 * alias through a link is caught, and the relative path is judged by whole
 * segments, so a sibling named `roles-assembled` is not inside `roles` and a
 * child named `..tmp` is inside while `..` is not. `relative` compares
 * without regard to case on Windows, as that file system does.
 */
export function isInside(parent: string, child: string): boolean {
  const path = relative(canonicalPath(parent), canonicalPath(child));
  return path === '' || !(path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path));
}

/**
 * Whether two worktree paths name one directory, as a run's recorded
 * worktree is compared with the one a command runs in: the same resolved
 * path, compared without case on Windows, whose paths are case-insensitive.
 */
export function sameDirectory(a: string, b: string): boolean {
  const [left, right] = [resolve(a), resolve(b)];
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * A symlink's target text as git records it. Windows stores a link's target
 * with backslashes, where git records it with forward slashes, so the target
 * reads back with forward slashes there and a link compares equal to its
 * blob on every platform. Elsewhere a backslash is part of a name and the
 * text is kept as written.
 */
export function linkTargetText(target: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? target.replaceAll('\\', '/') : target;
}

/** The target text of the symlink at `absolute`, as git records it. */
export function readLinkText(absolute: string): Buffer {
  return Buffer.from(linkTargetText(readlinkSync(absolute)));
}

/**
 * Whether `path` names a regular file, following a symlink to its target. A
 * path that cannot be examined for any reason (missing, beneath a file, a
 * dangling link, denied) is not a file, so a lookup moves on rather than
 * throwing.
 */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
