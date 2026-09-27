// Assemble every role prompt from roles/manifest.json and print one line per
// role; with --output DIRECTORY also write each prompt to DIRECTORY/<key>.md,
// so a reviewer can read exactly what a worker in that role would receive.
// Nothing under roles/ is changed: the engine reads the fragments themselves,
// and an --output inside the roles directory is refused before anything is
// written.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isInside } from '../src/paths.ts';
import { assembleRoles, repositoryRolesRoot } from '../src/roles/assemble.ts';

/**
 * Create the output directory, which must not exist yet: its parents are
 * made as needed, and the directory itself by a create that fails when
 * anything is already there, so no directory made by another process in
 * the meantime is ever written into.
 */
function createOutputDirectory(output: string): void {
  // A file system root always exists, and creating one fails with EPERM on Windows rather than EEXIST.
  if (dirname(output) === output) throw new Error(`Output must not exist yet: ${output}`);
  mkdirSync(dirname(output), { recursive: true });
  try {
    mkdirSync(output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Output must not exist yet: ${output}`, { cause: error });
    throw error;
  }
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
  createOutputDirectory(output);
  for (const role of roles) writeFileSync(join(output, `${role.key}.md`), role.prompt);
}
for (const role of roles) {
  console.log(`${role.key}\t${String(role.fragments.length)} fragments\t${String(Buffer.byteLength(role.prompt, 'utf8'))} bytes\t${role.sha256}`);
}
if (output !== undefined) console.log(`Wrote ${String(roles.length)} prompts to ${output}`);
