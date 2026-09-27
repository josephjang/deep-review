/**
 * How a verification phase groups the working list (R2 of the read-only
 * review, TD7): by file, a verifier per group, so a file's context is read
 * once per group rather than once per candidate. Pure over the candidates;
 * the plan it gives is recorded once and resumed from the ledger.
 */

/** What grouping needs of a candidate: its id and where it points, located or not. */
export interface Groupable {
  readonly id: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly rawFile: string;
  readonly rawLine: number;
}

export interface PlannedGroup {
  readonly id: string;
  readonly candidateIds: readonly string[];
}

/** The most candidates one verifier is given; a group above it is split into neighbouring chunks. */
export const maxGroupSize = 8;

/** The key a candidate groups under: its scope path, or its own file spelling when unlocated, kept apart from located ones. */
const groupKey = (candidate: Groupable): string => (candidate.file === null ? `unlocated:${candidate.rawFile}` : `located:${candidate.file}`);

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Consecutive chunks of at most `maxGroupSize`, the last absorbing a
 * remainder of one into its predecessor, so no chunk holds a single
 * candidate when the group had more.
 */
export function chunk<T>(items: readonly T[], size: number = maxGroupSize): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  if (chunks.length > 1 && chunks[chunks.length - 1]!.length === 1) {
    const last = chunks.pop()!;
    chunks[chunks.length - 1] = [...chunks[chunks.length - 1]!, ...last];
  }
  return chunks;
}

/**
 * Group the working list for verification: located candidates by scope
 * path and unlocated ones by their own file spelling, each group sorted by
 * line and then by id, groups in file order with located files first, and
 * every group over `maxGroupSize` split by `chunk`. Group ids are `g1`,
 * `g2`, ... in that order.
 */
export function planGroups(candidates: readonly Groupable[]): PlannedGroup[] {
  const groups = new Map<string, Groupable[]>();
  for (const candidate of candidates) {
    const key = groupKey(candidate);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [candidate]);
    else group.push(candidate);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    // `located:` sorts before `unlocated:` by text as well, so one comparison orders both the kind and the path.
    return byText(a, b);
  });
  const planned: PlannedGroup[] = [];
  for (const key of keys) {
    const members = [...groups.get(key)!].sort((a, b) => (a.line ?? a.rawLine) - (b.line ?? b.rawLine) || byText(a.id, b.id));
    for (const part of chunk(members)) planned.push({ id: `g${String(planned.length + 1)}`, candidateIds: part.map((candidate) => candidate.id) });
  }
  return planned;
}
