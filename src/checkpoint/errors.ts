import { EngineError } from '../errors.ts';

/** Base class for the errors that concern the checkpoint: its location, its ledger, the runs folded from it and its evidence store. */
export class CheckpointError extends EngineError {
  override readonly name: string = 'CheckpointError';
}

/** The directory is not inside a git worktree, so there is no checkpoint to locate. */
export class NotInRepositoryError extends CheckpointError {
  override readonly name = 'NotInRepositoryError';
}

/** The ledger was written by a newer engine whose schema this one does not know. */
export class UnsupportedSchemaError extends CheckpointError {
  override readonly name = 'UnsupportedSchemaError';
  readonly found: number;
  readonly supported: number;
  constructor(found: number, supported: number) {
    super(`Ledger schema ${String(found)} is newer than the supported schema ${String(supported)}; upgrade the engine`);
    this.found = found;
    this.supported = supported;
  }
}

/** The caller folded the run up to one sequence, but the ledger has moved past it. */
export class StaleRevisionError extends CheckpointError {
  override readonly name = 'StaleRevisionError';
  readonly runId: string;
  readonly expected: number;
  readonly actual: number;
  constructor(runId: string, expected: number, actual: number) {
    super(`Run ${runId} is at sequence ${String(actual)}, not ${String(expected)}; fold it again before appending`);
    this.runId = runId;
    this.expected = expected;
    this.actual = actual;
  }
}

/** The ledger holds an event kind or version this engine's registry does not declare. */
export class UnknownEventError extends CheckpointError {
  override readonly name = 'UnknownEventError';
  readonly kind: string;
  readonly version: number;
  constructor(kind: string, version: number) {
    super(`Event kind ${kind} version ${String(version)} is not in this engine's registry`);
    this.kind = kind;
    this.version = version;
  }
}

/**
 * An event of a run whose kind and version a model does not declare, and
 * the engine that wrote it. It lives here rather than beside the fold so
 * that the error naming it needs no import from the fold, which imports
 * this module.
 */
export interface UnknownEvent {
  readonly sequence: number;
  readonly kind: string;
  readonly version: number;
  readonly engine: string;
}

/**
 * Why a run holding `unknown` cannot be read by the engine `reader`: one
 * sentence, shared by the error that refuses a named run and the line a
 * command prints for a run it passes over. The writing engine is named and
 * not called newer, because an engine identity orders nothing.
 */
export function unreadableRunReason(unknown: UnknownEvent, reader: string): string {
  return `it holds ${unknown.kind}@${String(unknown.version)} at sequence ${String(unknown.sequence)}, written by engine ${unknown.engine}, which this engine (${reader}) does not declare; an engine that declares it, such as the one that wrote it, can read the run`;
}

/** The run holds an event this engine does not declare, so it cannot be folded, resumed or appended to. */
export class UnreadableRunError extends CheckpointError {
  override readonly name = 'UnreadableRunError';
  readonly runId: string;
  readonly unknown: UnknownEvent;
  readonly engine: string;
  constructor(runId: string, unknown: UnknownEvent, engine: string) {
    super(`run ${runId} cannot be read: ${unreadableRunReason(unknown, engine)}`);
    this.runId = runId;
    this.unknown = unknown;
    this.engine = engine;
  }
}

/** A payload failed the schema its kind and version declare. */
export class InvalidPayloadError extends CheckpointError {
  override readonly name = 'InvalidPayloadError';
}

/** An event was appended to a run whose folded state no longer accepts events. */
export class RunClosedError extends CheckpointError {
  override readonly name = 'RunClosedError';
}

/** The run id names no run in this ledger. */
export class UnknownRunError extends CheckpointError {
  override readonly name = 'UnknownRunError';
  readonly runId: string;
  constructor(runId: string) {
    super(`Unknown run ${runId}`);
    this.runId = runId;
  }
}

/** A run's events do not form a valid history, such as a run without a creation event. */
export class InvalidHistoryError extends CheckpointError {
  override readonly name = 'InvalidHistoryError';
}

/** An evidence reference names a blob that is absent, or whose bytes do not match the reference. */
export class EvidenceError extends CheckpointError {
  override readonly name = 'EvidenceError';
}
