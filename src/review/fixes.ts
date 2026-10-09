/**
 * Which ranked findings go to a fixer, and how they are split among fixers
 * (R3, R18, R21 of the fix pass; R6 of the decision step): a finding is
 * routed by the decision the run recorded for it; the fixer-routed ones
 * are clustered one per file, a merged finding kept whole, so that no file
 * is owned by two clusters; each cluster's findings are cut into batches,
 * one fixer each, run one after another; and once that round has settled,
 * the findings blocked only on other clusters' files are planned again as
 * a second round. Pure over the ranked list, the decisions and the
 * answers; each plan is recorded once and resumed from the ledger.
 */
import type { FixedFinding, FixesPlanned } from '../checkpoint/events.ts';
import { firstRoundHolders, routeOfDecision, secondRoundFiles, type RecordedClaim, type RoutedDecision } from '../checkpoint/fix-state.ts';
import type { CandidateState } from '../checkpoint/review-fold.ts';
import { unlocatedSpellingIn } from './grouping.ts';
import type { ReportFinding } from './state.ts';

/** One ranked finding's route, as `fixes.planned@1` records it: `fixer`, or `held`, which no fixer sees. */
export type PlannedRoute = FixesPlanned['routes'][number];

/** The findings that share files, in rank order, and the files their fixers own. */
export interface PlannedCluster {
  /** `c1`, `c2`, ... in the order of each cluster's best-ranked finding. */
  readonly id: string;
  readonly findingIds: readonly string[];
  /** The repository paths the cluster owns, sorted; an unlocated finding contributes none. */
  readonly files: readonly string[];
}

/** One fixer's work: a run of consecutive findings of one cluster, which owns that cluster's files while it runs. */
export interface PlannedBatch {
  /** The cluster's id, a dash and the batch's number in the cluster from 1: `c1-1`, `c1-2`. */
  readonly key: string;
  readonly cluster: string;
  readonly findingIds: readonly string[];
}

export interface FixPlan {
  /** Every ranked finding's route, in rank order. */
  readonly routes: readonly PlannedRoute[];
  readonly clusters: readonly PlannedCluster[];
  /** Every cluster's batches, in launch order: by the rank of each batch's first finding. */
  readonly batches: readonly PlannedBatch[];
}

/**
 * A finding's key for one of its candidates: the repository path a
 * located one owns, or the spelling an unlocated one groups under, which
 * owns nothing. The NUL no path holds keeps the two kinds apart.
 */
const locatedKey = (path: string): string => `located\0${path}`;
const unlocatedKey = (spelling: string): string => `unlocated\0${spelling}`;
/** The path a located key owns, or null for an unlocated key. */
const ownedPath = (key: string): string | null => (key.startsWith('located\0') ? key.slice('located\0'.length) : null);

/**
 * Route the ranked findings by their decisions and cluster the
 * fixer-routed ones (R3). Every finding must have a decision, as the
 * decision phase records one per ranked finding; a finding with none is a
 * plan the engine cannot make, and throws. Each finding's keys are the
 * canonical file of its primary and of every member that is located, and
 * the spelling of every unlocated one, folded as verification grouping
 * folds it; clusters are the connected components of findings over shared
 * keys, so a merged finding across two files pulls every finding of both
 * into one cluster. `findings` must be in rank order, which then orders
 * the clusters by their best finding and each cluster's findings within
 * it. Each cluster's findings are then cut, in that order, into batches of
 * at most `batchSize` (`batchesOf`).
 */
export function planFixes(findings: readonly ReportFinding[], decisions: readonly RoutedDecision[], batchSize: number): FixPlan {
  const decided = new Map(decisions.map((decision) => [decision.id, decision]));
  const routes = findings.map((entry): PlannedRoute => {
    const decision = decided.get(entry.finding.id);
    if (decision === undefined) throw new Error(`Finding ${entry.finding.id} has no decision to route it by`);
    return { id: entry.finding.id, route: routeOfDecision(decision) };
  });
  const toFixer = new Set(routes.filter((route) => route.route === 'fixer').map((route) => route.id));
  const routed = findings.filter((entry) => toFixer.has(entry.finding.id));
  const candidatesOf = (entry: ReportFinding): readonly CandidateState[] => [entry.primary, ...entry.members];
  const spelling = unlocatedSpellingIn(routed.flatMap(candidatesOf));
  const keysOf = (entry: ReportFinding): string[] => [...new Set(candidatesOf(entry).map((candidate) => (candidate.located && candidate.file !== null ? locatedKey(candidate.file) : unlocatedKey(spelling(candidate)))))];

  const keys = routed.map(keysOf);
  const clusters = componentsOf(keys).map((indexes, position): PlannedCluster => ({
    id: `c${String(position + 1)}`,
    findingIds: indexes.map((index) => routed[index]!.finding.id),
    files: [...new Set(indexes.flatMap((index) => keys[index]!.map(ownedPath).filter((path) => path !== null)))].sort(),
  }));
  return { routes, clusters, batches: batchesOf(clusters, routes.map((route) => route.id), batchSize) };
}

/**
 * The connected components of items over the keys they share, each a list
 * of item positions in order, the components ordered by their first item:
 * so items given in rank order give clusters in the order of their
 * best-ranked item. A review has at most a few dozen findings, so the
 * union-find needs no path compression.
 */
function componentsOf(keys: readonly (readonly string[])[]): number[][] {
  const parent = keys.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    return root;
  };
  const owner = new Map<string, number>();
  keys.forEach((itemKeys, index) => {
    for (const key of itemKeys) {
      const first = owner.get(key);
      if (first === undefined) owner.set(key, index);
      else {
        // A component keeps its earliest item as its root, so component order follows the first item in it.
        const [a, b] = [find(first), find(index)];
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  });
  const members = new Map<number, number[]>();
  keys.forEach((_, index) => {
    const root = find(index);
    const list = members.get(root);
    if (list === undefined) members.set(root, [index]);
    else list.push(index);
  });
  return [...members.entries()].sort(([a], [b]) => a - b).map(([, indexes]) => indexes);
}

/** A finding the second round takes: its id and the files it was blocked on. */
export interface BlockedFinding {
  readonly id: string;
  readonly requiredFiles: readonly string[];
}

/** The second round of the fixes phase: the findings it takes, and their clusters and batches. */
export interface SecondRoundPlan {
  readonly blocked: readonly BlockedFinding[];
  readonly clusters: readonly PlannedCluster[];
  readonly batches: readonly PlannedBatch[];
}

/**
 * The second round (R21, PD18 of the fix pass; R4 of commit series
 * integrity), once every batch of the first has settled: each
 * fixer-routed finding, in rank order, whose first answer `answerOf`
 * gives is `blocked` on files that were each owned, or claimed at any
 * time of the round, by another first-round cluster; `claims` are the
 * first round's, settled or not. A finding's files are its first
 * cluster's, the files that cluster claimed, and the files it needed; the
 * findings are clustered over them as the first round clusters, numbered
 * on from its last cluster, and batched at `batchSize`. Empty when no
 * finding qualifies.
 */
export function planSecondRound(plan: Pick<FixPlan, 'routes' | 'clusters'>, answerOf: (id: string) => { readonly status: FixedFinding['status']; readonly requiredFiles: readonly string[] } | null, batchSize: number, claims: readonly Pick<RecordedClaim, 'path' | 'cluster'>[]): SecondRoundPlan {
  const heldBy = firstRoundHolders(plan.clusters, claims);
  const clusterOfFinding = new Map(plan.clusters.flatMap((cluster) => cluster.findingIds.map((id): [string, PlannedCluster] => [id, cluster])));
  const blocked = plan.routes.flatMap((route): (BlockedFinding & { readonly files: readonly string[] })[] => {
    const own = clusterOfFinding.get(route.id);
    const answer = own === undefined ? null : answerOf(route.id);
    if (own === undefined || answer === null || answer.status !== 'blocked' || answer.requiredFiles.length === 0) return [];
    const needed = [...new Set(answer.requiredFiles)];
    if (!needed.every((path) => [...(heldBy.get(path) ?? [])].some((cluster) => cluster !== own.id))) return [];
    return [{ id: route.id, requiredFiles: needed, files: secondRoundFiles(own, claims, needed) }];
  });
  const first = plan.clusters.length;
  const clusters = componentsOf(blocked.map((finding) => finding.files)).map((indexes, position): PlannedCluster => ({
    id: `c${String(first + position + 1)}`,
    findingIds: indexes.map((index) => blocked[index]!.id),
    files: [...new Set(indexes.flatMap((index) => blocked[index]!.files))].sort(),
  }));
  return {
    blocked: blocked.map(({ id, requiredFiles }) => ({ id, requiredFiles })),
    clusters,
    batches: batchesOf(clusters, plan.routes.map((route) => route.id), batchSize),
  };
}

/**
 * The batches of the clusters (R18): each cluster's findings, in rank
 * order, cut into consecutive runs of at most `batchSize`, numbered from
 * 1 within the cluster, and all of them ordered by the rank of their first
 * finding in `ranked`, so the run's best-ranked findings are fixed first
 * whatever cluster holds them.
 */
export function batchesOf(clusters: readonly PlannedCluster[], ranked: readonly string[], batchSize: number): PlannedBatch[] {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error(`A batch holds at least one finding, not ${String(batchSize)}`);
  const rank = new Map(ranked.map((id, index) => [id, index]));
  const rankOf = (id: string): number => {
    const found = rank.get(id);
    if (found === undefined) throw new Error(`Finding ${id} is not in the ranking`);
    return found;
  };
  const batches = clusters.flatMap((cluster) =>
    Array.from({ length: Math.ceil(cluster.findingIds.length / batchSize) }, (_, index): PlannedBatch => ({
      key: `${cluster.id}-${String(index + 1)}`,
      cluster: cluster.id,
      findingIds: cluster.findingIds.slice(index * batchSize, (index + 1) * batchSize),
    })));
  return batches
    .map((batch) => ({ batch, rank: rankOf(batch.findingIds[0]!) }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ batch }) => batch);
}
