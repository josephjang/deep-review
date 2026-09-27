// Assemble every role prompt from roles/manifest.json and print one line per
// role; with --output DIRECTORY also write each prompt to DIRECTORY/<key>.md,
// so a reviewer can read exactly what a worker in that role would receive.
// Nothing under roles/ is changed: the engine reads the fragments themselves,
// and an --output inside the roles directory is refused before anything is
// written.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { assembleRoles, repositoryRolesRoot } from '../src/roles/assemble.ts';

/**
 * The path with every symlink, junction and short name of its longest
 * existing ancestor resolved and the rest appended as written, so two
 * spellings of one directory compare equal even before it exists. The same
 * resolution `src/runtime/scratch.ts` judges scratch directories by.
 */
function canonicalPath(path: string): string {
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
 * Whether `child` is `parent` or beneath it, judged on canonical paths by
 * whole segments, so a sibling named `roles-assembled` is not inside
 * `roles`. `relative` compares without regard to case on Windows, as that
 * file system does.
 */
function isInside(parent: string, child: string): boolean {
  const path = relative(canonicalPath(parent), canonicalPath(child));
  return path === '' || !(path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path));
}

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    // The roles directory to assemble; defaults to this checkout's roles/.
    root: { type: 'string' },
  },
  strict: true,
});

const rolesRoot = values.root === undefined ? repositoryRolesRoot() : resolve(values.root);
const roles = assembleRoles(rolesRoot);
const output = values.output === undefined ? undefined : resolve(values.output);
if (output !== undefined) {
  // Written prompts under fragments/ would be entries no role names, which fails every later assembly; anywhere else under roles/ they would be stray files to commit.
  if (isInside(rolesRoot, output)) throw new Error(`Output must not be inside the roles directory ${rolesRoot}: ${output}`);
  if (existsSync(output)) throw new Error(`Output must not exist yet: ${output}`);
  mkdirSync(output, { recursive: true });
  for (const role of roles) writeFileSync(join(output, `${role.key}.md`), role.prompt);
}
for (const role of roles) {
  console.log(`${role.key}\t${String(role.fragments.length)} fragments\t${String(Buffer.byteLength(role.prompt, 'utf8'))} bytes\t${role.sha256}`);
}
if (output !== undefined) console.log(`Wrote ${String(roles.length)} prompts to ${output}`);
