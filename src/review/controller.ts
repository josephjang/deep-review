/**
 * The controller (R1, R5, R6, R7 of the read-only review; TD1, TD5, TD6):
 * find or create the run, take its lock, record the workers a previous
 * engine lost, then loop over fold, plan, execute and append until the
 * report is written or the run blocks. Every fact the planner needs is an
 * event, so a resumed run continues from the last step the ledger holds.
 */
import { resolve } from 'node:path';
import type { Checkpoint, NewEvent } from '../checkpoint/checkpoint.ts';
import type { Blocker, ReviewConfiguration, ReviewLimits, ScopeRequest } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { assembleRoles, type AssembledRole } from '../roles/assemble.ts';
import type { RuntimeAdapter } from '../runtime/adapter.ts';
import { PreflightError } from '../runtime/errors.ts';
import { runWorker, type WorkerReceipt } from '../runtime/launcher.ts';
import { preflight, type PreflightOptions } from '../runtime/preflight.ts';
import type { RuntimeRegistry } from '../runtime/registry.ts';
import { captureScope } from '../scope/capture.ts';
import { compareWorktree } from '../scope/compare.ts';
import { conventionFiles } from './conventions.ts';
import { InvalidPolicyError, ReviewRefusedError } from './errors.ts';
import { parseUnitLabel } from './labels.ts';
import { acquireRunLock, acquireStartLock, releaseOnExit, type ReleaseLock } from './lock.ts';
import { contributionOf, invocationFor, type PhaseContext } from './phases.ts';
import { readPolicy, resolvePolicy, rolesDigest, type PolicyFlags } from './policy.ts';
import { scopeBlock } from './prompts.ts';
import { renderReport } from './report.ts';
import { runSpendUsd, statisticsOf } from './spend.ts';
import { currentPhase, reviewStatus } from './state.ts';
import { driftBlocker, nextStep, type Live, type Unit } from './steps.ts';
import { blockerActions, unitName, type Phase } from './vocabulary.ts';

/**
 * The scope a command asks for. It is resolved only when the run it acts
 * on has none captured (a new run, or one whose capture failed), and a run
 * that has one keeps it, so the request is not even checked against a tree
 * that may have moved on.
 */
export interface ScopeSource {
  /** Whether the command named a scope, so a resumed run that ignores it can say so. */
  readonly named: boolean;
  /** The request to capture; throws, creating nothing, when the command names none or one the tree refutes. */
  readonly request: () => ScopeRequest;
}

export interface ReviewOptions {
  readonly checkpoint: Checkpoint;
  /** The worktree the review runs in; workers use it as their working directory. */
  readonly worktree: string;
  readonly runtimes: RuntimeRegistry;
  readonly runtime: string;
  readonly executable: string;
  readonly executableArgs?: readonly string[];
  readonly rolesRoot: string;
  readonly flags: PolicyFlags;
  /** The scope of a new run, or of an active one that has none yet; a run that captured one keeps it. */
  readonly scope: ScopeSource;
  readonly environment?: NodeJS.ProcessEnv;
  readonly scratchRoot?: string;
  /** The home directory the rules files are looked for under; the user's by default. */
  readonly home?: string;
  /** Progress, one line at a time; stderr by default. */
  readonly log?: (line: string) => void;
  readonly preflightOptions?: PreflightOptions;
}

export type ReviewOutcome =
  | { readonly kind: 'report'; readonly runId: string; readonly reportPath: string }
  | { readonly kind: 'blocked'; readonly runId: string; readonly blocker: Blocker & { readonly phase: Phase } };

/** How a launched worker settles: with its receipt, or with the error the launcher threw instead of one. */
type Settled = { readonly unit: Unit; readonly receipt: WorkerReceipt } | { readonly unit: Unit; readonly error: unknown };

/**
 * How a running worker is remembered until it settles. The promise never
 * rejects, so a launcher error is handled when the controller awaits it
 * and is never an unhandled rejection while another worker is awaited.
 */
interface InFlight {
  readonly unit: Unit;
  readonly startedAt: number;
  readonly promise: Promise<Settled>;
}

/** Whether a review may resume the run: it is active and has no report. A run created by another tool has no review; one that crashed before its scope or configuration is resumed by completing them. */
export function isResumable(run: RunState): boolean {
  return run.status === 'active' && (run.review === null || run.review.report === null);
}

/** The active runs a review may resume: those without a report. */
export function resumableRuns(checkpoint: Checkpoint): RunState[] {
  return checkpoint.listRuns().filter(isResumable);
}

/** The one run to resume, or null when there is none; two are refused, naming them. */
export function findActiveRun(checkpoint: Checkpoint): RunState | null {
  const runs = resumableRuns(checkpoint);
  if (runs.length > 1) {
    throw new ReviewRefusedError(`${String(runs.length)} runs are active (${runs.map((run) => run.id).join(', ')}); abandon all but one with \`deep-review abandon --run <id> --reason <text>\``);
  }
  return runs[0] ?? null;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const usd = (value: number | null): string => (value === null ? '' : `, ${value.toFixed(2)} USD`);

/** Run a review to its report or its blocker. */
export async function runReview(options: ReviewOptions): Promise<ReviewOutcome> {
  const log = options.log ?? ((line: string): void => {
    process.stderr.write(`${line}\n`);
  });
  const environment = options.environment ?? process.env;
  const adapter = options.runtimes.get(options.runtime);
  const roles = assembleRoles(options.rolesRoot);
  const rolesByKey = new Map(roles.map((role) => [role.key, role]));

  const { checkpoint } = options;
  const opened = await openRun({ ...options, log, environment, adapter, roles });
  let state = opened.state;
  const runId = state.id;
  const { release, scopeRequest, configure } = opened;
  const inFlight = new Map<string, InFlight>();
  /** Log a settled worker and append what it contributes; a launcher error is thrown, since nothing was recorded for its unit. */
  const record = (settled: Settled, startedAt: number): void => {
    const name = unitName(settled.unit.phase, settled.unit.key);
    // The launcher threw instead of returning a receipt (a run abandoned meanwhile, an invocation it refused, a runtime that no longer qualifies): the review cannot go on.
    if ('error' in settled) throw settled.error;
    const summary = adapter.summarizeUsage(settled.receipt.runtime.usage);
    log(`worker ${settled.unit.role} ${name}: ${settled.receipt.outcome} in ${seconds(Date.now() - startedAt)}${usd(summary.costUsd)}${settled.receipt.error === null ? '' : `: ${settled.receipt.error}`}`);
    state = checkpoint.fold(runId);
    const event = contributionOf(settled.unit, settled.receipt, state, options.worktree);
    if (event.kind === 'attempt.failed') log(`worker ${settled.unit.role} ${name}: attempt failed: ${(event.payload as { reason: string }).reason}`);
    state = append(checkpoint, state, [event]);
  };
  try {
    if (scopeRequest !== null) {
      state = captureScope(checkpoint, runId, scopeRequest);
      log(`run ${runId}: scope captured, ${String(state.scope!.files.length)} files`);
    }
    if (configure !== null) {
      state = append(checkpoint, state, [{ kind: 'review.configured', version: 1, payload: configure }]);
      log(`run ${runId}: configured for ${configure.runtime} ${configure.version}, models ${configure.models.strong} and ${configure.models.fast}`);
    }
    const configuration = state.review!.configuration;
    state = recordLimits(checkpoint, state, limitsInForce(configuration, options.flags, adapter), log);
    state = recordLostWorkers(checkpoint, state, log);
    state = reenterPhase(checkpoint, state, log);

    const scope = state.scope!;
    const block = scopeBlock({ worktree: options.worktree, scope, evidence: checkpoint.evidence, conventions: conventionFiles(options.worktree, scope.files.map((file) => file.path), options.home) });

    for (;;) {
      const review = state.review!;
      const live: Live = { running: new Set(inFlight.keys()), spendUsd: runSpendUsd(state, adapter) };
      const step = nextStep(review, live);
      switch (step.kind) {
        case 'blocked':
          log(`run ${runId}: blocked in ${step.blocker.phase} (${step.blocker.code}): ${step.blocker.detail}`);
          return { kind: 'blocked', runId, blocker: step.blocker };
        case 'complete':
          return { kind: 'report', runId, reportPath: checkpoint.evidence.pathOf(review.report!.report) };
        case 'start-phase':
          log(`phase ${step.phase}: started (attempt ${String(step.attempt)})`);
          state = append(checkpoint, state, [{ kind: 'phase.started', version: 1, payload: { phase: step.phase, attempt: step.attempt } }]);
          break;
        case 'check-worktree': {
          const comparison = compareWorktree(scope, options.worktree);
          const drifted = comparison.files.filter((file) => file.outcome !== 'unchanged') as { path: string; outcome: 'modified' | 'deleted' | 'restored' }[];
          const events: NewEvent[] = [{ kind: 'worktree.checked', version: 1, payload: { phase: step.phase, attempt: step.attempt, drifted: drifted.length > 0, files: drifted } }];
          if (drifted.length > 0) {
            const blocker = driftBlocker(drifted);
            events.push({ kind: 'phase.finished', version: 1, payload: { phase: step.phase, attempt: step.attempt, outcome: 'blocked', blocker } });
            log(`phase ${step.phase}: the worktree drifted from the scope: ${drifted.map((file) => `${file.path} (${file.outcome})`).join(', ')}`);
          }
          state = append(checkpoint, state, events);
          break;
        }
        case 'plan-verification':
          log(`phase ${step.phase}: ${String(step.groups.length)} group${step.groups.length === 1 ? '' : 's'} planned`);
          state = append(checkpoint, state, [{ kind: 'verification.planned', version: 1, payload: { phase: step.phase, groups: step.groups } }]);
          break;
        case 'degrade':
          for (const degradation of step.degradations) log(`phase ${step.phase}: ${degradation.kind === 'angle.failed' ? `angle ${degradation.angle} not run` : `group ${degradation.groupId} unverified`}: ${degradation.reason}`);
          state = append(checkpoint, state, step.degradations.map((degradation): NewEvent => (degradation.kind === 'angle.failed'
            ? { kind: 'angle.failed', version: 1, payload: { angle: degradation.angle, reason: degradation.reason } }
            : { kind: 'group.unverified', version: 1, payload: { phase: degradation.phase, groupId: degradation.groupId, reason: degradation.reason } })));
          break;
        case 'launch': {
          const context: PhaseContext = { state, worktree: options.worktree, roles: rolesByKey, configuration, scopeBlock: block };
          for (const unit of step.units) {
            const invocation = invocationFor(unit, context);
            log(`worker ${unit.role} ${unit.phase}:${unit.key}: started`);
            const startedAt = Date.now();
            const promise: Promise<Settled> = runWorker(checkpoint, runId, invocation, { runtimes: options.runtimes, environment, ...(options.scratchRoot === undefined ? {} : { scratchRoot: options.scratchRoot }) })
              .then((receipt): Settled => ({ unit, receipt }), (error: unknown): Settled => ({ unit, error }));
            inFlight.set(unitName(unit.phase, unit.key), { unit, startedAt, promise });
          }
          break;
        }
        case 'await': {
          const { settled, startedAt } = await nextSettled(inFlight);
          record(settled, startedAt);
          break;
        }
        case 'finish-phase':
          log(`phase ${step.phase}: ${step.outcome}${step.blocker === null ? '' : ` (${step.blocker.code}): ${step.blocker.detail}`}`);
          state = append(checkpoint, state, [{ kind: 'phase.finished', version: 1, payload: { phase: step.phase, attempt: step.attempt, outcome: step.outcome, blocker: step.blocker } }]);
          break;
        case 'write-report': {
          const statistics = statisticsOf(state, adapter);
          const report = checkpoint.evidence.put(renderReport(state, { engine: checkpoint.engine, statistics }));
          state = append(checkpoint, state, [
            { kind: 'report.written', version: 1, payload: { report, statistics } },
            { kind: 'phase.finished', version: 1, payload: { phase: 'report', attempt: state.review!.phases.report.attempt, outcome: 'completed', blocker: null } },
          ]);
          log(`run ${runId}: report written to ${checkpoint.evidence.pathOf(report)}`);
          break;
        }
      }
    }
  } catch (error) {
    // A worker's own preflight failed: the runtime stopped qualifying mid-run (an update, a removed binary), which is refused as at startup.
    throw refusalOf(error);
  } finally {
    // No way out of the loop leaves a worker running: after a launcher error,
    // a failed append or any other throw, the rest are awaited and their
    // answers recorded, so every finish reaches the ledger before the lock
    // is released and the caller closes the checkpoint. A failure to record
    // one is logged; the error that ended the loop is the one that surfaces.
    if (inFlight.size > 0) log(`run ${runId}: waiting for ${String(inFlight.size)} worker${inFlight.size === 1 ? '' : 's'} in flight`);
    while (inFlight.size > 0) {
      const { settled, startedAt } = await nextSettled(inFlight);
      try {
        record(settled, startedAt);
      } catch (error) {
        log(`worker ${settled.unit.role} ${unitName(settled.unit.phase, settled.unit.key)}: not recorded: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    release();
  }
}

/** A failed preflight as the `runtime-unqualified` refusal, with the operator's action; any other error as it is. */
function refusalOf(error: unknown): unknown {
  return error instanceof PreflightError ? new ReviewRefusedError(`${error.message}; ${blockerActions['runtime-unqualified']}`, 'runtime-unqualified') : error;
}

/** The first worker in flight to settle, taken off the map, with the time it started. */
async function nextSettled(inFlight: Map<string, InFlight>): Promise<{ settled: Settled; startedAt: number }> {
  const settled = await Promise.race([...inFlight.values()].map((entry) => entry.promise));
  const name = unitName(settled.unit.phase, settled.unit.key);
  const entry = inFlight.get(name)!;
  inFlight.delete(name);
  return { settled, startedAt: entry.startedAt };
}

/** What opening a run needs beyond the review's options. */
interface OpenContext extends ReviewOptions {
  readonly log: (line: string) => void;
  readonly environment: NodeJS.ProcessEnv;
  readonly adapter: RuntimeAdapter;
  readonly roles: readonly AssembledRole[];
}

/** An open run: its state, the release of its lock, and what it still needs before its first step. */
interface OpenedRun {
  readonly state: RunState;
  readonly release: ReleaseLock;
  /** The scope to capture, for a run that has none yet; null for one that captured it. */
  readonly scopeRequest: ScopeRequest | null;
  /** The configuration to pin, for a run not yet configured; null for one whose configuration is pinned. */
  readonly configure: ReviewConfiguration | null;
}

/**
 * Find the active run or create one, and take its run lock, all under the
 * checkpoint's start lock: two engines started together would otherwise
 * both find no run and create one each. A found run is read again once its
 * lock is held, since the engine that held the lock until a moment ago may
 * have appended after the find (a late worker finish, its report); one no
 * longer resumable is let go, and a run is created as if none had been
 * found. Everything that depends on the run is decided from that one read:
 *
 * - A run with no scope yet, new or left by a capture that failed, gets
 *   the command's scope request, resolved before a new run is created so
 *   a refused request creates nothing; a run that has one ignores the
 *   command's, and says so.
 * - A configured run reads its pinned configuration, not the policy file
 *   or the flags (R3, design: role policy): its roles must still digest
 *   as pinned, and its pinned executable is what is preflighted. Only
 *   `--concurrency` and `--budget-usd` apply per invocation, and the
 *   limits they put in force are recorded when they change. A run not yet
 *   configured resolves the policy and preflights the command's
 *   executable, before a new run is created so a refusal creates nothing.
 *
 * The run lock is taken before the preflight for a found run, so an
 * engine running it refuses this one at once, and is released on every
 * way out: the caller's release, the process's exit, and a signal that
 * ends it (design, run lifecycle step 2).
 */
async function openRun(context: OpenContext): Promise<OpenedRun> {
  const { checkpoint, log } = context;
  const releaseStart = releaseOnExit(acquireStartLock(checkpoint.root));
  let release: ReleaseLock | null = null;
  try {
    let found = findActiveRun(checkpoint);
    // The checkpoint is shared by every worktree of the repository, while a run's scope, worktree checks and workers belong to the worktree it was created in.
    if (found !== null && !sameDirectory(found.worktree, context.worktree)) {
      throw new ReviewRefusedError(`run ${found.id} is active in worktree ${found.worktree}, not ${context.worktree}; run the command there, or abandon the run with \`deep-review abandon --run ${found.id} --reason <text>\``);
    }
    if (found !== null) {
      release = releaseOnExit(acquireRunLock(checkpoint.root, found.id));
      // Read again under the lock: what the find returned may predate the last appends of the engine that held it.
      found = checkpoint.fold(found.id);
      if (!isResumable(found)) {
        log(`run ${found.id}: ${reviewStatus(found)} before its lock was taken; a new run is created`);
        release();
        release = null;
        found = null;
      }
    }
    const pinned = found?.review?.configuration ?? null;
    if (found !== null && pinned !== null && pinned.runtime !== context.runtime) {
      throw new ReviewRefusedError(`run ${found.id} is pinned to runtime ${pinned.runtime}, not ${context.runtime}; run it with --runtime ${pinned.runtime}, or abandon it`);
    }
    if (found !== null) {
      log(`run ${found.id}: resuming${found.scope === null ? '; it has no scope yet and captures the one this command names' : ''}`);
      if (found.scope !== null && context.scope.named) log(`run ${found.id} is active; its scope flags are ignored and the run continues`);
    }
    const scopeRequest = found === null || found.scope === null ? context.scope.request() : null;
    let configure: ReviewConfiguration | null = null;
    if (found !== null && pinned !== null) {
      await resumePinned(found.id, pinned, context);
    } else {
      const resolved = resolvePolicy(readPolicy(context.rolesRoot), context.roles, context.adapter, context.flags);
      const executableArgs = [...(context.executableArgs ?? [])];
      const version = await qualify(context.adapter, context.executable, executableArgs, context);
      configure = { ...resolved, roles: [...resolved.roles], executable: context.executable, executableArgs, version };
    }
    const state = found ?? checkpoint.createRun({ worktree: context.worktree });
    if (found === null) {
      release = releaseOnExit(acquireRunLock(checkpoint.root, state.id));
      log(`run ${state.id}: created`);
    }
    return { state, release: release!, scopeRequest, configure };
  } catch (error) {
    release?.();
    throw error;
  } finally {
    releaseStart();
  }
}

/**
 * Hold a configured run to what it pinned before it resumes: the role
 * prompts it ran must still digest as pinned, so the report's digest says
 * which prompts every worker got; the flags that apply per invocation are
 * checked as a new run's are, and the model flags, which do not apply,
 * are named as ignored; the pinned executable, not the command's, must
 * still qualify.
 */
async function resumePinned(runId: string, pinned: ReviewConfiguration, context: OpenContext): Promise<void> {
  const digest = rolesDigest(context.roles);
  if (digest !== pinned.rolesDigest) {
    throw new ReviewRefusedError(`run ${runId} was configured with roles digest ${pinned.rolesDigest}, and the roles at ${context.rolesRoot} now digest ${digest}; run it with the roles it started with (--roles <dir>), or abandon it with \`deep-review abandon --run ${runId} --reason <text>\``);
  }
  refuseInvocationFlags(context.adapter, context.flags);
  if (context.flags.strongModel !== undefined || context.flags.fastModel !== undefined) {
    context.log(`run ${runId} is pinned to models ${pinned.models.strong} and ${pinned.models.fast}; --strong-model and --fast-model are ignored`);
  }
  await qualify(context.adapter, pinned.executable, pinned.executableArgs, context);
}

/**
 * The checks `resolvePolicy` makes of the two flags a resumed run still
 * takes, with its messages: a budget on a runtime that reports no cost
 * could never be checked, and a concurrency outside 1 to 16 or a budget
 * that is not positive is malformed.
 */
function refuseInvocationFlags(adapter: RuntimeAdapter, flags: PolicyFlags): void {
  if (flags.budgetUsd !== undefined && !adapter.capabilities.costInUsd) {
    throw new InvalidPolicyError(`--budget-usd does not apply to runtime ${adapter.name}, which reports no cost in USD; the run has no budget there`);
  }
  if (flags.concurrency !== undefined && (!Number.isInteger(flags.concurrency) || flags.concurrency < 1 || flags.concurrency > 16)) {
    throw new InvalidPolicyError(`--concurrency must be a whole number from 1 to 16, not ${String(flags.concurrency)}`);
  }
  if (flags.budgetUsd !== undefined && !(Number.isFinite(flags.budgetUsd) && flags.budgetUsd > 0)) {
    throw new InvalidPolicyError(`--budget-usd must be a positive number, not ${String(flags.budgetUsd)}`);
  }
}

/** Preflight the executable and return its version, or refuse with `runtime-unqualified`. */
async function qualify(adapter: RuntimeAdapter, executable: string, executableArgs: readonly string[], context: OpenContext): Promise<string> {
  try {
    return await preflight(adapter, executable, [...executableArgs], context.environment, context.preflightOptions ?? {});
  } catch (error) {
    throw refusalOf(error);
  }
}

/** Whether two worktree paths name one directory: the same resolved path, compared without case on Windows, whose paths are case-insensitive. */
function sameDirectory(a: string, b: string): boolean {
  const [left, right] = [resolve(a), resolve(b)];
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Append with the state's sequence, once. While it holds the run lock the
 * controller is the run's one writer: another engine and `abandon` take
 * that lock first; a found run is read again once its lock is held; and
 * the launchers of the workers in flight append only while the controller
 * awaits them, after which `record` folds afresh. So the events were
 * planned from the ledger as it is, and a `StaleRevisionError` means
 * another writer broke in: it is thrown, never retried, since a retry would
 * re-send events planned without what that writer appended.
 */
function append(checkpoint: Checkpoint, state: RunState, events: readonly NewEvent[]): RunState {
  return checkpoint.append(state.id, state.lastSequence, events);
}

/**
 * The concurrency and the run budget this invocation puts in force: each
 * flag when given, else the pinned value. Both are per invocation, since a
 * higher budget is how a budget blocker is cleared and a smaller
 * concurrency is how a machine is spared. A runtime that reports no cost
 * has no budget to check.
 */
function limitsInForce(configuration: ReviewConfiguration, flags: PolicyFlags, adapter: RuntimeAdapter): ReviewLimits {
  return {
    concurrency: flags.concurrency ?? configuration.concurrency,
    runBudgetUsd: adapter.capabilities.costInUsd ? (flags.budgetUsd ?? configuration.runBudgetUsd) : null,
  };
}

/** Record the limits this invocation puts in force when they differ from the ones the run has, so the planner, `status` and the report read the ones in force. */
function recordLimits(checkpoint: Checkpoint, state: RunState, limits: ReviewLimits, log: (line: string) => void): RunState {
  const current = state.review!.limits;
  if (current.concurrency === limits.concurrency && current.runBudgetUsd === limits.runBudgetUsd) return state;
  log(`run ${state.id}: limits in force: concurrency ${String(limits.concurrency)}, ${limits.runBudgetUsd === null ? 'no run budget' : `run budget ${limits.runBudgetUsd.toFixed(2)} USD`}`);
  return append(checkpoint, state, [{ kind: 'limits.changed', version: 1, payload: limits }]);
}

/** Every worker still running on the ledger died with the engine that launched it, or was orphaned by a hard kill: record each lost (TD5). */
function recordLostWorkers(checkpoint: Checkpoint, state: RunState, log: (line: string) => void): RunState {
  const running = Object.values(state.workers).filter((worker) => worker.status === 'running');
  if (running.length === 0) return state;
  const events = running.map((worker): NewEvent => {
    const unit = parseUnitLabel(worker.launch.label);
    log(`worker ${worker.launch.label ?? worker.launch.workerId}: lost with the previous engine`);
    return { kind: 'worker.lost', version: 1, payload: { workerId: worker.launch.workerId, phase: unit?.phase ?? null, key: unit?.key ?? null, reason: 'the engine exited while the worker ran' } };
  });
  return append(checkpoint, state, events);
}

/** A phase left running or blocked by a previous engine is re-entered at the next attempt, which checks the worktree again and clears a blocker. */
function reenterPhase(checkpoint: Checkpoint, state: RunState, log: (line: string) => void): RunState {
  const review = state.review!;
  const phase = currentPhase(review);
  if (phase === null) return state;
  const attempt = review.phases[phase].attempt + 1;
  log(`phase ${phase}: re-entered (attempt ${String(attempt)})${review.blocker === null ? '' : `, clearing the ${review.blocker.code} blocker`}`);
  return append(checkpoint, state, [{ kind: 'phase.started', version: 1, payload: { phase, attempt } }]);
}
