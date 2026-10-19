/**
 * The kill marks a child leaves when a kill from outside the engine ends it
 * (R4, R8 of resumable runs), and their words. Pure, so the ledger fold and
 * the report read the same list as the spawn code without loading it.
 */
import type { ProcessResult } from './process.ts';

/**
 * The exit codes a kill from outside the engine leaves on a child (R4,
 * PD5, TD4 of resumable runs): 128 plus the number of SIGHUP, SIGINT,
 * SIGQUIT, SIGKILL or SIGTERM, which a shell gives a process that signal
 * ended, and 3221225786, STATUS_CONTROL_C_EXIT, which Windows gives a
 * process Ctrl-C ended. Exit code 1 is no mark: `taskkill` leaves it, and
 * so does a check that fails by itself.
 */
export const killMarkCodes: readonly number[] = [129, 130, 131, 137, 143, 3221225786];

/** How a guard that left no result ended, as Node reported its exit. */
export interface GuardEnd {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/** The end of a child as a kill mark reads it, live or as the ledger recorded it, with how its guard ended when that is known. */
type ChildEnd = { readonly termination: ProcessResult['termination'] | null; readonly exitCode: number | null; readonly signal: string | null; readonly guardEnd?: GuardEnd };

/**
 * Whether a child that exited was ended by a kill from outside the engine:
 * a signal, one of `killMarkCodes`, or no result from its guard (R4, R8 of
 * resumable runs). Checks and workers read this one list, so the two
 * cannot disagree on a mark. A child the engine killed at its timeout is no
 * mark: its termination is `killed`.
 */
export function endedByKill(end: ChildEnd): boolean {
  if (end.termination !== 'exited') return false;
  return guardLeftNoResult(end) || end.signal !== null || (end.exitCode !== null && killMarkCodes.includes(end.exitCode));
}

/**
 * Whether a child that exited has no end of its own because its guard left
 * no result (R8 of resumable runs): an exit code and a signal both null,
 * which Node never reports for an exit, so the ledger keeps it without a
 * value of its own. Every reader decodes the two nulls here.
 */
export function guardLeftNoResult(end: ChildEnd): boolean {
  return end.termination === 'exited' && end.exitCode === null && end.signal === null;
}

/**
 * How a child a kill from outside ended, as a log line or an error names
 * it: the signal or the exit code it left, or no result from its guard,
 * with how the guard ended when the live result knows it.
 */
export function killMarkWords(end: ChildEnd): string {
  if (guardLeftNoResult(end)) return end.guardEnd === undefined ? 'no result from its guard' : `no result from its guard, which ${guardEndWords(end.guardEnd)}`;
  if (end.signal !== null) return `signal ${end.signal}, a kill mark`;
  return `exit code ${String(end.exitCode)}, a kill mark`;
}

/** How a guard that left no result ended, as words: by a signal, or by an exit of its own with a code. */
function guardEndWords(end: GuardEnd): string {
  if (end.signal !== null) return `ended by signal ${end.signal}`;
  return end.exitCode === null ? 'ended with no exit code and no signal' : `exited with code ${String(end.exitCode)}`;
}
