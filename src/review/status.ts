/**
 * What the `status` command prints about a run (R13 of the read-only
 * review): its status, worktree, runtime and models, the phase it is in,
 * its workers, its spend against the run budget in force, what the budget
 * check counts when that differs from the reported spend, its blocker with
 * the operator's action, its report, and for a fix run (R13 of the fix
 * pass) its batches, its checks, its patches and its commits, as text
 * lines and as JSON.
 */
import { allBatches, allClusters, isNotAttempted, lastRun } from '../checkpoint/fix-state.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { isAnswered, type ReviewState } from '../checkpoint/review-fold.ts';
import type { RuntimeAdapter } from '../runtime/adapter.ts';
import { budgetSpendNote, budgetSpendOf, statisticsOf } from './spend.ts';
import { unitLabel } from './labels.ts';
import { currentPhase, reviewStatus } from './state.ts';
import { checkPhases } from './vocabulary.ts';

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
  const patches = (review?.report?.patches ?? []).map(evidencePath);
  const fix = review === null ? null : fixStatus(state, review);
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
    ...(fix === null ? [] : fix.lines),
    ...patches.map((path, index) => `Patch ${String(index + 1)}: ${path}`),
    ...(review?.fix?.commits === null || review?.fix?.commits === undefined ? [] : [`Commits: ${String(review.fix.commits.commits.length)} created, ${review.fix.commits.from} to ${review.fix.commits.to}`]),
  ];
  const json = { runId: state.id, status, worktree: state.worktree, phase, workers: counts, statistics, budgetCheck: budgetSpend, blocker: review?.blocker ?? null, report: reportPath, fix: fix?.json ?? null, patches, commits: review?.fix?.commits ?? null, review };
  return { lines, json };
}

/** A fixer batch's state as `status` names it: no worker yet, one running, its answer recorded, or not attempted after two failures. */
type BatchState = 'pending' | 'running' | 'answered' | 'not attempted';

/** What `status` says of a fix run: each batch's state, the clusters, the findings held, and each check's last outcome in each checks phase. */
function fixStatus(state: RunState, review: ReviewState): { lines: string[]; json: Record<string, unknown> } | null {
  const fix = review.fix;
  if (fix === null) return null;
  const running = new Set(Object.values(state.workers).filter((worker) => worker.status === 'running').map((worker) => worker.launch.label));
  const clusters = allClusters(fix).map((cluster) => ({ id: cluster.id, findings: cluster.findingIds, files: cluster.files }));
  const batches = allBatches(fix).map((batch) => {
    const label = unitLabel('fixer', 'fixes', batch.key);
    const batchState: BatchState = isAnswered(review, 'fixes', batch.key) ? 'answered' : isNotAttempted(fix, 'fixes', batch.key) ? 'not attempted' : running.has(label) ? 'running' : 'pending';
    return { key: batch.key, cluster: batch.cluster, state: batchState, findings: batch.findingIds };
  });
  const held = (fix.plan?.routes ?? []).filter((route) => route.route === 'held').map((route) => route.id);
  const checks = (fix.checks.planned?.checks ?? []).map((check) => ({
    kind: check.kind,
    command: check.command,
    outcomes: Object.fromEntries(checkPhases.map((phase) => [phase, lastRun(fix, phase, check.kind)?.outcome ?? null])),
  }));
  const lines = [
    fix.plan === null ? 'Fix pass: not planned yet' : `Fix pass: ${batches.length === 0 ? 'no batch' : batches.map((batch) => `${batch.key} ${batch.state}`).join(', ')}; ${String(held.length)} held for the author`,
    ...checks.map((check) => `Check ${check.kind}: ${check.command === null ? 'not available' : checkPhases.map((phase) => `${phase} ${check.outcomes[phase] ?? '-'}`).join(', ')}`),
  ];
  return { lines, json: { clusters, batches, held, checks, revisions: fix.revisions.length } };
}
