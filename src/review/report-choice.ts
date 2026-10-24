/**
 * The run `report` shows when no `--run` names one (R8 of the questions in
 * the chat): the run of the worktree that has a current report and whose
 * last event is the latest in the ledger, as `answer` and `commit` take
 * theirs, since a read-only run continued into the fix pass finishes
 * after runs that started later (R9 of fix pass continuation). Each run
 * of the worktree whose last event is later has no report, and the choice
 * names it with why, so that an older result is never taken for the
 * current one. A later run this engine cannot read is named too.
 */
import { isUnreadable, type Checkpoint } from '../checkpoint/checkpoint.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { sameDirectory } from '../paths.ts';
import { cutAtWord, shortLineLimit } from './brief.ts';
import { counted } from './markdown.ts';
import { latestFirst, passedOverLine, shortRunId } from './runs.ts';
import { hasCurrentReport } from './state.ts';
import { noReportWords } from './status.ts';

/** A run `report` passed over: its id, and why it has no report, in the words of `noReportWords`. */
export interface PassedOver {
  readonly run: string;
  readonly state: string;
}

/** What `report` chose: the run it shows, or null; the later runs it passed over, the latest first; and the newest run of the worktree, for a refusal when none has a report. */
export interface ReportChoice {
  readonly run: RunState | null;
  readonly passedOver: readonly PassedOver[];
  readonly newest: { readonly id: string; readonly state: string } | null;
}

/** The most `Not shown:` lines `report` prints before a line that counts the others. */
export const shownPassedOver = 3;

/** A run as the choice weighs it: its id, its last sequence, its state, or null for a run this engine cannot read, and why it has no report, in the words a `Not shown:` line gives. */
interface Weighed {
  readonly id: string;
  readonly lastSequence: number;
  readonly state: RunState | null;
  readonly words: string;
}

/** Choose the run `report` shows for `worktree`, logging a line for each run this engine cannot read, as every command that picks a run does. */
export function chooseReportRun(checkpoint: Checkpoint, worktree: string, log: (line: string) => void): ReportChoice {
  const weighed: Weighed[] = [];
  for (const listed of checkpoint.listRuns()) {
    if (isUnreadable(listed)) {
      log(passedOverLine(listed.id, listed.unreadable, checkpoint.engine));
      // A run whose worktree cannot be read may be this worktree's, so it is named rather than hidden.
      if (listed.worktree === null || sameDirectory(listed.worktree, worktree)) weighed.push({ id: listed.id, lastSequence: checkpoint.ledger.lastSequence(listed.id), state: null, words: `cannot be read by this engine (${checkpoint.engine}); an engine that declares its events can show it` });
    } else if (sameDirectory(listed.worktree, worktree)) {
      weighed.push({ id: listed.id, lastSequence: listed.lastSequence, state: listed, words: noReportWords(listed) });
    }
  }
  const ordered = latestFirst(weighed);
  const index = ordered.findIndex((entry) => entry.state !== null && hasCurrentReport(entry.state));
  const newest = ordered[0];
  return {
    run: index === -1 ? null : ordered[index]!.state,
    passedOver: index === -1 ? [] : ordered.slice(0, index).map((entry) => ({ run: entry.id, state: entry.words })),
    newest: newest === undefined ? null : { id: newest.id, state: newest.words },
  };
}

/** The `Not shown:` lines `report` prints before the short form: at most `shownPassedOver`, the latest first, then one that counts the others, each cut at a word, since the reason of an abandon has no limit. */
export function notShownLines(passedOver: readonly PassedOver[]): string[] {
  const lines = passedOver.slice(0, shownPassedOver).map((entry) => `Not shown: run ${shortRunId(entry.run)}, a later run, ${entry.state}.`);
  const more = passedOver.length - shownPassedOver;
  return [...lines, ...(more > 0 ? [`Not shown: ${counted(more, 'more later run', 'more later runs')}; deep-review status --all lists them`] : [])].map((line) => cutAtWord(line, shortLineLimit));
}
