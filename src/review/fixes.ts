/**
 * Which ranked findings go to a fixer, and how they are split among fixers
 * (R2, R3, R18 of the fix pass): a finding is routed by its merged verdict
 * and its primary's angle, as the rubric says; the fixer-routed ones are
 * clustered one per file, a merged finding kept whole, so that no file is
 * owned by two clusters; and each cluster's findings are cut into batches,
 * one fixer each, run one after another. Pure over the ranked list; the
 * plan it gives is recorded once and resumed from the ledger.
 */
import type { CandidateState } from '../checkpoint/review-fold.ts';
import { unlocatedSpellingIn } from './grouping.ts';
import type { ReportFinding } from './state.ts';
import { angleClasses } from './vocabulary.ts';

/** Where a finding goes: to a fixer, or held for the author with no fixer seeing it. */
export type Route = 'fixer' | 'held';

export interface PlannedRoute {
  readonly id: string;
  readonly route: Route;
}

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
 * A finding's route (R2): a CONFIRMED finding goes to a fixer, and so does
 * a PLAUSIBLE one whose primary is from a correctness or cost angle or
 * `CONVENTIONS`; a PLAUSIBLE design finding (`DESIGN`, `DUPLICATION`,
 * `ALTITUDE`) is held for the author. The unverified mark changes nothing,
 * as the rubric says.
 */
export function routeOf(entry: Pick<ReportFinding, 'primary' | 'resolution'>): Route {
  if (entry.resolution.verdict === 'CONFIRMED') return 'fixer';
  return angleClasses[entry.primary.angle] === 'correctness' ? 'fixer' : 'held';
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
 * Route the ranked findings and cluster the fixer-routed ones (R3). Each
 * finding's keys are the canonical file of its primary and of every member
 * that is located, and the spelling of every unlocated one, folded as
 * verification grouping folds it; clusters are the connected components of
 * findings over shared keys, so a merged finding across two files pulls
 * every finding of both into one cluster. `findings` must be in rank
 * order, which then orders the clusters by their best finding and each
 * cluster's findings within it. Each cluster's findings are then cut, in
 * that order, into batches of at most `batchSize` (`batchesOf`).
 */
export function planFixes(findings: readonly ReportFinding[], batchSize: number): FixPlan {
  const routes = findings.map((entry): PlannedRoute => ({ id: entry.finding.id, route: routeOf(entry) }));
  const routed = findings.filter((entry) => routeOf(entry) === 'fixer');
  const candidatesOf = (entry: ReportFinding): readonly CandidateState[] => [entry.primary, ...entry.members];
  const spelling = unlocatedSpellingIn(routed.flatMap(candidatesOf));
  const keysOf = (entry: ReportFinding): string[] => [...new Set(candidatesOf(entry).map((candidate) => (candidate.located && candidate.file !== null ? locatedKey(candidate.file) : unlocatedKey(spelling(candidate)))))];

  // Union-find over finding positions: two findings sharing a key are one cluster. A review has at most a few dozen findings, so no path compression is needed.
  const parent = routed.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    return root;
  };
  const owner = new Map<string, number>();
  const keys = routed.map(keysOf);
  keys.forEach((findingKeys, index) => {
    for (const key of findingKeys) {
      const first = owner.get(key);
      if (first === undefined) owner.set(key, index);
      else {
        // The cluster keeps its earliest finding as its root, so cluster order follows the best rank in it.
        const [a, b] = [find(first), find(index)];
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  });

  const members = new Map<number, number[]>();
  routed.forEach((_, index) => {
    const root = find(index);
    const list = members.get(root);
    if (list === undefined) members.set(root, [index]);
    else list.push(index);
  });
  const clusters = [...members.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, indexes], position): PlannedCluster => ({
      id: `c${String(position + 1)}`,
      findingIds: indexes.map((index) => routed[index]!.finding.id),
      files: [...new Set(indexes.flatMap((index) => keys[index]!.map(ownedPath).filter((path) => path !== null)))].sort(),
    }));
  return { routes, clusters, batches: batchesOf(clusters, routes.map((route) => route.id), batchSize) };
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
