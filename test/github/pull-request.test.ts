import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GitHubCallError, PullRequestRefusedError } from '../../src/github/errors.ts';
import {
  impliedPaths,
  listPullRequestFiles,
  listReviewComments,
  listReviews,
  newLinesOf,
  pathDifference,
  postReview,
  pullRequestLabel,
  pullRequestPathOf,
  readBranchHead,
  readMergeBase,
  readPullRequest,
  type PullRequestFile,
  type PullRequestTarget,
} from '../../src/github/pull-request.ts';
import { fakeGhCalls, fakeGhWith } from '../helpers/fake-gh.ts';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const mergeBase = 'c'.repeat(40);

/** A pull request as GitHub answers it, with `overrides` over its fields. */
const pullRequestBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  html_url: 'https://github.com/acme/widgets/pull/42',
  number: 42,
  state: 'open',
  merged: false,
  head: { sha: head, ref: 'feature' },
  base: { sha: base, ref: 'main' },
  changed_files: 2,
  title: 'Add a widget',
  body: 'Why the widget.',
  user: { login: 'someone' },
  ...overrides,
});

const target: PullRequestTarget = { host: 'github.com', owner: 'acme', repository: 'widgets', number: 42 };

/** The arguments of the `index`th call the stand-in logged. */
const argsOf = (script: string, index = 0): readonly string[] => fakeGhCalls(script)[index]?.args ?? [];

/** The error `run` throws, which must be `kind`. */
function thrown<T extends Error>(run: () => unknown, kind: new (...args: never[]) => T): T {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof kind, String(error));
    return error;
  }
  assert.fail('nothing was thrown');
}

describe('readPullRequest', () => {
  it('reads a number in the clone, letting gh fill the repository, and takes the host, owner and repository from its URL', (t) => {
    const { gh, script } = fakeGhWith(t, [{ endpoint: 'repos/{owner}/{repo}/pulls/42', pages: [{ body: pullRequestBody({ body: '' }) }] }]);
    assert.deepEqual(readPullRequest(gh, { number: 42, repository: null }), {
      host: 'github.com',
      owner: 'acme',
      repository: 'widgets',
      number: 42,
      url: 'https://github.com/acme/widgets/pull/42',
      state: 'open',
      merged: false,
      head,
      baseRef: 'main',
      changedFiles: 2,
      title: 'Add a widget',
      body: null,
    });
    assert.ok(!argsOf(script).includes('--hostname'), 'a number lets gh choose the host');
  });

  it('reads a URL on its host, and keeps a merged pull request as GitHub says', (t) => {
    const url = 'https://ghe.example.com/acme/widgets/pull/7';
    const { gh, script } = fakeGhWith(t, [{ endpoint: 'repos/acme/widgets/pulls/7', pages: [{ body: pullRequestBody({ html_url: url, number: 7, state: 'closed', merged: true }) }] }]);
    const pullRequest = readPullRequest(gh, { number: 7, repository: 'ghe.example.com/acme/widgets' });
    assert.deepEqual([pullRequest.host, pullRequest.state, pullRequest.merged, pullRequest.body], ['ghe.example.com', 'closed', true, 'Why the widget.']);
    assert.deepEqual(argsOf(script), ['api', '--include', '-X', 'GET', '--hostname', 'ghe.example.com', 'repos/acme/widgets/pulls/7']);
  });

  it('reads a target on its host, as a run recorded it', (t) => {
    const url = 'https://ghe.example.com/acme/widgets/pull/7';
    const { gh, script } = fakeGhWith(t, [{ endpoint: 'repos/acme/widgets/pulls/7', pages: [{ body: pullRequestBody({ html_url: url, number: 7 }) }] }]);
    const pullRequest = readPullRequest(gh, { host: 'ghe.example.com', owner: 'acme', repository: 'widgets', number: 7 });
    assert.deepEqual([pullRequest.host, pullRequest.owner, pullRequest.repository, pullRequest.number], ['ghe.example.com', 'acme', 'widgets', 7]);
    assert.deepEqual(argsOf(script), ['api', '--include', '-X', 'GET', '--hostname', 'ghe.example.com', 'repos/acme/widgets/pulls/7']);
  });

  it('refuses an answer whose URL is not of the pull request it asked for', (t) => {
    const urls = ['https://github.com/acme/widgets/issues/42', 'https://github.com/acme/widgets/pull/43', 'https://github.com/acme/widgets/pull/42/files', 'https://github.com//widgets/pull/42'];
    const { gh } = fakeGhWith(t, urls.map((url) => ({ endpoint: 'repos/{owner}/{repo}/pulls/42', pages: [{ body: pullRequestBody({ html_url: url }) }] })));
    for (const url of urls) {
      const error = thrown(() => readPullRequest(gh, { number: 42, repository: null }), GitHubCallError);
      assert.equal(error.failure.kind, 'unreadable', url);
      assert.match(error.message, new RegExp(`${url.replaceAll('.', '\\.')} is not the URL of pull request #42`), url);
    }
  });

  it('refuses an answer that lacks what the engine keeps', (t) => {
    const { gh } = fakeGhWith(t, [{ endpoint: 'repos/{owner}/{repo}/pulls/42', pages: [{ body: pullRequestBody({ head: undefined }) }] }]);
    const error = thrown(() => readPullRequest(gh, { number: 42, repository: null }), GitHubCallError);
    assert.equal(error.failure.kind, 'unreadable');
    assert.match(error.message, /^reading pull request #42: gh gave nothing the engine can read as an answer/);
  });

  it("gives GitHub's refusal with its status", (t) => {
    const { gh } = fakeGhWith(t, [{ endpoint: 'repos/{owner}/{repo}/pulls/42', pages: [{ status: 404, body: { message: 'Not Found' } }] }]);
    const error = thrown(() => readPullRequest(gh, { number: 42, repository: null }), GitHubCallError);
    assert.deepEqual([error.failure.kind, (error.failure as { status: number }).status], ['answer', 404]);
    assert.equal(error.message, 'reading pull request #42: GitHub answered 404: Not Found');
  });

  it('refuses for want of an account with the action for github.com, and for an Enterprise host', (t) => {
    const { gh } = fakeGhWith(t, [
      { endpoint: 'repos/acme/widgets/pulls/1', noAccount: true },
      { endpoint: 'repos/acme/widgets/pulls/2', noAccount: true },
    ]);
    const dotCom = thrown(() => readPullRequest(gh, { number: 1, repository: 'github.com/acme/widgets' }), GitHubCallError);
    assert.match(dotCom.message, /run `gh auth login --hostname github\.com`, or set GH_TOKEN$/);
    const enterprise = thrown(() => readPullRequest(gh, { number: 2, repository: 'ghe.example.com/acme/widgets' }), GitHubCallError);
    assert.match(enterprise.message, /run `gh auth login --hostname ghe\.example\.com`, or set GH_ENTERPRISE_TOKEN$/);
  });
});

describe('pullRequestPathOf', () => {
  it('splits the owner, the repository and the number around pull, with the segments after the number', () => {
    assert.deepEqual(pullRequestPathOf(new URL('https://github.com/acme/widgets/pull/42')), { owner: 'acme', repository: 'widgets', number: '42', rest: [] });
    assert.deepEqual(pullRequestPathOf(new URL('https://github.com/acme/widgets/pull/42/files?w=1#diff-1')), { owner: 'acme', repository: 'widgets', number: '42', rest: ['files'] });
    assert.deepEqual(pullRequestPathOf(new URL('https://github.com/acme/widgets/pull/')), { owner: 'acme', repository: 'widgets', number: '', rest: [] }, 'the callers check the number');
  });

  it('gives null for a path that is not of a pull request', () => {
    for (const url of ['https://github.com/acme/widgets/issues/42', 'https://github.com/acme/widgets/pull', 'https://github.com/acme/pull/42', 'https://github.com/']) {
      assert.equal(pullRequestPathOf(new URL(url)), null, url);
    }
  });
});

describe('pullRequestLabel', () => {
  it('names a pull request by its number and its owner and repository, without the host', () => {
    assert.equal(pullRequestLabel(target), 'pull request #42 of acme/widgets');
    assert.equal(pullRequestLabel({ number: 7, owner: 'ghe-org', repository: 'tools.js' }), 'pull request #7 of ghe-org/tools.js');
  });
});

describe('readBranchHead and readMergeBase', () => {
  it('percent-encodes each segment of a branch name, keeping its slashes, on the host', (t) => {
    const { gh, script } = fakeGhWith(t, [{ endpoint: 'repos/acme/widgets/git/ref/heads/release/1.0%23hot%25fix', pages: [{ body: { ref: 'refs/heads/release/1.0#hot%fix', object: { sha: base, type: 'commit' } } }] }]);
    assert.equal(readBranchHead(gh, target, 'release/1.0#hot%fix'), base);
    assert.deepEqual(argsOf(script).slice(4, 6), ['--hostname', 'github.com']);
  });

  it('takes the merge base from the comparison of two commits', (t) => {
    const { gh, script } = fakeGhWith(t, [{ endpoint: `repos/acme/widgets/compare/${base}...${head}`, pages: [{ body: { status: 'ahead', merge_base_commit: { sha: mergeBase }, commits: [] } }] }]);
    assert.equal(readMergeBase(gh, target, base, head), mergeBase);
    assert.ok(argsOf(script).includes('--hostname'));
  });
});

describe('listPullRequestFiles', () => {
  it('lists every page of 100, keeping each path, status, previous path and patch', (t) => {
    const { gh, script } = fakeGhWith(t, [
      {
        endpoint: 'repos/acme/widgets/pulls/42/files?per_page=100',
        pages: [
          { body: [{ filename: 'src/a.ts', status: 'modified', additions: 1, patch: '@@ -1 +1 @@\n-a\n+b' }] },
          { body: [{ filename: 'src/c.ts', status: 'renamed', previous_filename: 'src/b.ts' }] },
        ],
      },
    ]);
    assert.deepEqual(listPullRequestFiles(gh, { ...target, changedFiles: 2 }), [
      { path: 'src/a.ts', status: 'modified', previousPath: null, patch: '@@ -1 +1 @@\n-a\n+b' },
      { path: 'src/c.ts', status: 'renamed', previousPath: 'src/b.ts', patch: null },
    ]);
    assert.deepEqual(argsOf(script), ['api', '--include', '-X', 'GET', '--hostname', 'github.com', '--paginate', 'repos/acme/widgets/pulls/42/files?per_page=100']);
  });

  it('refuses a pull request of more than 3000 files before it lists any', (t) => {
    const { gh, script } = fakeGhWith(t, []);
    const error = thrown(() => listPullRequestFiles(gh, { ...target, changedFiles: 3001 }), PullRequestRefusedError);
    assert.match(error.message, /changes 3001 files, and GitHub lists no more than 3000/);
    assert.deepEqual(fakeGhCalls(script), []);
  });
});

describe('the reviews', () => {
  it('lists every page of the reviews of a pull request, an empty body as empty text', (t) => {
    const { gh } = fakeGhWith(t, [
      {
        endpoint: 'repos/acme/widgets/pulls/42/reviews?per_page=100',
        pages: [{ body: [{ id: 1, html_url: 'https://github.com/r/1', body: 'first', state: 'COMMENTED' }] }, { body: [{ id: 2, html_url: 'https://github.com/r/2', body: null }] }],
      },
    ]);
    assert.deepEqual(listReviews(gh, target), [
      { id: 1, url: 'https://github.com/r/1', body: 'first' },
      { id: 2, url: 'https://github.com/r/2', body: '' },
    ]);
  });

  it('lists every page of the comments of one review', (t) => {
    const { gh } = fakeGhWith(t, [{ endpoint: 'repos/acme/widgets/pulls/42/reviews/9/comments?per_page=100', pages: [{ body: [{ id: 5, html_url: 'https://github.com/c/5', body: 'on a line', line: null }] }] }]);
    assert.deepEqual(listReviewComments(gh, target, 9), [{ id: 5, url: 'https://github.com/c/5', body: 'on a line' }]);
  });

  it('posts one review whose event is COMMENT, each comment on the right side of its line', (t) => {
    const { gh, script } = fakeGhWith(t, [{ method: 'POST', endpoint: 'repos/acme/widgets/pulls/42/reviews', pages: [{ body: { id: 77, html_url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-77', body: 'the body' } }] }]);
    const posted = postReview(gh, target, { commit: head, body: 'the body', comments: [{ path: 'src/a.ts', line: 3, body: 'a comment' }] });
    assert.deepEqual(posted, { id: 77, url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-77' });
    const [call] = fakeGhCalls(script);
    assert.deepEqual(call?.args, ['api', '--include', '-X', 'POST', '--hostname', 'github.com', '--input', '-', 'repos/acme/widgets/pulls/42/reviews']);
    assert.deepEqual(JSON.parse(call.stdin), { commit_id: head, body: 'the body', event: 'COMMENT', comments: [{ path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'a comment' }] });
  });

  it("gives GitHub's refusal of a post with its status and message", (t) => {
    const { gh } = fakeGhWith(t, [{ method: 'POST', endpoint: 'repos/acme/widgets/pulls/42/reviews', pages: [{ status: 422, body: { message: 'Unprocessable Entity', errors: ['Line must be part of the diff'] } }] }]);
    const error = thrown(() => postReview(gh, target, { commit: head, body: 'b', comments: [] }), GitHubCallError);
    assert.deepEqual(error.failure, { kind: 'answer', status: 422, headers: (error.failure as { headers: unknown }).headers, message: 'Unprocessable Entity: Line must be part of the diff', bodies: [{ message: 'Unprocessable Entity', errors: ['Line must be part of the diff'] }] });
  });
});

describe('impliedPaths and pathDifference', () => {
  const file = (path: string, status: PullRequestFile['status'], previousPath: string | null = null): Pick<PullRequestFile, 'path' | 'status' | 'previousPath'> => ({ path, status, previousPath });

  it('implies each path by its status, as git diff --no-renames lists them', () => {
    const files = [
      file('added.ts', 'added'),
      file('modified.ts', 'modified'),
      file('removed.ts', 'removed'),
      file('new-name.ts', 'renamed', 'old-name.ts'),
      file('copy.ts', 'copied', 'original.ts'),
      file('mode.sh', 'changed'),
      file('same.ts', 'unchanged'),
    ];
    assert.deepEqual(impliedPaths(files), ['added.ts', 'copy.ts', 'mode.sh', 'modified.ts', 'new-name.ts', 'old-name.ts', 'removed.ts']);
  });

  it('finds no difference when the change holds the same paths in any order', () => {
    assert.equal(pathDifference([file('b', 'added'), file('a', 'renamed', 'z')], ['z', 'b', 'a']), null);
  });

  it('names the paths of each side that differ, up to ten, with how many there are', () => {
    const many = Array.from({ length: 12 }, (_, index) => `extra-${String(index).padStart(2, '0')}`);
    const difference = pathDifference([file('shared', 'modified'), file('missing', 'added')], ['shared', ...many]);
    assert.deepEqual(difference, { onGitHub: ['missing'], onGitHubCount: 1, inChange: many.slice(0, 10), inChangeCount: 12 });
  });

  it('holds the previous path of a copy as no path of the change', () => {
    assert.deepEqual(pathDifference([file('copy.ts', 'copied', 'original.ts')], ['copy.ts', 'original.ts']), { onGitHub: [], onGitHubCount: 0, inChange: ['original.ts'], inChangeCount: 1 });
  });
});

describe('newLinesOf', () => {
  it('gives the new lines of a hunk, added or context, and none for a deleted line', () => {
    const patch = '@@ -10,4 +10,4 @@ function f() {\n context one\n-removed\n+added\n context two\n context three';
    assert.deepEqual([...newLinesOf(patch)!], [[10, 'context'], [11, 'added'], [12, 'context'], [13, 'context']]);
  });

  it('reads an omitted count as 1', () => {
    assert.deepEqual([...newLinesOf('@@ -3 +3 @@\n-old\n+new')!], [[3, 'added']]);
  });

  it('reads every hunk, past a line that says a file has no newline at its end', () => {
    const patch = '@@ -1,2 +1,3 @@\n a\n+b\n c\n@@ -20,2 +21,1 @@\n-x\n y\n\\ No newline at end of file';
    assert.deepEqual([...newLinesOf(patch)!], [[1, 'context'], [2, 'added'], [3, 'context'], [21, 'context']]);
  });

  it('gives every line of a new file as added, and none for a deleted file', () => {
    assert.deepEqual([...newLinesOf('@@ -0,0 +1,2 @@\n+one\n+two')!], [[1, 'added'], [2, 'added']]);
    assert.deepEqual([...newLinesOf('@@ -1,2 +0,0 @@\n-one\n-two')!], []);
  });

  it('gives null for a file with no patch', () => {
    assert.equal(newLinesOf(null), null);
  });
});
