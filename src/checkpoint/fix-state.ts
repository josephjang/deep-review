/**
 * What the fix pass's events say about a run (R6, R10, R18, R21 of the fix
 * pass): the checks it pinned and every run of them, the plan of routes,
 * clusters and batches and the second round's, each fixer's recorded
 * answer, every revision of the tree in ledger order, the units settled
 * without an answer, and the commits built from the run afterwards. Facts as recorded; the planner reads what to do
 * next from them. The questions below are answered from this state alone.
 */
import { checkPhases, editingPhases, type CheckKind, type CheckPhase, type EditingPhase } from '../review/vocabulary.ts';
import type { CheckRan, ChecksPlannedV1, CommitsCreated, FixedFinding, FixesPlanned, FixesReplanned, FixRecorded, PlannedCheckV2, RecordedDecision, TreeRevised, UnitUnattempted } from './events.ts';

/**
 * One kind's check as the fold holds a plan, whichever version recorded
 * it. A version 1 plan's origin is the manifest rule that found its
 * command, and it names no source; a version 2 plan's is who decided it,
 * a flag, the survey or nobody, with the survey's source.
 */
export interface PlannedCheck {
  readonly kind: CheckKind;
  readonly command: string | null;
  readonly origin: ChecksPlannedV1['checks'][number]['origin'] | PlannedCheckV2['origin'];
  /** Why the kind has no command; null when it has one. */
  readonly reason: string | null;
  readonly source: PlannedCheckV2['source'];
}

/** The checks a run executes, as the fold holds them. */
export interface ChecksPlanned {
  /** One per kind, in the order the checks run. */
  readonly checks: readonly PlannedCheck[];
  /** The package manager a version 1 plan named for its package scripts; null for a version 2 plan, which a flag or the survey decided. */
  readonly manager: string | null;
}

/** Why a unit of an editing phase was not attempted (R12, R19 of the fix pass). */
export interface NotAttempted {
  readonly cause: UnitUnattempted['cause'];
  readonly reason: string;
}

export interface FixState {
  readonly checks: {
    /** The checks the run executes, pinned at configuration by a version 1 plan and when the survey completes by a version 2 one, or null until `checks.planned` is folded. */
    readonly planned: ChecksPlanned | null;
    /** Every run or skip of a check, by checks phase, in ledger order. */
    readonly runs: Readonly<Record<CheckPhase, readonly CheckRan[]>>;
  };
  /** The routes, clusters and batches, or null until the fixes phase plans them. */
  readonly plan: FixesPlanned | null;
  /** The second round of the fixes phase, or null until its first round has settled and it is planned (R21). */
  readonly secondRound: FixesReplanned | null;
  /** Each recorded answer, by editing phase and then by unit key. */
  readonly answers: Readonly<Record<EditingPhase, Readonly<Record<string, FixRecorded>>>>;
  /** Every revision of the tree, in ledger order. */
  readonly revisions: readonly TreeRevised[];
  /** The units settled without an answer, by editing phase and then by unit key: two failures or the run budget, with the reason; their findings are not attempted. */
  readonly notAttempted: Readonly<Record<EditingPhase, Readonly<Record<string, NotAttempted>>>>;
  /** The commits built from the run after its report, or null until they are. */
  readonly commits: CommitsCreated | null;
}

/** The fix state of a run just configured with the fix pass. */
export function emptyFixState(): FixState {
  return {
    checks: { planned: null, runs: Object.fromEntries(checkPhases.map((phase) => [phase, []])) as unknown as Record<CheckPhase, CheckRan[]> },
    plan: null,
    secondRound: null,
    answers: Object.fromEntries(editingPhases.map((phase) => [phase, {}])) as Record<EditingPhase, Record<string, FixRecorded>>,
    revisions: [],
    notAttempted: Object.fromEntries(editingPhases.map((phase) => [phase, {}])) as Record<EditingPhase, Record<string, NotAttempted>>,
    commits: null,
  };
}

/** The last run of a kind's check in a checks phase, or null when it has none. */
export function lastRun(fix: FixState, phase: CheckPhase, kind: CheckKind): CheckRan | null {
  return fix.checks.runs[phase].findLast((run) => run.kind === kind) ?? null;
}

/** Whether a kind's check failed or timed out before any edit (R10, R24 of the fix pass). */
export function failedAtBaseline(fix: FixState, kind: CheckKind): boolean {
  return ['failed', 'timeout'].includes(lastRun(fix, 'baseline-checks', kind)?.outcome ?? '');
}

/**
 * The kinds the repair takes (R10, R11, R24 of the fix pass): those whose
 * check failed or timed out after the fixes, having passed before any
 * edit, which the fixes broke, or having failed then too, whose output
 * may hide a failure the fixes added. The repair worker reads which
 * failures are new; a kind that did not start at baseline, its tool
 * missing, is never one.
 */
export function repairTargets(fix: FixState): CheckKind[] {
  const planned = fix.checks.planned?.checks ?? [];
  return planned
    .map((check) => check.kind)
    .filter((kind) => (lastRun(fix, 'baseline-checks', kind)?.outcome === 'passed' || failedAtBaseline(fix, kind)) && ['failed', 'timeout'].includes(lastRun(fix, 'checks', kind)?.outcome ?? ''));
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

/** The clusters of the round a fixes-phase batch belongs to: within a round no file has two owners, and a round's ownership ends with it (R21). */
export function roundClusters(fix: FixState, key: string): PlannedCluster[] {
  const second = fix.secondRound?.batches.some((batch) => batch.key === key) ?? false;
  return [...((second ? fix.secondRound?.clusters : fix.plan?.clusters) ?? [])];
}

/** Whether every batch of the first round has settled: answered, or not attempted. */
export function firstRoundSettled(fix: FixState): boolean {
  return (fix.plan?.batches ?? []).every((batch) => Object.hasOwn(fix.answers.fixes, batch.key) || isNotAttempted(fix, 'fixes', batch.key));
}

/** A finding's last recorded answer in the fixes phase, the second round's over the first's, with the batch that gave it; null when none answered it. */
export function lastAnswerOf(fix: FixState, id: string): { readonly batch: string; readonly finding: FixedFinding } | null {
  for (const batch of [...allBatches(fix)].reverse()) {
    if (!batch.findingIds.includes(id)) continue;
    const finding = fix.answers.fixes[batch.key]?.findings.find((candidate) => candidate.id === id);
    if (finding !== undefined) return { batch: batch.key, finding };
  }
  return null;
}

/** The cluster a fixes-phase unit works, by its batch key, or null. */
export function clusterOfBatch(fix: FixState, key: string): PlannedCluster | null {
  const batch = batchOf(fix, key);
  return batch === null ? null : clusterOf(fix, batch.cluster);
}

/** The batches of the same cluster planned before this one, in their order; none for a key the plan does not have. */
export function earlierBatches(fix: FixState, key: string): PlannedBatch[] {
  const batch = batchOf(fix, key);
  if (batch === null) return [];
  const siblings = allBatches(fix).filter((candidate) => candidate.cluster === batch.cluster);
  return siblings.slice(0, siblings.indexOf(batch));
}

/** Every path the fixes phase revised, sorted: what the repair owns (TD8 of the fix pass). */
export function fixesRevisedPaths(fix: FixState): string[] {
  return [...new Set(fix.revisions.filter((revision) => revision.phase === 'fixes').flatMap((revision) => revision.files.map((file) => file.path)))].sort();
}

/** The files a unit of an editing phase owns: its batch's cluster's files, or for the repair everything the fixes phase revised. */
export function ownedFiles(fix: FixState, phase: EditingPhase, key: string): readonly string[] {
  return phase === 'repair' ? fixesRevisedPaths(fix) : (clusterOfBatch(fix, key)?.files ?? []);
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

/** Whether a unit of an editing phase is settled as not attempted, after two failures or at the run budget. */
export function isNotAttempted(fix: FixState, phase: EditingPhase, key: string): boolean {
  return Object.hasOwn(fix.notAttempted[phase], key);
}

/** What routing reads of a finding's decision: which finding, what was decided, and for an ask the default it applies; picked from each kind's variant, so an ask always carries its question. */
export type RoutedDecision = RecordedDecision extends infer Decision ? (Decision extends RecordedDecision ? Pick<Decision, 'id' | 'decision' | 'ask'> : never) : never;

/**
 * A finding's route by its decision (R6 of the decision step), the one
 * rule the planner plans by and the fold holds a recorded plan to: a
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
    case 'ask': {
      const applied = decision.ask.options[decision.ask.applied];
      if (applied === undefined) throw new Error(`The ask decided for ${decision.id} applies no option it offers`);
      return applied.edits ? 'fixer' : 'held';
    }
  }
}
