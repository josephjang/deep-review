/**
 * What the fix pass's events say about a run (R6, R10, R18, R21 of the fix
 * pass; R3 of commit series integrity): the checks it pinned and every run
 * of them, the plan of routes, clusters and batches and the second
 * round's, each fixer's recorded answer, every revision of the tree in
 * ledger order, the units settled without an answer, the files the
 * clusters claimed and the claims left out of the ledger, and the commits
 * built from the run afterwards. Facts as recorded; the planner reads what
 * to do next from them. The questions below are answered from this state
 * alone.
 */
import { checkPhases, editingPhases, type CheckKind, type CheckPhase, type EditingPhase, type LostClaimReason } from '../review/vocabulary.ts';
import type { CheckRan, ChecksPlannedV1, ClaimsLost, CommitsCreated, FixedFinding, FixesPlanned, FixesReplanned, FixRecorded, PlannedCheckV2, RecordedDecision, TreeRevised, UnitUnattempted } from './events.ts';

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
  /** Every file claimed, in ledger order, both rounds' (R3 of commit series integrity). */
  readonly claims: readonly RecordedClaim[];
  /** Every claim marker left out of the ledger, in ledger order (R3, review F9). */
  readonly lostClaims: readonly LostClaim[];
  /** The holder each recorded violation was judged against when its answer folded, by fixes-phase unit key and then path; a later claim of the path does not change it (R6 of commit series integrity). */
  readonly violationHolders: Readonly<Record<string, Readonly<Record<string, PathHolder>>>>;
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
    claims: [],
    lostClaims: [],
    violationHolders: {},
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

/** Whether a fixes-phase batch has settled: answered, or not attempted. */
const batchSettled = (fix: FixState, key: string): boolean => Object.hasOwn(fix.answers.fixes, key) || isNotAttempted(fix, 'fixes', key);

/** Whether every batch of the first round has settled: answered, or not attempted. */
export function firstRoundSettled(fix: FixState): boolean {
  return (fix.plan?.batches ?? []).every((batch) => batchSettled(fix, batch.key));
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

/**
 * Who holds each path in a round (R3 of commit series integrity): its
 * owner by the round's plan, and for a path no cluster owns, the cluster
 * whose claim of it came last, settled or not. Keyed by `keyOf`, the path
 * as the engine compares it: the exact path for the fold, or lowercased
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
 * (PD3). The repair, the only unit of its phase, has none. Keyed by the
 * exact path, as the fold compares paths, or by `keyOf`.
 */
export function heldByOthers(fix: FixState, key: string, keyOf: (path: string) => string = (path) => path): Map<string, PathHolder> {
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
 */
export function heldInRoundByOthers(fix: FixState, key: string, keyOf: (path: string) => string = (path) => path): Map<string, PathHolder> {
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

/** An ask as a decision records it: its question, its options, and the indexes of the option recommended and the default applied. */
export type DecidedAsk = Extract<RecordedDecision, { readonly decision: 'ask' }>['ask'];

/** The option an ask applies as its default; the ledger holds its index among the options, so a missing one is a state the fold never holds. */
export function appliedOptionOf(ask: DecidedAsk): DecidedAsk['options'][number] {
  const applied = ask.options[ask.applied];
  if (applied === undefined) throw new Error(`An ask applies option ${String(ask.applied)} of the ${String(ask.options.length)} it offers`);
  return applied;
}

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
    case 'ask':
      return appliedOptionOf(decision.ask).edits ? 'fixer' : 'held';
  }
}
