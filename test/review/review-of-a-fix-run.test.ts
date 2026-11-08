import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import type { Gh } from '../../src/github/gh.ts';
import { resolvePullRequestScope, type ScopeSource } from '../../src/review/controller.ts';
import { reviewStatus } from '../../src/review/state.ts';
import type { NamedScope } from '../../src/scope/capture.ts';
import { fakeGhCalls, fakeGhWith, type FakeGhStep } from '../helpers/fake-gh.ts';
import { fixerAnswer, type Script } from '../helpers/fake-runtime.ts';
import { fixedA, fixedB, reviewScript } from '../helpers/fix-pass-fixture.ts';
import { git } from '../helpers/repository.ts';
import { reportText, ReviewSandbox, sandboxConcurrency } from '../helpers/review-sandbox.ts';

/** The review of fix-pass-fixture.ts, which decides two fixes and leaves one finding, with a fixer for each of its two clusters. */
const fixingScript: Script = {
  ...reviewScript,
  'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'] }]) },
  'fixer:fixes:c2-1': { edits: [{ writes: { 'src/b.ts': fixedB }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/b.ts'] }]) },
};

/** What `gh` answers for pull request #42 of the sandbox's change, once: the pull request, the head of its base branch, the merge base and its files. */
function pullRequestSteps(box: ReviewSandbox): FakeGhStep[] {
  const head = git(box.repo, 'rev-parse', 'HEAD');
  const base = git(box.repo, 'rev-parse', 'HEAD~1');
  const baseHead = 'd'.repeat(40);
  return [
    { endpoint: 'repos/{owner}/{repo}/pulls/42', pages: [{ body: { html_url: 'https://github.com/acme/widgets/pull/42', number: 42, state: 'open', merged: false, head: { sha: head }, base: { ref: 'main' }, changed_files: 3, title: 'Parse with a guard', body: null } }] },
    { endpoint: 'repos/acme/widgets/git/ref/heads/main', pages: [{ body: { object: { sha: baseHead } } }] },
    { endpoint: `repos/acme/widgets/compare/${baseHead}...${head}`, pages: [{ body: { merge_base_commit: { sha: base } } }] },
    { endpoint: 'repos/acme/widgets/pulls/42/files?per_page=100', pages: [{ body: [{ filename: 'src/a.ts', status: 'modified', patch: '@@ -1,3 +1,7 @@' }, { filename: 'src/b.ts', status: 'added', patch: '@@ -0,0 +1 @@' }, { filename: 'src/gone.ts', status: 'removed', patch: '@@ -1 +0,0 @@' }] }] },
  ];
}

/** The scope of `review --pr <number>` by its number, whose request reads GitHub through `gh`. */
const pullRequestSource = (box: ReviewSandbox, gh: Gh, number = 42): ScopeSource => {
  const request = { pullRequest: { number, repository: null }, paths: [] };
  return { named: true, pullRequest: true, choice: () => ({ mode: 'pull-request', request }), request: () => resolvePullRequestScope(box.repo, request, gh) };
};

/** The scope of a command that names `named`, which a resumed run never reads the request of. */
const resumingSource = (named: NamedScope, pullRequest: boolean): ScopeSource => ({
  named: true,
  pullRequest,
  choice: () => named,
  request: () => assert.fail('a resumed run reads no request'),
});

describe('a resumed read-only run of a pull request and the scope of the command (R3 of the review of a fix run)', { timeout: 900_000, concurrency: sandboxConcurrency }, () => {
  /** A sandbox whose read-only `review --pr 42` blocked before its report, and the run. */
  async function stopped(t: TestContext): Promise<{ box: ReviewSandbox; runId: string; script: string }> {
    const box = ReviewSandbox.forTest(t, { triage: { exit: 2 } });
    const { gh, script } = fakeGhWith(t, pullRequestSteps(box));
    const first = await box.review('claude', { scope: pullRequestSource(box, gh) });
    assert.equal(first.kind, 'blocked');
    box.script(fixingScript);
    box.logs.length = 0;
    return { box, runId: first.runId, script };
  }

  const commands: readonly (readonly [string, NamedScope, boolean])[] = [
    ['review --last-commit --fix', { mode: 'last-commit', request: { paths: [] } }, false],
    ['review --pr 99 --fix', { mode: 'pull-request', request: { pullRequest: { number: 99, repository: null }, paths: [] } }, true],
  ];
  for (const [name, named, pullRequest] of commands) {
    it(`brings it to its read-only report with ${name}, which names another scope, ignores its --fix and fixes nothing`, async (t) => {
      const { box, runId, script } = await stopped(t);
      reportText(await box.fix('claude', { scope: resumingSource(named, pullRequest) }));
      const run = box.checkpoint.fold(runId);
      assert.equal(box.checkpoint.foldRuns().length, 1, 'no second run');
      assert.equal(reviewStatus(run), 'complete');
      assert.equal(run.review!.fix, null, 'the run stays read-only');
      assert.equal(run.review!.continuedFrom, null);
      assert.equal(box.events(runId).some(([kind]) => kind === 'fix.pinned'), false, 'nothing was pinned');
      assert.deepEqual(git(box.repo, 'status', '--porcelain'), '', 'no fixer edited the tree');
      assert.ok(box.logs.includes(`run ${runId} is pinned without the fix pass; --fix, --check and --no-check are ignored; once its report is written, run again with --fix to continue it into the fix pass`), box.logs.join('\n'));
      assert.ok(!box.logs.some((line) => line.includes('this command continues it into the fix pass')), box.logs.join('\n'));
      assert.equal(fakeGhCalls(script).length, 4, 'GitHub was read once, for the capture');
    });
  }
});
