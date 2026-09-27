/** Base class for every error the engine raises on purpose, so callers can tell them from bugs. */
export class EngineError extends Error {
  override readonly name: string = 'EngineError';
}
