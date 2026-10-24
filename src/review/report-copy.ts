/**
 * The copy of a run's report that a person opens (R14, PD10, TD6, TD7 of
 * the brief of a run): a Markdown file beside the ledger, outside the
 * worktree, named by the day the run started and the run. The report in
 * the evidence store stays the record of its moment; the copy is the
 * report as the ledger says it now, so each command that changes what the
 * report says writes it again: `review`, `answer`, `commit` and `report`.
 * A copy is a convenience: a failure to write it is logged and never fails
 * the command.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../atomic-write.ts';
import type { Checkpoint } from '../checkpoint/checkpoint.ts';
import type { RunState } from '../checkpoint/fold.ts';
import type { RuntimeAdapter } from '../runtime/adapter.ts';
import { continueCommand } from './continue-command.ts';
import { renderReport, type ReportInput } from './report.ts';
import { shortRunId } from './runs.ts';
import { budgetSpendOf, statisticsOf } from './spend.ts';
import { budgetStoppedRun } from './state.ts';

/** The directory under the checkpoint root that holds the copies. */
export const reportsDirectoryName = 'reports';

/**
 * Where the copy of a run's report is: `<checkpoint>/reports/<date>-<run>.md`,
 * the day the run started in UTC and the first 8 characters of its id. The
 * one place that knows the rule, so a later change can move the copy.
 */
export function reportCopyPath(checkpointRoot: string, state: Pick<RunState, 'id' | 'createdAt'>): string {
  return join(checkpointRoot, reportsDirectoryName, `${state.createdAt.slice(0, 10)}-${shortRunId(state.id)}.md`);
}

/**
 * What a render outside the step `write-report` needs beyond the ledger:
 * the engine, its entry, the runtime adapter of the run, the home
 * directory, and the roles the command that continues a stopped fix pass
 * names: null for the engine's own, else `rolesPlaceholder`.
 */
export interface CopyContext {
  readonly engineEntry: string;
  readonly adapter: Pick<RuntimeAdapter, 'summarizeUsage' | 'capabilities'>;
  readonly continueRoles: () => string | null;
  readonly home?: string;
}

/**
 * The command that continues a fix pass the run budget stopped, with the
 * roles the context names, or null for any other run: the one rule for the
 * copy's facts and `report --json`, so the two cannot name different
 * commands.
 */
export function stoppedContinueCommand(state: RunState, context: Pick<CopyContext, 'engineEntry' | 'adapter' | 'continueRoles'>): string | null {
  const spend = budgetStoppedRun(state) ? budgetSpendOf(state, context.adapter).usd : null;
  return spend === null ? null : continueCommand(state, context.engineEntry, context.continueRoles(), spend);
}

/**
 * The input of `renderReport` for a run with a current report, read from
 * the ledger as `status` reads it: the statistics and the budget check
 * from the fold and the adapter of the run's runtime, the patches from the
 * current report, and for a fix pass the run budget stopped the command
 * that continues it, with a placeholder for roles that are not the
 * engine's own, as `status` names them.
 */
export function reportInputOf(checkpoint: Pick<Checkpoint, 'engine' | 'evidence'>, state: RunState, context: CopyContext): ReportInput {
  const review = state.review;
  if (review === null || review.report === null) throw new Error(`Run ${state.id} has no current report`);
  const statistics = statisticsOf(state, context.adapter);
  const budgetCheck = statistics.budgetApplied ? budgetSpendOf(state, context.adapter) : null;
  const continuing = stoppedContinueCommand(state, context);
  return {
    engine: checkpoint.engine,
    engineEntry: context.engineEntry,
    statistics,
    budgetCheck,
    store: checkpoint.evidence.root,
    home: context.home ?? homedir(),
    ...(review.fix === null ? {} : { fix: { patches: review.report.patches, continueCommand: continuing } }),
  };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Remove the copy at `path` that a failed render or write left older than
 * the run's report, since `status` names a copy whenever the file exists
 * (TD6). It logs what it removed, or why it could not; a missing copy has
 * nothing to remove, and a directory in its place is never removed.
 */
function removeStaleCopy(path: string, runId: string, log: (line: string) => void): void {
  if (!existsSync(path)) return;
  try {
    rmSync(path, { force: true });
    log(`run ${runId}: removed the copy of the report at ${path}, which is older than the report`);
  } catch (error) {
    log(`run ${runId}: could not remove the copy of the report at ${path}, which is older than the report: ${messageOf(error)}`);
  }
}

/**
 * Write `text` as the copy of the report at `path`, creating its directory,
 * by an atomic replace (`write`, a seam for the tests), so no reader sees
 * half a copy. A failure is logged, removes the copy it would have
 * replaced, and gives null; the record in the evidence store is the report.
 */
export function writeReportCopy(path: string, text: string, runId: string, log: (line: string) => void, write: (path: string, text: string) => void = writeFileAtomic): string | null {
  try {
    mkdirSync(dirname(path), { recursive: true });
    write(path, text);
    return path;
  } catch (error) {
    log(`run ${runId}: could not write the copy of the report to ${path}: ${messageOf(error)}`);
    removeStaleCopy(path, runId, log);
    return null;
  }
}

/**
 * Render the run's report from the ledger as it is now and write it as its
 * copy, giving the copy's path; null, writing nothing, while the run has no
 * current report, as while an answer pass, a continuation or a reopened fix
 * pass works again, and when the copy cannot be rendered or written, which
 * it logs, removing the copy it would have replaced.
 */
export function refreshReportCopy(checkpoint: Pick<Checkpoint, 'root' | 'engine' | 'evidence'>, state: RunState, context: CopyContext, log: (line: string) => void): string | null {
  if (state.review?.report === null || state.review?.report === undefined) return null;
  const path = reportCopyPath(checkpoint.root, state);
  let text: string;
  try {
    text = renderReport(state, reportInputOf(checkpoint, state, context));
  } catch (error) {
    // A copy never fails a command, whatever stops its render: the roles it names, the statistics or the report itself (TD6).
    log(`run ${state.id}: could not render the copy of the report: ${messageOf(error)}`);
    removeStaleCopy(path, state.id, log);
    return null;
  }
  return writeReportCopy(path, text, state.id, log);
}
