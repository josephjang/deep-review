/**
 * The worktree check (R7, PD11, TD2, TD3 of the fix pass): the tree
 * compared with what the run expects, the scope's after states overlaid by
 * every revision, and `HEAD` with the run's head, the scope's head or the
 * last commit `deep-review commit` made for the run (`runHead`, PD7 of
 * answers). In a phase that reads,
 * every expected file is compared. In an editing phase the check at the
 * attempt's start leaves out the files of every unit that has no recorded
 * answer and has not failed, since a fixer editing its own files is the
 * phase's purpose and a lost fixer's half-applied edits are what its
 * replacement is told to expect; the check at the phase's end compares
 * every expected file.
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { maxStraysPerCheck, type TreeRestored, type WorktreeCheckV6 } from '../checkpoint/events.ts';
import { isNotAttempted, ownedFiles, runHead } from '../checkpoint/fix-state.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { isAnswered } from '../checkpoint/review-fold.ts';
import { unitsOf } from './steps.ts';
import type { ArtifactReference, EvidenceStore } from '../evidence/store.ts';
import { freezeBytes } from '../scope/capture.ts';
import { compareExpected, expectedTree, headMoved, readTreeEntry, straysOf, worktreeReader, type DriftedFile, type ExpectedMatch, type ExpectedTree } from './tree.ts';
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
      .flatMap((unit) => ownedFiles(review, phase, unit.key)),
  );
}

/** What a check found: the expected files that differ and `HEAD` when it moved; it drifted when either is there. */
export interface DriftFound {
  readonly files: readonly DriftedFile[];
  readonly head: WorktreeCheckV6['head'];
}

/** Compare the worktree with what the run expects by `match`, as git would store each file (R22), leaving out `excluded`, and `HEAD` with the run's head; reads only the expected files and `HEAD`. */
export function findDrift(state: RunState, worktree: string, match: ExpectedMatch, excluded: ReadonlySet<string> = new Set()): DriftFound {
  if (state.scope === null) throw new Error(`Run ${state.id} has no scope`);
  return { files: compareExpected(expectedTreeOf(state), worktreeReader(worktree), excluded, match), head: headMoved(worktree, runHead(state)) };
}

export const drifted = (found: DriftFound): boolean => found.files.length > 0 || found.head !== null;

/** A check to record: its `worktree.checked@5` payload, and how many strays past `maxStraysPerCheck` the payload leaves out. */
export interface WorktreeCheck {
  readonly payload: WorktreeCheckV6;
  readonly unlisted: number;
}

/**
 * The check of what a check found, with the strays git reports at that
 * moment: the first `maxStraysPerCheck` in path order, the most the event
 * holds, so a tree with more of them, such as a formatter's run over the
 * repository, is still checked. A stray past the cap is not known to the
 * run, so the first check does not record it as one the run found before
 * any fixer ran.
 */
export function worktreeChecked(state: RunState, worktree: string, phase: Phase, attempt: number, moment: WorktreeCheckV6['moment'], found: DriftFound): WorktreeCheck {
  const strays = straysOf(worktree, expectedTreeOf(state));
  return {
    payload: {
      phase,
      attempt,
      moment,
      drifted: drifted(found),
      head: found.head,
      files: found.files.map((file) => ({ path: file.path, outcome: file.outcome, expected: file.expected })),
      strays: strays.slice(0, maxStraysPerCheck),
    },
    unlisted: Math.max(0, strays.length - maxStraysPerCheck),
  };
}

/** The check a phase's attempt makes at its start, at its end, or after a write back: an editing phase's start leaves its unsettled units' files out (TD3). */
export function phaseCheck(state: RunState, worktree: string, phase: Phase, attempt: number, moment: 'start' | 'end' | 'restored', match: ExpectedMatch): WorktreeCheck {
  const excluded = moment === 'start' ? unsettledFiles(state, phase) : new Set<string>();
  return worktreeChecked(state, worktree, phase, attempt, moment, findDrift(state, worktree, match, excluded));
}

/** A file to write back (R7 of resumable runs): what the tree holds there, frozen as evidence, and what the run expects, each null for nothing, as `tree.restored` records them. */
export type RestoredFile = TreeRestored['files'][number];

/**
 * The files the run expects that differ from what it recorded, as a write
 * back after a check a kill cut short records them (R7 of resumable
 * runs): each one's bytes in the tree frozen, which keeps them as
 * evidence, and its expected state; `only` keeps to the paths a drift
 * named. Reads only the expected files.
 */
export function restoredFiles(state: RunState, worktree: string, match: ExpectedMatch, evidence: Pick<EvidenceStore, 'put'>, only: ReadonlySet<string> | null = null): RestoredFile[] {
  const expected = expectedTreeOf(state);
  return findDrift(state, worktree, match).files.filter((file) => only === null || only.has(file.path)).map((file): RestoredFile => {
    const now = readTreeEntry(worktree, file.path);
    const want = expected.get(file.path) ?? null;
    return { path: file.path, before: now === null ? null : freezeBytes(evidence, now.bytes), beforeSymlink: now?.symlink ?? false, expected: want?.frozen ?? null, expectedSymlink: want?.symlink ?? false };
  });
}

/**
 * Write back the bytes the run expects at each file (R7 of resumable
 * runs): remove a file it expects absent, and write each other one from
 * its frozen blob, a symlink as a link to its target text. A file whose
 * expected bytes were too large to keep is not written: the check of the
 * tree after the write back then finds it drifted, and the run blocks.
 */
export function writeBack(worktree: string, files: readonly RestoredFile[], read: (reference: ArtifactReference) => Buffer): void {
  for (const file of files) {
    const absolute = join(worktree, ...file.path.split('/'));
    if (file.expected !== null && !('blob' in file.expected)) continue;
    rmSync(absolute, { force: true });
    if (file.expected === null) continue;
    const bytes = read(file.expected.blob);
    mkdirSync(dirname(absolute), { recursive: true });
    if (file.expectedSymlink) symlinkSync(bytes.toString('utf8'), absolute);
    else writeFileSync(absolute, bytes);
  }
}
