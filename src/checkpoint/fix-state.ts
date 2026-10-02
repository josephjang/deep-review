/**
 * What the fix pass's events say about a run (R6, R10 of the fix pass):
 * the checks it pinned and every run of them, the plan of routes,
 * clusters and batches, each fixer's recorded answer, every revision of the tree in
 * ledger order, the units that failed twice, and the commits built from
 * the run afterwards. Facts as recorded; the planner reads what to do
 * next from them. The questions below are answered from this state alone.
 */
import { checkPhases, editingPhases, type CheckKind, type CheckPhase, type EditingPhase } from '../review/vocabulary.ts';
import type { CheckRan, ChecksPlanned, CommitsCreated, FixesPlanned, FixRecorded, TreeRevised } from './events.ts';

export interface FixState {
  readonly checks: {
    /** The checks pinned at configuration, or null until `checks.planned` is folded. */
    readonly planned: ChecksPlanned | null;
    /** Every run or skip of a check, by checks phase, in ledger order. */
    readonly runs: Readonly<Record<CheckPhase, readonly CheckRan[]>>;
  };
  /** The routes, clusters and batches, or null until the fixes phase plans them. */
  readonly plan: FixesPlanned | null;
  /** Each recorded answer, by editing phase and then by unit key. */
  readonly answers: Readonly<Record<EditingPhase, Readonly<Record<string, FixRecorded>>>>;
  /** Every revision of the tree, in ledger order. */
  readonly revisions: readonly TreeRevised[];
  /** The units that failed twice, by editing phase and then by unit key, with the reason; their findings are not attempted. */
  readonly notAttempted: Readonly<Record<EditingPhase, Readonly<Record<string, string>>>>;
  /** The commits built from the run after its report, or null until they are. */
  readonly commits: CommitsCreated | null;
}

/** The fix state of a run just configured with the fix pass. */
export function emptyFixState(): FixState {
  return {
    checks: { planned: null, runs: Object.fromEntries(checkPhases.map((phase) => [phase, []])) as unknown as Record<CheckPhase, CheckRan[]> },
    plan: null,
    answers: Object.fromEntries(editingPhases.map((phase) => [phase, {}])) as Record<EditingPhase, Record<string, FixRecorded>>,
    revisions: [],
    notAttempted: Object.fromEntries(editingPhases.map((phase) => [phase, {}])) as Record<EditingPhase, Record<string, string>>,
    commits: null,
  };
}

/** The last run of a kind's check in a checks phase, or null when it has none. */
export function lastRun(fix: FixState, phase: CheckPhase, kind: CheckKind): CheckRan | null {
  return fix.checks.runs[phase].findLast((run) => run.kind === kind) ?? null;
}

/**
 * The kinds the repair takes (R10, R11 of the fix pass): those whose check
 * passed before any edit and failed or timed out after the fixes. A kind
 * that failed at baseline is never the fixers' fault and is not repaired.
 */
export function repairTargets(fix: FixState): CheckKind[] {
  const planned = fix.checks.planned?.checks ?? [];
  return planned
    .map((check) => check.kind)
    .filter((kind) => lastRun(fix, 'baseline-checks', kind)?.outcome === 'passed' && ['failed', 'timeout'].includes(lastRun(fix, 'checks', kind)?.outcome ?? ''));
}

export type PlannedCluster = FixesPlanned['clusters'][number];
export type PlannedBatch = FixesPlanned['batches'][number];

/** The planned cluster with this id, or null. */
export function clusterOf(fix: FixState, id: string): PlannedCluster | null {
  return fix.plan?.clusters.find((cluster) => cluster.id === id) ?? null;
}

/** The planned batch with this key, a fixes-phase unit key, or null. */
export function batchOf(fix: FixState, key: string): PlannedBatch | null {
  return fix.plan?.batches.find((batch) => batch.key === key) ?? null;
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
  const siblings = (fix.plan?.batches ?? []).filter((candidate) => candidate.cluster === batch.cluster);
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

/** Whether a unit of an editing phase failed twice and is settled as not attempted. */
export function isNotAttempted(fix: FixState, phase: EditingPhase, key: string): boolean {
  return Object.hasOwn(fix.notAttempted[phase], key);
}
