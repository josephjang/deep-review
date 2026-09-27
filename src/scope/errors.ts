import { EngineError } from '../errors.ts';

/** The request names a scope the capture cannot honour: bad path, two selectors, a range that is not checked out. */
export class InvalidScopeRequestError extends EngineError {
  override readonly name = 'InvalidScopeRequestError';
}

/** The repository is in a state the capture refuses to represent: unmerged paths, submodules, embedded repositories, too many files. */
export class UnsupportedRepositoryStateError extends EngineError {
  override readonly name = 'UnsupportedRepositoryStateError';
}

/** HEAD, the index or a scope file changed while the capture was reading; nothing was recorded. */
export class CaptureRacedError extends EngineError {
  override readonly name = 'CaptureRacedError';
}

/** The run already has a scope; a run is captured once. */
export class ScopeAlreadyCapturedError extends EngineError {
  override readonly name = 'ScopeAlreadyCapturedError';
}
