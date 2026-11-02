import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GitHubCallError, PullRequestRefusedError, refusingGitHub, type GitHubRefusal } from '../../src/github/errors.ts';
import type { GhResult } from '../../src/github/gh.ts';
import { ReviewRefusedError } from '../../src/review/errors.ts';

/** An answer of GitHub with `status` and `message`. */
const answer = (status: number, message: string): GhResult => ({ kind: 'answer', status, headers: new Map(), message, bodies: [] });

/** What `refusingGitHub` makes of a read that throws `error`, under `refusal`. */
function thrownBy(error: Error, refusal: GitHubRefusal): unknown {
  try {
    refusingGitHub(() => {
      throw error;
    }, refusal);
  } catch (thrown) {
    return thrown;
  }
  assert.fail('refusingGitHub threw nothing');
}

/** The message of the refusal `thrown` is, failing the test for anything else. */
function refusalOf(thrown: unknown): string {
  assert.ok(thrown instanceof ReviewRefusedError, String(thrown));
  return thrown.message;
}

const acme: GitHubRefusal = { host: 'github.com', pullRequest: 'pull request #42 of acme/widgets' };

describe('refusingGitHub (R8 and the publication in the design of the review on the pull request)', () => {
  it('gives what the read gives', () => {
    assert.equal(refusingGitHub(() => 7, acme), 7);
  });

  it('names the account that must read the pull request for a 401 and a 404, and what else only a 404 may mean', () => {
    const missing = { ...acme, missing: 'check that pull request #42 exists in the repository of this clone' };
    assert.equal(refusalOf(thrownBy(new GitHubCallError('reading pull request #42', answer(401, 'Bad credentials')), missing)), 'reading pull request #42: GitHub answered 401: Bad credentials; run `gh auth login --hostname github.com`, or set GH_TOKEN with an account that can read pull request #42 of acme/widgets');
    assert.equal(refusalOf(thrownBy(new GitHubCallError('reading pull request #42', answer(404, 'Not Found')), missing)), 'reading pull request #42: GitHub answered 404: Not Found; check that pull request #42 exists in the repository of this clone, or run `gh auth login --hostname github.com`, or set GH_TOKEN with an account that can read pull request #42 of acme/widgets');
  });

  it('refuses another 4xx, gh missing and gh with no account by their own words, and a pull request the engine cannot review, each with what was recorded', () => {
    const recorded = { ...acme, recorded: 'nothing was posted or recorded' };
    assert.equal(refusalOf(thrownBy(new GitHubCallError('reading', answer(422, 'Unprocessable')), recorded)), 'reading: GitHub answered 422: Unprocessable; nothing was posted or recorded');
    assert.match(refusalOf(thrownBy(new GitHubCallError('reading', { kind: 'missing', executable: 'gh', detail: 'ENOENT' }), recorded)), /^reading: gh could not be started \(ENOENT\); .*; nothing was posted or recorded$/);
    assert.match(refusalOf(thrownBy(new GitHubCallError('reading', { kind: 'no-account', host: 'github.com', action: 'run gh auth login' }), recorded)), /^reading: gh has no account for github\.com; run gh auth login; nothing was posted or recorded$/);
    assert.equal(refusalOf(thrownBy(new PullRequestRefusedError('too many files'), recorded)), 'too many files; nothing was posted or recorded');
    assert.match(refusalOf(thrownBy(new GitHubCallError('reading', answer(404, 'Not Found')), recorded)), /with an account that can read pull request #42 of acme\/widgets; nothing was posted or recorded$/);
  });

  it('names in place of the account what a 404 means when the refusal says it is gone, and only for a 404', () => {
    const gone = { ...acme, missing: 'check the number', gone: 'the base branch main is no longer on GitHub', recorded: 'nothing was posted or recorded' };
    assert.equal(refusalOf(thrownBy(new GitHubCallError('reading the head of branch main', answer(404, 'Not Found')), gone)), 'reading the head of branch main: GitHub answered 404: Not Found; the base branch main is no longer on GitHub; nothing was posted or recorded');
    assert.match(refusalOf(thrownBy(new GitHubCallError('reading', answer(401, 'Bad credentials')), gone)), /; run `gh auth login --hostname github\.com`, or set GH_TOKEN with an account that can read pull request #42 of acme\/widgets; nothing was posted or recorded$/);
  });

  it('leaves a server error, a timeout, an unreadable answer with no action and any other error errors, exit 1, saying what was recorded when the refusal names it', () => {
    for (const status of [500, 502, 503]) {
      const error = new GitHubCallError('reading', answer(status, 'Server Error'));
      assert.equal(thrownBy(error, acme), error, `a ${String(status)} is no refusal`);
      const recorded = thrownBy(error, { ...acme, recorded: 'nothing was posted or recorded' });
      assert.ok(recorded instanceof GitHubCallError && !(recorded instanceof ReviewRefusedError), `a ${String(status)} is no refusal`);
      assert.equal(recorded.message, `reading: GitHub answered ${String(status)}: Server Error; nothing was posted or recorded`);
      assert.equal(recorded.failure, error.failure);
    }
    const timeout = new GitHubCallError('reading', { kind: 'timeout', timeoutMs: 1000 });
    assert.equal(thrownBy(timeout, acme), timeout);
    const unreadable = new GitHubCallError('reading', { kind: 'unreadable', detail: 'no status line' });
    assert.equal(thrownBy(unreadable, acme), unreadable);
    const other = new Error('another');
    assert.equal(thrownBy(other, acme), other);
  });

  it('refuses an unreadable answer with the action that answers it, when the refusal names one', () => {
    const unreadable = new GitHubCallError('reading', { kind: 'unreadable', detail: 'no status line' });
    assert.equal(refusalOf(thrownBy(unreadable, { ...acme, unreadable: 'give --pr the URL' })), 'reading: gh gave nothing the engine can read as an answer: no status line; give --pr the URL');
  });
});
