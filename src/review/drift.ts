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
 * every expected file. It also writes back the expected files a check a
 * kill cut short left changed (R7 of resumable runs), with what the tree
 * held there frozen first as evidence.
 */
import { chmodSync, lstatSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { maxStraysPerCheck, type TreeRestored, type WorktreeCheckV6 } from '../checkpoint/events.ts';
import { isNotAttempted, ownedFiles, runHead } from '../checkpoint/fix-state.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { isAnswered } from '../checkpoint/review-fold.ts';
import { unitsOf } from './steps.ts';
import type { ArtifactReference, EvidenceStore } from '../evidence/store.ts';
import { freezeBytes } from '../scope/capture.ts';
import * as gitApi from '../scope/git.ts';
import { compareExpected, expectedTree, headMoved, readTreeEntry, straysOf, worktreeReader, type DriftedFile, type ExpectedMatch, type ExpectedTree, type TreeEntry, type TreeReader } from './tree.ts';
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
 * named. Bytes too large to freeze keep only their hash, and `writeBack`
 * leaves such a file as it is. Reads only the expected files.
 */
export function restoredFiles(state: RunState, worktree: string, match: ExpectedMatch, evidence: Pick<EvidenceStore, 'put'>, only: ReadonlySet<string> | null = null): RestoredFile[] {
  const expected = expectedTreeOf(state);
  // Each file is read once, so the bytes frozen are the ones compared; only a differing file's entry is kept, so the bytes held are those to freeze.
  const entries = new Map<string, TreeEntry | null>();
  const read: TreeReader = (path) => {
    const entry = readTreeEntry(worktree, path);
    if (only === null || only.has(path)) entries.set(path, entry);
    return entry;
  };
  const matches: ExpectedMatch = (path, want, now) => {
    if (!match(path, want, now)) return false;
    entries.delete(path);
    return true;
  };
  return compareExpected(expected, read, new Set(), matches).filter((file) => only === null || only.has(file.path)).map((file): RestoredFile => {
    const now = entries.get(file.path) ?? null;
    const want = expected.get(file.path) ?? null;
    return { path: file.path, before: now === null ? null : freezeBytes(evidence, now.bytes), beforeSymlink: now?.symlink ?? false, expected: want?.frozen ?? null, expectedSymlink: want?.symlink ?? false };
  });
}

/** A file the write back left as the tree holds it, and why. */
export interface LeftFile {
  readonly path: string;
  readonly reason: string;
}

/**
 * Write back the bytes the run expects at each file (R7 of resumable
 * runs): remove a file it expects absent, and write each other one from
 * its frozen blob, a symlink as a link to its target text. A regular file
 * the tree holds is written in place, which keeps its mode, and one
 * written where none was takes the executable bit git's index records for
 * it, since the frozen bytes record no mode. Each file is written back on
 * its own, and one it cannot write is left as the tree holds it and
 * returned with the reason: its bytes in the tree were too large to keep
 * as evidence, so writing over them would lose them; its expected bytes
 * were too large to keep; a directory, or another entry whose bytes were
 * never frozen, is where the file is expected; a file is where a parent
 * directory is expected; or the write failed, as a symlink does on
 * Windows without the privilege. The check of the tree after the write
 * back then finds each one drifted, and the run blocks naming it.
 */
export function writeBack(worktree: string, files: readonly RestoredFile[], read: (reference: ArtifactReference) => Buffer): LeftFile[] {
  const left: LeftFile[] = [];
  for (const file of files) {
    const reason = writeBackFile(worktree, file, read);
    if (reason !== null) left.push({ path: file.path, reason });
  }
  return left;
}

/** Write back one file, or say why it is left as the tree holds it. */
function writeBackFile(worktree: string, file: RestoredFile, read: (reference: ArtifactReference) => Buffer): string | null {
  if (file.before !== null && !('blob' in file.before)) return 'its bytes in the tree were too large to have been kept';
  if (file.expected !== null && !('blob' in file.expected)) return 'its expected bytes were too large to have been kept';
  const bytes = file.expected === null ? null : read(file.expected.blob);
  const absolute = join(worktree, ...file.path.split('/'));
  try {
    // What stands in the way had no bytes frozen, so it is never removed.
    const parent = parentInTheWay(worktree, file.path);
    if (parent !== null) return `${parent} is not a directory`;
    const now = lstatSync(absolute, { throwIfNoEntry: false });
    if (now !== undefined && !now.isFile() && !now.isSymbolicLink()) return now.isDirectory() ? 'a directory is there' : 'an entry that is neither a file nor a symlink is there';
    // A regular file written in place keeps its mode, such as the executable bit, which the frozen bytes do not record.
    if (bytes !== null && !file.expectedSymlink && now?.isFile() === true) {
      writeFileSync(absolute, bytes);
      return null;
    }
    rmSync(absolute, { force: true });
    if (bytes === null) return null;
    mkdirSync(dirname(absolute), { recursive: true });
    if (file.expectedSymlink) symlinkSync(bytes.toString('utf8'), absolute);
    else createFile(worktree, file.path, absolute, bytes);
    return null;
  } catch (error) {
    return `writing it failed: ${(error as Error).message}`;
  }
}

/** The first parent of `path` that is there and is not a directory, null when none is. */
function parentInTheWay(worktree: string, path: string): string | null {
  const segments = path.split('/');
  for (let depth = 1; depth < segments.length; depth += 1) {
    const parent = segments.slice(0, depth);
    const stat = lstatSync(join(worktree, ...parent), { throwIfNoEntry: false });
    if (stat === undefined) return null;
    if (!stat.isDirectory()) return parent.join('/');
  }
  return null;
}

/**
 * Create a regular file where none is, executable on POSIX where git's
 * index records the path as `100755`: readable bits mirrored to the
 * executable ones, as a checkout under the same umask writes it.
 */
function createFile(worktree: string, path: string, absolute: string, bytes: Buffer): void {
  writeFileSync(absolute, bytes);
  if (process.platform === 'win32' || indexMode(worktree, path) !== '100755') return;
  const { mode } = statSync(absolute);
  chmodSync(absolute, mode | ((mode & 0o444) >> 2));
}

/** The mode git's index records for `path`, such as `100644`, or null where it lists none. */
function indexMode(worktree: string, path: string): string | null {
  const [record] = gitApi.records(gitApi.gitText(worktree, ['ls-files', '--stage', '-z', '--', gitApi.literal(path)]));
  return record === undefined ? null : record.slice(0, record.indexOf(' '));
}
