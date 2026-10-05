import { EngineError } from '../errors.ts';

/**
 * A replay cannot run as asked, for a reason its operator must act on
 * before any worker is paid for: a recorded prompt that cannot be read
 * back into the invocation that carried it, a tree that is not the one the
 * run reviewed, a run with nothing to replay, or results that belong to
 * another run.
 */
export class ReplayRefusedError extends EngineError {
  override readonly name = 'ReplayRefusedError';
}
