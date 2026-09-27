/**
 * How a verification phase groups the working list (R2 of the read-only
 * review, TD7): by file, a verifier per group, so a file's context is read
 * once per group rather than once per candidate. Pure over the candidates;
 * the plan it gives is recorded once and resumed from the ledger.
 */
import { normalizeFileName } from './locations.ts';

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

/** An unlocated candidate's file as the finder spelled it, normalized as a scope path is and without regard to case. */
const spellingOf = (candidate: Groupable): string => normalizeFileName(candidate.rawFile).toLowerCase();

/** Whether a normalized spelling is absolute: rooted at `/` or at a drive such as `c:/`. */
const isAbsolute = (spelling: string): boolean => spelling.startsWith('/') || /^[a-z]:\//i.test(spelling);

/**
 * The spelling each unlocated candidate's file groups under. Spellings of
 * one path that differ in slashes, a leading `./` or case are already one
 * after `spellingOf`. An absolute spelling joins the longest relative
 * spelling given for it, the one it ends with after a slash, so
 * `C:\repo\src\a.ts` and `src/a.ts` share a verifier; an absolute spelling
 * no relative one names stays as it is. A mistaken join only gives one
 * verifier two files to read, since each candidate carries its own
 * spelling into the verifier's prompt.
 */
function unlocatedSpellings(candidates: readonly Groupable[]): Map<string, string> {
  const spellings = new Set(candidates.filter((candidate) => candidate.file === null).map(spellingOf));
  const relative = [...spellings].filter((spelling) => !isAbsolute(spelling));
  const joined = new Map<string, string>();
  for (const spelling of spellings) {
    const within = isAbsolute(spelling) ? relative.filter((name) => spelling.endsWith(`/${name}`)) : [];
    joined.set(spelling, within.reduce((longest, name) => (name.length > longest.length ? name : longest), within[0] ?? spelling));
  }
  return joined;
}

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
 * path and unlocated ones by their file spelling (`unlocatedSpellings`),
 * each group sorted by line and then by id, groups in file order with
 * located files first, and every group over `maxGroupSize` split by
 * `chunk`. Group ids are `g1`, `g2`, ... in that order.
 */
export function planGroups(candidates: readonly Groupable[]): PlannedGroup[] {
  const spellings = unlocatedSpellings(candidates);
  // Unlocated candidates are kept apart from located ones even on a file of the same name.
  const groupKey = (candidate: Groupable): string => (candidate.file === null ? `unlocated:${spellings.get(spellingOf(candidate))!}` : `located:${candidate.file}`);
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
