/**
 * What the fix pass's events say about a run (R6, R10, R18, R21 of the fix
 * pass; R3 of commit series integrity): the checks it pinned and every run
 * of them, the plan of routes, clusters and batches and the second
 * round's, each fixer's recorded answer, every revision of the tree in
 * ledger order, the units settled without an answer, the files the
 * clusters claimed and the claims left out of the ledger, and every
 * series of commits built from the run afterwards (R8 of answers). Facts
 * as recorded; the planner reads what to do next from them. The questions
 * below are answered from this state alone, or with the review state
 * beside it where an answer pass is concerned.
 */
import { budgetDegradingPhases, checkPhases, documentationUnitKey, editingPhases, repairUnitKey, type CheckKind, type CheckPhase, type EditingPhase, type LostClaimReason, type Phase } from '../review/vocabulary.ts';
import { normalizeFileName } from '../review/locations.ts';
import { currentPass, madeTheEdit, passKey, passNumber, passOf, type AppliedBy } from './answer-state.ts';
import { documentationSearchId, type CheckRan, type CheckStarted, type ChecksPlannedV1, type ClaimsLost, type CommitsCreated, type CommitsPrepared, type DocumentationItem, type DocumentationPlanned, type FixedFinding, type FixesPlanned, type FixesReplanned, type FixRecorded, type FixReopened, type PlannedCheckV2, type PlannedCheckV3, type RecordedDecision, type ReportWritten, type ScopeMode, type TreeRestored, type TreeRevised, type UnitUnattempted } from './events.ts';
import { endedByKill } from '../runtime/kill-marks.ts';
import type { RunState } from './fold.ts';
import type { ReviewState } from './review-fold.ts';

/**
 * One kind's check as the fold holds a plan, whichever version recorded
 * it. A version 1 plan's origin is the manifest rule that found its
 * command, and it names no source; a version 2 or 3 plan's is who decided
 * it, a setting, the survey or nobody, with the survey's source. A
 * setting's check has the layer that gave it, and a flag of a version 1
 * or 2 plan reads as a setting of the flag layer (R11 of the
 * configuration).
 */
export interface PlannedCheck {
  readonly kind: CheckKind;
  readonly command: string | null;
  readonly origin: Exclude<ChecksPlannedV1['checks'][number]['origin'], 'flag'> | PlannedCheckV3['origin'];
  /** The layer of a setting's check; null for any other. */
  readonly layer: PlannedCheckV3['layer'];
  /** Why the kind has no command; null when it has one. */
  readonly reason: string | null;
  readonly source: PlannedCheckV2['source'];
}

/** A version 2 plan's check as the fold holds it: a flag's is a setting of the flag layer. */
export const plannedCheckOfV2 = (check: PlannedCheckV2): PlannedCheck => (check.origin === 'flag' ? { ...check, origin: 'setting', layer: 'flag' } : { ...check, layer: null });

/** The checks a run executes, as the fold holds them. */
export interface ChecksPlanned {
  /** One per kind, in the order the checks run. */
  readonly checks: readonly PlannedCheck[];
  /** The package manager a version 1 plan named for its package scripts; null for a version 2 plan, which a flag or the survey decided. */
  readonly manager: string | null;
}

/**
 * A file a cluster claimed (R1, R3 of commit series integrity): the path,
 * the claiming cluster and batch, the round the batch belongs to, and when
 * the claim was made, null for a late claim recorded at the answer that
 * named the file (R6).
 */
export interface RecordedClaim {
  readonly path: string;
  readonly cluster: string;
  readonly key: string;
  readonly round: 1 | 2;
  readonly claimedAt: string | null;
}

/** A claim marker the engine left out of the ledger, with the unit and cluster the marker named (R3, review F9). */
export type LostClaim = ClaimsLost['files'][number] & { readonly unit: string; readonly cluster: string };

/** Who holds a path in a round: the cluster that owns it by the plan, or the one whose claim of it came last. */
export interface PathHolder {
  readonly cluster: string;
  readonly by: 'plan' | 'claim';
}

/** Why a unit of an editing phase was not attempted (R12, R19 of the fix pass). */
export interface NotAttempted {
  readonly cause: UnitUnattempted['cause'];
  readonly reason: string;
}

/**
 * A run of a check as the fold holds it (TD3 of resumable runs): its
 * record, a version 1 or 2 run replacing nothing, how many revisions of
 * the tree the ledger held before it, so a reader tells a run a later
 * revision made old from a current one, and the index in its phase's runs
 * of the run its `replaces` names, as the fold resolved it (`runStanding`),
 * or null when it replaces nothing.
 */
export interface CheckRunState extends CheckRan {
  readonly revisionsBefore: number;
  readonly replacedAt: number | null;
}

/** A start of a check as the fold holds it (R7 of resumable runs): its record, and how many runs of its phase the ledger held before it, so a reader finds a start no run came after. */
export interface CheckStartState extends CheckStarted {
  readonly runsBefore: number;
}

/** A write back as the fold holds it (R7 of resumable runs): its record, and how many worktree checks the run held before it, since the drift rule reads only the checks after it. */
export interface RestorationState extends TreeRestored {
  readonly checksBefore: number;
}

/**
 * A reopening of a fix pass the run budget stopped (R11 of resumable
 * runs): when it was recorded, the units it reopened, and the report it
 * replaces; and, so a reader orders it against the answer passes and the
 * repair by the ledger rather than the clock, how many answer passes the
 * run held then and whether the repair, which answers once, had answered.
 */
export interface ReopeningState {
  readonly at: string;
  readonly units: FixReopened['units'];
  readonly reportBefore: ReportWritten;
  readonly answerPassesBefore: number;
  readonly repairAnswered: boolean;
}

export interface FixState {
  readonly checks: {
    /** The checks the run executes, pinned at configuration by a version 1 plan and when the survey completes by a version 2 one, or null until `checks.planned` is folded. */
    readonly planned: ChecksPlanned | null;
    /** Every run or skip of a check, by checks phase, in ledger order. */
    readonly runs: Readonly<Record<CheckPhase, readonly CheckRunState[]>>;
    /** Every recorded start of a check, by checks phase, in ledger order (R7 of resumable runs); none before `check.started` existed. */
    readonly starts: Readonly<Record<CheckPhase, readonly CheckStartState[]>>;
    /** The last attempt of each checks phase that a `phase.finished` ended, 0 for none (R3 of resumable runs). */
    readonly finished: Readonly<Record<CheckPhase, number>>;
  };
  /** The routes, clusters and batches, or null until the fixes phase plans them. */
  readonly plan: FixesPlanned | null;
  /** The second round of the fixes phase, or null until its first round has settled and it is planned (R21). */
  readonly secondRound: FixesReplanned | null;
  /** The items of the documentation step, or null until the step is planned, and for good in a run without it or whose fixes revised nothing (R2, TD2 of the documentation step). */
  readonly documentation: DocumentationPlanned | null;
  /** Each recorded answer, by editing phase and then by unit key. */
  readonly answers: Readonly<Record<EditingPhase, Readonly<Record<string, FixRecorded>>>>;
  /** Every revision of the tree, in ledger order. */
  readonly revisions: readonly TreeRevised[];
  /** The units settled without an answer, by editing phase and then by unit key: two failures or the run budget, with the reason; their findings are not attempted. */
  readonly notAttempted: Readonly<Record<EditingPhase, Readonly<Record<string, NotAttempted>>>>;
  /** Every file claimed, in ledger order, both rounds' (R3 of commit series integrity). */
  readonly claims: readonly RecordedClaim[];
  /** Every claim marker left out of the ledger, in ledger order (R3, review F9). */
  readonly lostClaims: readonly LostClaim[];
  /** The holder each recorded violation was judged against when its answer folded, by fixes-phase unit key and then path; a later claim of the path does not change it (R6 of commit series integrity). */
  readonly violationHolders: Readonly<Record<string, Readonly<Record<string, PathHolder>>>>;
  /** Every series of commits built from the run after a report, in ledger order: the first from the scope's head, each later one from the last commit of the one before (R8 of answers). Empty until `deep-review commit` builds one. */
  readonly commits: readonly CommitsCreated[];
  /** A series `commit` prepared and neither completed nor dropped yet, which a stop left open (R9 of resumable runs); null when none is open. */
  readonly openSeries: CommitsPrepared | null;
  /** Every prepared series a later command dropped, since the branch had not moved, in ledger order. */
  readonly droppedSeries: readonly CommitsPrepared[];
  /** Every write back after a check that a kill cut short, in ledger order (R7 of resumable runs). */
  readonly restorations: readonly RestorationState[];
  /** Every reopening of the fix pass, in ledger order (R11 of resumable runs). */
  readonly reopenings: readonly ReopeningState[];
}

/** The fix state of a run just configured with the fix pass. */
export function emptyFixState(): FixState {
  return {
    checks: {
      planned: null,
      runs: Object.fromEntries(checkPhases.map((phase) => [phase, []])) as unknown as Record<CheckPhase, CheckRunState[]>,
      starts: Object.fromEntries(checkPhases.map((phase) => [phase, []])) as unknown as Record<CheckPhase, CheckStartState[]>,
      finished: Object.fromEntries(checkPhases.map((phase) => [phase, 0])) as Record<CheckPhase, number>,
    },
    plan: null,
    secondRound: null,
    documentation: null,
    answers: Object.fromEntries(editingPhases.map((phase) => [phase, {}])) as Record<EditingPhase, Record<string, FixRecorded>>,
    revisions: [],
    notAttempted: Object.fromEntries(editingPhases.map((phase) => [phase, {}])) as Record<EditingPhase, Record<string, NotAttempted>>,
    claims: [],
    lostClaims: [],
    violationHolders: {},
    commits: [],
    openSeries: null,
    droppedSeries: [],
    restorations: [],
    reopenings: [],
  };
}

/**
 * The last fresh run of a kind's check in a checks phase at an attempt
 * past `after`, any attempt by default (TD3 of resumable runs): one no
 * later revision made old (`isOldRun`), whatever the phase's floor, or
 * null when the kind has none. A baseline run never grows old, so the last
 * baseline run is always its fresh one. `lastRecordedRun` keeps old runs,
 * and `lastCurrentRun` adds the floor.
 */
export function lastFreshRun(fix: FixState, phase: CheckPhase, kind: CheckKind, after = 0): CheckRunState | null {
  return fix.checks.runs[phase].findLast((run) => run.kind === kind && run.attempt > after && !isOldRun(fix, phase, run)) ?? null;
}

/** The last recorded run of a kind's check in a checks phase at an attempt past `after`, fresh or old, or null when it has none: what the Checks table shows of a phase that did not run again. */
export function lastRecordedRun(fix: FixState, phase: CheckPhase, kind: CheckKind, after = 0): CheckRunState | null {
  return fix.checks.runs[phase].findLast((run) => run.kind === kind && run.attempt > after) ?? null;
}

/**
 * The editing phases whose revisions make a run of each checks phase old
 * (TD3 of resumable runs): a later revision makes a run old only when it
 * changes the state its phase checks. A baseline run checks the tree
 * before every edit and never grows old; a revision by a check makes no
 * run old, since a check that writes files records its own writes; and an
 * answer pass's revision runs `answer-checks` again through its floor
 * (`checksFloor`), not by making its runs old. The documentation step
 * revises the tree the fixes leave, so it stales what they stale (R9 of
 * the documentation step).
 */
const stalingPhases: Readonly<Record<CheckPhase, readonly EditingPhase[]>> = {
  'baseline-checks': [],
  checks: ['fixes', 'documentation', 'answer'],
  'repair-checks': ['fixes', 'documentation', 'repair', 'answer'],
  'answer-checks': ['fixes', 'documentation', 'repair'],
};

/**
 * The editing phases whose later revisions make the Checks table and
 * `status` say a run checked an earlier tree (R15, TD3 of resumable runs):
 * the fixes, the documentation step and the repair, after any phase but
 * the baseline, which checks
 * the tree before every edit. An answer pass marks no run, since the runs
 * after answers show the tree it left, so each phase's set is its
 * `stalingPhases` set without the answer pass.
 */
const markingPhases = Object.fromEntries(checkPhases.map((phase) => [phase, stalingPhases[phase].filter((editing) => editing !== 'answer')])) as unknown as Readonly<Record<CheckPhase, readonly EditingPhase[]>>;

/** The editing phase of the first revision the ledger holds after a run whose phase is one of `editing`, or null when none is. */
function revisionAfter(fix: Pick<FixState, 'revisions'>, run: Pick<CheckRunState, 'revisionsBefore'>, editing: readonly EditingPhase[]): EditingPhase | null {
  const phases: readonly string[] = editing;
  return (fix.revisions.slice(run.revisionsBefore).find((revision) => phases.includes(revision.phase))?.phase as EditingPhase | undefined) ?? null;
}

/** The editing phase of the first revision after a run that changed the tree it checked, as the record names it, or null when none did. */
export function earlierTreeEdit(fix: Pick<FixState, 'revisions'>, phase: CheckPhase, run: Pick<CheckRunState, 'revisionsBefore'>): EditingPhase | null {
  return revisionAfter(fix, run, markingPhases[phase]);
}

/** Whether a run of a checks phase is old: a revision the ledger holds after it changed the state its phase checks. */
export function isOldRun(fix: Pick<FixState, 'revisions'>, phase: CheckPhase, run: Pick<CheckRunState, 'revisionsBefore'>): boolean {
  return revisionAfter(fix, run, stalingPhases[phase]) !== null;
}

/** The last current run of a kind in a checks phase (TD3 of resumable runs): a fresh run (`lastFreshRun`) past the phase's floor (`checksFloor`); null when the kind has none. */
export function lastCurrentRun(review: Pick<ReviewState, 'answerPasses'> & { readonly fix: FixState }, phase: CheckPhase, kind: CheckKind): CheckRunState | null {
  return lastFreshRun(review.fix, phase, kind, checksFloor(review, phase));
}

/**
 * Whether an attempt of a checks phase was cut (R3 of resumable runs):
 * after the phase's last finished attempt and before its current one, so
 * a stop ended it with no `phase.finished`. The current attempt is never a
 * cut attempt.
 */
export function isCutAttempt(review: Pick<ReviewState, 'phases'> & { readonly fix: FixState }, phase: CheckPhase, attempt: number): boolean {
  return attempt > review.fix.checks.finished[phase] && attempt < review.phases[phase].attempt;
}

/**
 * What a new run of a kind in a checks phase stands to its last current
 * run, by the rules of `check.ran@3` (R3, R4, R7 of resumable runs):
 * `first` when the kind has no current run; `again` with that run and why
 * when it was cut, when it is the first timeout of the kind in the current
 * attempt, or when it did not pass in a cut attempt; null when the kind may
 * not run again, since its last current run is its result.
 */
export type RunStanding =
  | { readonly kind: 'first' }
  | { readonly kind: 'again'; readonly run: CheckRunState; readonly why: 'cut' | 'timeout' | 'cut-attempt' }
  | null;

export function runStanding(review: Pick<ReviewState, 'answerPasses' | 'phases'> & { readonly fix: FixState }, phase: CheckPhase, kind: CheckKind): RunStanding {
  const last = lastCurrentRun(review, phase, kind);
  if (last === null) return { kind: 'first' };
  if (last.outcome === 'cut') return { kind: 'again', run: last, why: 'cut' };
  const current = review.phases[phase].attempt;
  const firstTimeout = review.fix.checks.runs[phase].find((run) => run.kind === kind && run.attempt === current && run.outcome === 'timeout');
  if (last.outcome === 'timeout' && last.attempt === current && firstTimeout === last) return { kind: 'again', run: last, why: 'timeout' };
  if (last.outcome !== 'passed' && isCutAttempt(review, phase, last.attempt)) return { kind: 'again', run: last, why: 'cut-attempt' };
  return null;
}

/**
 * Whether a run of a kind ending with `outcome` in `attempt` is the second
 * cut of the kind in one attempt, which is a failure (R4 of resumable
 * runs): it is cut, and the run it replaces (`runStanding`) was cut in the
 * same attempt. The engine records such a run failed, and `check.ran@3`
 * refuses one recorded cut, both by this rule.
 */
export function secondCut(replaces: { readonly run: Pick<CheckRunState, 'attempt'>; readonly why: Extract<RunStanding, { kind: 'again' }>['why'] } | null, attempt: number, outcome: CheckRunState['outcome']): boolean {
  return outcome === 'cut' && replaces?.why === 'cut' && replaces.run.attempt === attempt;
}

/** The start of a kind's check at an attempt that no run of the kind at that attempt came after, or null: a check a stop cut, or one running now (R7 of resumable runs). */
export function openStart(fix: FixState, phase: CheckPhase, kind: CheckKind, attempt: number): CheckStartState | null {
  const start = fix.checks.starts[phase].findLast((candidate) => candidate.kind === kind && candidate.attempt === attempt) ?? null;
  if (start === null) return null;
  return fix.checks.runs[phase].slice(start.runsBefore).some((run) => run.kind === kind && run.attempt === attempt) ? null : start;
}

/** A check that a kill cut short (R7 of resumable runs), by its kind and the attempt it ran in. */
export interface CutShortCheck {
  readonly kind: CheckKind;
  readonly attempt: number;
}

/**
 * Whether a run of a check was cut short by a kill, its writes no work of a
 * complete check (R4, R7 of resumable runs): a run that ended cut, one the
 * engine killed at its timeout, or the second cut of a kind in one attempt,
 * which is recorded failed with the kill mark it ended with, or with no
 * result from its guard.
 */
export const killedRun = (run: Pick<CheckRunState, 'outcome' | 'termination' | 'exitCode' | 'signal'>): boolean => run.outcome === 'cut' || run.termination === 'killed' || (run.outcome === 'failed' && endedByKill(run));

/**
 * Every check of a checks phase that a kill cut short, in ledger order (R7
 * of resumable runs): a run that a kill ended (`killedRun`) after its
 * start, or a start no run came after, which a stop cut. A run by an
 * engine from before `check.started` is never one: it has no start before
 * it, and it recorded its writes as a revision, so it explains no later
 * drift.
 */
export function cutShortChecks(fix: FixState, phase: CheckPhase): readonly (CheckRunState | CheckStartState)[] {
  const starts = fix.checks.starts[phase];
  // A start of the run's kind in its attempt recorded before it, which only a version 3 run has.
  const started = (run: CheckRunState, index: number): boolean => starts.some((start) => start.kind === run.kind && start.attempt === run.attempt && start.runsBefore <= index);
  // Ledger order, by the count of runs before each check, a run's index or a start's `runsBefore`, and then a start first: a start with k runs before it came before the run at index k.
  const order = { start: 0, run: 1 } as const;
  return [
    ...fix.checks.runs[phase].flatMap((run, index) => (killedRun(run) && started(run, index) ? [{ check: run, runsBefore: index, order: order.run }] : [])),
    ...starts.flatMap((start) => (openStart(fix, phase, start.kind, start.attempt) === start ? [{ check: start, runsBefore: start.runsBefore, order: order.start }] : [])),
  ].sort((a, b) => a.runsBefore - b.runsBefore || a.order - b.order).map((candidate) => candidate.check);
}

/**
 * The last check of a checks phase that a kill cut short in an attempt
 * before the current one (R7 of resumable runs), whatever its kind
 * (`cutShortChecks`), whose writes are not resolved; null when there is
 * none. A drift its writes explain is written back, not blocked on. Its
 * writes are resolved once its write back finished, the tree checked again
 * after the write back's record (the moment `restored`), or once a later
 * attempt before the current one checked the tree and found no drift,
 * the check having left nothing to write back; a write back a stop cut
 * between its record and its writes is made again. After either, a drift
 * is no longer the check's, but an edit of a person while no engine ran,
 * which blocks as any drift does.
 */
export function cutShortBefore(review: Pick<ReviewState, 'phases' | 'checks'> & { readonly fix: FixState }, phase: CheckPhase): CutShortCheck | null {
  const { fix } = review;
  const current = review.phases[phase].attempt;
  // The last write back of a kind's run at an attempt decides, since a second cut of the kind in that attempt is written back after the first.
  const writtenBack = (kind: CheckKind, attempt: number): boolean => {
    const last = fix.restorations.findLast((restoration) => restoration.phase === phase && restoration.check.kind === kind && restoration.check.attempt === attempt);
    return last !== undefined && review.checks.slice(last.checksBefore).some((check) => check.phase === phase && check.attempt === last.attempt && check.moment === 'restored');
  };
  // A worktree check with no drift at an attempt between the cut one and the current one: the tree then held what the run expects.
  const foundClean = (attempt: number): boolean => review.checks.some((check) => check.phase === phase && check.attempt > attempt && check.attempt < current && !check.drifted);
  const last = cutShortChecks(fix, phase).findLast((check) => check.attempt < current && !writtenBack(check.kind, check.attempt) && !foundClean(check.attempt));
  return last === undefined ? null : { kind: last.kind, attempt: last.attempt };
}

/**
 * How many worktree checks the run held before the last write back of a
 * phase's attempt (R7 of resumable runs), or -1 when the attempt has none.
 * A write back resolves the drift of every check of its attempt indexed
 * before it, so the planner's drift rule and the report's fate of a drift
 * both read it here.
 */
export function lastRestorationAt(fix: FixState | null, phase: Phase, attempt: number): number {
  return fix?.restorations.findLast((restoration) => restoration.phase === phase && restoration.attempt === attempt)?.checksBefore ?? -1;
}

/**
 * The attempt of a checks phase past which its runs are the current ones:
 * for `answer-checks`, the attempt it was at when the current answer pass
 * opened it, so each pass runs every check once again (R5 of answers);
 * 0 for every other checks phase, whose runs grow old instead when a
 * later revision changes the state it checks (`isOldRun`, TD3 of
 * resumable runs), so it runs a kind again only then, or when its last
 * run was cut (`runStanding`).
 */
export function checksFloor(review: Pick<ReviewState, 'answerPasses'>, phase: CheckPhase): number {
  return phase === 'answer-checks' ? (currentPass(review)?.pass.openedAt.checks ?? 0) : 0;
}

/** Whether a kind's check failed or timed out before any edit (R10, R24 of the fix pass), by its last baseline run, which never grows old. */
export function failedAtBaseline(fix: FixState, kind: CheckKind): boolean {
  return ['failed', 'timeout'].includes(lastFreshRun(fix, 'baseline-checks', kind)?.outcome ?? '');
}

/**
 * The kinds the repair takes (R10, R11, R24 of the fix pass): those whose
 * check failed or timed out after the fixes, having passed before any
 * edit, which the fixes broke, or having failed then too, whose output
 * may hide a failure the fixes added. The repair worker reads which
 * failures are new; a kind that did not start at baseline, its tool
 * missing, is never one. It reads the last baseline run and the last
 * fresh run after the fixes (`lastFreshRun`, TD3 of resumable runs); the report, which
 * says why the repair ran or not, reads the last run after the fixes
 * whatever revision came later (`recorded`), since an answer pass after
 * the repair makes those runs old without changing what the repair read.
 */
export function repairTargets(fix: FixState, read: 'current' | 'recorded' = 'current'): CheckKind[] {
  const planned = fix.checks.planned?.checks ?? [];
  const afterFixes = (kind: CheckKind): CheckRunState | null => (read === 'current' ? lastFreshRun(fix, 'checks', kind) : lastRecordedRun(fix, 'checks', kind));
  return planned
    .map((check) => check.kind)
    .filter((kind) => (lastFreshRun(fix, 'baseline-checks', kind)?.outcome === 'passed' || failedAtBaseline(fix, kind)) && ['failed', 'timeout'].includes(afterFixes(kind)?.outcome ?? ''));
}

export type PlannedCluster = FixesPlanned['clusters'][number];
export type PlannedBatch = FixesPlanned['batches'][number];

/** Every planned cluster of both rounds, the first round's first. */
export function allClusters(fix: FixState): PlannedCluster[] {
  return [...(fix.plan?.clusters ?? []), ...(fix.secondRound?.clusters ?? [])];
}

/** Every planned batch of both rounds, in launch order within each, the first round's first. */
export function allBatches(fix: FixState): PlannedBatch[] {
  return [...(fix.plan?.batches ?? []), ...(fix.secondRound?.batches ?? [])];
}

/** The planned cluster with this id, of either round, or null. */
export function clusterOf(fix: FixState, id: string): PlannedCluster | null {
  return allClusters(fix).find((cluster) => cluster.id === id) ?? null;
}

/** The planned batch with this key, a fixes-phase unit key, of either round, or null. */
export function batchOf(fix: FixState, key: string): PlannedBatch | null {
  return allBatches(fix).find((batch) => batch.key === key) ?? null;
}

/** Whether a fixes-phase batch has settled: answered, or not attempted. */
const batchSettled = (fix: FixState, key: string): boolean => Object.hasOwn(fix.answers.fixes, key) || isNotAttempted(fix, 'fixes', key);

/** Whether every batch of the first round has settled: answered, or not attempted. */
export function firstRoundSettled(fix: FixState): boolean {
  return (fix.plan?.batches ?? []).every((batch) => batchSettled(fix, batch.key));
}

/**
 * Whether the second round of the fixes can be planned (R21 of the fix
 * pass, PD13 of resumable runs): every batch of the first round settled,
 * and none of them as not attempted for the run budget, since a reopened
 * fix pass launches such a batch first, and the second round is planned
 * from the answers of the whole first round.
 */
export function secondRoundPlannable(fix: FixState): boolean {
  return firstRoundSettled(fix) && !budgetStoppedUnits(fix).some((unit) => unit.phase === 'fixes' && roundOf(fix, unit.key) === 1);
}

/** The round a fixes-phase batch belongs to: the second when the second round plans it, else the first. */
export function roundOf(fix: FixState, key: string): 1 | 2 {
  return (fix.secondRound?.batches.some((batch) => batch.key === key) ?? false) ? 2 : 1;
}

/** The plan of one round of the fixes phase, its clusters and batches, or null until that round is planned: within a round no file has two owners, and a round's ownership ends with it (R21). */
export function planOfRound(fix: FixState, round: 1 | 2): Pick<FixesPlanned, 'clusters' | 'batches'> | null {
  return round === 1 ? fix.plan : fix.secondRound;
}

/** The clusters and batches of one round of the fixes phase, none before it is planned. */
function roundPlan(fix: FixState, round: 1 | 2): { readonly clusters: readonly PlannedCluster[]; readonly batches: readonly PlannedBatch[] } {
  const plan = planOfRound(fix, round);
  return { clusters: plan?.clusters ?? [], batches: plan?.batches ?? [] };
}

/** The claims of one round, in ledger order. */
export function claimsOfRound(fix: FixState, round: 1 | 2): RecordedClaim[] {
  return fix.claims.filter((claim) => claim.round === round);
}

/** The last claim of a path in a round by a cluster other than `except`, settled or not, as `holdersKeyedBy` names a claimed path's holder. */
export function lastClaimOf(fix: FixState, round: 1 | 2, path: string, except?: string): RecordedClaim | undefined {
  return claimsOfRound(fix, round).findLast((claim) => claim.path === path && claim.cluster !== except);
}

/** The clusters of a round whose every batch has settled, answered or not attempted: they hold their claims no more (PD3 of commit series integrity). */
export function settledClusters(fix: FixState, round: 1 | 2): Set<string> {
  const { clusters, batches } = roundPlan(fix, round);
  return new Set(clusters.filter((cluster) => batches.filter((batch) => batch.cluster === cluster.id).every((batch) => batchSettled(fix, batch.key))).map((cluster) => cluster.id));
}

/** A round's holder of a path, with the path as the plan or the holder's last claim spells it. */
export interface SpelledHolder extends PathHolder {
  readonly path: string;
}

/** The key of a path compared exactly, as the fold compares paths: the path itself. */
export const exactPath = (path: string): string => path;

/**
 * Who holds each path in a round (R3 of commit series integrity): its
 * owner by the round's plan, and for a path no cluster owns, the cluster
 * whose claim of it came last, settled or not. Keyed by `keyOf`, the path
 * as the engine compares it: `exactPath` for the fold, or lowercased
 * where the worktree's file system folds case (TD4), where an owner by the
 * plan still wins over a claim spelled otherwise, so two spellings of one
 * file never give it two holders.
 */
export function holdersKeyedBy(fix: FixState, round: 1 | 2, keyOf: (path: string) => string): Map<string, SpelledHolder> {
  const holders = new Map<string, SpelledHolder>();
  for (const cluster of roundPlan(fix, round).clusters) for (const path of cluster.files) holders.set(keyOf(path), { path, cluster: cluster.id, by: 'plan' });
  for (const claim of claimsOfRound(fix, round)) if (holders.get(keyOf(claim.path))?.by !== 'plan') holders.set(keyOf(claim.path), { path: claim.path, cluster: claim.cluster, by: 'claim' });
  return holders;
}

/**
 * Why a cluster may not claim a path its round's holder holds (R3 of
 * commit series integrity): `owned` when a cluster owns it by the plan,
 * `held` when the cluster holds it already by claim or another cluster
 * that has not settled does; null when nobody holds it, or only a settled
 * cluster's claim did (PD3). The fold, the settle and the late claim judge
 * a claim by this one rule, so they agree (TD5).
 */
export function claimRefusal(holder: PathHolder | undefined, cluster: string, settled: ReadonlySet<string>): Exclude<LostClaimReason, 'unplanned'> | null {
  if (holder === undefined) return null;
  if (holder.by === 'plan') return 'owned';
  return holder.cluster === cluster || !settled.has(holder.cluster) ? 'held' : null;
}

/** The paths a cluster claimed among `claims`, in the order it first claimed them. */
const pathsClaimedBy = (claims: readonly Pick<RecordedClaim, 'path' | 'cluster'>[], cluster: string): string[] => [...new Set(claims.filter((claim) => claim.cluster === cluster).map((claim) => claim.path))];

/** The paths a cluster claimed in a round, in the order it first claimed them. */
export function clusterClaims(fix: FixState, round: 1 | 2, cluster: string): string[] {
  return pathsClaimedBy(claimsOfRound(fix, round), cluster);
}

/**
 * A second-round finding's files (R4 of commit series integrity): its
 * first-round cluster's files, the files that cluster claimed among the
 * first round's `claims`, and the files the finding was blocked on,
 * sorted, none twice. The planner plans by it and the fold holds a
 * recorded plan to it, so the two cannot drift apart.
 */
export function secondRoundFiles(own: { readonly id: string; readonly files: readonly string[] }, claims: readonly Pick<RecordedClaim, 'path' | 'cluster'>[], requiredFiles: readonly string[]): string[] {
  return [...new Set([...own.files, ...pathsClaimedBy(claims, own.id), ...requiredFiles])].sort();
}

/**
 * The paths another cluster of a fixes-phase batch's round holds while the
 * batch runs (R1, R6 of commit series integrity): every path another
 * cluster owns, and every path another cluster that has not settled holds
 * by its last claim; a settled cluster's claimed files are free again
 * (PD3). The repair, the only unit of its phase, has none. Keyed by
 * `keyOf`, as `holdersKeyedBy` is.
 */
export function heldByOthers(fix: FixState, key: string, keyOf: (path: string) => string): Map<string, PathHolder> {
  return othersOfRound(fix, key, keyOf, settledClusters(fix, roundOf(fix, key)));
}

/**
 * The paths another cluster of a fixes-phase batch's round has held at
 * any point of the round (R5 of commit series integrity): every path
 * another cluster owns, and every path another cluster holds by the
 * round's last claim of it, settled or not. A settle frees a claimed file
 * for a new claim (PD3), but not for an attempt's revisions: the
 * attempt's snapshots may predate the holder's edit, which the holder's
 * revision has already recorded, and taking the file would undo it.
 * Keyed by `keyOf`, as `holdersKeyedBy` is.
 */
export function heldInRoundByOthers(fix: FixState, key: string, keyOf: (path: string) => string): Map<string, PathHolder> {
  return othersOfRound(fix, key, keyOf, new Set());
}

/** The round's holders of a batch's paths other than its own cluster, less the claims of the clusters in `released`. */
function othersOfRound(fix: FixState, key: string, keyOf: (path: string) => string, released: ReadonlySet<string>): Map<string, PathHolder> {
  const own = clusterOfBatch(fix, key)?.id;
  const held = new Map<string, PathHolder>();
  for (const [path, { cluster, by }] of holdersKeyedBy(fix, roundOf(fix, key), keyOf)) {
    if (cluster === own || (by === 'claim' && released.has(cluster))) continue;
    held.set(path, { cluster, by });
  }
  return held;
}

/**
 * Every first-round cluster that held each path (R4 of commit series
 * integrity): its owner by the plan, and every cluster that claimed it at
 * any time of the round, whether it settled after or not, since a holder
 * that settled after refusing a sibling still blocked that sibling.
 */
export function firstRoundHolders(clusters: readonly { readonly id: string; readonly files: readonly string[] }[], claims: readonly Pick<RecordedClaim, 'path' | 'cluster'>[]): Map<string, Set<string>> {
  const holders = new Map<string, Set<string>>();
  const add = (path: string, cluster: string): void => {
    const set = holders.get(path);
    if (set === undefined) holders.set(path, new Set([cluster]));
    else set.add(cluster);
  };
  for (const cluster of clusters) for (const path of cluster.files) add(path, cluster.id);
  for (const claim of claims) add(claim.path, claim.cluster);
  return holders;
}

/**
 * Whether a first-round cluster other than `own` held a path, among the
 * `holders` `firstRoundHolders` gives (R4 of commit series integrity): a
 * finding blocked on such paths alone is the second round's. The planner
 * takes findings by it and the fold holds a recorded plan to it, so the
 * two cannot drift apart.
 */
export function heldByAnother(holders: ReadonlyMap<string, ReadonlySet<string>>, path: string, own: string): boolean {
  return [...(holders.get(path) ?? [])].some((cluster) => cluster !== own);
}

/**
 * A finding's last recorded fixer answer, with the phase and the unit key
 * that gave it: an answer pass's over the fixes phase's, a later pass's
 * over an earlier one's (R5, R10 of answers), and in the fixes phase the
 * second round's over the first's; null when no fixer answered it.
 */
export function lastAnswerOf(fix: FixState, id: string): { readonly phase: 'fixes' | 'answer'; readonly key: string; readonly finding: FixedFinding } | null {
  const passes = Object.keys(fix.answers.answer).filter((key) => passNumber(key) !== null).sort((a, b) => passNumber(b)! - passNumber(a)!);
  for (const key of passes) {
    const finding = fix.answers.answer[key]!.findings.find((candidate) => candidate.id === id);
    if (finding !== undefined) return { phase: 'answer', key, finding };
  }
  const fixes = lastFixesAnswerOf(fix, id);
  return fixes === null ? null : { phase: 'fixes', ...fixes };
}

/** A finding's last recorded fixes-phase answer, with the batch key that gave it: the second round's over the first's; null when no batch's fixer answered it. */
export function lastFixesAnswerOf(fix: FixState, id: string): { readonly key: string; readonly finding: FixedFinding } | null {
  for (const batch of [...allBatches(fix)].reverse()) {
    if (!batch.findingIds.includes(id)) continue;
    const finding = fix.answers.fixes[batch.key]?.findings.find((candidate) => candidate.id === id);
    if (finding !== undefined) return { key: batch.key, finding };
  }
  return null;
}

/** An editing unit's own revisions of the tree, its fixers' and its attempts', in ledger order; a run of the checks is no unit's. */
export function unitRevisions(fix: FixState, phase: EditingPhase, key: string): TreeRevised[] {
  return fix.revisions.filter((revision) => revision.phase === phase && revision.source.kind !== 'check' && revision.source.key === key);
}

/**
 * Whether an answer pass left edits for a finding that apply no answer
 * (R5, R7 of answers): the last pass whose fixer made the finding's edit,
 * or that revised the tree for it, did the latter without the former. Its
 * fixer's revisions naming the finding count, and an attempt's, which
 * also counts when it names no finding, since what an attempt left after
 * its last snapshot may be any of its pass's findings'. The tree then
 * holds part of an answer, so no earlier state of the finding stands.
 */
export function passLeftEdits(review: Pick<ReviewState, 'fix' | 'answerPasses'>, id: string): boolean {
  const fix = review.fix;
  if (fix === null) return false;
  const revisedFor = (key: string): boolean => {
    const inPass = passOf(review, key)?.ids.includes(id) ?? false;
    return unitRevisions(fix, 'answer', key).some((revision) => revision.change.findings.includes(id) || (revision.source.kind === 'attempt' && revision.change.findings.length === 0 && inPass));
  };
  for (let n = review.answerPasses.length; n >= 1; n -= 1) {
    const key = passKey(n);
    const finding = fix.answers.answer[key]?.findings.find((candidate) => candidate.id === id);
    if (finding !== undefined && madeTheEdit(finding.status)) return false;
    if (revisedFor(key)) return true;
  }
  return false;
}

/** The cluster a fixes-phase unit works, by its batch key, or null. */
export function clusterOfBatch(fix: FixState, key: string): PlannedCluster | null {
  const batch = batchOf(fix, key);
  return batch === null ? null : clusterOf(fix, batch.cluster);
}

/**
 * Where a fixes-phase batch stands in its round, 1-based, out of the
 * batches that round planned (R7 of the skill surface corrections), or
 * null for a key neither round plans: the second round counts from 1
 * again, since it is planned only when the first has settled.
 */
export function batchPosition(fix: FixState, key: string): { readonly index: number; readonly count: number } | null {
  const { batches } = roundPlan(fix, roundOf(fix, key));
  const index = batches.findIndex((batch) => batch.key === key);
  return index < 0 ? null : { index: index + 1, count: batches.length };
}

/** The batches of the same cluster planned before this one, in their order; none for a key the plan does not have. */
export function earlierBatches(fix: FixState, key: string): PlannedBatch[] {
  const batch = batchOf(fix, key);
  if (batch === null) return [];
  const siblings = allBatches(fix).filter((candidate) => candidate.cluster === batch.cluster);
  return siblings.slice(0, siblings.indexOf(batch));
}

/** Every path the revisions of the given editing phases changed, sorted. */
function revisedPathsOf(fix: FixState, phases: readonly EditingPhase[]): string[] {
  const of: readonly string[] = phases;
  return [...new Set(fix.revisions.filter((revision) => of.includes(revision.phase)).flatMap((revision) => revision.files.map((file) => file.path)))].sort();
}

/** Every path the fixes phase revised, sorted: what the documentation step owns beside its documents (TD9 of the documentation step). */
export function fixesRevisedPaths(fix: FixState): string[] {
  return revisedPathsOf(fix, ['fixes']);
}

/** Every path the fixes phase and the documentation step revised, sorted: what the repair owns (TD8 of the fix pass, R9 of the documentation step). */
export function fixPassRevisedPaths(fix: FixState): string[] {
  return revisedPathsOf(fix, ['fixes', 'documentation']);
}

/** Every path any revision of the run changed, sorted. */
export function revisedPaths(fix: FixState): string[] {
  return [...new Set(fix.revisions.flatMap((revision) => revision.files.map((file) => file.path)))].sort();
}

/** The repository files the findings' candidates are located in, primaries and members, sorted; an unlocated candidate gives none. */
function locatedFilesOf(review: Pick<ReviewState, 'ranking' | 'candidates'>, ids: readonly string[]): string[] {
  const candidates = (review.ranking ?? []).filter((finding) => ids.includes(finding.id)).flatMap((finding) => [finding.id, ...finding.members]);
  const files = candidates.flatMap((id) => {
    const candidate = review.candidates[id];
    return candidate === undefined || !candidate.located || candidate.file === null ? [] : [candidate.file];
  });
  return [...new Set(files)].sort();
}

/** The parts of a review state that say what an editing unit owns and answers for. */
export type EditingUnitView = Pick<ReviewState, 'fix' | 'answerPasses' | 'ranking' | 'candidates'>;

/**
 * The files a unit of an editing phase owns: its batch's cluster's files;
 * for the documentation step everything the fixes phase revised and the
 * repository path of each document its plan names (TD9 of the
 * documentation step); for the repair everything the fixes phase and the
 * documentation step revised (R9); and for an answer pass every path any
 * revision of the run changed and the files its findings are located in
 * (R5 of answers), since it is the only editor in the tree and may have
 * to undo what a default's fixer did. None in a run without the fix pass.
 */
export function ownedFiles(review: EditingUnitView, phase: EditingPhase, key: string): readonly string[] {
  const fix = review.fix;
  if (fix === null) return [];
  switch (phase) {
    case 'fixes':
      return clusterOfBatch(fix, key)?.files ?? [];
    case 'documentation': {
      const documents = (fix.documentation?.items ?? []).flatMap((item) => (item.path === null ? [] : [item.path]));
      return [...new Set([...fixesRevisedPaths(fix), ...documents])].sort();
    }
    case 'repair':
      return fixPassRevisedPaths(fix);
    case 'answer':
      return [...new Set([...revisedPaths(fix), ...locatedFilesOf(review, passOf(review, key)?.ids ?? [])])].sort();
  }
}

/**
 * The ids a unit of an editing phase answers for, in the order its task
 * numbers them: a fixes-phase batch's findings, the items of the
 * documentation step's plan, the check kinds the repair repairs, or an
 * answer pass's findings. Null for a unit the phase does not have: a
 * batch the plan lacks, the documentation step before its plan, the
 * repair with nothing to repair, a key no answer pass has, or any unit of
 * a run without the fix pass. The fold and the events of a unit's work
 * read it alike.
 */
export function unitIdsOf(review: Pick<ReviewState, 'fix' | 'answerPasses'>, phase: EditingPhase, key: string): readonly string[] | null {
  const fix = review.fix;
  if (fix === null) return null;
  switch (phase) {
    case 'fixes':
      return batchOf(fix, key)?.findingIds ?? null;
    case 'documentation':
      return key === documentationUnitKey && fix.documentation !== null ? fix.documentation.items.map((item) => item.id) : null;
    case 'repair': {
      const targets = repairTargets(fix);
      return key === repairUnitKey && targets.length > 0 ? targets : null;
    }
    case 'answer':
      return passOf(review, key)?.ids ?? null;
  }
}

/**
 * The commit the run's work stands on (R6, R8 of answers, PD7): the last
 * commit of the last series `deep-review commit` built for the run, or,
 * before any, the scope's head. The worktree check and `commit` compare
 * `HEAD` with it, so a committed run can take an answer pass and a later
 * series of commits.
 */
export function runHead(state: Pick<RunState, 'id' | 'scope' | 'review'>): string {
  if (state.scope === null) throw new Error(`Run ${state.id} has no scope`);
  return state.review?.fix?.commits.at(-1)?.to ?? state.scope.head;
}

/** How many of the run's revisions the series built so far commit: each series commits every revision from where the one before ended, in ledger order, so this is one past the last revision any series holds, and 0 before any. */
export function committedRevisions(fix: Pick<FixState, 'commits'>): number {
  const indexes = fix.commits.flatMap((series) => series.commits.map((commit) => commit.revision)).filter((revision): revision is number => revision !== 'change');
  return indexes.length === 0 ? 0 : Math.max(...indexes) + 1;
}

/** What the next series of commits holds: whether it commits the captured change, and the revisions with their indexes among the run's. */
export interface NextSeries {
  readonly change: boolean;
  readonly revisions: readonly { readonly index: number; readonly revision: TreeRevised }[];
}

/**
 * The next series of commits (R17 of the fix pass, R8 of answers): the
 * captured change first in worktree mode, by the first series only; then
 * every revision no series holds yet, with its index among the run's
 * revisions, in ledger order. `commit` builds it, and the fold holds a
 * recorded series to it.
 */
export function nextSeries(fix: Pick<FixState, 'commits' | 'revisions'>, mode: ScopeMode): NextSeries {
  const from = committedRevisions(fix);
  return { change: mode === 'worktree' && fix.commits.length === 0, revisions: fix.revisions.slice(from).map((revision, offset) => ({ index: from + offset, revision })) };
}

/**
 * The message a revision is committed and patched with (R20 of the fix
 * pass): its own, except for a finding's revision from an attempt that
 * did not finish, which takes the message of that finding's recorded
 * answer when a later worker of the unit gave one, having verified the
 * attempt's edits as already applied.
 */
export function revisionMessageOf(fix: FixState, revision: TreeRevised): TreeRevised['change']['message'] {
  const { source } = revision;
  if (source.kind !== 'attempt' || revision.change.findings.length !== 1 || !(editingPhases as readonly string[]).includes(revision.phase)) return revision.change.message;
  const id = revision.change.findings[0]!;
  const answer = fix.answers[revision.phase as EditingPhase][source.key];
  return answer?.findings.find((finding) => finding.id === id)?.message ?? revision.change.message;
}

/** Why a unit was not attempted, in the words the report and the tasks use, or null for a unit that was. */
export function notAttemptedNote(fix: FixState, phase: EditingPhase, key: string): string | null {
  const settled = fix.notAttempted[phase][key];
  if (settled === undefined) return null;
  return settled.cause === 'budget' ? `the run budget was reached first: ${settled.reason}` : settled.reason;
}

/** The units the run budget left not attempted, the batches of the fixes, the documentation step and the repair, in phase order: what a reopened fix pass lists and launches (R11 of resumable runs, R8 of the documentation step). */
export function budgetStoppedUnits(fix: Pick<FixState, 'notAttempted'>): FixReopened['units'] {
  return budgetDegradingPhases.flatMap((phase) => Object.entries(fix.notAttempted[phase]).filter(([, settled]) => settled.cause === 'budget').map(([key]) => ({ phase, key })));
}

/** A `drift` line as the plan of the documentation step and an answer of the fixes both name it: the batch, the file as written and the stale fact. */
export const driftLineKey = (key: string, line: { readonly file: string; readonly what: string }): string => JSON.stringify([key, line.file, line.what]);

/**
 * The items of the documentation step (R2, TD8 of the documentation
 * step): the `drift` lines of the answers of the fixes, read batch by
 * batch in the order of `allBatches` and each answer's lines in their
 * order, grouped by the repository path `resolve` reads each line's file
 * as, the way a reported path is read; a line whose path `resolve`
 * refuses, null, groups with the lines of the same path folded as an
 * unlocated candidate's is (`normalizeFileName`, then lower case). Each
 * item keeps the path its first line wrote and the resolved one, the
 * items are numbered `doc-1` upward in the order of their first lines,
 * and the item `search` comes last. A run whose fixes reported no line has
 * the search alone. The controller computes them, since `resolve` reads
 * the worktree; the fold holds a recorded plan to its lines and does not
 * group them again.
 */
export function documentationItemsOf(fix: FixState, resolve: (file: string) => string | null): DocumentationItem[] {
  const groups = new Map<string, { file: string; path: string | null; drift: DocumentationItem['drift'][number][] }>();
  for (const batch of allBatches(fix)) {
    for (const line of fix.answers.fixes[batch.key]?.drift ?? []) {
      const path = resolve(line.file);
      // A resolved path and a folded one never share a key, so a refused path never joins a document of the repository.
      const group = path === null ? `folded:${normalizeFileName(line.file).toLowerCase()}` : `path:${path}`;
      const entry = groups.get(group) ?? { file: line.file, path, drift: [] };
      entry.drift.push({ key: batch.key, file: line.file, what: line.what });
      groups.set(group, entry);
    }
  }
  const documents = [...groups.values()].map((entry, index): DocumentationItem => ({ id: `doc-${String(index + 1)}`, file: entry.file, path: entry.path, drift: entry.drift }));
  return [...documents, { id: documentationSearchId, file: null, path: null, drift: [] }];
}

/** Whether a unit of an editing phase is settled as not attempted, after two failures or at the run budget. */
export function isNotAttempted(fix: FixState, phase: EditingPhase, key: string): boolean {
  return Object.hasOwn(fix.notAttempted[phase], key);
}

/** What routing reads of a finding's decision: which finding, what was decided, and for an ask the default it applies; picked from each kind's variant, so an ask always carries its question. */
export type RoutedDecision = RecordedDecision extends infer Decision ? (Decision extends RecordedDecision ? Pick<Decision, 'id' | 'decision' | 'ask'> : never) : never;

/** An ask as a decision records it: its question, its options, and the indexes of the option recommended and the default applied. */
export type DecidedAsk = Extract<RecordedDecision, { readonly decision: 'ask' }>['ask'];

/** The option an ask applies as its default; the ledger holds its index among the options, so a missing one is a state the fold never holds. */
export function appliedOptionOf(ask: DecidedAsk): DecidedAsk['options'][number] {
  const applied = ask.options[ask.applied];
  if (applied === undefined) throw new Error(`An ask applies option ${String(ask.applied)} of the ${String(ask.options.length)} it offers`);
  return applied;
}

/**
 * A finding's route by its decision and its standing answer (R4 of
 * answers, TD4), the one rule the planner plans by and the fold holds a
 * recorded plan to: a finding whose answer owes an edit goes to a fixer,
 * whatever its decision, since the fixer makes the tree hold the answer;
 * one with no answer, or one whose answer the tree already holds, routes
 * by its decision (`routeOfDecision`).
 */
export function routeOf(decision: RoutedDecision, answer: { readonly appliedBy: AppliedBy } | null): FixesPlanned['routes'][number]['route'] {
  return answer !== null && answer.appliedBy === null ? 'fixer' : routeOfDecision(decision);
}

/**
 * A finding's route by its decision alone (R6 of the decision step), the
 * rule for a finding nobody answered: a
 * `fix` goes to a fixer, and so does an `ask` whose applied default edits
 * the code, which the fixer applies while the question waits for the
 * author; a `leave`, and an `ask` whose default keeps the code as it is,
 * are `held`, and no fixer sees them.
 */
export function routeOfDecision(decision: RoutedDecision): FixesPlanned['routes'][number]['route'] {
  switch (decision.decision) {
    case 'fix':
      return 'fixer';
    case 'leave':
      return 'held';
    case 'ask':
      return appliedOptionOf(decision.ask).edits ? 'fixer' : 'held';
  }
}
