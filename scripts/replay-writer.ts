// Replay the writer of a recorded run with this engine and the current
// roles, at the version of its answer given, 4 by default, to measure the
// answer before the engine builds on it (PD9, OQ1 of
// docs/changes/2026-11-12-review-in-the-writers-words.requirements.md and
// its design). The run's ledger is read up to the start of its
// explanation phase, one writer is launched on the runtime named, and its
// answer is checked as the explanation phase checks it. The answer, its
// size, its time, its cost and each part that failed are written to the
// output directory. It calls a real model, costs money and needs the
// runtime's CLI signed in, so it is run by hand, never by `npm run check`:
//   npm run replay-writer -- --checkpoint <dir> --run <id> --tree <dir> --output <dir> --runtime <claude|codex>
//     [--version <1|2|3|4>] [--roles <dir>] [--executable <path>] [--executable-arg <arg>]... [--print-task]
// --checkpoint is the run's `deep-review-checkpoint` directory: a copy of
// its ledger is read, and its frozen blobs, and nothing is written there.
// --run takes a run id or a prefix of one. --tree is a checkout of the
// repository at the reviewed head with no change and with the run's
// commits; a tree that differs is refused. --output must be absent or
// empty. --version is 4 by default; the run's own version is the other
// one it takes. --roles is this checkout's roles/ by default.
// --print-task writes the prompt and launches nothing.
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { engineVersion } from '../src/engine.ts';
import { replayWriter, writerFactsFileName } from '../src/replay/writer.ts';
import { resolveExecutable } from '../src/review/executable.ts';
import type { WriterVersion } from '../src/review/schemas.ts';
import { repositoryRolesRoot } from '../src/roles/assemble.ts';

const { values } = parseArgs({
  options: {
    checkpoint: { type: 'string' },
    run: { type: 'string' },
    tree: { type: 'string' },
    output: { type: 'string' },
    runtime: { type: 'string' },
    version: { type: 'string' },
    executable: { type: 'string' },
    'executable-arg': { type: 'string', multiple: true },
    roles: { type: 'string' },
    'print-task': { type: 'boolean', default: false },
  },
  strict: true,
});

/** A flag that must be given, by name. */
function required(name: 'checkpoint' | 'run' | 'tree' | 'output' | 'runtime'): string {
  const value = values[name];
  if (value === undefined || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

/** The version `--version` names, 4 when it is not given. */
function versionOf(given: string | undefined): WriterVersion {
  if (given === undefined) return 4;
  if (given === '1' || given === '2' || given === '3' || given === '4') return Number(given) as WriterVersion;
  throw new Error(`--version takes 1, 2, 3 or 4, not ${given}`);
}

const runtime = required('runtime');
const output = resolve(required('output'));
const outcome = await replayWriter({
  checkpoint: required('checkpoint'),
  run: required('run'),
  tree: required('tree'),
  output,
  runtime,
  version: versionOf(values.version),
  executable: resolveExecutable(values.executable ?? runtime),
  executableArgs: values['executable-arg'] ?? [],
  rolesRoot: values.roles === undefined ? repositoryRolesRoot() : resolve(values.roles),
  printTask: values['print-task'],
  engine: engineVersion(),
  log: (line) => {
    console.log(line);
  },
});
if (outcome.facts !== null) {
  if (outcome.facts.outcome !== 'completed') process.exitCode = 1;
  console.log(`facts: ${join(output, writerFactsFileName)}`);
}
