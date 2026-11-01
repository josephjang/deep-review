import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { accountAction, ghTokenVariables, runGhApi, type Gh, type GhResult } from '../../src/github/gh.ts';
import { fakeGh, fakeGhCalls, fakeGhWith } from '../helpers/fake-gh.ts';

/** `result` as an answer, failing the test otherwise. */
function answerOf(result: GhResult): Extract<GhResult, { kind: 'answer' }> {
  assert.equal(result.kind, 'answer', JSON.stringify(result));
  return result as Extract<GhResult, { kind: 'answer' }>;
}

describe('runGhApi', () => {
  it('gives the status, the headers by their names in lower case and the body of an answer, from gh api --include', (t) => {
    const { gh, script } = fakeGhWith(t, [{ endpoint: 'repos/{owner}/{repo}/pulls/1', pages: [{ headers: { 'X-GitHub-Request-Id': 'abc' }, body: { number: 1 } }] }]);
    const answer = answerOf(runGhApi(gh, { endpoint: 'repos/{owner}/{repo}/pulls/1' }));
    assert.equal(answer.status, 200);
    assert.equal(answer.message, null);
    assert.equal(answer.headers.get('x-github-request-id'), 'abc');
    assert.deepEqual(answer.bodies, [{ number: 1 }]);
    assert.deepEqual(fakeGhCalls(script), [{ args: ['api', '--include', '-X', 'GET', 'repos/{owner}/{repo}/pulls/1'], stdin: '' }]);
  });

  it('gives the body of every page with --paginate, and the headers of the last', (t) => {
    const pages = [1, 2, 3].map((page) => ({ headers: { Link: `page ${String(page)}` }, body: [{ page }] }));
    const { gh, script } = fakeGhWith(t, [{ endpoint: 'list', pages }]);
    const answer = answerOf(runGhApi(gh, { endpoint: 'list', paginate: true, hostname: 'github.com' }));
    assert.deepEqual(answer.bodies, [[{ page: 1 }], [{ page: 2 }], [{ page: 3 }]]);
    assert.equal(answer.headers.get('link'), 'page 3');
    assert.deepEqual(fakeGhCalls(script)[0]?.args, ['api', '--include', '-X', 'GET', '--hostname', 'github.com', '--paginate', 'list']);
  });

  it('gives an answer with no body as null', (t) => {
    const { gh } = fakeGhWith(t, [{ endpoint: 'empty', pages: [{ status: 204 }] }]);
    assert.deepEqual(answerOf(runGhApi(gh, { endpoint: 'empty' })).bodies, [null]);
  });

  it('sends the body of a write as JSON on stdin with --input -', (t) => {
    const { gh, script } = fakeGhWith(t, [{ method: 'POST', endpoint: 'write', pages: [{ status: 201, body: { id: 9 } }] }]);
    const answer = answerOf(runGhApi(gh, { endpoint: 'write', method: 'POST', hostname: 'ghe.example.com', input: { body: 'text' } }));
    assert.equal(answer.status, 201);
    assert.deepEqual(fakeGhCalls(script), [{ args: ['api', '--include', '-X', 'POST', '--hostname', 'ghe.example.com', '--input', '-', 'write'], stdin: '{"body":"text"}' }]);
  });

  it("gives an answer that is not a success with GitHub's message and each of its errors", (t) => {
    const body = { message: 'Unprocessable Entity', errors: ['Line must be part of the diff', { resource: 'PullRequestReview', field: 'commit_id', code: 'invalid' }] };
    const { gh } = fakeGhWith(t, [{ method: 'POST', endpoint: 'reviews', pages: [{ status: 422, body }] }]);
    const answer = answerOf(runGhApi(gh, { endpoint: 'reviews', method: 'POST', input: {} }));
    assert.equal(answer.status, 422);
    assert.equal(answer.message, 'Unprocessable Entity: Line must be part of the diff; PullRequestReview.commit_id is invalid');
  });

  it('keeps the retry-after header of a refusal at a rate limit', (t) => {
    const { gh } = fakeGhWith(t, [{ endpoint: 'limited', pages: [{ status: 429, headers: { 'Retry-After': '60' }, body: { message: 'You have exceeded a secondary rate limit' } }] }]);
    const answer = answerOf(runGhApi(gh, { endpoint: 'limited' }));
    assert.equal(answer.status, 429);
    assert.equal(answer.headers.get('retry-after'), '60');
    assert.equal(answer.message, 'You have exceeded a secondary rate limit');
  });

  it('gives the status of a page that failed after earlier pages, with the bodies of all', (t) => {
    const { gh } = fakeGhWith(t, [{ endpoint: 'list', pages: [{ body: [1] }, { status: 502, body: { message: 'Server Error' } }] }]);
    const answer = answerOf(runGhApi(gh, { endpoint: 'list', paginate: true }));
    assert.equal(answer.status, 502);
    assert.deepEqual(answer.bodies, [[1], { message: 'Server Error' }]);
  });

  it('says that gh is missing when its executable cannot be started', (t) => {
    const { gh } = fakeGhWith(t, []);
    const result = runGhApi({ ...gh, executable: join(gh.cwd, 'no-such-gh'), args: [] }, { endpoint: 'x' });
    assert.equal(result.kind, 'missing');
  });

  it('says that gh timed out when it does not finish in time', (t) => {
    const { gh } = fakeGhWith(t, [{ endpoint: 'slow', hang: true }], 1500);
    assert.deepEqual(runGhApi(gh, { endpoint: 'slow' }), { kind: 'timeout', timeoutMs: 1500 });
  });

  it('refuses for want of an account with the action for the host the call names', (t) => {
    const { gh } = fakeGhWith(t, [{ endpoint: 'a', noAccount: true }, { endpoint: 'b', noAccount: true }, { endpoint: 'c', noAccount: true }]);
    assert.deepEqual(runGhApi(gh, { endpoint: 'a', hostname: 'github.com' }), { kind: 'no-account', host: 'github.com', action: 'run `gh auth login --hostname github.com`, or set GH_TOKEN' });
    assert.deepEqual(runGhApi(gh, { endpoint: 'b', hostname: 'ghe.example.com' }), { kind: 'no-account', host: 'ghe.example.com', action: 'run `gh auth login --hostname ghe.example.com`, or set GH_ENTERPRISE_TOKEN' });
    assert.deepEqual(runGhApi(gh, { endpoint: 'c' }), { kind: 'no-account', host: null, action: 'run `gh auth login`, or set GH_TOKEN (GH_ENTERPRISE_TOKEN for a GitHub Enterprise Server)' });
  });

  it('names GH_TOKEN for a host of GitHub Enterprise Cloud under ghe.com, which gh takes it for', () => {
    assert.equal(accountAction('acme.ghe.com'), 'run `gh auth login --hostname acme.ghe.com`, or set GH_TOKEN');
  });

  it('says that an answer whose body is not JSON cannot be read', (t) => {
    const { gh } = fakeGhWith(t, [{ endpoint: 'html', pages: [{ raw: '<html>not json</html>' }] }]);
    const result = runGhApi(gh, { endpoint: 'html' });
    assert.equal(result.kind, 'unreadable');
    assert.match((result as { detail: string }).detail, /not JSON/);
  });

  it("says that a run of gh that failed before GitHub answered cannot be read, with gh's words", (t) => {
    const { gh } = fakeGhWith(t, []);
    const result = runGhApi(gh, { endpoint: 'unscripted' });
    assert.equal(result.kind, 'unreadable');
    assert.match((result as { detail: string }).detail, /exited 1 with no answer: fake-gh: no step answers GET unscripted/);
  });

  it('names the four variables that hold a token for gh', () => {
    assert.deepEqual(ghTokenVariables, ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']);
  });
});

describe('the stand-in gh', () => {
  /** Run a Node process that calls the stand-in once under `script`, and give what it printed: `survived` when the stand-in did not end it. */
  const parentOf = (gh: Gh): string => {
    const child = `require('node:child_process').spawnSync(process.execPath, ${JSON.stringify([fakeGh, 'api', '--include', '-X', 'POST', '--input', '-', 'post'])}, { input: '{}' }); process.stdout.write('survived');`;
    return spawnSync(process.execPath, ['-e', child], { env: gh.environment, encoding: 'utf8' }).stdout;
  };

  it('ends the process that started it before it logs the call, for a step that stops before', (t) => {
    const { gh, script } = fakeGhWith(t, [{ method: 'POST', endpoint: 'post', stop: 'before', pages: [{ status: 201, body: {} }] }]);
    assert.equal(parentOf(gh), '');
    assert.ok(existsSync(`${script}.stopped`));
    assert.deepEqual(fakeGhCalls(script), []);
  });

  it('ends the process that started it after it logs the call, for a step that stops after', (t) => {
    const { gh, script } = fakeGhWith(t, [{ method: 'POST', endpoint: 'post', stop: 'after', pages: [{ status: 201, body: {} }] }]);
    assert.equal(parentOf(gh), '');
    assert.equal(fakeGhCalls(script).length, 1);
  });
});
