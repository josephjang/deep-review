import { EngineError } from '../errors.ts';
import { ReviewRefusedError } from '../review/errors.ts';
import { accountAction, ghFailureOf, type GhResult } from './gh.ts';

/**
 * A call of `gh api` that gave no answer the engine can use: `gh` missing,
 * a timeout, no account for the host, an answer of GitHub that is not a
 * success, or one the engine cannot read. `failure` keeps what the call
 * gave, so a caller can tell a refusal of GitHub, with its status and
 * message, from a post whose outcome is unknown; `what` names the call,
 * and `recorded`, when given, what the command recorded, said last.
 */
export class GitHubCallError extends EngineError {
  override readonly name = 'GitHubCallError';
  readonly what: string;
  readonly failure: GhResult;
  constructor(what: string, failure: GhResult, recorded?: string) {
    super(`${what}: ${ghFailureOf(failure)}${recorded === undefined ? '' : `; ${recorded}`}`);
    this.what = what;
    this.failure = failure;
  }
}

/** A pull request the engine cannot review as GitHub gave it, such as one of more files than GitHub lists. */
export class PullRequestRefusedError extends EngineError {
  override readonly name = 'PullRequestRefusedError';
}

/** What a refusal of a read of GitHub names beside the words of GitHub or `gh` (`refusingGitHub`). */
export interface GitHubRefusal {
  /** The host of the pull request, whose account a 401 or a 404 names, or null for the host `gh` takes for the clone. */
  readonly host: string | null;
  /** The pull request, as a 401 or a 404 names it to the account that must read it. */
  readonly pullRequest: string;
  /** What else a 404 may mean, such as a number that names no pull request, said before the account's action; none when absent. */
  readonly missing?: string;
  /** What the command recorded, said at the end of each refusal; nothing when absent. */
  readonly recorded?: string;
  /** The action that answers an answer the engine cannot read, which is a refusal then; an error when absent. */
  readonly unreadable?: string;
}

/**
 * The result of `read`, calls of GitHub, with each one GitHub or `gh`
 * refused, and each pull request the engine cannot review as GitHub gave
 * it, turned into a refusal, exit 2, that names its action: a 401 or a 404
 * names the account that must read the pull request, after what else a
 * 404 may mean; another answer of 4xx, `gh` missing and `gh` with no
 * account for the host name their own. A timeout and a server error of
 * GitHub, a status of 500 or more, stay errors, exit 1, as for the post
 * (the publication in the design of the review on the pull request), and
 * so does an answer the engine cannot read, unless the refusal names the
 * action that answers it.
 */
export function refusingGitHub<T>(read: () => T, refusal: GitHubRefusal): T {
  const refused = (words: string): ReviewRefusedError => new ReviewRefusedError(refusal.recorded === undefined ? words : `${words}; ${refusal.recorded}`);
  try {
    return read();
  } catch (error) {
    if (error instanceof PullRequestRefusedError) throw refused(error.message);
    if (!(error instanceof GitHubCallError)) throw error;
    const { failure } = error;
    if (failure.kind === 'answer' && (failure.status === 401 || failure.status === 404)) {
      const missing = failure.status === 404 && refusal.missing !== undefined ? `${refusal.missing}, or ` : '';
      throw refused(`${error.message}; ${missing}${accountAction(refusal.host)} with an account that can read ${refusal.pullRequest}`);
    }
    if ((failure.kind === 'answer' && failure.status < 500) || failure.kind === 'missing' || failure.kind === 'no-account') throw refused(error.message);
    if (failure.kind === 'unreadable' && refusal.unreadable !== undefined) throw refused(`${error.message}; ${refusal.unreadable}`);
    throw error;
  }
}
