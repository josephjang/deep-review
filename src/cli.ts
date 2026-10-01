/**
 * The `deep-review` command (R1, R13 of the read-only review): `review` runs
 * a review to its report in the foreground and is resumable, `status` prints
 * the fold of a run, `abandon` closes one, and `snapshot` is what a fix
 * worker runs after each finding (R6 of the fix pass). The entry point of
 * the bundle and of `npm run review` during development.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Checkpoint } from './checkpoint/checkpoint.ts';
import { UnknownRunError } from './checkpoint/errors.ts';
import type { ScopeRequest } from './checkpoint/events.ts';
import type { RunState } from './checkpoint/fold.ts';
import { ledgerFileName } from './checkpoint/ledger.ts';
import { locateCheckpoint } from './checkpoint/locate.ts';
import { engineIdentity, engineRolesRoot } from './engine.ts';
import { EngineError } from './errors.ts';
import { findActiveRun, runReview, type ScopeSource } from './review/controller.ts';
import { ReviewRefusedError } from './review/errors.ts';
import { resolveExecutable } from './review/executable.ts';
import { acquireRunLock, acquireStartLock } from './review/lock.ts';
import { invocationFlagProblem, maxConcurrency, type PolicyFlags } from './review/policy.ts';
import { reviewStatus } from './review/state.ts';
import { takeSnapshot } from './review/snapshot.ts';
import { describeRun } from './review/status.ts';
import { defaultRuntimes } from './runtime/runtimes.ts';
import { status as gitStatus } from './scope/git.ts';

export const usage = `usage:
  deep-review review  --runtime claude|codex [--executable <path>] [--executable-arg <arg>]...
                      [--strong-model <model>] [--fast-model <model>]
                      (--last-commit | --worktree | --ref <ref> | --from <rev> --to <rev> [--merge-base])
                      [--path <path>]... [--concurrency 1..${String(maxConcurrency)}] [--budget-usd <usd>] [--repo <dir>] [--roles <dir>]
  deep-review status  [--run <id>] [--json] [--repo <dir>]
  deep-review abandon --reason <text> [--run <id>] [--repo <dir>]
  deep-review snapshot --finding <n> --into <dir> [--repo <dir>]   (run by a fix worker after each finding)

exit codes: 0 a report (its path is the last line of stdout) or a status; 2 a blocked run or a refusal, with the blocker and the operator's action on stderr; 1 any other error.`;

const options = {
  runtime: { type: 'string' },
  executable: { type: 'string' },
  'executable-arg': { type: 'string', multiple: true },
  'strong-model': { type: 'string' },
  'fast-model': { type: 'string' },
  'last-commit': { type: 'boolean' },
  worktree: { type: 'boolean' },
  ref: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  'merge-base': { type: 'boolean' },
  path: { type: 'string', multiple: true },
  concurrency: { type: 'string' },
  'budget-usd': { type: 'string' },
  repo: { type: 'string' },
  roles: { type: 'string' },
  run: { type: 'string' },
  json: { type: 'boolean' },
  reason: { type: 'string' },
  finding: { type: 'string' },
  into: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true; strict: true }>>['values'];

/** What the command writes to. */
export interface CommandIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}

/** The flags each command takes; any other given flag is refused by name. */
const allowed: Record<string, readonly (keyof Values)[]> = {
  review: ['runtime', 'executable', 'executable-arg', 'strong-model', 'fast-model', 'last-commit', 'worktree', 'ref', 'from', 'to', 'merge-base', 'path', 'concurrency', 'budget-usd', 'repo', 'roles', 'help'],
  status: ['run', 'json', 'repo', 'help'],
  abandon: ['reason', 'run', 'repo', 'help'],
  snapshot: ['finding', 'into', 'repo', 'help'],
};

/** A command-line mistake: the usage is printed with it. */
export class UsageError extends EngineError {
  override readonly name = 'UsageError';
}

function number(flag: string, text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const value = Number(text);
  if (text.trim() === '' || !Number.isFinite(value)) throw new UsageError(`${flag} must be a number, not ${JSON.stringify(text)}`);
  return value;
}

/** Whether any scope flag is given. */
export function hasScopeFlags(values: Values): boolean {
  return values['last-commit'] === true || values.worktree === true || values.ref !== undefined || values.from !== undefined || values.to !== undefined || values['merge-base'] === true || (values.path?.length ?? 0) > 0;
}

/** The scope request the flags name, or null when no scope flag is given; more than one mode is refused. */
export function scopeRequestOf(values: Values, worktree: string): { mode: 'last-commit' | 'worktree' | 'ref' | 'range'; request: ScopeRequest } | null {
  const paths = values.path ?? [];
  const modes = [values['last-commit'] === true, values.worktree === true, values.ref !== undefined, values.from !== undefined || values.to !== undefined].filter(Boolean).length;
  if (modes > 1) throw new UsageError('choose one scope: --last-commit, --worktree, --ref <ref>, or --from <rev> --to <rev>');
  if (values['merge-base'] === true && values.from === undefined) throw new UsageError('--merge-base applies to --from and --to only');
  if (values['last-commit'] === true) {
    if (gitStatus(worktree).length > 0) throw new UsageError('--last-commit reviews the last commit of a clean tree, and this tree has uncommitted changes; use --worktree to review them');
    return { mode: 'last-commit', request: { paths } };
  }
  if (values.worktree === true) {
    if (gitStatus(worktree).length === 0) throw new UsageError('--worktree reviews uncommitted changes, and this tree has none; use --last-commit to review the last commit');
    return { mode: 'worktree', request: { paths } };
  }
  if (values.ref !== undefined) return { mode: 'ref', request: { ref: values.ref, paths } };
  if (values.from !== undefined || values.to !== undefined) {
    if (values.from === undefined || values.to === undefined) throw new UsageError('--from and --to go together');
    return { mode: 'range', request: { range: { from: values.from, to: values.to, mergeBase: values['merge-base'] === true }, paths } };
  }
  return null;
}

/** Run the command line and return the exit code. */
export async function main(argv: readonly string[], io: CommandIo): Promise<number> {
  try {
    return await run(argv, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n\n${usage}\n`);
      return 1;
    }
    // Every refusal exits 2, as the usage promises; one with a blocker code names it.
    if (error instanceof ReviewRefusedError) {
      io.stderr(error.code === null ? `refused: ${error.message}\n` : `blocked (${error.code}): ${error.message}\n`);
      return 2;
    }
    if (error instanceof EngineError) {
      io.stderr(`${error.name}: ${error.message}\n`);
      return 1;
    }
    io.stderr(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return 1;
  }
}

async function run(argv: readonly string[], io: CommandIo): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true; strict: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help === true || command === undefined) {
    io.stdout(`${usage}\n`);
    return command === undefined && values.help !== true ? 1 : 0;
  }
  if (!Object.hasOwn(allowed, command)) throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  if (rest.length > 0) throw new UsageError(`unexpected argument ${JSON.stringify(rest[0])}`);
  for (const flag of Object.keys(values) as (keyof Values)[]) {
    if (values[flag] !== undefined && !allowed[command]!.includes(flag)) throw new UsageError(`--${flag} does not apply to ${command}`);
  }
  const location = locateCheckpoint(values.repo === undefined ? io.cwd : resolve(io.cwd, values.repo));
  switch (command) {
    case 'review':
      return review(values, io, location.root, location.worktree);
    case 'status':
      return status(values, io, location.root);
    case 'snapshot':
      return snapshot(values, io, location.worktree);
    default:
      return abandon(values, io, location.root);
  }
}

/** Copy the worktree's changed and expected paths into a fixer's snapshot directory after one finding (R6 of the fix pass); reads no ledger, so a sandbox that keeps the git directory read-only runs it. */
function snapshot(values: Values, io: CommandIo, worktree: string): number {
  const finding = values.finding;
  if (finding === undefined || !/^(0|[1-9][0-9]{0,5})$/.test(finding)) throw new UsageError(`--finding must be a finding's index, a whole number from 0, not ${JSON.stringify(finding ?? '')}`);
  if (values.into === undefined || values.into.trim() === '') throw new UsageError('--into <dir> is required');
  const into = resolve(io.cwd, values.into);
  const listing = takeSnapshot({ worktree, finding: Number(finding), into });
  io.stdout(`snapshot ${finding}: ${String(Object.keys(listing.paths).length)} paths into ${into}\n`);
  return 0;
}

/** Open the checkpoint with this engine's identity, or null when the repository has none and `create` is false. */
function openCheckpoint(root: string, create: boolean): Checkpoint | null {
  if (!create && !existsSync(join(root, ledgerFileName))) return null;
  return Checkpoint.open(root, { engine: engineIdentity() });
}

async function review(values: Values, io: CommandIo, root: string, worktree: string): Promise<number> {
  if (values.runtime === undefined) throw new UsageError('--runtime claude|codex is required');
  const runtimes = defaultRuntimes();
  if (!runtimes.names().includes(values.runtime)) throw new UsageError(`--runtime must be one of ${runtimes.names().join(', ')}, not ${JSON.stringify(values.runtime)}`);
  const concurrency = number('--concurrency', values.concurrency);
  const budgetUsd = number('--budget-usd', values['budget-usd']);
  const flags: PolicyFlags = {
    ...(values['strong-model'] === undefined ? {} : { strongModel: values['strong-model'] }),
    ...(values['fast-model'] === undefined ? {} : { fastModel: values['fast-model'] }),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
  };
  // A malformed value is a command-line mistake, refused with the usage before the checkpoint is opened; the policy refuses it with the same message for a caller that does not come through here.
  const problem = invocationFlagProblem(flags);
  if (problem !== null) throw new UsageError(problem);
  const checkpoint = openCheckpoint(root, true)!;
  try {
    // The controller resolves the scope only for a run that has none yet: a resumed run keeps the scope it captured, so its flags are not even checked against the tree, which may have moved on.
    const scope: ScopeSource = {
      named: hasScopeFlags(values),
      request: () => {
        const chosen = scopeRequestOf(values, worktree);
        if (chosen === null) throw new UsageError('a new run needs its scope: --last-commit, --worktree, --ref <ref>, or --from <rev> --to <rev>');
        return chosen.request;
      },
    };
    const runtime = values.runtime;
    const outcome = await runReview({
      checkpoint,
      worktree,
      runtimes,
      runtime,
      // Resolved, and a shim refused, only for a run not yet configured: a configured run preflights and launches the executable it pinned.
      executable: () => resolveExecutable(values.executable ?? runtime, io.environment, process.platform, io.cwd),
      executableArgs: values['executable-arg'] ?? [],
      rolesRoot: values.roles ?? engineRolesRoot(),
      flags,
      scope,
      environment: io.environment,
      log: (line) => io.stderr(`${line}\n`),
    });
    if (outcome.kind === 'report') {
      io.stdout(`${outcome.reportPath}\n`);
      return 0;
    }
    io.stderr(`blocked in ${outcome.blocker.phase} (${outcome.blocker.code}): ${outcome.blocker.detail}\naction: ${outcome.blocker.action}\n`);
    return 2;
  } finally {
    checkpoint.close();
  }
}

/** The run a command names with --run, or else the active run, null when there is none; an id the checkpoint does not hold is a usage error. */
function resolveRun(checkpoint: Checkpoint, run: string | undefined): RunState | null {
  if (run === undefined) return findActiveRun(checkpoint);
  try {
    return checkpoint.fold(run);
  } catch (error) {
    if (error instanceof UnknownRunError) throw new UsageError(error.message);
    throw error;
  }
}

function status(values: Values, io: CommandIo, root: string): number {
  const checkpoint = openCheckpoint(root, false);
  if (checkpoint === null) {
    io.stdout(values.json === true ? 'null\n' : 'No run: this repository has no checkpoint yet.\n');
    return 0;
  }
  try {
    const state = resolveRun(checkpoint, values.run);
    if (state === null) {
      io.stdout(values.json === true ? 'null\n' : 'No active run.\n');
      return 0;
    }
    const adapter = defaultRuntimes().get(state.review?.configuration.runtime ?? 'claude');
    const described = describeRun(state, adapter, (reference) => checkpoint.evidence.pathOf(reference));
    io.stdout(values.json === true ? `${JSON.stringify(described.json, null, 2)}\n` : `${described.lines.join('\n')}\n`);
    return 0;
  } finally {
    checkpoint.close();
  }
}

function abandon(values: Values, io: CommandIo, root: string): number {
  if (values.reason === undefined || values.reason.trim() === '') throw new UsageError('--reason <text> is required');
  const checkpoint = openCheckpoint(root, false);
  if (checkpoint === null) throw new UsageError('this repository has no checkpoint, so there is no run to abandon');
  try {
    // Under the start lock, as a review finds or creates its run: an engine resuming the run cannot slip between the find and the append.
    const releaseStart = acquireStartLock(checkpoint.root);
    try {
      const found = resolveRun(checkpoint, values.run);
      if (found === null) throw new UsageError('no active run to abandon');
      const release = acquireRunLock(checkpoint.root, found.id);
      try {
        // Folded again under the run's lock: an engine that held it until a moment ago may have written the report since.
        const state = checkpoint.fold(found.id);
        const status = reviewStatus(state);
        // A complete run keeps its report and its status; the ledger could still take the event, since a review run is never closed.
        if (status === 'complete' || status === 'abandoned') throw new UsageError(`run ${state.id} is ${status}; only an active or blocked run can be abandoned`);
        checkpoint.append(state.id, state.lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: values.reason } }]);
      } finally {
        release();
      }
      io.stdout(`run ${found.id} abandoned: ${values.reason}\n`);
      return 0;
    } finally {
      releaseStart();
    }
  } finally {
    checkpoint.close();
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    environment: process.env,
    cwd: process.cwd(),
  });
}
