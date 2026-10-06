// Replay the verifiers of a recorded run and count how the samples agree.
// Every verification group the run planned is sent again, with the prompt
// its verifier was sent then, to a fresh verifier on the runtime named, in
// a clean checkout of the commit the run reviewed; the verdicts are kept
// beside the ones the run recorded, and a summary says how the samples
// agree. It calls real models, costs money and needs the runtime's CLI
// signed in, so it is run by hand, never by `npm run check`:
//   npm run replay -- --checkpoint <dir> --run <id> --tree <dir> --output <dir> --runtime <claude|codex>
//     [--repeat 1] [--role-text recorded|current] [--model <name>] [--effort <level>] [--executable <path>] [--executable-arg <arg>]...
//     [--concurrency <n>] [--budget-usd <n>] [--group <phase>:<id>]... [--roles <dir>] [--dry-run]
// --checkpoint is a `deep-review-checkpoint` directory, best a copy of the
// one the run was recorded in: it is only read, but opening a ledger may
// write its journal files. --run takes a run id or a prefix of one. --tree
// is a checkout of the repository at the recorded head with no change; a
// tree that differs is refused. --output is kept: a later replay of the
// same run into it adds its samples to the same results. --role-text
// current puts the verifier prompt of --roles (this checkout's roles/ by
// default) in place of the recorded one, which is how a changed prompt is
// measured. --budget-usd stops new launches once the replay's workers have
// spent that much, on a runtime that reports cost. --executable-arg goes
// before the runtime's own arguments, as in a review: for an npm install,
// --executable names the node binary and --executable-arg the CLI's entry
// script. --dry-run writes every prompt under <output>/prompts and
// launches nothing.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Checkpoint } from '../src/checkpoint/checkpoint.ts';
import { effortSchema } from '../src/checkpoint/events.ts';
import { ledgerFileName } from '../src/checkpoint/ledger.ts';
import { engineVersion } from '../src/engine.ts';
import { resultsFileName, replayVerifier, summaryFileName } from '../src/replay/run.ts';
import { roleTextChoices, type RoleTextChoice } from '../src/replay/samples.ts';
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
    'role-text': { type: 'string', default: 'recorded' },
    repeat: { type: 'string', default: '1' },
    concurrency: { type: 'string' },
    'budget-usd': { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    group: { type: 'string', multiple: true },
    roles: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: true,
});

/** A flag that must be given, by name. */
function required(name: 'checkpoint' | 'run' | 'tree' | 'output' | 'runtime'): string {
  const value = values[name];
  if (value === undefined || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

/** A flag's value as a whole number of at least `least`, or undefined when the flag is not given. */
function wholeNumber(name: 'repeat' | 'concurrency', least: number): number | undefined {
  const text = values[name];
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!Number.isInteger(value) || value < least) throw new Error(`--${name} must be a whole number of at least ${String(least)}, not ${JSON.stringify(text)}`);
  return value;
}

const roleText = values['role-text'];
if (!(roleTextChoices as readonly string[]).includes(roleText)) throw new Error(`--role-text must be one of ${roleTextChoices.join(', ')}`);
const budgetText = values['budget-usd'];
const budgetUsd = budgetText === undefined ? null : Number(budgetText);
if (budgetUsd !== null && (!Number.isFinite(budgetUsd) || budgetUsd <= 0)) throw new Error(`--budget-usd must be a positive number, not ${JSON.stringify(budgetText)}`);
const effort = values.effort === undefined ? undefined : effortSchema.parse(values.effort);
const concurrency = wholeNumber('concurrency', 1);

const root = resolve(required('checkpoint'));
// Opening a ledger creates one where none is, so a mistyped path would leave an empty checkpoint behind.
if (!existsSync(join(root, ledgerFileName))) throw new Error(`${root} holds no ${ledgerFileName}; --checkpoint names a deep-review-checkpoint directory`);
const runtime = required('runtime');
const source = Checkpoint.open(root, { engine: engineVersion() });
try {
  const prefix = required('run');
  const runs = source.listRuns().filter((run) => run.id.startsWith(prefix));
  if (runs.length !== 1) throw new Error(`--run ${prefix} names ${runs.length === 0 ? 'no run' : `${String(runs.length)} runs`} of ${root}; it holds ${source.listRuns().map((run) => run.id).join(', ')}`);
  const output = resolve(required('output'));
  const outcome = await replayVerifier({
    source,
    runId: runs[0]!.id,
    tree: required('tree'),
    output,
    runtime,
    executable: resolveExecutable(values.executable ?? runtime),
    executableArgs: values['executable-arg'] ?? [],
    rolesRoot: values.roles === undefined ? repositoryRolesRoot() : resolve(values.roles),
    roleText: roleText as RoleTextChoice,
    repeat: wholeNumber('repeat', 1) ?? 1,
    budgetUsd,
    dryRun: values['dry-run'],
    engine: engineVersion(),
    log: (line) => {
      console.log(line);
    },
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(effort === undefined ? {} : { effort }),
    ...(values.group === undefined ? {} : { groups: values.group }),
  });
  if (values['dry-run']) {
    console.log('dry run: nothing was launched');
  } else {
    const cost = outcome.spend.costUsd === null ? 'no cost reported' : `${outcome.spend.costUsd.toFixed(2)} USD`;
    console.log(`samples ${outcome.samples.join(', ')}: ${String(outcome.spend.workers)} workers, ${String(outcome.spend.seconds)} s, ${cost}`);
    if (outcome.notLaunched.length > 0) console.log(`not launched at the budget: ${outcome.notLaunched.join(', ')}`);
    if (outcome.unverified.length > 0) {
      // Kept in the results, marked unverified; the exit code says a sample is not a pass over every candidate, so nobody scores it as one unread.
      console.log(`no verdicts in any attempt: ${outcome.unverified.join(', ')}`);
      process.exitCode = 1;
    }
    // A sample every group of which went unverified measured nothing at all, which is worth its own line.
    if (outcome.unjudged.length > 0) console.log(`no verifier answered in: ${outcome.unjudged.join(', ')}`);
    console.log(`results: ${join(output, resultsFileName)}`);
    console.log(`summary: ${join(output, summaryFileName)}`);
  }
} finally {
  source.close();
}
