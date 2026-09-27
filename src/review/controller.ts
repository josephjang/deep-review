/**
 * The controller (R1, R5, R6, R7 of the read-only review; TD1, TD5, TD6):
 * find or create the run, take its lock, record the workers a previous
 * engine lost, then loop over fold, plan, execute and append until the
 * report is written or the run blocks. Every fact the planner needs is an
 * event, so a resumed run continues from the last step the ledger holds.
 */
import type { Checkpoint, NewEvent } from '../checkpoint/checkpoint.ts';
import { StaleRevisionError } from '../checkpoint/errors.ts';
import type { Blocker, ReviewConfiguration, ScopeRequest } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { assembleRoles } from '../roles/assemble.ts';
import type { RuntimeAdapter } from '../runtime/adapter.ts';
import { PreflightError } from '../runtime/errors.ts';
import { runWorker, type WorkerReceipt } from '../runtime/launcher.ts';
import { preflight, type PreflightOptions } from '../runtime/preflight.ts';
import type { RuntimeRegistry } from '../runtime/registry.ts';
import { captureScope } from '../scope/capture.ts';
import { compareWorktree } from '../scope/compare.ts';
import { conventionFiles } from './conventions.ts';
import { ReviewRefusedError } from './errors.ts';
import { parseUnitLabel } from './labels.ts';
import { acquireRunLock, releaseOnExit } from './lock.ts';
import { contributionOf, invocationFor, type PhaseContext } from './phases.ts';
import { readPolicy, resolvePolicy, type PolicyFlags } from './policy.ts';
import { scopeBlock } from './prompts.ts';
import { renderReport } from './report.ts';
import { runSpendUsd, statisticsOf } from './spend.ts';
import { reviewStatus } from './state.ts';
import { driftBlocker, nextStep, type Live, type Unit } from './steps.ts';
import { blockerActions, unitName, type Phase } from './vocabulary.ts';

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
  /** The scope of a new run; a resumed run keeps the scope it captured. */
  readonly scope: ScopeRequest;
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

/** How many times an append is re-folded and retried when a launcher's finish got there first. */
const appendAttempts = 50;

/** The active runs a review may resume: those without a report. A run created by another tool has no review; one that crashed before its scope or configuration is resumed by completing them. */
export function resumableRuns(checkpoint: Checkpoint): RunState[] {
  return checkpoint.listRuns().filter((run) => run.status === 'active' && (run.review === null || run.review.report === null));
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
  const executableArgs = [...(options.executableArgs ?? [])];
  const roles = assembleRoles(options.rolesRoot);
  const rolesByKey = new Map(roles.map((role) => [role.key, role]));
  const resolved = resolvePolicy(readPolicy(options.rolesRoot), roles, adapter, options.flags);

  let version: string;
  try {
    version = await preflight(adapter, options.executable, executableArgs, environment, options.preflightOptions ?? {});
  } catch (error) {
    if (error instanceof PreflightError) throw new ReviewRefusedError(`${error.message}; ${blockerActions['runtime-unqualified']}`, 'runtime-unqualified');
    throw error;
  }

  const { checkpoint } = options;
  let state = findActiveRun(checkpoint);
  if (state !== null && state.review !== null && state.review.configuration.runtime !== options.runtime) {
    throw new ReviewRefusedError(`run ${state.id} is pinned to runtime ${state.review.configuration.runtime}, not ${options.runtime}; run it with --runtime ${state.review.configuration.runtime}, or abandon it`);
  }
  if (state === null) {
    state = checkpoint.createRun({ worktree: options.worktree });
    log(`run ${state.id}: created`);
  } else {
    log(`run ${state.id}: resuming`);
  }
  const runId = state.id;
  // Released on every way out: the finally below, the process's exit, and a signal that ends it (design, run lifecycle step 2).
  const release = releaseOnExit(acquireRunLock(checkpoint.root, runId));
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
    if (state.scope === null) {
      state = captureScope(checkpoint, runId, options.scope);
      log(`run ${runId}: scope captured, ${String(state.scope!.files.length)} files`);
    }
    if (state.review === null) {
      const configuration: ReviewConfiguration = { ...resolved, roles: [...resolved.roles], executable: options.executable, executableArgs, version };
      state = checkpoint.append(runId, state.lastSequence, [{ kind: 'review.configured', version: 1, payload: configuration }]);
      log(`run ${runId}: configured for ${configuration.runtime} ${version}, models ${configuration.models.strong} and ${configuration.models.fast}`);
    }
    const configuration = state.review!.configuration;
    // Per invocation: a higher budget is how a budget blocker is cleared, and a smaller concurrency is how a machine is spared.
    const concurrency = options.flags.concurrency ?? configuration.concurrency;
    const budgetUsd = adapter.capabilities.costInUsd ? (options.flags.budgetUsd ?? configuration.runBudgetUsd) : null;

    state = recordLostWorkers(checkpoint, state, log);
    state = reenterPhase(checkpoint, state, log);

    const scope = state.scope!;
    const block = scopeBlock({ worktree: options.worktree, scope, evidence: checkpoint.evidence, conventions: conventionFiles(options.worktree, scope.files.map((file) => file.path), options.home) });

    for (;;) {
      const review = state.review!;
      const live: Live = { running: new Set(inFlight.keys()), concurrency, spendUsd: runSpendUsd(state, adapter), budgetUsd };
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

/** The first worker in flight to settle, taken off the map, with the time it started. */
async function nextSettled(inFlight: Map<string, InFlight>): Promise<{ settled: Settled; startedAt: number }> {
  const settled = await Promise.race([...inFlight.values()].map((entry) => entry.promise));
  const name = unitName(settled.unit.phase, settled.unit.key);
  const entry = inFlight.get(name)!;
  inFlight.delete(name);
  return { settled, startedAt: entry.startedAt };
}

/**
 * Append with the state's sequence, re-folding and retrying when another
 * writer got there first: the launchers of the workers in flight append
 * each finish themselves, so several may land between a fold and its
 * append. `abandon` can race a locked run too, and it closes the run, so
 * the retry then fails with the closed-run error.
 */
function append(checkpoint: Checkpoint, state: RunState, events: readonly NewEvent[]): RunState {
  let current = state;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return checkpoint.append(current.id, current.lastSequence, events);
    } catch (error) {
      if (!(error instanceof StaleRevisionError) || attempt >= appendAttempts) throw error;
      current = checkpoint.fold(current.id);
    }
  }
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
  const phase = (Object.keys(review.phases) as Phase[]).find((candidate) => review.phases[candidate].status === 'running' || review.phases[candidate].status === 'blocked');
  if (phase === undefined) return state;
  const attempt = review.phases[phase].attempt + 1;
  log(`phase ${phase}: re-entered (attempt ${String(attempt)})${review.blocker === null ? '' : `, clearing the ${review.blocker.code} blocker`}`);
  return append(checkpoint, state, [{ kind: 'phase.started', version: 1, payload: { phase, attempt } }]);
}

/** What `status` prints about a run, as text lines and as a JSON value. */
export function describeRun(state: RunState, adapter: Pick<RuntimeAdapter, 'summarizeUsage' | 'capabilities'>, evidencePath: (reference: { sha256: string; bytes: number }) => string): { lines: string[]; json: Record<string, unknown> } {
  const status = reviewStatus(state);
  const review = state.review;
  const workers = Object.values(state.workers);
  const counts = { running: workers.filter((worker) => worker.status === 'running').length, finished: workers.filter((worker) => worker.status === 'finished').length, lost: workers.filter((worker) => worker.status === 'lost').length };
  const statistics = review === null ? null : statisticsOf(state, adapter);
  const phase = review === null ? null : ((Object.keys(review.phases) as Phase[]).find((candidate) => review.phases[candidate].status === 'running' || review.phases[candidate].status === 'blocked') ?? null);
  const reportPath = review?.report === null || review?.report === undefined ? null : evidencePath(review.report.report);
  const lines = [
    `Run ${state.id}: ${status}${state.abandonReason === null ? '' : ` (${state.abandonReason})`}`,
    `Worktree: ${state.worktree}`,
    review === null ? 'Review: not configured' : `Runtime: ${review.configuration.runtime} ${review.configuration.version}; models ${review.configuration.models.strong} and ${review.configuration.models.fast}`,
    phase === null ? 'Phase: none running' : `Phase: ${phase} (attempt ${String(review!.phases[phase].attempt)}, ${review!.phases[phase].status})`,
    `Workers: ${String(counts.running)} running, ${String(counts.finished)} finished, ${String(counts.lost)} lost`,
    statistics === null
      ? 'Spend: none'
      : `Spend: ${statistics.total.costUsd === null ? 'no cost reported' : `${statistics.total.costUsd.toFixed(2)} USD`}${review?.configuration.runBudgetUsd === null || review?.configuration.runBudgetUsd === undefined ? '' : ` of ${review.configuration.runBudgetUsd.toFixed(2)} USD`}; ${statistics.total.inputTokens === null ? 'no tokens reported' : `${String(statistics.total.inputTokens)} input, ${String(statistics.total.outputTokens ?? 0)} output tokens`}`,
    ...(review?.blocker === null || review?.blocker === undefined ? [] : [`Blocker: ${review.blocker.code}: ${review.blocker.detail}`, `Action: ${review.blocker.action}`]),
    ...(reportPath === null ? [] : [`Report: ${reportPath}`]),
  ];
  const json = { runId: state.id, status, worktree: state.worktree, phase, workers: counts, statistics, blocker: review?.blocker ?? null, report: reportPath, review };
  return { lines, json };
}
