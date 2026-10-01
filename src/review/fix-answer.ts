/**
 * A fixer's answer against the tree (R4, R5 of the fix pass): every path
 * it reports resolved to the worktree's own spelling, refused when it
 * leaves the repository; the files another cluster owns that it reports
 * as violations; and the rule that every owned file whose bytes changed
 * is reported under some finding. The checks the schema cannot express
 * and that need no tree are `checkFixerAnswer` in schemas.ts.
 */
import { isAbsolute, relative } from 'node:path';
import { canonicalPath } from '../paths.ts';
import { StructuralCheckError } from './errors.ts';
import { normalizeFileName, type RepoLookup } from './locations.ts';
import type { FixerOutput } from './schemas.ts';

/** Whether a normalized name is rooted, at `/` or at a drive such as `C:`. */
const rooted = (name: string): boolean => name.startsWith('/') || /^[A-Za-z]:(\/|$)/.test(name) || isAbsolute(name);

/**
 * The repository path a fixer's reported path names, in the worktree's
 * own spelling when the worktree holds it (so `Src/A.ts` on a
 * case-insensitive file system is `src/a.ts`), and as written otherwise,
 * for a file it deleted or one it means to create. An absolute path is
 * taken relative to the worktree. A path outside the worktree, through
 * `..`, or into the git directory is refused as a structural check.
 */
export function resolveReportedPath(worktree: string, lookup: RepoLookup, raw: string): string {
  let name = normalizeFileName(raw.trim()).replace(/\/+$/, '');
  if (rooted(name)) {
    const inside = relative(canonicalPath(worktree), canonicalPath(raw.trim()));
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw new StructuralCheckError(`The reported path ${JSON.stringify(raw)} is outside the worktree ${worktree}`);
    name = inside.replaceAll('\\', '/');
  }
  const segments = name.split('/');
  if (name === '' || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) throw new StructuralCheckError(`The reported path ${JSON.stringify(raw)} is not a path inside the repository`);
  if (segments.some((segment) => segment.toLowerCase() === '.git')) throw new StructuralCheckError(`The reported path ${JSON.stringify(raw)} is in the git directory, which no fixer edits`);
  const held = [...new Set(lookup(name))];
  // None held is a deleted or a new file; two held, differing only in case on a case-sensitive file system, leave the one written.
  return held.length === 1 ? held[0]! : name;
}

/** A fixer's answer with every path resolved, and what it says about ownership. */
export interface ResolvedAnswer {
  /** Each finding's `files` and `requiredFiles`, resolved, in the answer's order. */
  readonly findings: readonly (FixerOutput['findings'][number] & { readonly files: readonly string[]; readonly requiredFiles: readonly string[] })[];
  /** Every file the answer names under some finding, resolved. */
  readonly named: ReadonlySet<string>;
  /** The named files another cluster of the phase owns, sorted: each a violation recorded on the answer (PD4). */
  readonly violations: readonly string[];
}

/** What an answer is checked against: the worktree, the unit's own files, and the files every other cluster of its phase owns. */
export interface OwnershipContext {
  readonly worktree: string;
  readonly lookup: RepoLookup;
  readonly owned: readonly string[];
  /** Every path another cluster of the phase owns, with that cluster's id. */
  readonly othersOwned: ReadonlyMap<string, string>;
}

/**
 * Resolve every path an answer reports and judge its ownership: a
 * required file must not be one the unit owns, since a fixer is never
 * blocked by its own file; a named file another cluster owns is a
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
  const violations = [...named].filter((path) => context.othersOwned.has(path)).sort();
  return { findings, named, violations };
}

/**
 * Refuse an answer that leaves out an owned file whose bytes changed
 * (R4, TD11): the report would otherwise claim edits nobody accounted
 * for, and the retry is told the tree may already hold the work.
 */
export function requireOwnedReported(changedOwned: readonly string[], named: ReadonlySet<string>): void {
  const unreported = changedOwned.filter((path) => !named.has(path));
  if (unreported.length > 0) throw new StructuralCheckError(`The answer names no finding for the owned file${unreported.length === 1 ? '' : 's'} ${unreported.join(', ')}, whose bytes changed; every owned file a fixer changes is reported under the finding it served`);
}
