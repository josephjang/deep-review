// Assemble every role prompt from roles/manifest.json and print one line per
// role; with --output DIRECTORY also write each prompt to DIRECTORY/<key>.md,
// so a reviewer can read exactly what a worker in that role would receive.
// Nothing under roles/ is changed: the engine reads the fragments themselves.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { assembleRoles, repositoryRolesRoot } from '../src/roles/assemble.ts';

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
  if (existsSync(output)) throw new Error(`Output must not exist yet: ${output}`);
  mkdirSync(output, { recursive: true });
  for (const role of roles) writeFileSync(join(output, `${role.key}.md`), role.prompt);
}
for (const role of roles) {
  console.log(`${role.key}\t${String(role.fragments.length)} fragments\t${String(Buffer.byteLength(role.prompt, 'utf8'))} bytes\t${role.sha256}`);
}
if (output !== undefined) console.log(`Wrote ${String(roles.length)} prompts to ${output}`);
