/**
 * The reducers of the fix pass's events (R3, R5, R6, R9, R12, R17, R18 of
 * the fix pass), registered by `fold.ts` beside the review's. Each refuses
 * a history the engine could not have written: a second plan, a plan of
 * routes the findings' decisions do not give (R6 of the decision step), a
 * plan of checks the survey did not give, a batch out
 * of its cluster's order or over the pinned size, a run of a
 * check whose phase is not running, two runs of one kind in a phase, an
 * answer for a unit that does not exist, a revision no answer or check
 * accounts for, commits on a run without a report, a claim of a file
 * another cluster holds (R3 of commit series integrity).
 */
import { batchKeySchema, clusterIdSchema, isCheckPhase, isEditingPhase, repairUnitKey, type EditingPhase } from '../review/vocabulary.ts';
import type { CheckRan, ChecksPlannedV1, ChecksPlannedV2, ClaimsLost, CommitsCreated, FilesClaimed, FixesPlanned, FixesReplanned, FixRecorded, TreeRevised, UnitUnattempted } from './events.ts';
import { batchOf, claimRefusal, claimsOfRound, clusterClaims, firstRoundHolders, firstRoundSettled, heldByOthers, holdersOf, isNotAttempted, lastAnswerOf, lastRun, repairTargets, roundOf, routeOfDecision, settledClusters, type ChecksPlanned, type FixState, type PathHolder } from './fix-state.ts';
import type { DecodedEvent, FoldDrafts, Reducer, RunState } from './fold.ts';
import { answered, invalid, requireReview, requireRunning, requireUnanswered, withReview, type ReviewState } from './review-fold.ts';
import { lastSurvey } from './survey-state.ts';

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

/** The checks of a version 1 plan, recorded at configuration by the manifest rules (R8 of the fix pass), on a run configured before the survey existed. */
const checksPlannedV1: Reducer<ChecksPlannedV1> = (state, payload, event) => {
  const { current, review, fix } = requireFix(state, event);
  if (fix.checks.planned !== null) throw invalid(event, 'plans its checks twice');
  if (review.survey !== null) throw invalid(event, 'plans its checks by the manifest rules on a run its survey decides them for');
  const baseline = review.phases['baseline-checks'].status;
  if (baseline === 'completed' || baseline === 'degraded') throw invalid(event, `plans its checks after the baseline phase ${baseline}`);
  const planned: ChecksPlanned = { checks: payload.checks.map((check) => ({ ...check, source: null })), manager: payload.manager };
  return withFix(current, review, { ...fix, checks: { ...fix.checks, planned } }, event);
};

/**
 * The checks of a version 2 plan, recorded when the survey phase
 * completes (R6, R15 of the repository survey): once, while the phase
 * runs, standing on a recorded survey or on the run going on without
 * one. A check the survey decided is the last answer's command for its
 * kind, with its source and basis, and no tool missing; one nobody
 * decided is a kind that answer gave no command. A flag's is the flag's
 * and is not checked here, since the flags are not on the ledger.
 */
const checksPlannedV2: Reducer<ChecksPlannedV2> = (state, payload, event) => {
  const { current, review, fix } = requireFix(state, event);
  if (fix.checks.planned !== null) throw invalid(event, 'plans its checks twice');
  if (review.survey === null) throw invalid(event, 'plans its checks from a survey on a run configured before the survey existed');
  requireRunning(review, event, 'survey');
  const answer = lastSurvey(review.survey);
  if (answer === null && review.survey.failure === null) throw invalid(event, 'plans its checks before its survey is recorded or the run goes on without one');
  for (const check of payload.checks) {
    if (check.origin === 'flag') continue;
    const surveyed = answer?.checks?.find((entry) => entry.kind === check.kind) ?? null;
    if (surveyed === null) throw invalid(event, `plans the ${check.kind} check as the survey's, which surveyed no such kind`);
    if (check.origin === 'none') {
      if (surveyed.command !== null) throw invalid(event, `plans no ${check.kind} check, for which the survey gave ${JSON.stringify(surveyed.command)}`);
      continue;
    }
    const same = surveyed.command === check.command && surveyed.missingTool === null && surveyed.basis === check.source?.basis && surveyed.source?.path === check.source.path && surveyed.source.quote === check.source.quote;
    if (!same) throw invalid(event, `plans ${JSON.stringify(check.command)} for the ${check.kind} check, which is not the survey's runnable command for it`);
  }
  const planned: ChecksPlanned = { checks: payload.checks, manager: null };
  return withFix(current, review, { ...fix, checks: { ...fix.checks, planned } }, event);
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
  // A run with the decision step routes each finding by its recorded decision (R6 of the decision step); one configured before it routed by verdict and angle, which this fold does not recompute.
  if (review.phases.decision.status !== 'skipped') {
    if (ranked.length > 0 && review.decisions === null) throw invalid(event, 'plans its fixes before its findings are decided');
    for (const route of payload.routes) {
      const decision = review.decisions?.find((candidate) => candidate.id === route.id);
      if (decision !== undefined && routeOfDecision(decision) !== route.route) throw invalid(event, `routes ${route.id} ${route.route}, which its ${decision.decision} decision does not`);
    }
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
  requireBatches(event, payload.routes, payload.clusters, payload.batches, review.configuration.fixes?.batchSize ?? null);
  return withFix(current, review, { ...fix, plan: payload }, event);
};

/**
 * The second round's plan (R21; R4 of commit series integrity): once,
 * after the first round settled; each finding it takes was answered
 * blocked in the first round on the files it names, each owned or claimed
 * at any time of the round by another first-round cluster; its clusters
 * are numbered on from the first round's, hold those findings once each,
 * and own each finding's first cluster's files, the files that cluster
 * claimed and the files it needed, no file twice; and its batches are held
 * to its clusters as the first round's are. Which findings qualify is
 * checked, not recomputed, so a later engine with another rule reads this
 * plan as it was made; a history without claims folds as it did before
 * claims existed.
 */
const fixesReplanned: Reducer<FixesReplanned> = (state, payload, event) => {
  const { current, review, fix } = requireFix(state, event);
  requireRunning(review, event, 'fixes');
  const plan = fix.plan;
  if (plan === null) throw invalid(event, 'plans a second round before the first');
  if (fix.secondRound !== null) throw invalid(event, 'plans its second round twice');
  if (!firstRoundSettled(fix)) throw invalid(event, 'plans its second round before every batch of the first settled');
  const heldBy = firstRoundHolders(plan.clusters, claimsOfRound(fix, 1));
  const filesOf = new Map<string, readonly string[]>();
  for (const entry of payload.blocked) {
    if (filesOf.has(entry.id)) throw invalid(event, `takes finding ${entry.id} into its second round twice`);
    const own = plan.clusters.find((cluster) => cluster.findingIds.includes(entry.id));
    const answer = lastAnswerOf(fix, entry.id)?.finding;
    if (own === undefined || answer?.status !== 'blocked') throw invalid(event, `takes finding ${entry.id} into its second round, which the first round did not answer blocked`);
    if (new Set(entry.requiredFiles).size !== entry.requiredFiles.length || !entry.requiredFiles.every((path) => answer.requiredFiles.includes(path)) || !answer.requiredFiles.every((path) => entry.requiredFiles.includes(path))) {
      throw invalid(event, `gives finding ${entry.id} the files [${entry.requiredFiles.join(', ')}], not the ones it was blocked on [${answer.requiredFiles.join(', ')}]`);
    }
    const foreign = entry.requiredFiles.filter((path) => ![...(heldBy.get(path) ?? [])].some((cluster) => cluster !== own.id));
    if (foreign.length > 0) throw invalid(event, `takes finding ${entry.id} into its second round for ${foreign.join(', ')}, which no other first-round cluster owned or claimed`);
    filesOf.set(entry.id, [...new Set([...own.files, ...clusterClaims(fix, 1, own.id), ...entry.requiredFiles])]);
  }
  const owner = new Map<string, string>();
  const taken = new Set<string>();
  payload.clusters.forEach((cluster, index) => {
    const number = plan.clusters.length + index + 1;
    if (cluster.id !== `c${String(number)}`) throw invalid(event, `numbers second-round cluster ${String(index + 1)} ${cluster.id}, not c${String(number)}`);
    for (const id of cluster.findingIds) {
      if (!filesOf.has(id)) throw invalid(event, `clusters finding ${id} in its second round, which it does not take`);
      if (taken.has(id)) throw invalid(event, `clusters finding ${id} twice in its second round`);
      taken.add(id);
    }
    const expected = [...new Set(cluster.findingIds.flatMap((id) => filesOf.get(id)!))].sort();
    if (expected.length !== cluster.files.length || expected.some((path, position) => [...cluster.files].sort()[position] !== path)) {
      throw invalid(event, `gives second-round cluster ${cluster.id} the files [${cluster.files.join(', ')}], not its findings' [${expected.join(', ')}]`);
    }
    for (const path of cluster.files) {
      const first = owner.get(path);
      if (first !== undefined) throw invalid(event, `gives file ${path} to second-round clusters ${first} and ${cluster.id}`);
      owner.set(path, cluster.id);
    }
  });
  const untaken = [...filesOf.keys()].filter((id) => !taken.has(id));
  if (untaken.length > 0) throw invalid(event, `takes ${untaken.join(', ')} into its second round but clusters none of them`);
  requireBatches(event, plan.routes, payload.clusters, payload.batches, review.configuration.fixes?.batchSize ?? null);
  return withFix(current, review, { ...fix, secondRound: payload }, event);
};

/**
 * Hold a plan's batches to its clusters (R18): each cluster's batches,
 * numbered `<cluster>-1` upward in the order they appear, hold its
 * findings once each, in its order, none more than the pinned batch size;
 * and the batches appear in the rank of their first finding, the order
 * they are launched in.
 */
function requireBatches(event: DecodedEvent, routes: FixesPlanned['routes'], clusters: FixesPlanned['clusters'], batches: FixesPlanned['batches'], batchSize: number | null): void {
  if (batchSize === null) throw invalid(event, 'plans batches on a run that pinned no batch size');
  const rank = new Map(routes.map((route, index) => [route.id, index]));
  // Per cluster, the batches seen so far and the findings they hold.
  const seen = new Map<string, { batches: number; findings: string[] }>();
  let previous = -1;
  for (const batch of batches) {
    const { batches: numbered, findings: done } = seen.get(batch.cluster) ?? { batches: 0, findings: [] };
    const cluster = clusters.find((candidate) => candidate.id === batch.cluster);
    if (cluster === undefined) throw invalid(event, `plans batch ${batch.key} for cluster ${batch.cluster}, which it does not plan`);
    if (batch.key !== `${batch.cluster}-${String(numbered + 1)}` || !batchKeySchema.safeParse(batch.key).success) throw invalid(event, `numbers batch ${String(numbered + 1)} of cluster ${batch.cluster} ${batch.key}`);
    if (batch.findingIds.length > batchSize) throw invalid(event, `puts ${String(batch.findingIds.length)} findings in batch ${batch.key}, more than the pinned size ${String(batchSize)}`);
    const expected = cluster.findingIds.slice(done.length, done.length + batch.findingIds.length);
    if (batch.findingIds.some((id, index) => id !== expected[index])) throw invalid(event, `gives batch ${batch.key} [${batch.findingIds.join(', ')}], not the next of cluster ${cluster.id}'s findings in order`);
    const first = rank.get(batch.findingIds[0]!)!;
    if (first < previous) throw invalid(event, `plans batch ${batch.key} after a batch whose first finding ranks below its own`);
    previous = first;
    seen.set(batch.cluster, { batches: numbered + 1, findings: [...done, ...batch.findingIds] });
  }
  for (const cluster of clusters) {
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
  // A violation is a reported file another cluster of the unit's round holds, by the plan or by a claim folded before the answer (R6 of commit series integrity), and that holder is kept with it; the repair, the only unit of its phase, has none.
  const others = payload.phase === 'fixes' ? heldByOthers(fix, payload.key) : new Map<string, PathHolder>();
  const named = new Set(payload.findings.flatMap((finding) => finding.files));
  const holders: [string, PathHolder][] = [];
  for (const path of payload.violations) {
    const holder = others.get(path);
    if (holder === undefined || !named.has(path)) throw invalid(event, `records a violation on ${path}, which is not a reported file another cluster holds`);
    holders.push([path, holder]);
  }
  const answers = { ...fix.answers, [payload.phase]: { ...fix.answers[payload.phase], [payload.key]: payload } };
  const violationHolders = holders.length === 0 ? fix.violationHolders : { ...fix.violationHolders, [payload.key]: Object.fromEntries(holders) };
  return withFix(current, review, { ...fix, answers, violationHolders }, event, answered(review, drafts, { phase: payload.phase, key: payload.key }, payload.workerId));
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

/**
 * The files one batch claimed (R1, R3, R6 of commit series integrity),
 * while the fixes phase runs: the batch is one the plan has, of the
 * cluster the event names, and each file is held by no cluster of the
 * batch's round, neither owned nor claimed by another cluster that has
 * not settled, nor claimed by this cluster while it holds it already. The
 * cluster then holds each file, the latest claimant of it.
 */
const filesClaimed: Reducer<FilesClaimed> = (state, payload, event) => {
  const { current, review, fix } = requireFix(state, event);
  requireRunning(review, event, 'fixes');
  const batch = batchOf(fix, payload.key);
  if (batch === null) throw invalid(event, `claims files for ${payload.key}, which the plan does not have`);
  if (batch.cluster !== payload.cluster) throw invalid(event, `claims files for ${payload.key} under cluster ${payload.cluster}, not its cluster ${batch.cluster}`);
  const round = roundOf(fix, payload.key);
  const holders = holdersOf(fix, round);
  const settled = settledClusters(fix, round);
  for (const file of payload.files) {
    const holder = holders.get(file.path);
    if (holder === undefined) continue;
    const refusal = claimRefusal(holder, payload.cluster, settled);
    if (refusal === null) continue;
    const why = refusal === 'owned' ? `which cluster ${holder.cluster} owns` : holder.cluster === payload.cluster ? 'which its cluster holds already' : `which cluster ${holder.cluster} holds and has not settled`;
    throw invalid(event, `claims ${file.path} for ${payload.key}, ${why}`);
  }
  const claims = [...fix.claims, ...payload.files.map((file) => ({ path: file.path, cluster: payload.cluster, key: payload.key, round, claimedAt: file.claimedAt }))];
  return withFix(current, review, { ...fix, claims }, event);
};

/** Claim markers the engine left out of the ledger (R3, review F9), while the fixes phase runs; the markers named the unit and the cluster, which need not be the plan's. */
const claimsLost: Reducer<ClaimsLost> = (state, payload, event) => {
  const { current, review, fix } = requireFix(state, event);
  requireRunning(review, event, 'fixes');
  const lostClaims = [...fix.lostClaims, ...payload.files.map((file) => ({ ...file, unit: payload.unit, cluster: payload.cluster }))];
  return withFix(current, review, { ...fix, lostClaims }, event);
};

const unitUnattempted: Reducer<UnitUnattempted> = (state, payload, event) => {
  const { current, review, fix } = requireFix(state, event);
  requireRunning(review, event, payload.phase);
  if (unitIds(fix, payload.phase, payload.key) === null) throw invalid(event, `settles ${payload.phase}:${payload.key}, which the phase does not have`);
  requireUnanswered(review, event, { phase: payload.phase, key: payload.key });
  if (isNotAttempted(fix, payload.phase, payload.key)) throw invalid(event, `settles ${payload.phase}:${payload.key} as not attempted twice`);
  const notAttempted = { ...fix.notAttempted, [payload.phase]: { ...fix.notAttempted[payload.phase], [payload.key]: { cause: payload.cause, reason: payload.reason } } };
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
  'checks.planned@1': checksPlannedV1,
  'checks.planned@2': checksPlannedV2,
  'fixes.planned@1': fixesPlanned,
  'fixes.replanned@1': fixesReplanned,
  'check.ran@1': checkRan,
  'fix.recorded@1': fixRecorded,
  'tree.revised@1': treeRevised,
  'unit.unattempted@1': unitUnattempted,
  'commits.created@1': commitsCreated,
  'files.claimed@1': filesClaimed,
  'claims.lost@1': claimsLost,
} as const;
