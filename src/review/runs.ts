/**
 * The runs a command may pick from: every run of the ledger this engine
 * can read. The checkpoint is shared by every worktree and every engine
 * build of the repository, so it may hold a run written by a build that
 * declares events this one does not; such a run is passed over, with one
 * line naming the engine that wrote it, and is never called closed.
 */
import { isUnreadable, type Checkpoint } from '../checkpoint/checkpoint.ts';
import { unreadableRunReason, type UnknownEvent } from '../checkpoint/errors.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { ReviewRefusedError } from './errors.ts';

/** How many characters of a run id the brief, the name of a copy and the list of runs show, and the fewest `--run` takes (R11 of the questions in the chat). */
export const shortRunIdLength = 8;

/** The start of a run id that the brief, the name of a copy and the list of runs show. */
export const shortRunId = (runId: string): string => runId.slice(0, shortRunIdLength);

/** Every run this engine can read, in ledger order, logging one line for each run it passes over. */
export function readableRuns(checkpoint: Checkpoint, log: (line: string) => void): RunState[] {
  const readable: RunState[] = [];
  for (const run of checkpoint.listRuns()) {
    if (isUnreadable(run)) log(passedOverLine(run.id, run.unreadable, checkpoint.engine));
    else readable.push(run);
  }
  return readable;
}

/**
 * `runs` by their last event in the ledger, the latest first: the order
 * `answer`, `commit` and `report` take their run in, the first that
 * qualifies, since a read-only run continued into the fix pass finishes
 * after runs that started later (R9 of fix pass continuation).
 */
export function latestFirst<Run extends { readonly lastSequence: number }>(runs: readonly Run[]): Run[] {
  return [...runs].sort((a, b) => b.lastSequence - a.lastSequence);
}

/** The line a command prints for a run it passes over because the engine `reader` cannot read it. */
export function passedOverLine(runId: string, unknown: UnknownEvent, reader: string): string {
  return `run ${runId}: passed over: ${unreadableRunReason(unknown, reader)}`;
}

/**
 * The id of the run that `--run` names (R11 of the questions in the
 * chat): `given` when the ledger holds that id, else the one run whose id
 * starts with `given` when it has at least `shortRunIdLength` characters.
 * A start that two or more runs share is refused with their ids. A start
 * that names none, or a shorter one, is given back as it is, so that the
 * fold refuses it as an unknown id, as it refused every id before. An
 * unreadable run is named by its start too, and the fold then refuses it
 * by name.
 */
export function runIdOf(checkpoint: Checkpoint, given: string): string {
  const ids = checkpoint.runIds();
  if (ids.includes(given) || given.length < shortRunIdLength) return given;
  const named = ids.filter((id) => id.startsWith(given));
  if (named.length > 1) throw new ReviewRefusedError(`--run ${given} names ${String(named.length)} runs (${named.join(', ')}); give more of the id`);
  return named[0] ?? given;
}
