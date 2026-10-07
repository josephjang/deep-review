/**
 * The worktree check (R7, PD11, TD2, TD3 of the fix pass): the tree
 * compared with what the run expects, the scope's after states overlaid by
 * every revision, and `HEAD` with the scope's head. In a phase that reads,
 * every expected file is compared. In an editing phase the check at the
 * attempt's start leaves out the files of every unit that has no recorded
 * answer and has not failed, since a fixer editing its own files is the
 * phase's purpose and a lost fixer's half-applied edits are what its
 * replacement is told to expect; the check at the phase's end compares
 * every expected file.
 */
import type { WorktreeCheckV4 } from '../checkpoint/events.ts';
import { isNotAttempted, ownedFiles } from '../checkpoint/fix-state.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { isAnswered } from '../checkpoint/review-fold.ts';
import { unitsOf } from './steps.ts';
import { compareExpected, expectedTree, headMoved, straysOf, worktreeReader, type DriftedFile, type ExpectedMatch, type ExpectedTree } from './tree.ts';
import { isEditingPhase, type Phase } from './vocabulary.ts';

/** The tree the run expects of a configured run: its scope overlaid by its revisions. */
export function expectedTreeOf(state: RunState): ExpectedTree {
  if (state.scope === null) throw new Error(`Run ${state.id} has no scope`);
  return expectedTree(state.scope, state.review?.fix?.revisions ?? []);
}

/** The files the start check of an editing phase leaves out: those of every unit with no recorded answer that has not failed. */
export function unsettledFiles(state: RunState, phase: Phase): Set<string> {
  const review = state.review;
  const fix = review?.fix ?? null;
  if (review === null || fix === null || !isEditingPhase(phase)) return new Set();
  return new Set(
    unitsOf(review, phase)
      .filter((unit) => !isAnswered(review, phase, unit.key) && !isNotAttempted(fix, phase, unit.key))
      .flatMap((unit) => ownedFiles(fix, phase, unit.key)),
  );
}

/** What a check found: the expected files that differ and `HEAD` when it moved; it drifted when either is there. */
export interface DriftFound {
  readonly files: readonly DriftedFile[];
  readonly head: WorktreeCheckV4['head'];
}

/** Compare the worktree with what the run expects by `match`, as git would store each file (R22), leaving out `excluded`; reads only the expected files and `HEAD`. */
export function findDrift(state: RunState, worktree: string, match: ExpectedMatch, excluded: ReadonlySet<string> = new Set()): DriftFound {
  if (state.scope === null) throw new Error(`Run ${state.id} has no scope`);
  return { files: compareExpected(expectedTreeOf(state), worktreeReader(worktree), excluded, match), head: headMoved(worktree, state.scope.head) };
}

export const drifted = (found: DriftFound): boolean => found.files.length > 0 || found.head !== null;

/** The `worktree.checked@4` payload of a check: what it found, and the strays git reports at that moment. */
export function worktreeChecked(state: RunState, worktree: string, phase: Phase, attempt: number, moment: WorktreeCheckV4['moment'], found: DriftFound): WorktreeCheckV4 {
  return {
    phase,
    attempt,
    moment,
    drifted: drifted(found),
    head: found.head,
    files: found.files.map((file) => ({ path: file.path, outcome: file.outcome, expected: file.expected })),
    strays: straysOf(worktree, expectedTreeOf(state)),
  };
}

/** The check a phase's attempt makes at its start or end: an editing phase's start leaves its unsettled units' files out (TD3). */
export function phaseCheck(state: RunState, worktree: string, phase: Phase, attempt: number, moment: 'start' | 'end', match: ExpectedMatch): WorktreeCheckV4 {
  const excluded = moment === 'start' ? unsettledFiles(state, phase) : new Set<string>();
  return worktreeChecked(state, worktree, phase, attempt, moment, findDrift(state, worktree, match, excluded));
}
