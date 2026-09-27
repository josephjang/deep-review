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
