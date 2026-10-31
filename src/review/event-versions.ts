/**
 * The version each event that names a phase is written at (TD5 of the
 * documentation step): the oldest version that holds every word the event
 * carries, and never older than the version the engine writes for the
 * phases it knew before. A run that never enters a later phase then holds
 * no event an older engine cannot read. Adding a phase is one row of
 * `phaseVersions`, and adding a carried word one row of `carriedVersions`.
 */
import type { NewEvent } from '../checkpoint/checkpoint.ts';
import type { CheckRan } from '../checkpoint/events.ts';
import type { AttemptFault, Phase, worktreeMoments } from './vocabulary.ts';

/** The kinds whose version a writer asks for here. */
export type VersionedKind = 'phase.started' | 'phase.finished' | 'worktree.checked' | 'attempt.failed' | 'worker.lost' | 'report.written' | 'tree.revised' | 'fix.recorded' | 'unit.unattempted' | 'fix.reopened' | 'check.started' | 'check.ran';

type WorktreeMoment = (typeof worktreeMoments)[number];

/** The version each kind is written at when nothing it carries needs a later one. */
const floors: Readonly<Record<VersionedKind, number>> = {
  'phase.started': 5,
  'phase.finished': 6,
  'worktree.checked': 5,
  'attempt.failed': 6,
  'worker.lost': 5,
  'report.written': 5,
  'tree.revised': 2,
  'fix.recorded': 2,
  'unit.unattempted': 1,
  'fix.reopened': 1,
  'check.started': 1,
  'check.ran': 3,
};

/** Each phase added after the floors, with the first version of each kind that names it. */
const phaseVersions: Readonly<Partial<Record<Phase, Readonly<Partial<Record<VersionedKind, number>>>>>> = {
  documentation: { 'phase.started': 6, 'phase.finished': 7, 'worktree.checked': 7, 'attempt.failed': 8, 'worker.lost': 6, 'report.written': 6, 'tree.revised': 3, 'fix.recorded': 3, 'unit.unattempted': 2, 'fix.reopened': 2 },
  'base-checks': { 'phase.started': 7, 'phase.finished': 8, 'worktree.checked': 8, 'report.written': 7, 'check.started': 2, 'check.ran': 4 },
};

/** What an event of a kind carries beside its phases that a later version records. */
interface Carried {
  readonly 'worktree.checked': { readonly moment: WorktreeMoment };
  readonly 'attempt.failed': { readonly fault: AttemptFault };
  readonly 'fix.recorded': { readonly comparisons: boolean; readonly cites: boolean };
}

/** The first version of each kind of `Carried` that records the words it carries, 0 for words every version holds. */
const carriedVersions: { readonly [K in keyof Carried]: (words: Carried[K]) => number } = {
  // The moment of a worktree check after a write back, which version 6 first records (R7 of resumable runs).
  'worktree.checked': ({ moment }) => (moment === 'restored' ? 6 : 0),
  // The faults of a failed attempt that version 7 first records: a kill mark and the provider's usage limit (R4, R14 of resumable runs).
  'attempt.failed': ({ fault }) => (fault === 'cut' || fault === 'limit' ? 7 : 0),
  // An answer one of whose validation entries cites a run, which version 5 first records (R7, TD7 of runs on the record); else the answer of the repair of a run with the checks on the base, which carries its comparisons with the base (TD6, TD7 of the facts before a merge).
  'fix.recorded': ({ comparisons, cites }) => (cites ? 5 : comparisons ? 4 : 0),
};

/**
 * The version to write an event of `kind` at, for the phases it names,
 * none for a lost worker with no unit, every row for a report's
 * statistics and every unit for a reopened fix pass, and the words
 * `Carried` asks of its kind: the moment of a worktree check, the fault
 * of a failed attempt, and whether an answer carries comparisons with the
 * base or cites a run in its validation.
 */
export function writtenVersion<K extends VersionedKind>(kind: K, phases: readonly Phase[], ...carried: K extends keyof Carried ? [Carried[K]] : []): number {
  // A generic kind cannot index the table, so the lookup widens each row to the words of any carried kind; the signature pairs them.
  const version = (carriedVersions as Partial<Record<VersionedKind, (words: Carried[keyof Carried]) => number>>)[kind];
  const words = carried[0];
  return Math.max(floors[kind], ...phases.map((phase) => phaseVersions[phase]?.[kind] ?? 0), version === undefined || words === undefined ? 0 : version(words));
}

/** The `check.ran` of a run, at the version its phase is written at: one before version 4, which no run on the base is, has no `skipReason`. */
export function checkRanEvent({ skipReason, ...ran }: CheckRan): NewEvent {
  const version = writtenVersion('check.ran', [ran.phase]);
  return { kind: 'check.ran', version, payload: version < 4 ? ran : { ...ran, skipReason } };
}
