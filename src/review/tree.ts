/**
 * What the run expects the reviewed tree to hold, and how an edit becomes a
 * revision of it (R6, R7, TD1 of the fix pass). The expected tree is the
 * scope's after states overlaid, in ledger order, by every revision's
 * files; the worktree check compares the tree with it, so an edit a worker
 * or a check accounted for is not drift and an edit nobody did still is.
 * A revision is computed by reading paths through a reader (the worktree,
 * or a fixer's snapshot standing in for it) and freezing the ones that
 * differ from the state before.
 */
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { FrozenFile, ScopeState } from '../checkpoint/events.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import { freezeBytes } from '../scope/capture.ts';
import { matchesFrozen } from '../scope/compare.ts';
import * as gitApi from '../scope/git.ts';

/** A file the run expects: its frozen bytes, and whether it is a symlink whose target text they are. */
export interface ExpectedFile {
  readonly frozen: FrozenFile;
  readonly symlink: boolean;
}

/** Every path the run vouches for, with the file it expects there, or null where it expects nothing. */
export type ExpectedTree = ReadonlyMap<string, ExpectedFile | null>;

/** One path a revision changed: what it became, null when it was deleted. */
export interface RevisedFile {
  readonly path: string;
  readonly status: 'created' | 'modified' | 'deleted';
  /** Whether the path is now a symlink; false for a deleted path. */
  readonly symlink: boolean;
  readonly after: FrozenFile | null;
}

/** What the tree holds at a path, as a revision reads it: a file's bytes or a symlink's target text. */
export interface TreeEntry {
  readonly bytes: Buffer;
  readonly symlink: boolean;
}

/**
 * Reads one repository path: the entry there, null when nothing is, or
 * undefined when the reader cannot say, such as a snapshot that did not
 * list the path; a revision leaves such a path to a later reader.
 */
export type TreeReader = (path: string) => TreeEntry | null | undefined;

/** The tree the scope captured, overlaid in order by each revision's files. */
export function expectedTree(scope: Pick<ScopeState, 'files'>, revisions: readonly { readonly files: readonly RevisedFile[] }[]): Map<string, ExpectedFile | null> {
  const tree = new Map<string, ExpectedFile | null>();
  for (const file of scope.files) tree.set(file.path, file.after === null ? null : { frozen: file.after, symlink: file.symlink });
  for (const revision of revisions) applyRevision(tree, revision.files);
  return tree;
}

/** Overlay one revision's files on a tree, in place. */
export function applyRevision(tree: Map<string, ExpectedFile | null>, files: readonly RevisedFile[]): void {
  for (const file of files) tree.set(file.path, file.after === null ? null : { frozen: file.after, symlink: file.symlink });
}

/**
 * What the worktree holds at a repository path: a file's bytes, a
 * symlink's target text, or null for nothing a revision can record (no
 * entry, a directory, a path through a file), so that every check and
 * revision reads one answer for one tree and none throws on what a worker
 * left there.
 */
export function readTreeEntry(worktree: string, path: string): TreeEntry | null {
  const absolute = join(worktree, ...path.split('/'));
  let stat;
  try {
    stat = lstatSync(absolute, { throwIfNoEntry: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw error;
  }
  if (stat === undefined) return null;
  if (stat.isSymbolicLink()) return { bytes: Buffer.from(readlinkSync(absolute)), symlink: true };
  if (stat.isFile()) return { bytes: readFileSync(absolute), symlink: false };
  return null;
}

/** A reader over the worktree, which can always say what a path holds. */
export const worktreeReader = (worktree: string): TreeReader => (path) => readTreeEntry(worktree, path);

/** Whether what a path holds is what the run expects there; a path the tree does not name is expected absent. */
export function matchesExpected(expected: ExpectedFile | null | undefined, now: TreeEntry | null): boolean {
  if (expected === undefined || expected === null) return now === null;
  return now !== null && matchesFrozen(expected.frozen, now.bytes, now.symlink, expected.symlink);
}

/** How a path differs from what the run expects: changed, gone, or there when it is expected absent. */
export type DriftOutcome = 'modified' | 'deleted' | 'restored';

/** A path that differs, with the state the run expected, so the operator can restore it; null where nothing was expected. */
export interface DriftedFile {
  readonly path: string;
  readonly outcome: DriftOutcome;
  readonly expected: FrozenFile | null;
}

/**
 * Every expected path not in `excluded` whose content differs from what
 * the run expects, in path order. Reads only the expected paths and runs
 * no git command, so it is cheap enough to run before every answer.
 */
export function compareExpected(expected: ExpectedTree, read: TreeReader, excluded: ReadonlySet<string> = new Set()): DriftedFile[] {
  const drifted: DriftedFile[] = [];
  for (const path of [...expected.keys()].sort()) {
    if (excluded.has(path)) continue;
    const want = expected.get(path) ?? null;
    const now = read(path);
    if (now === undefined || matchesExpected(want, now)) continue;
    const outcome: DriftOutcome = want === null ? 'restored' : now === null ? 'deleted' : 'modified';
    drifted.push({ path, outcome, expected: want?.frozen ?? null });
  }
  return drifted;
}

/** `HEAD` against the head the scope captured: null while they agree, else both. */
export function headMoved(worktree: string, expectedHead: string): { readonly expected: string; readonly actual: string } | null {
  const actual = gitApi.head(worktree);
  return actual === expectedHead ? null : { expected: expectedHead, actual };
}

/** The paths git reports as untracked, ignored ones excepted, that the run does not expect: files nobody accounts for, listed and never drift. */
export function straysOf(worktree: string, expected: ExpectedTree): string[] {
  return gitApi
    .status(worktree)
    .filter((entry) => entry.code === '??' && !expected.has(entry.path))
    .map((entry) => entry.path)
    .sort();
}

/**
 * The revision entries of `paths` read through `read` against `expected`:
 * each path that differs, frozen, in path order. A path the reader cannot
 * speak for is left out, and so is one that matches.
 */
export function reviseFrom(evidence: Pick<EvidenceStore, 'put'>, read: TreeReader, expected: ExpectedTree, paths: Iterable<string>): RevisedFile[] {
  const revised: RevisedFile[] = [];
  for (const path of [...new Set(paths)].sort()) {
    const now = read(path);
    if (now === undefined) continue;
    const before = expected.get(path) ?? null;
    if (matchesExpected(before, now)) continue;
    if (now === null) revised.push({ path, status: 'deleted', symlink: false, after: null });
    else revised.push({ path, status: before === null ? 'created' : 'modified', symlink: now.symlink, after: freezeBytes(evidence, now.bytes) });
  }
  return revised;
}

/** One revision a fixer's answer gives: the findings it serves and the files it changed. */
export interface FindingRevision {
  readonly findings: readonly string[];
  readonly files: readonly RevisedFile[];
}

/** Where the states of a fixer's tree are read from: its snapshot after each finding, by index (null when it took none), and the worktree. */
export interface RevisionSources {
  readonly snapshot: (index: number) => TreeReader | null;
  readonly worktree: TreeReader;
}

/**
 * A fixer's answer as revisions, one per finding where it can be (R6,
 * PD14): for each finding in the order the task gave them, the paths that
 * differ in its snapshot from the state before it. The last finding reads
 * the worktree instead, so the tree's final state closes the sequence
 * whatever the fixer snapshotted. A finding with no snapshot, or whose
 * snapshot changed nothing, is carried into the next revision, which then
 * names it too; a path a snapshot does not list is taken from the next
 * reader that does.
 */
export function revisionsFromSnapshots(evidence: Pick<EvidenceStore, 'put'>, sources: RevisionSources, expected: ExpectedTree, paths: readonly string[], findings: readonly string[]): FindingRevision[] {
  const state = new Map(expected);
  const revisions: FindingRevision[] = [];
  let carried: string[] = [];
  findings.forEach((id, index) => {
    carried.push(id);
    const read = index === findings.length - 1 ? sources.worktree : sources.snapshot(index);
    if (read === null) return;
    const files = reviseFrom(evidence, read, state, paths);
    if (files.length === 0) return;
    revisions.push({ findings: carried, files });
    applyRevision(state, files);
    carried = [];
  });
  return revisions;
}
