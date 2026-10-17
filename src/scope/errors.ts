import { EngineError } from '../errors.ts';

/** The request names a scope the capture cannot honour: bad path, two selectors, a range that is not checked out. */
export class InvalidScopeRequestError extends EngineError {
  override readonly name = 'InvalidScopeRequestError';
}

/** The repository is in a state the capture refuses to represent: unmerged paths, submodules, embedded repositories, too many files. */
export class UnsupportedRepositoryStateError extends EngineError {
  override readonly name = 'UnsupportedRepositoryStateError';
}

/**
 * The change has no path to review: it was empty, or `scope.exclude` left
 * every changed path out (R10 of the configuration). Nothing is recorded,
 * and the run is refused before it exists.
 */
export class EmptyChangeError extends EngineError {
  override readonly name = 'EmptyChangeError';
}

/** HEAD, the index or a scope file changed while the capture was reading; nothing was recorded. */
export class CaptureRacedError extends EngineError {
  override readonly name = 'CaptureRacedError';
}

/** The run already has a scope; a run is captured once. */
export class ScopeAlreadyCapturedError extends EngineError {
  override readonly name = 'ScopeAlreadyCapturedError';
}
