/**
 * The `Scope:` line that `config show` prints before a run and `status`
 * prints for a run (R11 of the skill surface corrections; R12 of the
 * questions in the chat): the scope as the person asked for it, the number
 * of commits and of changed files the run reviews, where the change starts,
 * with the name the scope gives its base and its short commit, and where
 * it ends. A change that ends at the working tree says how many of its
 * files hold uncommitted changes, when that is known, and the paths
 * `scope.exclude` leaves out are counted apart. A person judges from it if
 * the run reviews what they asked for.
 */
import type { ScopeMode, ScopeRequest } from '../checkpoint/events.ts';
import { counted } from '../review/markdown.ts';
import { isEmptyTree } from './git.ts';

/** The mode of a scope as a person asks for it: `branch` for `--branch` or a `scope.default` of `branch`, which the capture records as a range, else the mode the capture chose. */
export type AskedMode = ScopeMode | 'branch';

/** The facts of the `Scope:` line. */
export interface ShownScope {
  readonly mode: AskedMode;
  /** The commit the change starts from, or the empty tree, the base of a root commit. */
  readonly base: string;
  /** The name the scope gives its base, such as `the merge base with origin/main` (`baseNameOf`). */
  readonly baseName: string;
  /** The commit the change ends at, a `last-commit` scope's, or null for a change that ends at the working tree. */
  readonly target: string | null;
  /** The commits of the change on the first parent from its end back to its base, or null when git could not count them. */
  readonly commits: number | null;
  /** The changed files the run reviews. */
  readonly fileCount: number;
  /** The changed paths `scope.exclude` leaves out. */
  readonly excludedCount: number;
  /** The reviewed files that hold uncommitted changes, for a change that ends at the working tree, or null when that is not known or the change ends at a commit. */
  readonly uncommitted: number | null;
  /** Why the change has nothing to review, or null when it has a path left. */
  readonly empty: string | null;
}

/** A commit as the line names it: its first 8 characters, as the brief names one, or the empty tree, the base of a root commit. */
export const commitWords = (commit: string): string => (isEmptyTree(commit) ? 'the empty tree' : commit.slice(0, 8));

/**
 * The name a scope gives its base, from the request and the mode the
 * person asked for: the merge base with the base ref of `branch` or of a
 * range that takes it, the start of any other range, the ref of `ref`,
 * `HEAD` for `worktree`, and the parent of `HEAD` for `last-commit`.
 */
export function baseNameOf(mode: AskedMode, request: Pick<ScopeRequest, 'ref' | 'range'>): string {
  if (request.range !== undefined) return request.range.mergeBase ? `the merge base with ${request.range.from}` : request.range.from;
  if (request.ref !== undefined) return request.ref;
  return mode === 'last-commit' ? 'the parent of HEAD' : 'HEAD';
}

/** Where the change starts, named and with its short commit, or the empty tree, which has no other name. */
const baseWords = (scope: ShownScope): string => (isEmptyTree(scope.base) ? 'the empty tree' : `${scope.baseName} (${commitWords(scope.base)})`);

/** Where the change ends: its commit, or the working tree, with how many of the reviewed files hold uncommitted changes when that is known. */
function endWords(scope: ShownScope): string {
  if (scope.target !== null) return commitWords(scope.target);
  if (scope.uncommitted === null) return 'the working tree';
  return scope.uncommitted === 0 ? 'the working tree, which has no uncommitted change' : `the working tree, where ${counted(scope.uncommitted, 'file holds', 'files hold')} uncommitted changes`;
}

/** What the change holds: its commits, when counted, and its files, with the paths `scope.exclude` leaves out apart. */
function sizeWords(scope: ShownScope): string {
  const commits = scope.commits === null ? null : scope.commits === 0 ? 'no commit' : counted(scope.commits, 'commit', 'commits');
  const files = counted(scope.fileCount, 'file', 'files');
  const excluded = scope.excludedCount === 0 ? '' : ` (${counted(scope.excludedCount, 'more path', 'more paths')} left out by scope.exclude)`;
  return `${commits === null ? '' : `${commits} and `}${files}${excluded}`;
}

/** The `Scope:` line; a change with nothing to review gives its ends and why, and no count. */
export function scopeLine(scope: ShownScope): string {
  const ends = `from ${baseWords(scope)} to ${endWords(scope)}`;
  return scope.empty === null ? `Scope: ${scope.mode}, ${sizeWords(scope)}, ${ends}` : `Scope: ${scope.mode}, ${ends}; ${scope.empty}`;
}
