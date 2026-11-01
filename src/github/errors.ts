import { EngineError } from '../errors.ts';
import { ghFailureOf, type GhResult } from './gh.ts';

/**
 * A call of `gh api` that gave no answer the engine can use: `gh` missing,
 * a timeout, no account for the host, an answer of GitHub that is not a
 * success, or one the engine cannot read. `failure` keeps what the call
 * gave, so a caller can tell a refusal of GitHub, with its status and
 * message, from a post whose outcome is unknown.
 */
export class GitHubCallError extends EngineError {
  override readonly name = 'GitHubCallError';
  readonly failure: GhResult;
  constructor(what: string, failure: GhResult) {
    super(`${what}: ${ghFailureOf(failure)}`);
    this.failure = failure;
  }
}

/** A pull request the engine cannot review as GitHub gave it, such as one of more files than GitHub lists. */
export class PullRequestRefusedError extends EngineError {
  override readonly name = 'PullRequestRefusedError';
}
