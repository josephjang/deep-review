/**
 * What the `status` command prints about a run (R13 of the read-only
 * review): its status, worktree, runtime and models, the phase it is in,
 * its workers, its spend against the run budget in force, what the budget
 * check counts when that differs from the reported spend, its blocker with
 * the operator's action, and its report, as text lines and as JSON.
 */
import type { RunState } from '../checkpoint/fold.ts';
import type { RuntimeAdapter } from '../runtime/adapter.ts';
import { budgetSpendNote, budgetSpendOf, statisticsOf } from './spend.ts';
import { currentPhase, reviewStatus } from './state.ts';

/** What `status` prints about a run, as text lines and as a JSON value. */
export function describeRun(state: RunState, adapter: Pick<RuntimeAdapter, 'summarizeUsage' | 'capabilities'>, evidencePath: (reference: { sha256: string; bytes: number }) => string): { lines: string[]; json: Record<string, unknown> } {
  const status = reviewStatus(state);
  const review = state.review;
  const workers = Object.values(state.workers);
  const counts = { running: workers.filter((worker) => worker.status === 'running').length, finished: workers.filter((worker) => worker.status === 'finished').length, lost: workers.filter((worker) => worker.status === 'lost').length };
  const statistics = review === null ? null : statisticsOf(state, adapter);
  const phase = review === null ? null : currentPhase(review);
  const budgetUsd = review?.limits.runBudgetUsd ?? null;
  // What the budget check counts differs from the reported spend when it charged a worker at its cap or left a lost one out; both are then shown.
  const budgetSpend = review === null ? null : budgetSpendOf(state, adapter);
  const budgetNote = budgetSpend === null ? null : budgetSpendNote(budgetSpend);
  const checkedUsd = budgetSpend?.usd ?? null;
  const budgetCheckLine = budgetUsd === null || checkedUsd === null || budgetNote === null ? null : `Budget check: ${checkedUsd.toFixed(2)} USD of ${budgetUsd.toFixed(2)} USD, ${budgetNote}`;
  const reportPath = review?.report === null || review?.report === undefined ? null : evidencePath(review.report.report);
  const lines = [
    `Run ${state.id}: ${status}${state.abandonReason === null ? '' : ` (${state.abandonReason})`}`,
    `Worktree: ${state.worktree}`,
    review === null ? 'Review: not configured' : `Runtime: ${review.configuration.runtime} ${review.configuration.version}; models ${review.configuration.models.strong} and ${review.configuration.models.fast}`,
    phase === null ? 'Phase: none running' : `Phase: ${phase} (attempt ${String(review!.phases[phase].attempt)}, ${review!.phases[phase].status})`,
    `Workers: ${String(counts.running)} running, ${String(counts.finished)} finished, ${String(counts.lost)} lost`,
    statistics === null
      ? 'Spend: none'
      : `Spend: ${statistics.total.costUsd === null ? 'no cost reported' : `${statistics.total.costUsd.toFixed(2)} USD`}${budgetUsd === null || budgetCheckLine !== null ? '' : ` of ${budgetUsd.toFixed(2)} USD`}; ${statistics.total.inputTokens === null ? 'no tokens reported' : `${String(statistics.total.inputTokens)} input, ${String(statistics.total.outputTokens ?? 0)} output tokens`}`,
    ...(budgetCheckLine === null ? [] : [budgetCheckLine]),
    ...(review?.blocker === null || review?.blocker === undefined ? [] : [`Blocker: ${review.blocker.code}: ${review.blocker.detail}`, `Action: ${review.blocker.action}`]),
    ...(reportPath === null ? [] : [`Report: ${reportPath}`]),
  ];
  const json = { runId: state.id, status, worktree: state.worktree, phase, workers: counts, statistics, budgetCheck: budgetSpend, blocker: review?.blocker ?? null, report: reportPath, review };
  return { lines, json };
}
