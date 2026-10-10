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

/** Every run this engine can read, in ledger order, logging one line for each run it passes over. */
export function readableRuns(checkpoint: Checkpoint, log: (line: string) => void): RunState[] {
  const readable: RunState[] = [];
  for (const run of checkpoint.listRuns()) {
    if (isUnreadable(run)) log(passedOverLine(run.id, run.unreadable, checkpoint.engine));
    else readable.push(run);
  }
  return readable;
}

/** The line a command prints for a run it passes over because the engine `reader` cannot read it. */
export function passedOverLine(runId: string, unknown: UnknownEvent, reader: string): string {
  return `run ${runId}: passed over: ${unreadableRunReason(unknown, reader)}`;
}
