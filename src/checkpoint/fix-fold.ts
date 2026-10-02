/**
 * The reducers of the fix pass's events (R3, R5, R6, R9, R12, R17, R18 of
 * the fix pass), registered by `fold.ts` beside the review's. Each refuses
 * a history the engine could not have written: a second plan, a batch out
 * of its cluster's order or over the pinned size, a run of a
 * check whose phase is not running, two runs of one kind in a phase, an
 * answer for a unit that does not exist, a revision no answer or check
 * accounts for, commits on a run without a report.
 */
import { batchKeySchema, clusterIdSchema, isCheckPhase, isEditingPhase, repairUnitKey, type EditingPhase } from '../review/vocabulary.ts';
import type { CheckRan, ChecksPlanned, ClusterFailed, CommitsCreated, FixesPlanned, FixRecorded, TreeRevised } from './events.ts';
import { batchOf, clusterOfBatch, isNotAttempted, lastRun, repairTargets, type FixState } from './fix-state.ts';
import type { DecodedEvent, FoldDrafts, Reducer, RunState } from './fold.ts';
import { answered, invalid, requireReview, requireRunning, requireUnanswered, withReview, type ReviewState } from './review-fold.ts';

/** The run, which must be configured for review with the fix pass. */
function requireFix(state: RunState | undefined, event: DecodedEvent): { current: RunState; review: ReviewState; fix: FixState } {
  const { current, review } = requireReview(state, event);
  if (review.fix === null) throw invalid(event, `has ${event.kind} on a run configured without the fix pass`);
  return { current, review, fix: review.fix };
}

const withFix = (current: RunState, review: ReviewState, fix: FixState, event: DecodedEvent, units: ReviewState['units'] = review.units): RunState => withReview(current, { ...review, fix, units }, event);

/** The ids a unit of an editing phase answers for: its batch's findings, or for the repair the kinds it repairs. Null for a unit the phase does not have. */
function unitIds(fix: FixState, phase: EditingPhase, key: string): readonly string[] | null {
  if (phase === 'repair') {
    const targets = repairTargets(fix);
    return key === repairUnitKey && targets.length > 0 ? targets : null;
  }
  return batchOf(fix, key)?.findingIds ?? null;
}

const checksPlanned: Reducer<ChecksPlanned> = (state, payload, event) => {
  const { current, review, fix } = requireFix(state, event);
  if (fix.checks.planned !== null) throw invalid(event, 'plans its checks twice');
  const baseline = review.phases['baseline-checks'].status;
  if (baseline === 'completed' || baseline === 'degraded') throw invalid(event, `plans its checks after the baseline phase ${baseline}`);
  return withFix(current, review, { ...fix, checks: { ...fix.checks, planned: payload } }, event);
};

const fixesPlanned: Reducer<FixesPlanned> = (state, payload, event) => {
  const { current, review, fix } = requireFix(state, event);
  requireRunning(review, event, 'fixes');
  if (fix.plan !== null) throw invalid(event, 'plans its fixes twice');
  // Every ranked finding is routed once, and only those.
  const ranked = (review.ranking ?? []).map((finding) => finding.id);
  const routed = payload.routes.map((route) => route.id);
  if (new Set(routed).size !== routed.length || routed.length !== ranked.length || !ranked.every((id) => routed.includes(id))) {
    throw invalid(event, `routes [${routed.join(', ')}], which is not every ranked finding [${ranked.join(', ')}] once`);
  }
  const toFixer = new Set(payload.routes.filter((route) => route.route === 'fixer').map((route) => route.id));
  const clustered = new Set<string>();
  const owner = new Map<string, string>();
  payload.clusters.forEach((cluster, index) => {
    if (cluster.id !== `c${String(index + 1)}` || !clusterIdSchema.safeParse(cluster.id).success) throw invalid(event, `numbers cluster ${String(index + 1)} ${cluster.id}`);
    for (const id of cluster.findingIds) {
      if (!toFixer.has(id)) throw invalid(event, `clusters finding ${id}, which is not routed to a fixer`);
      if (clustered.has(id)) throw invalid(event, `clusters finding ${id} twice`);
      clustered.add(id);
    }
    for (const file of cluster.files) {
      const first = owner.get(file);
      if (first !== undefined) throw invalid(event, `gives file ${file} to clusters ${first} and ${cluster.id}`);
      owner.set(file, cluster.id);
    }
  });
  const unclustered = [...toFixer].filter((id) => !clustered.has(id));
  if (unclustered.length > 0) throw invalid(event, `routes ${unclustered.join(', ')} to a fixer but clusters none of them`);
  requireBatches(event, payload, review.configuration.fixes?.batchSize ?? null);
  return withFix(current, review, { ...fix, plan: payload }, event);
};

/**
 * Hold a plan's batches to its clusters (R18): each cluster's batches,
 * numbered `<cluster>-1` upward in the order they appear, hold its
 * findings once each, in its order, none more than the pinned batch size;
 * and the batches appear in the rank of their first finding, the order
 * they are launched in.
 */
function requireBatches(event: DecodedEvent, payload: FixesPlanned, batchSize: number | null): void {
  if (batchSize === null) throw invalid(event, 'plans batches on a run that pinned no batch size');
  const rank = new Map(payload.routes.map((route, index) => [route.id, index]));
  // Per cluster, the batches seen so far and the findings they hold.
  const seen = new Map<string, { batches: number; findings: string[] }>();
  let previous = -1;
  for (const batch of payload.batches) {
    const { batches, findings: done } = seen.get(batch.cluster) ?? { batches: 0, findings: [] };
    const cluster = payload.clusters.find((candidate) => candidate.id === batch.cluster);
    if (cluster === undefined) throw invalid(event, `plans batch ${batch.key} for cluster ${batch.cluster}, which it does not plan`);
    if (batch.key !== `${batch.cluster}-${String(batches + 1)}` || !batchKeySchema.safeParse(batch.key).success) throw invalid(event, `numbers batch ${String(batches + 1)} of cluster ${batch.cluster} ${batch.key}`);
    if (batch.findingIds.length > batchSize) throw invalid(event, `puts ${String(batch.findingIds.length)} findings in batch ${batch.key}, more than the pinned size ${String(batchSize)}`);
    const expected = cluster.findingIds.slice(done.length, done.length + batch.findingIds.length);
    if (batch.findingIds.some((id, index) => id !== expected[index])) throw invalid(event, `gives batch ${batch.key} [${batch.findingIds.join(', ')}], not the next of cluster ${cluster.id}'s findings in order`);
    const first = rank.get(batch.findingIds[0]!)!;
    if (first < previous) throw invalid(event, `plans batch ${batch.key} after a batch whose first finding ranks below its own`);
    previous = first;
    seen.set(batch.cluster, { batches: batches + 1, findings: [...done, ...batch.findingIds] });
  }
  for (const cluster of payload.clusters) {
    if ((seen.get(cluster.id)?.findings.length ?? 0) !== cluster.findingIds.length) throw invalid(event, `leaves findings of cluster ${cluster.id} in no batch`);
  }
}

const checkRan: Reducer<CheckRan> = (state, payload, event) => {
  const { current, review, fix } = requireFix(state, event);
  requireRunning(review, event, payload.phase, payload.attempt);
  const planned = fix.checks.planned?.checks.find((check) => check.kind === payload.kind);
  if (planned === undefined) throw invalid(event, `runs the ${payload.kind} check before the checks are planned`);
  if (planned.command === null) throw invalid(event, `runs the ${payload.kind} check, which has no command`);
  if (planned.command !== payload.command) throw invalid(event, `runs ${JSON.stringify(payload.command)} for the ${payload.kind} check, pinned as ${JSON.stringify(planned.command)}`);
  if (lastRun(fix, payload.phase, payload.kind) !== null) throw invalid(event, `runs the ${payload.kind} check twice in ${payload.phase}`);
  const runs = { ...fix.checks.runs, [payload.phase]: [...fix.checks.runs[payload.phase], payload] };
  return withFix(current, review, { ...fix, checks: { ...fix.checks, runs } }, event);
};

const fixRecorded: Reducer<FixRecorded> = (state, payload, event, drafts: FoldDrafts) => {
  const { current, review, fix } = requireFix(state, event);
  requireRunning(review, event, payload.phase);
  const ids = unitIds(fix, payload.phase, payload.key);
  if (ids === null) throw invalid(event, `records an answer for ${payload.phase}:${payload.key}, which the phase does not have`);
  requireUnanswered(review, event, { phase: payload.phase, key: payload.key });
  if (isNotAttempted(fix, payload.phase, payload.key)) throw invalid(event, `records an answer for ${payload.phase}:${payload.key} after it failed`);
  const given = payload.findings.map((finding) => finding.id);
  if (given.length !== ids.length || !ids.every((id) => given.includes(id))) throw invalid(event, `answers [${given.join(', ')}] for ${payload.phase}:${payload.key}, which holds [${ids.join(', ')}]`);
  // A violation is a reported file another cluster of the phase owns; the repair, the only unit of its phase, has none.
  const own = payload.phase === 'fixes' ? clusterOfBatch(fix, payload.key)?.id : undefined;
  const others = new Set((fix.plan?.clusters ?? []).filter((cluster) => payload.phase === 'fixes' && cluster.id !== own).flatMap((cluster) => cluster.files));
  const named = new Set(payload.findings.flatMap((finding) => finding.files));
  for (const path of payload.violations) {
    if (!others.has(path) || !named.has(path)) throw invalid(event, `records a violation on ${path}, which is not a reported file another cluster owns`);
  }
  const answers = { ...fix.answers, [payload.phase]: { ...fix.answers[payload.phase], [payload.key]: payload } };
  return withFix(current, review, { ...fix, answers }, event, answered(review, drafts, { phase: payload.phase, key: payload.key }, payload.workerId));
};

const treeRevised: Reducer<TreeRevised> = (state, payload, event) => {
  const { current, review, fix } = requireFix(state, event);
  requireRunning(review, event, payload.phase);
  const { source } = payload;
  switch (source.kind) {
    case 'fix': {
      if (!isEditingPhase(payload.phase)) throw invalid(event, `revises the tree for an answer in ${payload.phase}, which no fixer runs in`);
      const answer = fix.answers[payload.phase][source.key];
      if (answer === undefined || answer.workerId !== source.workerId) throw invalid(event, `revises the tree for ${payload.phase}:${source.key} by worker ${source.workerId}, whose answer is not recorded`);
      const ids = new Set(answer.findings.map((finding) => finding.id));
      const revisedBefore = new Set(fix.revisions.filter((revision) => revision.phase === payload.phase && revision.source.kind === 'fix' && revision.source.key === source.key).flatMap((revision) => revision.change.findings));
      for (const id of payload.change.findings) {
        if (!ids.has(id)) throw invalid(event, `revises the tree for ${id}, which ${payload.phase}:${source.key} did not answer`);
        if (revisedBefore.has(id)) throw invalid(event, `revises the tree for ${id} twice`);
      }
      break;
    }
    case 'check': {
      if (!isCheckPhase(payload.phase)) throw invalid(event, `revises the tree for the ${source.check} check in ${payload.phase}, which runs no check`);
      const run = lastRun(fix, payload.phase, source.check);
      if (run === null || run.outcome === 'skipped') throw invalid(event, `revises the tree for the ${source.check} check, which did not run in ${payload.phase}`);
      break;
    }
    case 'attempt': {
      if (!isEditingPhase(payload.phase)) throw invalid(event, `revises the tree for an attempt in ${payload.phase}, which no fixer runs in`);
      const ids = unitIds(fix, payload.phase, source.key);
      if (ids === null) throw invalid(event, `revises the tree for an attempt of ${payload.phase}:${source.key}, which the phase does not have`);
      // The attempt's failure, or its loss, is folded first, in the same append.
      if (!(review.units[payload.phase][source.key]?.failures ?? []).some((failure) => failure.workerId === source.workerId)) {
        throw invalid(event, `revises the tree for an attempt of ${payload.phase}:${source.key} by worker ${source.workerId}, which did not fail`);
      }
      const revisedBefore = new Set(fix.revisions.filter((revision) => revision.source.kind === 'attempt' && revision.source.workerId === source.workerId).flatMap((revision) => revision.change.findings));
      for (const id of payload.change.findings) {
        if (!ids.includes(id)) throw invalid(event, `revises the tree for ${id}, which ${payload.phase}:${source.key} does not hold`);
        if (revisedBefore.has(id)) throw invalid(event, `revises the tree for ${id} twice for one attempt`);
      }
      break;
    }
  }
  return withFix(current, review, { ...fix, revisions: [...fix.revisions, payload] }, event);
};

const clusterFailed: Reducer<ClusterFailed> = (state, payload, event) => {
  const { current, review, fix } = requireFix(state, event);
  requireRunning(review, event, payload.phase);
  if (unitIds(fix, payload.phase, payload.key) === null) throw invalid(event, `fails ${payload.phase}:${payload.key}, which the phase does not have`);
  requireUnanswered(review, event, { phase: payload.phase, key: payload.key });
  if (isNotAttempted(fix, payload.phase, payload.key)) throw invalid(event, `fails ${payload.phase}:${payload.key} twice`);
  const notAttempted = { ...fix.notAttempted, [payload.phase]: { ...fix.notAttempted[payload.phase], [payload.key]: payload.reason } };
  return withFix(current, review, { ...fix, notAttempted }, event);
};

const commitsCreated: Reducer<CommitsCreated> = (state, payload, event) => {
  const { current, review, fix } = requireFix(state, event);
  if (review.report === null) throw invalid(event, 'creates commits before its report');
  if (fix.commits !== null) throw invalid(event, 'creates its commits twice');
  if (current.scope === null || payload.from !== current.scope.head) throw invalid(event, `creates commits on ${payload.from}, not the scope's head`);
  // The captured change first in worktree mode, then every revision once, in ledger order.
  const expected: (number | 'change')[] = [...(current.scope.mode === 'worktree' ? ['change' as const] : []), ...fix.revisions.map((_, index) => index)];
  const given = payload.commits.map((commit) => commit.revision);
  if (given.length !== expected.length || given.some((revision, index) => revision !== expected[index])) throw invalid(event, `creates commits for [${given.join(', ')}], not [${expected.join(', ')}]`);
  if (payload.commits.at(-1)!.sha !== payload.to) throw invalid(event, 'moves the branch to a commit that is not its last');
  return withFix(current, review, { ...fix, commits: payload }, event);
};

/** The fix pass's reducers, registered by `fold.ts` beside the review's. */
export const fixReducers = {
  'checks.planned@1': checksPlanned,
  'fixes.planned@1': fixesPlanned,
  'check.ran@1': checkRan,
  'fix.recorded@1': fixRecorded,
  'tree.revised@1': treeRevised,
  'cluster.failed@1': clusterFailed,
  'commits.created@1': commitsCreated,
} as const;
