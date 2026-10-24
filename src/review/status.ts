/**
 * What the `status` command prints about a run (R13 of the read-only
 * review): its status, worktree, the scope it captured (R12 of the
 * questions in the chat), runtime and models, the phase it is in,
 * its workers, its spend against the run budget in force, what the budget
 * check counts when that differs from the reported spend, its blocker with
 * the operator's action, its report and the copy of it beside the ledger
 * (R16 of the brief of a run) and for a run continued into the fix
 * pass its read-only report (R7 of fix pass continuation), what its
 * decision step decided
 * (R8 of the decision step), and for a fix run (R13 of the fix
 * pass) its batches, its claims (R3 of commit series integrity), its
 * checks, its patches and its commits, every series of them, and its
 * answers and answer passes (R10 of answers), as text lines and as JSON;
 * and the list of the runs of the checkpoint that `status --all` prints
 * (R10 of the questions in the chat).
 */
import { answerWords, standingAnswers } from '../checkpoint/answer-state.ts';
import { allBatches, allClusters, earlierTreeEdit, isNotAttempted, lastRecordedRun } from '../checkpoint/fix-state.ts';
import type { ScopeState } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { isAnswered, type ReviewState } from '../checkpoint/review-fold.ts';
import { sameDirectory } from '../paths.ts';
import type { RuntimeAdapter } from '../runtime/adapter.ts';
import { recordedSetting } from '../checkpoint/settings-state.ts';
import { askedMode, baseNameOf, commitWords, endWords, scopeLine, type AskedMode, type ShownScope } from '../scope/scope-line.ts';
import { cutAtWord, shortLineLimit } from './brief.ts';
import { continueCommand, rolesPlaceholder } from './continue-command.ts';
import { stopLimitations } from './fix-report.ts';
import { counted, inlineText } from './markdown.ts';
import { cutWorkerLines, limitBlockLines, lostWorkerLines } from './report.ts';
import { shortRunId } from './runs.ts';
import { settingsHeaderLine, settingsLimitations } from './settings-report.ts';
import { budgetSpendNote, budgetSpendOf, statisticsOf } from './spend.ts';
import { unitLabel } from './labels.ts';
import { budgetStoppedRun, currentPhase, hasCurrentReport, reviewStatus } from './state.ts';
import { checkPhases, decisionCounts, decisionCountWords } from './vocabulary.ts';

/**
 * What `status` names a complete fix run the run budget stopped with
 * (R11, R15 of resumable runs): the engine that runs the command that
 * continues it, and whether the run's roles are the engine's own, by
 * their digest, since `status` is given no roles directory.
 */
export interface StatusContinuation {
  readonly engineEntry: string;
  readonly ownRolesDigest: () => string;
}

export { rolesPlaceholder };

/** The line that names how to continue a fix pass the run budget stopped, or none for any other run. */
function continueLine(state: RunState, adapter: Pick<RuntimeAdapter, 'summarizeUsage' | 'capabilities'>, continuation: StatusContinuation | null): { line: string; command: string } | null {
  const review = state.review;
  if (continuation === null || review === null || !budgetStoppedRun(state)) return null;
  const spend = budgetSpendOf(state, adapter).usd;
  if (spend === null) return null;
  const own = review.configuration.rolesDigest === continuation.ownRolesDigest();
  const command = continueCommand(state, continuation.engineEntry, own ? null : rolesPlaceholder, spend);
  return { command, line: `Continue: ${command}, which continues the fix pass the run budget stopped and reviews nothing again${own ? '' : `, with the roles directory the run was reviewed with in place of ${rolesPlaceholder}`}` };
}

/** What `status` gives `describeRun` beside the run, each fact it finds outside the ledger. */
export interface StatusFacts {
  /** What names how to continue a fix pass the run budget stopped, or null to name none. */
  readonly continuation?: StatusContinuation | null;
  /** The path of the copy of the run's report beside the ledger, when one exists, which the line of the report names (R16 of the brief of a run). */
  readonly reportCopy?: string | null;
  /** The commits of the run's change, as git counts them now (`commitCount`), or null when git could not count them. */
  readonly commits?: number | null;
}

/**
 * The mode of a run's scope as the person asked for it (R12 of the
 * questions in the chat), by the rule `config show` applies too
 * (`askedMode`), from what the run recorded: its scope and the
 * `review.base` it recorded. That of a run that recorded no settings
 * keeps the mode it captured.
 */
export function askedModeOf(state: RunState): AskedMode {
  const scope = state.scope;
  if (scope === null) throw new Error(`Run ${state.id} has no scope`);
  const configuration = state.review?.configuration;
  const base = configuration === undefined ? undefined : recordedSetting(configuration, 'review.base')?.value;
  return askedMode(scope.mode, scope.request, base);
}

/** The facts of the `Scope:` line of a run, from the scope it captured: no count of uncommitted files, which the run does not record. */
function shownScopeOf(state: RunState, scope: ScopeState, commits: number | null): ShownScope {
  const mode = askedModeOf(state);
  return { mode, base: scope.base, baseName: baseNameOf(mode, scope.request), target: scope.mode === 'last-commit' ? scope.head : null, commits, fileCount: scope.files.length, excludedCount: scope.excluded.count, uncommitted: null, empty: null };
}

/** What `status` prints about a run, as text lines and as a JSON value. */
export function describeRun(state: RunState, adapter: Pick<RuntimeAdapter, 'summarizeUsage' | 'capabilities'>, evidencePath: (reference: { sha256: string; bytes: number }) => string, facts: StatusFacts = {}): { lines: string[]; json: Record<string, unknown> } {
  const { continuation = null, reportCopy = null, commits = null } = facts;
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
  // The copy is named only beside a current report: while the run works again, the copy holds the report before.
  const copy = reportPath === null ? null : reportCopy;
  // A run continued into the fix pass keeps its read-only report beside the one it writes next (R7 of fix pass continuation).
  const continuedFrom = review?.continuedFrom === null || review?.continuedFrom === undefined ? null : { report: evidencePath(review.continuedFrom.report.report), at: review.continuedFrom.at };
  const patches = (review?.report?.patches ?? []).map(evidencePath);
  const fix = review === null ? null : fixStatus(state, review);
  // How many findings the decision step decided each way (R8 of the decision step), or null while it has recorded none.
  const decisions = review?.decisions === null || review?.decisions === undefined ? null : decisionCounts(review.decisions);
  const continuing = continueLine(state, adapter, continuation);
  // What a stop did, as the notes of the run in the report name it (R15 of resumable runs).
  const stops = [...cutWorkerLines(state.workers), ...lostWorkerLines(state.workers, review?.fix?.revisions ?? []), ...(review === null ? [] : [...limitBlockLines(review), ...stopLimitations(review, evidencePath)])].map((line) => `Stop: ${line}`);
  // The scope the run captured, so a resumed run shows its scope too (R12 of the questions in the chat).
  const shown = state.scope === null ? null : shownScopeOf(state, state.scope, commits);
  const lines = [
    `Run ${state.id}: ${status}${state.abandonReason === null ? '' : ` (${state.abandonReason})`}`,
    `Worktree: ${state.worktree}`,
    ...(shown === null ? [] : [scopeLine(shown)]),
    review === null ? 'Review: not configured' : `Runtime: ${review.configuration.runtime} ${review.configuration.version}; models ${review.configuration.models.strong} and ${review.configuration.models.fast}`,
    // The same lines the report gives of the settings (R7 of the configuration).
    ...(review === null ? [] : [settingsHeaderLine(review.configuration)]),
    ...(review === null || state.scope === null ? [] : settingsLimitations(review.configuration, state.scope)),
    phase === null ? 'Phase: none running' : `Phase: ${phase} (attempt ${String(review!.phases[phase].attempt)}, ${review!.phases[phase].status})`,
    `Workers: ${String(counts.running)} running, ${String(counts.finished)} finished, ${String(counts.lost)} lost`,
    statistics === null
      ? 'Spend: none'
      : `Spend: ${statistics.total.costUsd === null ? 'no cost reported' : `${statistics.total.costUsd.toFixed(2)} USD`}${budgetUsd === null || budgetCheckLine !== null ? '' : ` of ${budgetUsd.toFixed(2)} USD`}; ${statistics.total.inputTokens === null ? 'no tokens reported' : `${String(statistics.total.inputTokens)} input, ${String(statistics.total.outputTokens ?? 0)} output tokens`}`,
    ...(budgetCheckLine === null ? [] : [budgetCheckLine]),
    ...(review?.blocker === null || review?.blocker === undefined ? [] : [`Blocker: ${review.blocker.code}: ${review.blocker.detail}`, `Action: ${review.blocker.action}`]),
    ...(continuedFrom === null ? [] : [`Continued from: ${continuedFrom.report}, into the fix pass on ${continuedFrom.at}`]),
    ...(reportPath === null ? [] : [copy === null ? `Report: ${reportPath}` : `Report: ${copy}, a copy of the record ${reportPath}`]),
    ...(continuing === null ? [] : [continuing.line]),
    ...stops,
    ...(decisions === null ? [] : [`Decisions: ${decisionCountWords(decisions)}`]),
    ...(review === null ? [] : answersLine(review)),
    ...(fix === null ? [] : fix.lines),
    ...patches.map((path, index) => `Patch ${String(index + 1)}: ${path}`),
    ...(review?.fix?.commits ?? []).map((series) => `Commits: ${String(series.commits.length)} created, ${series.from} to ${series.to}`),
  ];
  const scopeJson = shown === null || state.scope === null ? null : { ...shown, files: state.scope.files.map((file) => file.path), excluded: [...state.scope.excluded.paths] };
  const json = { runId: state.id, status, worktree: state.worktree, scope: scopeJson, phase, workers: counts, statistics, budgetCheck: budgetSpend, blocker: review?.blocker ?? null, report: reportPath, reportCopy: copy, continuedFrom, decisions, answers: review?.answers ?? [], answerPasses: review?.answerPasses.map(({ reportBefore, ...pass }) => ({ ...pass, reportBefore: evidencePath(reportBefore.report) })) ?? [], fix: fix?.json ?? null, patches, commits: review?.fix?.commits ?? [], continueCommand: continuing?.command ?? null, review };
  return { lines, json };
}

/**
 * What `status` says of a run's answers (R10 of answers): each answered
 * finding's standing answer, how many the tree holds, and the answer
 * passes, the last one's time; nothing for a run nobody answered.
 */
function answersLine(review: ReviewState): string[] {
  const standing = [...standingAnswers(review).values()];
  if (standing.length === 0) return [];
  const applied = standing.filter((answer) => answer.appliedBy !== null).length;
  const last = review.answerPasses.at(-1);
  const passes = last === undefined ? 'no pass' : `passes: ${String(review.answerPasses.length)}, the last on ${last.at}`;
  return [`Answers: ${String(standing.length)} recorded (${standing.map((answer) => `${answer.id} ${answerWords(answer.answer)}`).join(', ')}), ${String(applied)} applied; ${passes}`];
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
  // A run with the decision step keeps a finding from every fixer by its decision; one configured before it held a finding for the author by verdict and angle.
  const heldWords = review.phases.decision.status === 'skipped' ? 'held for the author' : 'no fixer sees, as decided';
  // The answer pass's checks are named once the run has had an answer pass, which alone runs them (R5 of answers).
  const shown = checkPhases.filter((phase) => phase !== 'answer-checks' || review.answerPasses.length > 0);
  const checks = (fix.checks.planned?.checks ?? []).map((check) => ({
    kind: check.kind,
    command: check.command,
    outcomes: Object.fromEntries(shown.map((phase) => [phase, lastRecordedRun(fix, phase, check.kind)?.outcome ?? null])),
    // A run a later fix or repair made old checked an earlier tree, as the report's Checks table marks it (TD3 of resumable runs).
    earlier: shown.filter((phase) => { const run = lastRecordedRun(fix, phase, check.kind); return run !== null && earlierTreeEdit(fix, phase, run) !== null; }),
  }));
  const claimingClusters = new Set(fix.claims.map((claim) => claim.cluster)).size;
  const late = fix.claims.filter((claim) => claim.claimedAt === null).length;
  const lines = [
    fix.plan === null ? 'Fix pass: not planned yet' : `Fix pass: ${batches.length === 0 ? 'no batch' : batches.map((batch) => `${batch.key} ${batch.state}`).join(', ')}; ${String(held.length)} ${heldWords}`,
    ...(fix.plan === null ? [] : [`Claims: ${String(fix.claims.length)} by ${String(claimingClusters)} cluster${claimingClusters === 1 ? '' : 's'}, ${String(late)} late, ${String(fix.lostClaims.length)} lost`]),
    ...checks.map((check) => `Check ${check.kind}: ${check.command === null ? 'not available' : shown.map((phase) => `${phase} ${check.outcomes[phase] ?? '-'}${check.earlier.includes(phase) ? ' (an earlier tree)' : ''}`).join(', ')}`),
  ];
  return { lines, json: { clusters, batches, held, claims: fix.claims, lostClaims: fix.lostClaims, checks, revisions: fix.revisions.length } };
}

/** The most runs `status --all` lists (R10 of the questions in the chat). */
export const listedRuns = 20;

/** The change a captured scope reviews, as the list of runs names it: the mode as the person asked for it (R12), the number of files, its base's short commit, and its end as the `Scope:` line names it. */
function scopeWords(state: RunState, scope: ScopeState): string {
  return `${askedModeOf(state)}, ${counted(scope.files.length, 'file', 'files')}, from ${commitWords(scope.base)} to ${endWords(shownScopeOf(state, scope, null))}`;
}

/**
 * The state of a run as the list of runs names it: an abandoned run with
 * its reason, cut at a word at `shortLineLimit` since the reason of an
 * abandon has no limit, and a blocked one with the code of its blocker.
 */
function stateWords(state: RunState): string {
  const status = reviewStatus(state);
  if (status === 'abandoned') return `abandoned (${cutAtWord(inlineText(state.abandonReason ?? ''), shortLineLimit)})`;
  if (status === 'blocked') return `blocked (${state.review!.blocker!.code})`;
  return status;
}

/**
 * The lines of `status --all` (R10 of the questions in the chat): one for
 * each run, newest first by the time it started, at most `listedRuns`,
 * and one more that counts the others and names `status --all --every`,
 * which lists every run, as `every` does here. A line gives the first 8
 * characters of the id, which `--run` takes (R11), the time the run
 * started, its state, its scope, its worktree when that is not
 * `worktree`, and the path of the copy of its current report. `copyOf`
 * gives the path of the copy of a run's report when that file exists. A
 * run whose report is not current, because it works again, names no copy,
 * since the copy then holds the report before.
 */
export function runListLines(runs: readonly RunState[], worktree: string, copyOf: (state: RunState) => string | null, every = false): string[] {
  // Newest first; runs that started at the same moment keep the reverse of their ledger order.
  const newest = [...runs].reverse().sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const shown = every ? newest : newest.slice(0, listedRuns);
  const lines = shown.map((state) => {
    const id = shortRunId(state.id);
    const scope = state.scope === null ? 'no scope captured yet' : scopeWords(state, state.scope);
    const elsewhere = sameDirectory(state.worktree, worktree) ? '' : `; worktree ${state.worktree}`;
    const current = hasCurrentReport(state);
    const copy = current ? copyOf(state) : null;
    const report = !current ? 'no current report' : copy === null ? `a current report with no copy; deep-review report --run ${id} writes one` : `report ${copy}`;
    return `${id} started ${state.createdAt}: ${stateWords(state)}; ${scope}${elsewhere}; ${report}`;
  });
  const more = newest.length - shown.length;
  return more === 0 ? lines : [...lines, `${counted(more, 'older run is', 'older runs are')} not shown; deep-review status --all --every lists every run`];
}
