/**
 * Path containment judged on canonical paths, shared by every check that must
 * tell whether one directory lies within another however either is spelled:
 * the scratch directory against the reviewed tree and the checkpoint
 * (`src/runtime/scratch.ts`), and the role prompts' output against the roles
 * directory (`scripts/roles.ts`).
 */
import { realpathSync } from 'node:fs';
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
