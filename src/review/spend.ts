/**
 * What a run spent (R6, R9 of the read-only review): each finished worker's
 * usage through the runtime's neutral summary, summed over the run and per
 * phase, the wall time its workers ran, and how many workers spent money no
 * summary reports, with the phase read from the worker's launch label.
 *
 * A worker that timed out, or failed after its process started but before
 * the runtime printed its usage, and a worker lost with its engine, was
 * billed but reports no cost. Its cost is unknowable, so it is left out of
 * every sum and counted instead, and the report says the run cost more
 * than its totals show. A worker whose process never started, a failed
 * spawn, spent nothing and is not counted. The budget check sums the
 * reported costs alone (the design's budget check, R6).
 */
import type { Spend } from '../checkpoint/events.ts';
import type { RunState, WorkerState } from '../checkpoint/fold.ts';
import { emptyUsageSummary, type RuntimeAdapter, type UsageSummary } from '../runtime/adapter.ts';
import { parseUnitLabel } from './labels.ts';
import { phases, type Phase } from './vocabulary.ts';

type Finished = Extract<WorkerState, { status: 'finished' }>;
type Lost = Extract<WorkerState, { status: 'lost' }>;
/** A worker that is over: finished with its receipt, or lost with its engine. */
export type SettledWorker = Finished | Lost;

const isFinished = (worker: WorkerState): worker is Finished => worker.status === 'finished';

/** The workers of a run that are over, finished or lost, in ledger order; a running worker has spent nothing the ledger can know yet. */
export function settledWorkers(state: RunState): SettledWorker[] {
  return Object.values(state.workers).filter((worker): worker is SettledWorker => worker.status !== 'running');
}

/** The neutral summary of a finished worker's usage; a usage that is not JSON, which a decoder never writes, summarizes as nothing. */
export function usageOf(worker: Finished, adapter: Pick<RuntimeAdapter, 'summarizeUsage'>): UsageSummary {
  if (worker.finish.usage === null) return emptyUsageSummary;
  try {
    return adapter.summarizeUsage(JSON.parse(worker.finish.usage));
  } catch {
    return emptyUsageSummary;
  }
}

/** A number summed over the workers that report it, or null when none does: a partial cost is still a cost the operator pays. */
function sumReported(values: readonly (number | null)[]): number | null {
  const reported = values.filter((value): value is number => value !== null);
  return reported.length === 0 ? null : reported.reduce((total, value) => total + value, 0);
}

/**
 * Round to the cent, half a cent up, so a sum of floating costs prints and
 * compares as money. The value in cents is first cut to twelve significant
 * digits: `1.005 * 100` is `100.49999999999999` in binary floating point,
 * and rounding that directly would lose the half cent.
 */
const cents = (value: number | null): number | null => (value === null ? null : Math.round(Number((value * 100).toPrecision(12))) / 100);

/**
 * The wall time a set of workers ran, in seconds: the length of the union of
 * their process intervals, so workers that ran at once count once and a gap
 * with no worker running counts not at all. An interval whose end precedes
 * its start, which a clock set back can record, counts as no time.
 */
function wallSeconds(workers: readonly Finished[]): number {
  const intervals = workers
    .map((worker) => ({ start: Date.parse(worker.finish.startedAt), end: Date.parse(worker.finish.endedAt) }))
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let open: { start: number; end: number } | null = null;
  for (const interval of intervals) {
    if (open !== null && interval.start <= open.end) {
      open.end = Math.max(open.end, interval.end);
      continue;
    }
    if (open !== null) total += open.end - open.start;
    open = { ...interval };
  }
  if (open !== null) total += open.end - open.start;
  return total / 1000;
}

/**
 * What a set of settled workers spent together. The finished ones give the
 * count, the wall time and the sums; a lost one only adds to the count of
 * workers whose cost is unreported, since nothing observed how it ended. A
 * finished worker that reports no cost adds to that count only when its
 * process started: one that never started was billed nothing.
 */
export function spendOf(workers: readonly SettledWorker[], adapter: Pick<RuntimeAdapter, 'summarizeUsage' | 'capabilities'>): Spend {
  const finished = workers.filter(isFinished);
  const summaries = finished.map((worker) => usageOf(worker, adapter));
  const lost = workers.length - finished.length;
  return {
    workers: finished.length,
    seconds: Math.round(wallSeconds(finished) * 10) / 10,
    costUsd: cents(sumReported(summaries.map((summary) => summary.costUsd))),
    costUnreported: adapter.capabilities.costInUsd ? lost + finished.filter((worker, index) => summaries[index]!.costUsd === null && worker.finish.termination !== 'not-started').length : null,
    inputTokens: sumReported(summaries.map((summary) => summary.inputTokens)),
    cachedInputTokens: sumReported(summaries.map((summary) => summary.cachedInputTokens)),
    outputTokens: sumReported(summaries.map((summary) => summary.outputTokens)),
  };
}

/**
 * The run's spend in USD so far, for the budget check: the costs of every
 * finished worker that reported one, or null when none did. A worker whose
 * cost is unreported adds nothing here; the report counts it.
 */
export function runSpendUsd(state: RunState, adapter: Pick<RuntimeAdapter, 'summarizeUsage' | 'capabilities'>): number | null {
  return spendOf(settledWorkers(state), adapter).costUsd;
}

/**
 * The statistics the report prints: one row per phase, from the workers
 * whose label names it, and a total over every settled worker; and whether
 * the run budget in force applied, which it does on a runtime that reports
 * cost when there is one.
 */
export function statisticsOf(state: RunState, adapter: Pick<RuntimeAdapter, 'summarizeUsage' | 'capabilities'>): { phases: (Spend & { phase: Phase })[]; total: Spend; budgetApplied: boolean } {
  const settled = settledWorkers(state);
  const byPhase = phases.map((phase) => ({ phase, ...spendOf(settled.filter((worker) => parseUnitLabel(worker.launch.label)?.phase === phase), adapter) }));
  return { phases: byPhase, total: spendOf(settled, adapter), budgetApplied: adapter.capabilities.costInUsd && (state.review?.limits.runBudgetUsd ?? null) !== null };
}
