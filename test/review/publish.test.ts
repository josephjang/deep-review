import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { main } from '../../src/command.ts';
import { cloneConfigPath, operatorConfigPath } from '../../src/config/files.ts';
import { dedicatedFlagValues } from '../../src/config/flags.ts';
import { flagLayerOf, parseSetFlag } from '../../src/config/resolve.ts';
import { configurationSource } from '../../src/config/source.ts';
import type { PublishPosted, PublishPrepared } from '../../src/checkpoint/events.ts';
import { GitHubCallError } from '../../src/github/errors.ts';
import type { Gh } from '../../src/github/gh.ts';
import { resolvePullRequestScope, type ReviewOptions, type ReviewOutcome, type ScopeSource } from '../../src/review/controller.ts';
import { flagCheckSettings } from '../../src/review/checks/discover.ts';
import { captureScope } from '../../src/scope/capture.ts';
import { PublicationOpenError, ReviewRefusedError } from '../../src/review/errors.ts';
import { acquireRunLock, acquireStartLock } from '../../src/review/lock.ts';
import { findingMarker, lastLineMarker, publicationMarker } from '../../src/review/markers.ts';
import { publishRun, type PublishOptions, type PublishOutcome } from '../../src/review/publish.ts';
import { refreshReportCopy } from '../../src/review/report-copy.ts';
import { describeRun } from '../../src/review/status.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { fakeGh, fakeGhCalls, fakeGhHeld, fakeGhWith, type FakeGhStep } from '../helpers/fake-gh.ts';
import type { Script } from '../helpers/fake-runtime.ts';
import { fixingReviewScript, reviewScript } from '../helpers/fix-pass-fixture.ts';
import { fakeClaude } from '../helpers/launcher.ts';
import { git } from '../helpers/repository.ts';
import { cliEntry, reportText, ReviewSandbox, sandboxConcurrency } from '../helpers/review-sandbox.ts';

/** The commits of the sandbox's change: the head of the pull request, and the merge base. */
const commitsOf = (box: ReviewSandbox): { head: string; base: string } => ({ head: git(box.repo, 'rev-parse', 'HEAD'), base: git(box.repo, 'rev-parse', 'HEAD~1') });

/** The head of the base branch that GitHub gives. */
const baseHead = 'd'.repeat(40);

/** The files GitHub lists for the sandbox's change, with their patches: every line of src/a.ts but its third and of src/b.ts added, so SCAN-1 at src/a.ts:2 and SCAN-2 at src/b.ts:1 go on their lines. */
const patchedFiles = [
  { filename: 'src/a.ts', status: 'modified', patch: '@@ -1,3 +1,7 @@\n-export function parse(text: string) {\n-  return text.length;\n+export function parse(text: string | null) {\n+  return text!.length;\n }\n+\n+export function other() {\n+  return parse(null);\n+}' },
  { filename: 'src/b.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+export const b = parse("x");' },
  { filename: 'src/gone.ts', status: 'removed', patch: '@@ -1 +0,0 @@\n-export const gone = 1;' },
];

/** Pull request #42 as GitHub answers it, of the sandbox's change unless `overrides` says otherwise. */
const pullRequestBody = (head: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  html_url: 'https://github.com/acme/widgets/pull/42',
  number: 42,
  state: 'open',
  merged: false,
  head: { sha: head },
  base: { ref: 'main' },
  changed_files: patchedFiles.length,
  title: 'Parse with a guard',
  body: 'Why the parser needs a guard.',
  ...overrides,
});

/** What `gh` answers when `review --pr 42` reads the pull request, by its number. */
function reviewSteps(box: ReviewSandbox): FakeGhStep[] {
  const { head, base } = commitsOf(box);
  return [
    { endpoint: 'repos/{owner}/{repo}/pulls/42', pages: [{ body: pullRequestBody(head) }] },
    { endpoint: 'repos/acme/widgets/git/ref/heads/main', pages: [{ body: { object: { sha: baseHead } } }] },
    { endpoint: `repos/acme/widgets/compare/${baseHead}...${head}`, pages: [{ body: { merge_base_commit: { sha: base } } }] },
    { endpoint: 'repos/acme/widgets/pulls/42/files?per_page=100', pages: [{ body: patchedFiles }] },
  ];
}

/** The scope of `review --pr 42`, with `paths`, read through `gh`. */
const pullRequestSource = (box: ReviewSandbox, gh: Gh, paths: string[] = []): ScopeSource => ({
  named: true,
  pullRequest: true,
  choice: () => ({ mode: 'pull-request', request: { pullRequest: { number: 42, repository: null }, paths } }),
  request: () => resolvePullRequestScope(box.repo, { pullRequest: { number: 42, repository: null }, paths }, gh),
});

/** How `publish` meets the pull request: as it was reviewed, unless `change` says otherwise, and the post as `post` answers it. */
interface PublishScript {
  readonly pullRequest?: Record<string, unknown>;
  readonly mergeBase?: string;
  readonly post?: Partial<FakeGhStep>;
}

/** What `gh` answers when `publish` posts the review of pull request #42: the pull request by its URL, the head of its base branch, the merge base, its files, the post, and what GitHub holds after it. */
function publishSteps(box: ReviewSandbox, change: PublishScript = {}): FakeGhStep[] {
  const { head, base } = commitsOf(box);
  return [
    { endpoint: 'repos/acme/widgets/pulls/42', pages: [{ body: pullRequestBody(head, change.pullRequest) }] },
    { endpoint: 'repos/acme/widgets/git/ref/heads/main', pages: [{ body: { object: { sha: baseHead } } }] },
    { endpoint: `repos/acme/widgets/compare/${baseHead}...${head}`, pages: [{ body: { merge_base_commit: { sha: change.mergeBase ?? base } } }] },
    { endpoint: 'repos/acme/widgets/pulls/42/files?per_page=100', pages: [{ body: patchedFiles }] },
    { method: 'POST', endpoint: 'repos/acme/widgets/pulls/42/reviews', held: true, ...change.post },
    { endpoint: 'repos/acme/widgets/pulls/42/reviews?per_page=100', held: true },
    { endpoint: 'repos/acme/widgets/pulls/42/reviews/1/comments?per_page=100', held: true },
  ];
}

/** A sandbox whose read-only run of pull request #42 reviewed `reviewScript` to its report, with `paths` when given. */
async function reviewed(t: TestContext, paths: string[] = [], script: Script = reviewScript): Promise<ReviewSandbox> {
  const box = ReviewSandbox.forTest(t, script);
  const { gh } = fakeGhWith(t, [...reviewSteps(box), ...reviewSteps(box)]);
  reportText(await box.review('claude', { scope: pullRequestSource(box, gh, paths) }));
  return box;
}

/** A `gh` for `publish` whose script `steps` gives, sharing the script of `held`, the one that holds what was posted, when given. */
function publishGh(t: TestContext, steps: readonly FakeGhStep[], held?: { readonly script: string }, timeoutMs?: number): { gh: Gh; script: string } {
  const made = fakeGhWith(t, steps, timeoutMs);
  if (held === undefined) return made;
  // The reviews GitHub holds stay across the commands of one test, as GitHub keeps them.
  writeFileSync(`${made.script}.held`, JSON.stringify(fakeGhHeld(held.script)));
  return made;
}

/** Publish the run of `box` with `gh`, the lines it logs gathered. */
function publishWith(box: ReviewSandbox, gh: Gh | (() => Gh), change: Partial<PublishOptions> = {}): { outcome: PublishOutcome; logs: string[] } {
  const logs: string[] = [];
  const outcome = publishRun({ checkpoint: box.checkpoint, worktree: box.repo, gitCommon: join(box.repo, '.git'), gh: typeof gh === 'function' ? gh : () => gh, engineEntry: cliEntry, environment: {}, log: (line) => logs.push(line), ...change });
  return { outcome, logs };
}

/** The refusal `act` throws, which must say `message`. */
function refused(act: () => unknown, message: RegExp): void {
  assert.throws(act, (error: unknown) => error instanceof ReviewRefusedError && message.test(error.message));
}

/** The events of the run of `publish`, as kind and payload. */
const publications = (box: ReviewSandbox): [string, Record<string, unknown>][] => box.events(box.run().id).filter(([kind]) => kind.startsWith('publish.'));

/** The calls of a script that write to GitHub. */
const writes = (script: string): number => fakeGhCalls(script).filter((call) => call.args.includes('POST')).length;

const reviewUrl = 'https://github.com/acme/widgets/pull/42#pullrequestreview-1';

// R7, R8, R13, R14 of the review on the pull request, and "Publish" of its design.
describe('publish', { timeout: 900_000, concurrency: sandboxConcurrency }, () => {
  it('posts one review, a comment on the head the run reviewed, with a comment on the line of each fix, records it before the post and after, names it in the report and status, and posts nothing the second time', async (t) => {
    const box = await reviewed(t);
    const { gh, script } = publishGh(t, publishSteps(box));
    const runId = box.run().id;
    let locks: string[] = [];
    let copy = '';
    const { outcome, logs } = publishWith(box, gh, {
      beforePost: () => {
        // The start lock is free once the run's lock is held, and the run's lock is held through the post.
        acquireStartLock(box.checkpoint.root)();
        assert.throws(() => acquireRunLock(box.checkpoint.root, runId), (error: unknown) => error instanceof ReviewRefusedError && error.code === 'lock-held');
        locks = ['start lock free', 'run lock held'];
      },
      refreshCopy: (run) => {
        copy = readFileSync(refreshReportCopy(box.checkpoint, run, { engineEntry: cliEntry, adapter: claudeAdapter, continueRoles: () => null }, () => {})!, 'utf8');
      },
    });
    assert.deepEqual(locks, ['start lock free', 'run lock held']);
    assert.deepEqual(outcome, { kind: 'posted', runId, url: reviewUrl, how: 'posted', comments: 2 });
    assert.deepEqual(logs, []);
    // GitHub holds one review, a comment on the head, with a comment on the line of each fix, each marked on its last line.
    const { head } = commitsOf(box);
    const [held, ...more] = fakeGhHeld(script);
    assert.deepEqual(more, []);
    assert.deepEqual([held!.event, held!.commit, lastLineMarker(held!.body)], ['COMMENT', head, publicationMarker(runId, 1)]);
    assert.deepEqual(held!.comments.map((comment) => [comment.path, comment.line, lastLineMarker(comment.body)]), [['src/a.ts', 2, findingMarker(runId, 'SCAN-1')], ['src/b.ts', 1, findingMarker(runId, 'SCAN-2')]]);
    // The ledger records the publication with what was sent frozen, then the review and each comment matched by its marker.
    const events = publications(box);
    assert.deepEqual(events.map(([kind]) => kind), ['publish.prepared', 'publish.posted']);
    const prepared = events[0]![1] as PublishPrepared;
    const post = fakeGhCalls(script).find((call) => call.args.includes('POST'))!;
    assert.equal(box.checkpoint.evidence.read(prepared.payload).toString('utf8'), post.stdin, 'the frozen payload is what was posted');
    assert.deepEqual([prepared.marker, prepared.target, prepared.commit], [publicationMarker(runId, 1), { host: 'github.com', owner: 'acme', repository: 'widgets', number: 42 }, head]);
    assert.deepEqual(prepared.places, [{ finding: 'SCAN-1', place: 'line', reason: 'on-the-diff' }, { finding: 'SCAN-2', place: 'line', reason: 'on-the-diff' }, { finding: 'SWEEP-1', place: 'body', reason: 'left' }]);
    const posted = events[1]![1] as PublishPosted;
    assert.deepEqual(posted.review, { id: 1, url: reviewUrl });
    assert.deepEqual(posted.comments, [
      { finding: 'SCAN-1', comment: { id: 1001, url: 'https://github.com/acme/widgets/pull/42#discussion_r1001' } },
      { finding: 'SCAN-2', comment: { id: 1002, url: 'https://github.com/acme/widgets/pull/42#discussion_r1002' } },
    ]);
    // "About this run" and status name the review (R6).
    assert.match(copy, /^Pull request: https:\/\/github\.com\/acme\/widgets\/pull\/42\nReview: https:\/\/github\.com\/acme\/widgets\/pull\/42#pullrequestreview-1$/m);
    const described = describeRun(box.run(), claudeAdapter, (reference) => box.checkpoint.evidence.pathOf(reference));
    assert.ok(described.lines.includes(`Review: ${reviewUrl}`), described.lines.join('\n'));
    assert.equal(described.json.postedReview, reviewUrl);
    // A run posted is posted once: the second publish prints its URL and calls GitHub not at all.
    const calls = fakeGhCalls(script).length;
    const again = publishWith(box, () => assert.fail('a posted run calls no gh'));
    assert.deepEqual(again.outcome, { kind: 'posted', runId, url: reviewUrl, how: 'earlier', comments: 2 });
    assert.equal(fakeGhCalls(script).length, calls);
    assert.equal(publications(box).length, 2);
  });

  it('prints in a dry run the body, each comment with its path and line, and the place of each finding, making no write call and recording nothing', async (t) => {
    const box = await reviewed(t);
    const { gh, script } = publishGh(t, publishSteps(box));
    const { outcome } = publishWith(box, gh, { dryRun: true });
    assert.equal(outcome.kind, 'dry-run');
    const text = outcome.kind === 'dry-run' ? outcome.lines.join('\n') : '';
    const runId = box.run().id;
    assert.ok(text.startsWith(`Dry run: run ${runId} would post one review to https://github.com/acme/widgets/pull/42, on its head ${commitsOf(box).head}; nothing is posted or recorded.\nWhere each finding goes:\n- 1 (SCAN-1): a comment on src/a.ts:2\n- 2 (SCAN-2): a comment on src/b.ts:1\n- 3 (SWEEP-1): in the body, left as is (src/a.ts:5)\nCut from the body to fit: nothing.\nSecrets replaced by the cleaning: 0.\n`), text);
    assert.match(text, /^--- The body of the review, \d+ characters ---\n## deep-review's review of this pull request/m);
    assert.ok(text.includes(`<!-- ${publicationMarker(runId, 1)} -->\n--- The end of the body ---`), text);
    assert.match(text, /^--- The comment of finding 1 \(SCAN-1\) on src\/a\.ts:2, \d+ characters ---$/m);
    assert.match(text, /^--- The comment of finding 2 \(SCAN-2\) on src\/b\.ts:1, \d+ characters ---$/m);
    assert.equal(writes(script), 0, 'no write call');
    assert.deepEqual(fakeGhCalls(script).map((call) => call.args.at(-1)), ['repos/acme/widgets/pulls/42', 'repos/acme/widgets/git/ref/heads/main', `repos/acme/widgets/compare/${baseHead}...${commitsOf(box).head}`, 'repos/acme/widgets/pulls/42/files?per_page=100']);
    assert.deepEqual(publications(box), []);
  });

  it('leaves the publication open with exit 1 on a timeout; a dry run says the next publish records it as not found, and the next publish does, then posts once', async (t) => {
    const box = await reviewed(t);
    const runId = box.run().id;
    const hung = publishGh(t, publishSteps(box, { post: { hang: true } }), undefined, 10_000);
    assert.throws(() => publishWith(box, hung.gh), (error: unknown) => error instanceof PublicationOpenError && error.message.includes(`gh did not finish within 10 s and was ended; GitHub may have made the review or not, so the publication ${publicationMarker(runId, 1)} stays open`));
    assert.deepEqual(publications(box).map(([kind]) => kind), ['publish.prepared']);
    // A dry run settles nothing: it says what the next publish records, and goes on as if the publication were dropped.
    const dry = publishGh(t, publishSteps(box), hung);
    const { outcome } = publishWith(box, dry.gh, { dryRun: true });
    const text = outcome.kind === 'dry-run' ? outcome.lines.join('\n') : '';
    assert.ok(text.includes(`run ${runId}: no review of the pull request carries the marker of the publication ${publicationMarker(runId, 1)}, which a stop left open; the next deep-review publish records it as not found and posts the review below.`), text);
    assert.ok(text.includes(`<!-- ${publicationMarker(runId, 2)} -->`), 'the review below is the second publication');
    assert.equal(writes(dry.script), 0);
    assert.deepEqual(publications(box).map(([kind]) => kind), ['publish.prepared']);
    // The next publish records it as not found and posts once.
    const next = publishGh(t, publishSteps(box), hung);
    const posted = publishWith(box, next.gh);
    assert.deepEqual(posted.outcome, { kind: 'posted', runId, url: reviewUrl, how: 'posted', comments: 2 });
    assert.ok(posted.logs.includes(`run ${runId}: no review of the pull request carries the marker of the publication ${publicationMarker(runId, 1)}, which a stop left open; it is recorded as not found, and the review is posted now`), posted.logs.join('\n'));
    assert.deepEqual(publications(box).map(([kind, payload]) => [kind, payload.marker, payload.reason]), [['publish.prepared', publicationMarker(runId, 1), undefined], ['publish.dropped', publicationMarker(runId, 1), 'not-found'], ['publish.prepared', publicationMarker(runId, 2), undefined], ['publish.posted', publicationMarker(runId, 2), undefined]]);
    assert.equal(fakeGhHeld(next.script).length, 1, 'GitHub holds one review of the run');
  });

  it('leaves the publication open with exit 1 on a 5xx; a dry run names the review that carries its marker, and the next publish records it as posted, its comments matched by their markers, posting nothing', async (t) => {
    const box = await reviewed(t);
    const runId = box.run().id;
    // GitHub made the review, and answered 502.
    const failed = publishGh(t, publishSteps(box, { post: { pages: [{ status: 502, body: { message: 'Server Error' } }] } }));
    assert.throws(() => publishWith(box, failed.gh), (error: unknown) => error instanceof PublicationOpenError && /GitHub answered 502: Server Error; GitHub may have made the review or not/.test(error.message));
    assert.equal(fakeGhHeld(failed.script).length, 1);
    const dry = publishGh(t, publishSteps(box), failed);
    const { outcome } = publishWith(box, dry.gh, { dryRun: true });
    assert.deepEqual(outcome, { kind: 'dry-run', runId, lines: [`run ${runId}: the publication ${publicationMarker(runId, 1)}, which a stop left open, is on the pull request as ${reviewUrl}; the next deep-review publish records it as posted, with 2 comments, and posts nothing.`, reviewUrl] });
    assert.deepEqual(publications(box).map(([kind]) => kind), ['publish.prepared']);
    const next = publishGh(t, publishSteps(box), failed);
    const settled = publishWith(box, next.gh);
    assert.deepEqual(settled.outcome, { kind: 'posted', runId, url: reviewUrl, how: 'settled', comments: 2 });
    assert.equal(writes(next.script) + writes(dry.script), 0, 'posted nothing');
    const posted = publications(box).at(-1)!;
    assert.equal(posted[0], 'publish.posted');
    assert.deepEqual((posted[1] as PublishPosted).comments.map((entry) => entry.finding), ['SCAN-1', 'SCAN-2']);
    assert.equal(fakeGhHeld(next.script).length, 1);
  });

  it('records a refusal of GitHub as not posted, with its status and message, and names the action of each status: the message of a 422, the wait of a 403 or 429 with retry-after or with no requests left, the account of a 401 or 404, and the token of a 403 with neither', async (t) => {
    const box = await reviewed(t);
    const runId = box.run().id;
    const cases: [Partial<FakeGhStep>, RegExp][] = [
      [{ held: false, pages: [{ status: 422, body: { message: 'Unprocessable Entity', errors: ['Line must be part of the diff'] } }] }, /GitHub refused the review of pull request #42 of acme\/widgets with 422: Unprocessable Entity: Line must be part of the diff; nothing was posted, and the publication deep-review publication \S+ 1 is recorded as not posted; answer what GitHub says/],
      [{ held: false, pages: [{ status: 403, headers: { 'Retry-After': '60' }, body: { message: 'You have exceeded a secondary rate limit' } }] }, /with 403: You have exceeded a secondary rate limit; .*; GitHub limits how fast an account posts; wait 60 seconds and run deep-review publish again$/],
      [{ held: false, pages: [{ status: 429, headers: { 'Retry-After': '30' }, body: { message: 'Too Many Requests' } }] }, /wait 30 seconds and run deep-review publish again$/],
      [{ held: false, pages: [{ status: 404, body: { message: 'Not Found' } }] }, /run `gh auth login --hostname github\.com`, or set GH_TOKEN with an account that can write to pull request #42 of acme\/widgets/],
      [{ held: false, pages: [{ status: 403, headers: { 'X-RateLimit-Remaining': '4999' }, body: { message: 'Resource not accessible by integration' } }] }, /the account or the token that gh uses cannot write to pull request #42 of acme\/widgets, as the token of a workflow on a pull request from a fork cannot/],
      [{ held: false, pages: [{ status: 403, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1793620800' }, body: { message: 'API rate limit exceeded for installation ID 1' } }] }, /with 403: API rate limit exceeded for installation ID 1; .*; GitHub limits how many requests an account makes an hour; wait until 2026-11-02T12:00:00\.000Z and run deep-review publish again$/],
    ];
    for (const [post, message] of cases) {
      const { gh, script } = publishGh(t, publishSteps(box, { post }));
      refused(() => publishWith(box, gh), message);
      assert.equal(fakeGhHeld(script).length, 0);
    }
    const events = publications(box);
    assert.deepEqual(events.map(([kind, payload]) => [kind, payload.reason, payload.status]), cases.flatMap((_, index) => [['publish.prepared', undefined, undefined], ['publish.dropped', 'refused', [422, 403, 429, 404, 403, 403][index]]]));
    assert.equal(events[1]![1].message, 'Unprocessable Entity: Line must be part of the diff');
    assert.equal(events.at(-2)![1].marker, publicationMarker(runId, 6));
  });

  it('refuses a pull request that is closed or merged, a head that moved, a merge base that moved, gh that is missing and gh with no account, posting nothing and recording nothing', async (t) => {
    const box = await reviewed(t);
    const { head, base } = commitsOf(box);
    const cases: [readonly FakeGhStep[], RegExp][] = [
      [publishSteps(box, { pullRequest: { state: 'closed' } }), /^pull request #42 of acme\/widgets is closed, and deep-review posts to an open pull request only/],
      [publishSteps(box, { pullRequest: { state: 'closed', merged: true } }), /is merged, and deep-review posts to an open pull request only/],
      [publishSteps(box, { pullRequest: { head: { sha: 'e'.repeat(40) } } }), new RegExp(`^the head of pull request #42 of acme/widgets is ${'e'.repeat(40)} now, not ${head}, .*gh pr checkout 42.*deep-review review --pr 42$`)],
      [publishSteps(box, { mergeBase: 'f'.repeat(40) }), new RegExp(`^the merge base of pull request #42 of acme/widgets with its base branch main is ${'f'.repeat(40)} now, not ${base}, `)],
      [[{ endpoint: 'repos/acme/widgets/pulls/42', noAccount: true }], /gh has no account for github\.com; run `gh auth login --hostname github\.com`, or set GH_TOKEN/],
    ];
    for (const [steps, message] of cases) {
      const { gh, script } = publishGh(t, steps);
      refused(() => publishWith(box, gh), message);
      assert.equal(writes(script), 0);
    }
    const missing = { executable: join(box.directory, 'no-gh'), args: [], cwd: box.repo };
    refused(() => publishWith(box, missing), /could not be started .*install the GitHub CLI, gh, or set github\.executable to its path/);
    assert.deepEqual(publications(box), []);
  });

  it('refuses a 404 of the head of the base branch or of the comparison as a branch or a commit GitHub no longer has, not as an account that cannot read the pull request', async (t) => {
    const box = await reviewed(t);
    const notFound = (endpoint: string): FakeGhStep[] => publishSteps(box).map((step) => (step.endpoint.startsWith(endpoint) ? { ...step, pages: [{ status: 404, body: { message: 'Not Found' } }] } : step));
    const action = /; the base branch main or a commit of its comparison with the head is no longer on GitHub; review the pull request again with deep-review review --pr 42; nothing was posted or recorded$/;
    const cases: [readonly FakeGhStep[], RegExp][] = [
      [notFound('repos/acme/widgets/git/ref/heads/'), new RegExp(`^reading the head of branch main: GitHub answered 404: Not Found${action.source}`)],
      [notFound('repos/acme/widgets/compare/'), new RegExp(`^comparing ${baseHead} with ${commitsOf(box).head}: GitHub answered 404: Not Found${action.source}`)],
    ];
    for (const [steps, message] of cases) {
      const { gh, script } = publishGh(t, steps);
      refused(() => publishWith(box, gh), message);
      assert.equal(writes(script), 0);
    }
    assert.deepEqual(publications(box), []);
  });

  it('ends a 5xx of a read before the post with exit 1, not a refusal, saying nothing was posted or recorded', async (t) => {
    const box = await reviewed(t);
    const failing = (endpoint: string, status: number): FakeGhStep[] => publishSteps(box).map((step) => (step.endpoint === endpoint ? { ...step, pages: [{ status, body: { message: 'Bad Gateway' } }] } : step));
    for (const steps of [failing('repos/acme/widgets/pulls/42', 502), failing('repos/acme/widgets/pulls/42/files?per_page=100', 503)]) {
      const { gh, script } = publishGh(t, steps);
      assert.throws(() => publishWith(box, gh), (error: unknown) => error instanceof GitHubCallError && !(error instanceof ReviewRefusedError) && /GitHub answered 50[23]: Bad Gateway; nothing was posted or recorded$/.test(error.message));
      assert.equal(writes(script), 0);
    }
    assert.deepEqual(publications(box), []);
  });

  it('says what a refusal after the settle recorded: that the publication a stop left open was not found', async (t) => {
    const box = await reviewed(t);
    const runId = box.run().id;
    const hung = publishGh(t, publishSteps(box, { post: { hang: true } }), undefined, 10_000);
    assert.throws(() => publishWith(box, hung.gh), PublicationOpenError);
    const closed = publishGh(t, publishSteps(box, { pullRequest: { state: 'closed' } }), hung);
    refused(() => publishWith(box, closed.gh), new RegExp(`is closed, and deep-review posts to an open pull request only; nothing was posted, and only that no review carries the publication ${publicationMarker(runId, 1)}, which a stop left open, was recorded$`));
    assert.deepEqual(publications(box).map(([kind, payload]) => [kind, payload.reason]), [['publish.prepared', undefined], ['publish.dropped', 'not-found']]);
    assert.equal(writes(closed.script), 0);
  });

  it('refuses, before any call of GitHub, a run with no current report, a run of another scope, and a run whose request names paths', async (t) => {
    const noGh = (): Gh => assert.fail('a refusal before GitHub resolves no gh');
    const blocked = ReviewSandbox.forTest(t, { triage: { exit: 2 } });
    const { gh } = fakeGhWith(t, reviewSteps(blocked));
    const outcome = await blocked.review('claude', { scope: pullRequestSource(blocked, gh) });
    assert.equal(outcome.kind, 'blocked');
    refused(() => publishWith(blocked, noGh, { runId: blocked.run().id }), /has no current report, since it is blocked \(\S+\); publish posts a finished run$/);
    refused(() => publishWith(blocked, noGh), /^no run of worktree .* has a report, so there is no review to post; the newest, run /);
    const other = ReviewSandbox.forTest(t, reviewScript);
    reportText(await other.review('claude'));
    refused(() => publishWith(other, noGh), /reviewed no pull request, so there is none to post its review to; review the pull request with deep-review review --pr <number>$/);
    const narrowed = await reviewed(t, ['src/a.ts', 'src/b.ts']);
    refused(() => publishWith(narrowed, noGh), /reviewed only the paths --path named \(src\/a\.ts, src\/b\.ts\), so its review could not say what it left out of the pull request; review the whole pull request with deep-review review --pr 42$/);
    for (const box of [blocked, other, narrowed]) assert.deepEqual(publications(box), []);
  });

  /** A sandbox whose `review --pr 42 --fix`, with `change`, reviewed the pull request, wrote the read-only report and continued the run into the fix pass, and what that command ended with. */
  async function continued(t: TestContext, script: Script, change: Partial<ReviewOptions> = {}): Promise<{ box: ReviewSandbox; outcome: ReviewOutcome }> {
    const box = ReviewSandbox.forTest(t, script);
    const { gh } = fakeGhWith(t, reviewSteps(box));
    const outcome = await box.fix('claude', { scope: pullRequestSource(box, gh), ...change });
    assert.notEqual(box.run().review!.continuedFrom, null, 'the run was continued into the fix pass');
    return { box, outcome };
  }

  it('posts the review of a run that review --pr --fix continued as the run stood at its read-only report, with the words of a run that went on to fix and no --fix, records it on the whole run, and posts nothing the second time (R5, R6 of the review of a fix run)', async (t) => {
    const { box, outcome } = await continued(t, fixingReviewScript);
    assert.equal(outcome.kind, 'report', 'the fix pass wrote its report');
    const runId = box.run().id;
    const dry = publishGh(t, publishSteps(box));
    const printed = publishWith(box, dry.gh, { dryRun: true }).outcome;
    const text = printed.kind === 'dry-run' ? printed.lines.join('\n') : '';
    // The findings go where they go in the review of the read-only run of the same head.
    assert.ok(text.startsWith(`Dry run: run ${runId} would post one review to https://github.com/acme/widgets/pull/42, on its head ${commitsOf(box).head}; nothing is posted or recorded.\nWhere each finding goes:\n- 1 (SCAN-1): a comment on src/a.ts:2\n- 2 (SCAN-2): a comment on src/b.ts:1\n- 3 (SWEEP-1): in the body, left as is (src/a.ts:5)\n`), text);
    assert.ok(text.includes('. It then went on to fix the findings it decided to fix, in the fix pass of its own run on the machine of the person who ran the review; those edits are not part of this review'), text);
    assert.ok(text.includes('What its fix pass changed reaches this branch only when the person who ran the review pushes it.'), text);
    for (const gone of ['changed no file', '--fix', 'deep-review fixed this']) assert.ok(!text.includes(gone), `no ${gone}`);
    assert.equal(writes(dry.script), 0);
    const { gh, script } = publishGh(t, publishSteps(box));
    assert.deepEqual(publishWith(box, gh).outcome, { kind: 'posted', runId, url: reviewUrl, how: 'posted', comments: 2 });
    const [held] = fakeGhHeld(script);
    assert.ok(held!.body.includes('It then went on to fix the findings it decided to fix') && !held!.body.includes('--fix'), held!.body);
    // The publication is recorded on the whole run, after its fix report.
    const kinds = box.events(runId).map(([kind]) => kind);
    assert.ok(kinds.lastIndexOf('report.written') < kinds.indexOf('publish.prepared'), kinds.join(', '));
    assert.deepEqual(publications(box).map(([kind]) => kind), ['publish.prepared', 'publish.posted']);
    const again = publishWith(box, () => assert.fail('a posted run calls no gh'));
    assert.deepEqual(again.outcome, { kind: 'posted', runId, url: reviewUrl, how: 'earlier', comments: 2 });
  });

  it('chooses with no --run a run whose fix pass blocked, since its review is finished, and refuses it once it is abandoned in its fix pass (R5 of the review of a fix run)', async (t) => {
    // No flag settles a check, so the continuation asks the surveyor again for the checks, and it fails twice.
    const { box, outcome } = await continued(t, { ...fixingReviewScript, surveyor: [{}, { exit: 2 }] }, { fix: flagCheckSettings({}, []) });
    assert.equal(outcome.kind, 'blocked');
    const runId = box.run().id;
    const { gh } = publishGh(t, publishSteps(box));
    const printed = publishWith(box, gh, { dryRun: true }).outcome;
    assert.equal(printed.runId, runId, 'the run whose fix pass blocked is chosen');
    assert.ok(printed.kind === 'dry-run' && printed.lines.join('\n').includes('It then went on to fix the findings it decided to fix'), JSON.stringify(printed));
    box.checkpoint.append(runId, box.run().lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'the fixes went another way' } }]);
    refused(() => publishWith(box, () => assert.fail('a refusal before GitHub resolves no gh')), new RegExp(`^run ${runId} was abandoned in its fix pass, and an abandoned run records nothing more, so its review cannot be recorded as posted; review the pull request again with deep-review review --pr 42$`));
    assert.deepEqual(publications(box), []);
  });

  it('refuses a fix run that reviewed and fixed in one pass, as an engine before this one ran review --pr --fix, naming the command that reviews the pull request again (R7 of the review of a fix run)', async (t) => {
    const box = ReviewSandbox.forTest(t, { triage: { exit: 2 } });
    // The configuration of a fix run, taken from a fix run of the last commit that blocked at its triage.
    assert.equal((await box.fix('claude')).kind, 'blocked');
    const stand = box.run();
    const pinned = box.events(stand.id).find(([kind]) => kind === 'review.configured')![1];
    box.checkpoint.append(stand.id, stand.lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'stand in for an older engine' } }]);
    // A run of pull request #42 with the fix pass from its start, which the next command resumes to its report.
    const { gh } = fakeGhWith(t, reviewSteps(box));
    const requested = pullRequestSource(box, gh).request();
    const { id } = box.checkpoint.createRun({ worktree: box.repo });
    box.checkpoint.append(id, captureScope(box.checkpoint, id, requested.request, { pullRequest: requested.pullRequest! }).lastSequence, [{ kind: 'review.configured', version: 9, payload: pinned }]);
    box.script(fixingReviewScript);
    reportText(await box.fix('claude'));
    assert.equal(box.checkpoint.fold(id).review!.continuedFrom, null, 'a fix run from its start');
    refused(() => publishWith(box, () => assert.fail('a refusal before GitHub resolves no gh'), { runId: id }), new RegExp(`^run ${id} reviewed and fixed in one pass, as an engine before this one ran review --pr --fix, so it holds no review written for a reader of the pull request; review the pull request again with deep-review review --pr 42, with or without --fix$`));
    assert.deepEqual(box.events(id).filter(([kind]) => kind.startsWith('publish.')), []);
  });

  it('runs gh as the operator\'s file names it now and posts in the language the run recorded, after the file changes (R15, R20)', async (t) => {
    const box = ReviewSandbox.forTest(t, reviewScript);
    const environment: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(box.directory, 'xdg'), APPDATA: join(box.directory, 'appdata') };
    const operator = operatorConfigPath(environment, process.platform)!;
    mkdirSync(dirname(operator), { recursive: true });
    writeFileSync(operator, 'schema = 1\nreview.language = "ko"\n');
    const flags = flagLayerOf([
      ...dedicatedFlagValues({ runtime: 'claude', policy: {}, checks: null, executableArgs: [fakeClaude] }),
      parseSetFlag(`github.executable=${JSON.stringify(process.execPath)}`),
      parseSetFlag(`github.args=[${JSON.stringify(join(box.directory, 'moved', 'gh.ts'))}]`),
    ]);
    const configuration = configurationSource({ worktree: box.repo, locations: { operator, clone: cloneConfigPath(join(box.repo, '.git')), invocation: null }, repositoryConfig: true, flags });
    const reading = fakeGhWith(t, reviewSteps(box));
    reportText(await box.review('claude', { scope: pullRequestSource(box, reading.gh), configuration }));
    const recorded = box.run().review!.configuration.settings!.values;
    assert.ok('github.args' in recorded && recorded['github.args'][0] === join(box.directory, 'moved', 'gh.ts'), 'the run recorded the gh that is gone by the post');
    writeFileSync(operator, `schema = 1\nreview.language = "en"\ngithub.executable = ${JSON.stringify(process.execPath)}\ngithub.args = [${JSON.stringify(fakeGh)}]\n`);
    const { script } = fakeGhWith(t, publishSteps(box));
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(['publish', '--dry-run', '--repo', box.repo], { stdout: (text) => out.push(text), stderr: (text) => err.push(text), environment: { ...environment, FAKE_GH_SCRIPT: script }, cwd: box.repo, engineEntry: cliEntry });
    assert.equal(code, 0, err.join(''));
    const text = out.join('');
    assert.ok(text.includes('## deep-review의 풀 리퀘스트 리뷰\n'), text);
    assert.equal(fakeGhCalls(script).length, 4, 'the gh the operator\'s file names now read the pull request, the head of its base branch, the merge base and the files');
    assert.equal(writes(script), 0);
  });
});
