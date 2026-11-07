// Replay the decider of a recorded run with this engine and the current
// roles, for the second gate of the settled choice (R8 of
// docs/changes/2026-11-06-choice-settled-on-the-record.requirements.md).
// The run's ledger is read up to the decision, one decider is launched on
// the runtime named, its answer is checked as the decision phase checks
// it, and a refused answer gets one more decider told what the refusal
// said. From the accepted decisions the review is rendered as
// `publish --dry-run` prints it, with no writer. It calls real models,
// costs money and needs the runtime's CLI signed in, so it is run by hand,
// never by `npm run check`:
//   npm run replay-decider -- --checkpoint <dir> --run <id> --tree <dir> --output <dir> --runtime <claude|codex>
//     [--roles <dir>] [--executable <path>] [--executable-arg <arg>]... [--print-task]
// --checkpoint is the run's `deep-review-checkpoint` directory: a copy of
// its ledger is read, and its frozen blobs, and nothing is written there.
// --run takes a run id or a prefix of one. --tree is a checkout of the
// repository at the reviewed head with no change; a tree that differs is
// refused. --output must be absent or empty. --roles is this checkout's
// roles/ by default. --print-task writes the first attempt's prompt and
// launches nothing.
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { engineVersion } from '../src/engine.ts';
import { decisionsFileName, factsFileName, replayDecider, reviewFileName } from '../src/replay/decider.ts';
import { resolveExecutable } from '../src/review/executable.ts';
import { repositoryRolesRoot } from '../src/roles/assemble.ts';

const { values } = parseArgs({
  options: {
    checkpoint: { type: 'string' },
    run: { type: 'string' },
    tree: { type: 'string' },
    output: { type: 'string' },
    runtime: { type: 'string' },
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

const runtime = required('runtime');
const output = resolve(required('output'));
const outcome = await replayDecider({
  checkpoint: required('checkpoint'),
  run: required('run'),
  tree: required('tree'),
  output,
  runtime,
  executable: resolveExecutable(values.executable ?? runtime),
  executableArgs: values['executable-arg'] ?? [],
  rolesRoot: values.roles === undefined ? repositoryRolesRoot() : resolve(values.roles),
  printTask: values['print-task'],
  engine: engineVersion(),
  log: (line) => {
    console.log(line);
  },
});
if (!values['print-task']) {
  if (outcome.decisions === null) process.exitCode = 1;
  else {
    console.log(`decisions: ${join(output, decisionsFileName)}`);
    console.log(`review: ${join(output, reviewFileName)}`);
  }
  console.log(`facts: ${join(output, factsFileName)}`);
}
