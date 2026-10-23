/**
 * The documents of the documentation step (R2, TD8 of the documentation
 * step): how the controller reads the path of each `drift` line of the
 * fixes when it plans the step, against the worktree, as it reads every
 * path a worker reports.
 */
import { isClaimablePath } from '../checkpoint/events.ts';
import { StructuralCheckError } from './errors.ts';
import { resolveReportedPath } from './fix-answer.ts';
import { worktreeLookup } from './locations.ts';

/**
 * The resolver of the documentation step's plan: the repository path a
 * `drift` line's file names, as `resolveReportedPath` reads a path a
 * worker reports, in the worktree's own spelling when the worktree holds
 * the file; null for a path it refuses, one outside the worktree, through
 * `..` or into the git directory, and for one no claim could record. A
 * refused path stays an item with no path, which the step can only leave
 * and the brief counts (TD8). A failure that is no refusal of the path is
 * thrown as it is.
 */
export function planPathOf(worktree: string): (file: string) => string | null {
  const lookup = worktreeLookup(worktree);
  return (file) => {
    let path: string;
    try {
      path = resolveReportedPath(worktree, lookup, file);
    } catch (error) {
      if (error instanceof StructuralCheckError) return null;
      throw error;
    }
    return isClaimablePath(path) ? path : null;
  };
}
