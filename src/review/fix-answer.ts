/**
 * A fixer's answer against the tree (R4, R5 of the fix pass; R1, R6 of
 * commit series integrity): every path it reports resolved to the
 * worktree's own spelling, refused when it leaves the repository; the
 * files another cluster owns or holds by a claim that it reports as
 * violations; and the rule that every owned or claimed file whose bytes
 * changed is reported under some finding. The checks the schema cannot
 * express and that need no tree are `checkFixerAnswer` in schemas.ts.
 */
import { isAbsolute, relative, sep } from 'node:path';
import type { PathHolder } from '../checkpoint/fix-state.ts';
import { canonicalPath } from '../paths.ts';
import { StructuralCheckError } from './errors.ts';
import { normalizeFileName, type RepoLookup } from './locations.ts';
import type { FixerOutput } from './schemas.ts';

/** Whether a normalized name is rooted, at `/` or at a drive such as `C:`. */
const rooted = (name: string): boolean => name.startsWith('/') || /^[A-Za-z]:(\/|$)/.test(name) || isAbsolute(name);

/**
 * How a refusal of a reported path names it, so each worker reads a
 * reason that fits its own task: a fixer, which edits files, and a
 * surveyor, which only names them.
 */
export interface ReportedPathWording {
  /** The path's name in a refusal, such as `The reported path`. */
  readonly what: string;
  /** Why a path into the git directory is refused, after "is in the git directory, ". */
  readonly gitDirectory: string;
}

/** The wording of a fixer's reported path. */
const fixerWording: ReportedPathWording = { what: 'The reported path', gitDirectory: 'which no fixer edits' };

/**
 * The answer to a file system question about a worker's path, or a
 * structural refusal of the path when the file system cannot give one
 * (denied, too long, a loop of links): the path came from the worker, so
 * the failure costs its attempt rather than ending the run. An error that
 * does not come from the file system is thrown as it is.
 */
export function resolvingPath<T>(what: string, raw: string, question: () => T): T {
  try {
    return question();
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (typeof code !== 'string') throw error;
    throw new StructuralCheckError(`${what} ${JSON.stringify(raw)} cannot be resolved: ${code}`, { cause: error });
  }
}

/** Refuse a path holding a NUL, which names no file and which every file system call rejects. */
export function requireNoNul(what: string, raw: string): void {
  if (raw.includes('\0')) throw new StructuralCheckError(`${what} ${JSON.stringify(raw)} contains a NUL character`);
}

/**
 * The repository path a worker's reported path names, in the worktree's
 * own spelling when the worktree holds it (so `Src/A.ts` on a
 * case-insensitive file system is `src/a.ts`), and as written otherwise,
 * for a file it deleted or one it means to create. An absolute path is
 * taken relative to the worktree. A path with a NUL, one the file system
 * cannot resolve, one outside the worktree, through `..`, or into the git
 * directory is refused as a structural check, in the words `wording`
 * gives (a fixer's by default).
 */
export function resolveReportedPath(worktree: string, lookup: RepoLookup, raw: string, wording: ReportedPathWording = fixerWording): string {
  const { what } = wording;
  requireNoNul(what, raw);
  let name = normalizeFileName(raw.trim()).replace(/\/+$/, '');
  if (rooted(name)) {
    const inside = relative(canonicalPath(worktree), resolvingPath(what, raw, () => canonicalPath(raw.trim())));
    // Judged by whole segments, as `isInside` does, so a child named `..tmp` is inside while `..` is not.
    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new StructuralCheckError(`${what} ${JSON.stringify(raw)} is outside the worktree ${worktree}`);
    name = inside.replaceAll('\\', '/');
  }
  const segments = name.split('/');
  if (name === '' || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) throw new StructuralCheckError(`${what} ${JSON.stringify(raw)} is not a path inside the repository`);
  if (segments.some((segment) => segment.toLowerCase() === '.git')) throw new StructuralCheckError(`${what} ${JSON.stringify(raw)} is in the git directory, ${wording.gitDirectory}`);
  const held = [...new Set(resolvingPath(what, raw, () => lookup(name)))];
  // None held is a deleted or a new file; two held, differing only in case on a case-sensitive file system, leave the one written.
  return held.length === 1 ? held[0]! : name;
}

/** A fixer's answer with every path resolved, and what it says about ownership. */
export interface ResolvedAnswer {
  /** Each finding's `files` and `requiredFiles`, resolved, in the answer's order. */
  readonly findings: readonly (FixerOutput['findings'][number] & { readonly files: readonly string[]; readonly requiredFiles: readonly string[] })[];
  /** Every file the answer names under some finding, resolved. */
  readonly named: ReadonlySet<string>;
  /** The named files another cluster of the round holds, sorted: each a violation recorded on the answer (PD4). */
  readonly violations: readonly string[];
}

/** What an answer is checked against: the worktree, the unit's own files, and the files every other cluster of its round holds. */
export interface OwnershipContext {
  readonly worktree: string;
  readonly lookup: RepoLookup;
  readonly owned: readonly string[];
  /** Every path another cluster of the round owns, or holds by a claim while it has not settled, with that cluster and how it holds the path. */
  readonly othersHeld: ReadonlyMap<string, PathHolder>;
}

/**
 * Resolve every path an answer reports and judge its ownership: a
 * required file must not be one the unit owns, since a fixer is never
 * blocked by its own file; a named file another cluster holds is a
 * violation, kept and recorded, never a refusal (PD4).
 */
export function resolveFixerAnswer(output: FixerOutput, context: OwnershipContext): ResolvedAnswer {
  const resolve = (raw: string): string => resolveReportedPath(context.worktree, context.lookup, raw);
  const owned = new Set(context.owned);
  const findings = output.findings.map((finding) => {
    const files = [...new Set(finding.files.map(resolve))];
    const requiredFiles = [...new Set(finding.requiredFiles.map(resolve))];
    const own = requiredFiles.filter((path) => owned.has(path));
    if (own.length > 0) throw new StructuralCheckError(`Finding [${String(finding.index)}] is blocked on ${own.join(', ')}, which its own cluster owns`);
    return { ...finding, files, requiredFiles };
  });
  const named = new Set(findings.flatMap((finding) => finding.files));
  const violations = [...named].filter((path) => context.othersHeld.has(path)).sort();
  return { findings, named, violations };
}

/**
 * Refuse an answer that leaves out an owned or claimed file whose bytes
 * changed (R4, TD11 of the fix pass; decided 2026-10-09 for commit series
 * integrity): the report would otherwise claim edits nobody accounted for,
 * and the retry is told the tree may already hold the work. A claimed file
 * is one the fixer said it would edit, so an unreported edit of it is
 * refused here rather than reaching the phase's end check as drift.
 */
export function requireOwnedReported(changedHeld: readonly string[], named: ReadonlySet<string>): void {
  const unreported = changedHeld.filter((path) => !named.has(path));
  if (unreported.length > 0) throw new StructuralCheckError(`The answer names no finding for the owned or claimed file${unreported.length === 1 ? '' : 's'} ${unreported.join(', ')}, whose bytes changed; every owned or claimed file a fixer changes is reported under the finding it served`);
}
