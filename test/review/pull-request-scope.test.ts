import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { parseArgs } from 'node:util';
import { hasScopeFlags, namedScopeOf, pullRequestNameOf, UsageError } from '../../src/command.ts';
import type { ScopeRequest } from '../../src/checkpoint/events.ts';
import type { ScopeSettings } from '../../src/config/resolve.ts';
import { GitHubCallError } from '../../src/github/errors.ts';
import type { Gh } from '../../src/github/gh.ts';
import type { PullRequestName } from '../../src/github/pull-request.ts';
import { replayVerifier } from '../../src/replay/run.ts';
import { continueCommand } from '../../src/review/continue-command.ts';
import { resolvePullRequestScope, type ScopeSource } from '../../src/review/controller.ts';
import { ReviewRefusedError } from '../../src/review/errors.ts';
import { githubExecutableAdvice, resolveExecutable } from '../../src/review/executable.ts';
import { acquireStartLock } from '../../src/review/lock.ts';
import { describeRun } from '../../src/review/status.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { captureScope, namesScope, type NamedScope } from '../../src/scope/capture.ts';
import { fakeGhCalls, fakeGhWith, type FakeGhStep } from '../helpers/fake-gh.ts';
import { reviewScript } from '../helpers/fix-pass-fixture.ts';
import { baseEnvironment, fakeClaude } from '../helpers/launcher.ts';
import { reportText, ReviewSandbox, sandboxConcurrency, scopeSource } from '../helpers/review-sandbox.ts';
import { git, write } from '../helpers/repository.ts';

/** The options of `review`, as `parseArgs` gives the values a test names. */
const valuesOf = (...args: string[]) =>
  parseArgs({
    args,
    options: { 'last-commit': { type: 'boolean' }, worktree: { type: 'boolean' }, branch: { type: 'boolean' }, base: { type: 'string' }, pr: { type: 'string' }, ref: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, 'merge-base': { type: 'boolean' }, path: { type: 'string', multiple: true }, fix: { type: 'boolean' } },
    strict: true,
  }).values as Parameters<typeof namedScopeOf>[0];

/** Pass 1 with no layer setting anything: the defaults, `review.base` none. */
const noScopeSettings: ScopeSettings = {
  scopeDefault: { value: 'auto', layer: 'default' },
  reviewBase: { value: null, layer: 'default' },
  githubExecutable: { value: 'gh', layer: 'default' },
  githubArgs: { value: [], layer: 'default' },
};

describe('--pr names a pull request without GitHub (R1, R4 of the review on the pull request)', () => {
  it('reads a number, and a URL with or without a path, query or fragment after the number, on github.com or an Enterprise host', () => {
    assert.deepEqual(pullRequestNameOf('42'), { number: 42, repository: null });
    assert.deepEqual(pullRequestNameOf('https://github.com/acme/widgets/pull/42'), { number: 42, repository: 'github.com/acme/widgets' });
    assert.deepEqual(pullRequestNameOf('https://github.com/acme/widgets/pull/42/files?w=1#diff-1'), { number: 42, repository: 'github.com/acme/widgets' });
    assert.deepEqual(pullRequestNameOf('https://ghe.example.com/team/tool.js/pull/7/commits'), { number: 7, repository: 'ghe.example.com/team/tool.js' });
    assert.deepEqual(pullRequestNameOf('https://ghe.example.com:443/team/tool.js/pull/7'), { number: 7, repository: 'ghe.example.com/team/tool.js' }, 'the default port is no port');
  });

  it('refuses the URL of a host with a port by name, since gh names a host without one', () => {
    assert.throws(() => pullRequestNameOf('https://ghe.example.com:8443/o/r/pull/7'), (error: unknown) => error instanceof UsageError && /^--pr cannot take "https:\/\/ghe\.example\.com:8443\/o\/r\/pull\/7": its host names the port 8443, and gh names a host without a port/.test(error.message));
  });

  it('refuses with the usage what is neither a number nor the URL of a pull request', () => {
    for (const text of ['0', '-3', '4.2', 'abc', '', 'http://github.com/acme/widgets/pull/42', 'https://github.com/acme/widgets/issues/42', 'https://github.com/acme/widgets/pull/x', 'https://github.com/acme/pull/42', 'https://github.com/acme/wid gets/pull/42', '99999999999999999999']) {
      assert.throws(() => pullRequestNameOf(text), (error: unknown) => error instanceof UsageError && /--pr takes the number of a pull request/.test(error.message), JSON.stringify(text));
    }
  });

  it('names the scope pull-request with its paths, goes with --path and --fix, and counts as a scope flag', () => {
    assert.deepEqual(namedScopeOf(valuesOf('--pr', '42', '--path', 'src', '--fix'), noScopeSettings), { mode: 'pull-request', request: { pullRequest: { number: 42, repository: null }, paths: ['src'] } });
    assert.equal(hasScopeFlags(valuesOf('--pr', '42')), true);
  });

  it('refuses another scope flag and --base beside it', () => {
    for (const other of [['--last-commit'], ['--worktree'], ['--branch'], ['--ref', 'HEAD'], ['--from', 'a', '--to', 'b']]) {
      assert.throws(() => namedScopeOf(valuesOf('--pr', '42', ...other), noScopeSettings), /choose one scope: .*--pr <number\|URL>/, other.join(' '));
    }
    assert.throws(() => namedScopeOf(valuesOf('--pr', '42', '--base', 'main'), noScopeSettings), /--base applies to --branch only/);
  });
});

describe('namesScope of a pull request (R4 of the review on the pull request)', () => {
  const facts = { host: 'github.com', owner: 'Acme', repository: 'Widgets', number: 42, url: 'https://github.com/Acme/Widgets/pull/42', baseRef: 'main', title: 'Add a widget', body: null };
  const range = { from: 'c'.repeat(40), to: 'HEAD', mergeBase: false };
  const recorded = { mode: 'range' as const, request: { range, paths: [], exclude: [], pullRequest: { number: 42, repository: null } }, pullRequest: facts };
  const named = (pullRequest: PullRequestName, paths: string[] = []): NamedScope => ({ mode: 'pull-request', request: { pullRequest, paths } });

  it('matches the run of the pull request by its number, and by its URL without regard to case, a run named by its number included', () => {
    assert.equal(namesScope(named({ number: 42, repository: null }), recorded), true);
    assert.equal(namesScope(named({ number: 42, repository: 'github.com/acme/widgets' }), recorded), true);
    assert.equal(namesScope(named({ number: 42, repository: 'GITHUB.COM/ACME/WIDGETS' }), recorded), true);
  });

  it('matches no other number, no other repository, no other paths, and no run of another scope', () => {
    assert.equal(namesScope(named({ number: 43, repository: null }), recorded), false);
    assert.equal(namesScope(named({ number: 42, repository: 'github.com/acme/gadgets' }), recorded), false);
    assert.equal(namesScope(named({ number: 42, repository: 'ghe.example.com/acme/widgets' }), recorded), false);
    assert.equal(namesScope(named({ number: 42, repository: null }, ['src']), recorded), false);
    assert.equal(namesScope(named({ number: 42, repository: null }), { mode: 'range', request: { range, paths: [], exclude: [] }, pullRequest: null }), false);
  });

  it('keeps a range from naming the run of a pull request, whose stopped fix pass continues with its URL', () => {
    assert.equal(namesScope({ mode: 'range', request: { range, paths: [] } }, recorded), false);
    const run = { worktree: '/work/repo', scope: { ...recorded, base: range.from, head: 'a'.repeat(40), files: [], patch: { sha256: '0'.repeat(64), bytes: 0 }, excluded: { paths: [], count: 0 } }, review: { configuration: { runtime: 'claude' } } } as unknown as Parameters<typeof continueCommand>[0];
    assert.equal(continueCommand(run, '/engine/main.mjs', null, 1), 'node "/engine/main.mjs" review --repo "/work/repo" --runtime claude --pr https://github.com/Acme/Widgets/pull/42 --fix --budget-usd 2');
  });
});

/** The sandbox's commits: its head, the change under review, and its base, the commit before. */
const commitsOf = (box: ReviewSandbox): { head: string; base: string } => ({ head: git(box.repo, 'rev-parse', 'HEAD'), base: git(box.repo, 'rev-parse', 'HEAD~1') });

/** The files GitHub lists for the sandbox's change: one modified, one added, one removed. */
const sandboxFiles = [
  { filename: 'src/a.ts', status: 'modified', patch: '@@ -1,3 +1,7 @@' },
  { filename: 'src/b.ts', status: 'added', patch: '@@ -0,0 +1 @@' },
  { filename: 'src/gone.ts', status: 'removed', patch: '@@ -1 +0,0 @@' },
];

/** A pull request as GitHub answers it, of the sandbox's change unless `overrides` says otherwise. */
const pullRequestBody = (head: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  html_url: 'https://github.com/acme/widgets/pull/42',
  number: 42,
  state: 'open',
  merged: false,
  head: { sha: head },
  base: { ref: 'main' },
  changed_files: 3,
  title: 'Parse with a guard',
  body: 'Why the parser needs a guard.',
  ...overrides,
});

/** What `gh` answers for pull request #42 of the sandbox, of acme/widgets unless `change` names another `<owner>/<repo>`: the pull request, the head of its base branch, the merge base, and its files, each as `change` gives it. */
function sandboxSteps(box: ReviewSandbox, change: { readonly pullRequest?: Record<string, unknown>; readonly mergeBase?: string; readonly files?: readonly unknown[]; readonly baseRef?: string; readonly repository?: string } = {}): FakeGhStep[] {
  const { head, base } = commitsOf(box);
  const baseRef = change.baseRef ?? 'main';
  const encoded = baseRef.split('/').map(encodeURIComponent).join('/');
  const baseHead = 'd'.repeat(40);
  const repository = change.repository ?? 'acme/widgets';
  return [
    { endpoint: 'repos/{owner}/{repo}/pulls/42', pages: [{ body: pullRequestBody(head, { html_url: `https://github.com/${repository}/pull/42`, base: { ref: baseRef }, ...change.pullRequest }) }] },
    { endpoint: `repos/${repository}/git/ref/heads/${encoded}`, pages: [{ body: { object: { sha: baseHead } } }] },
    { endpoint: `repos/${repository}/compare/${baseHead}...${head}`, pages: [{ body: { merge_base_commit: { sha: change.mergeBase ?? base } } }] },
    { endpoint: `repos/${repository}/pulls/42/files?per_page=100`, pages: [{ body: change.files ?? sandboxFiles }] },
  ];
}

/** Pull request #42 named by its number, with `paths`. */
const byNumber = (paths: string[] = []): Extract<NamedScope, { readonly mode: 'pull-request' }>['request'] => ({ pullRequest: { number: 42, repository: null }, paths });

/** The scope of `review --pr 42` through `gh`, with `around` run around each read of GitHub. */
const pullRequestSource = (box: ReviewSandbox, gh: Gh, around: (read: () => ReturnType<ScopeSource['request']>) => ReturnType<ScopeSource['request']> = (read) => read()): ScopeSource => ({
  named: true,
  pullRequest: true,
  choice: () => ({ mode: 'pull-request', request: byNumber() }),
  request: () => around(() => resolvePullRequestScope(box.repo, byNumber(), gh)),
});

/** The refusal `run` rejects with, which must say `message`. */
async function refused(run: () => Promise<unknown>, message: RegExp): Promise<void> {
  await assert.rejects(run, (error: unknown) => error instanceof ReviewRefusedError && message.test(error.message));
}

/** A sandbox whose `gh` answers `steps`, with that `gh` and its script. */
function sandboxWithGh(t: TestContext, steps: (box: ReviewSandbox) => FakeGhStep[]): { box: ReviewSandbox; gh: Gh; script: string } {
  const box = ReviewSandbox.forTest(t);
  const { gh, script } = fakeGhWith(t, steps(box));
  return { box, gh, script };
}

describe('the capture of a pull request (R2, R3, R5, R6, R15 of the review on the pull request)', { timeout: 600_000, concurrency: sandboxConcurrency }, () => {
  it('reads GitHub before the start lock, records scope.captured@3 with the body frozen, names the pull request, and launches no worker with a token for gh', async (t) => {
    const { box, gh, script } = sandboxWithGh(t, (sandbox) => sandboxSteps(sandbox));
    const recordFile = join(box.directory, 'record.json');
    let lockFree = false;
    const scope = pullRequestSource(box, gh, (read) => {
      acquireStartLock(box.checkpoint.root)();
      lockFree = true;
      return read();
    });
    const tokens = { GH_TOKEN: 'gh-token-1', GITHUB_TOKEN: 'gh-token-2', GH_ENTERPRISE_TOKEN: 'gh-token-3', GITHUB_ENTERPRISE_TOKEN: 'gh-token-4' };
    const report = reportText(await box.review('claude', { scope }, { ...tokens, FAKE_RECORD: recordFile }));
    assert.equal(lockFree, true, 'GitHub was read while the start lock was free');
    assert.equal(fakeGhCalls(script).length, 4, 'the pull request, the head of its base branch, the merge base and the files');
    const state = box.run();
    const { head, base } = commitsOf(box);
    const captured = box.checkpoint.ledger.events(state.id).find((event) => event.kind === 'scope.captured')!;
    assert.equal(captured.version, 3);
    assert.equal(box.checkpoint.ledger.events(state.id).find((event) => event.kind === 'review.configured')!.version, 10, 'a read-only run of a pull request explains its review');
    const scopeState = state.scope!;
    assert.deepEqual([scopeState.mode, scopeState.base, scopeState.head, scopeState.request.range, scopeState.request.pullRequest], ['range', base, head, { from: base, to: 'HEAD', mergeBase: false }, { number: 42, repository: null }]);
    const { body, ...facts } = scopeState.pullRequest!;
    assert.deepEqual(facts, { host: 'github.com', owner: 'acme', repository: 'widgets', number: 42, url: 'https://github.com/acme/widgets/pull/42', baseRef: 'main', title: 'Parse with a guard' });
    assert.equal(box.checkpoint.evidence.read(body!).toString('utf8'), 'Why the parser needs a guard.');
    assert.ok(box.logs.includes(`run ${state.id}: scope captured, pull request #42 of acme/widgets, 3 files`), box.logs.join('\n'));
    assert.match(report, /^Pull request: https:\/\/github\.com\/acme\/widgets\/pull\/42$/m);
    // The Scope line of status names the pull request and its base branch (R6).
    const described = describeRun(state, claudeAdapter, (reference) => box.checkpoint.evidence.pathOf(reference), { commits: 1 });
    assert.ok(described.lines.includes(`Scope: pull-request #42 of acme/widgets, 1 commit and 3 files, from the merge base with main (${base.slice(0, 8)}) to the working tree`), described.lines.join('\n'));
    // The worker the fake recorded last ran with none of the variables that hold a token for gh (R15).
    const seen = (JSON.parse(readFileSync(recordFile, 'utf8')) as { environment: Record<string, string> }).environment;
    assert.deepEqual(Object.keys(seen).filter((name) => name in tokens), []);
  });

  it('replays a verifier of the run without the variables that hold a token for gh (R15)', async (t) => {
    const { box, gh } = sandboxWithGh(t, (sandbox) => sandboxSteps(sandbox));
    box.script(reviewScript);
    reportText(await box.review('claude', { scope: pullRequestSource(box, gh) }));
    const tokens = { GH_TOKEN: 'gh-token-1', GITHUB_TOKEN: 'gh-token-2', GH_ENTERPRISE_TOKEN: 'gh-token-3', GITHUB_ENTERPRISE_TOKEN: 'gh-token-4' };
    const recordFile = join(box.directory, 'replay-record.json');
    await replayVerifier({
      source: box.checkpoint, runId: box.run().id, tree: box.repo, output: join(box.directory, 'replay'), runtime: 'claude', executable: process.execPath, executableArgs: [fakeClaude], rolesRoot: box.rolesRoot,
      roleText: 'recorded', repeat: 1, concurrency: 1, engine: '0.0.0-test', log: () => undefined,
      environment: { ...baseEnvironment, ...tokens, FAKE_SCRIPT: box.scriptFile, FAKE_RECORD: recordFile, FAKE_RECORD_ROLE: 'verifier' }, scratchRoot: box.scratchRoot,
    });
    const seen = (JSON.parse(readFileSync(recordFile, 'utf8')) as { environment: Record<string, string> }).environment;
    assert.deepEqual(Object.keys(seen).filter((name) => name in tokens), []);
  });

  it('records a --branch run at scope.captured@2 and review.configured@9, as before, and its workers keep the environment (R5)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    const recordFile = join(box.directory, 'record.json');
    await box.review('claude', { scope: scopeSource(() => ({ range: { from: 'HEAD~1', to: 'HEAD', mergeBase: true }, paths: [] })) }, { GH_TOKEN: 'gh-token-1', FAKE_RECORD: recordFile });
    const events = box.checkpoint.ledger.events(box.run().id);
    assert.equal(events.find((event) => event.kind === 'scope.captured')!.version, 2);
    assert.equal(events.find((event) => event.kind === 'review.configured')!.version, 9);
    assert.equal(box.run().scope!.pullRequest, null);
    assert.equal((JSON.parse(readFileSync(recordFile, 'utf8')) as { environment: Record<string, string> }).environment.GH_TOKEN, 'gh-token-1');
  });

  it('records an empty body as none, and a path scope.exclude leaves out is no difference from GitHub\'s list', async (t) => {
    const { box, gh } = sandboxWithGh(t, (sandbox) => sandboxSteps(sandbox, { pullRequest: { body: '' } }));
    const { head, base } = commitsOf(box);
    const facts = resolvePullRequestScope(box.repo, byNumber(), gh).pullRequest!;
    const { id } = box.checkpoint.createRun({ worktree: box.repo });
    const state = captureScope(box.checkpoint, id, { range: { from: base, to: 'HEAD', mergeBase: false }, paths: [] }, { exclude: ['src/gone.ts'], pullRequest: facts });
    assert.equal(state.scope!.pullRequest!.body, null);
    assert.deepEqual(state.scope!.excluded, { paths: ['src/gone.ts'], count: 1 });
    assert.equal(state.scope!.head, head);
  });

  it('resumes the active run whatever pull request the command names, with no call of gh (R4)', async (t) => {
    const { box, gh, script } = sandboxWithGh(t, (sandbox) => sandboxSteps(sandbox));
    const facts = resolvePullRequestScope(box.repo, byNumber(), gh).pullRequest!;
    const calls = fakeGhCalls(script).length;
    const { id } = box.checkpoint.createRun({ worktree: box.repo });
    captureScope(box.checkpoint, id, { range: { from: commitsOf(box).base, to: 'HEAD', mergeBase: false }, paths: [] }, { pullRequest: facts });
    const { gh: silent, script: silentScript } = fakeGhWith(t, []);
    const scope: ScopeSource = { ...pullRequestSource(box, silent), choice: () => ({ mode: 'pull-request', request: { pullRequest: { number: 43, repository: null }, paths: [] } }) };
    reportText(await box.review('claude', { scope }));
    assert.deepEqual(fakeGhCalls(silentScript), [], 'no call of gh');
    assert.equal(fakeGhCalls(script).length, calls);
    assert.equal(box.run().id, id);
    assert.ok(box.logs.includes(`run ${id} is active; its scope flags are ignored and the run continues`), box.logs.join('\n'));
  });

  it('reads GitHub under the start lock for an active run with no scope yet, the one case that does', async (t) => {
    const { box, gh } = sandboxWithGh(t, (sandbox) => sandboxSteps(sandbox, { pullRequest: { state: 'closed' } }));
    const { id } = box.checkpoint.createRun({ worktree: box.repo });
    let held = false;
    const scope = pullRequestSource(box, gh, (read) => {
      assert.throws(() => acquireStartLock(box.checkpoint.root), /lock/);
      held = true;
      return read();
    });
    await refused(() => box.review('claude', { scope }), /pull request #42 of acme\/widgets is closed/);
    assert.equal(held, true);
    assert.equal(box.run().id, id);
    assert.equal(box.run().scope, null, 'the run keeps no scope and resumes on the next command');
  });

  it('refuses a HEAD that moved between the read of GitHub and the start lock, creating no run', async (t) => {
    const { box, gh } = sandboxWithGh(t, (sandbox) => sandboxSteps(sandbox));
    const scope = pullRequestSource(box, gh, (read) => {
      const read_ = read();
      git(box.repo, 'commit', '-q', '--allow-empty', '-m', 'a commit after the read');
      return read_;
    });
    await refused(() => box.review('claude', { scope }), /^HEAD moved to [0-9a-f]{40} since pull request #42 of acme\/widgets was read at its head [0-9a-f]{40}; run the command again$/);
    assert.deepEqual(box.checkpoint.listRuns(), []);
  });

  it('refuses a tree that changed between the read of GitHub and the start lock, creating no run', async (t) => {
    const { box, gh } = sandboxWithGh(t, (sandbox) => sandboxSteps(sandbox));
    const scope = pullRequestSource(box, gh, (read) => {
      const read_ = read();
      write(box.repo, 'src/a.ts', 'changed after the read\n');
      return read_;
    });
    await refused(() => box.review('claude', { scope }), /^--pr reviews the head of pull request #42 of acme\/widgets in a clean tree, and this tree has uncommitted changes or untracked files; commit, stash or remove them, or review them with --worktree$/);
    assert.deepEqual(box.checkpoint.listRuns(), []);
  });

  describe('each refusal names its action and creates no run (R2, PD9)', () => {
    /** Review the sandbox's pull request #42 with `gh` answering `steps`, after `prepare`, which must be refused with `message`. */
    async function refusedReview(t: TestContext, message: RegExp, steps: (box: ReviewSandbox) => FakeGhStep[], prepare: (box: ReviewSandbox) => void = () => {}): Promise<{ box: ReviewSandbox; script: string }> {
      const { box, gh, script } = sandboxWithGh(t, steps);
      prepare(box);
      await refused(() => box.review('claude', { scope: pullRequestSource(box, gh) }), message);
      assert.deepEqual(box.checkpoint.listRuns(), [], 'no run');
      return { box, script };
    }

    it('refuses a URL of a repository GitHub gives under another name, as a renamed or moved one, naming the URL GitHub gives; another case of the name is the same', async (t) => {
      /** The sandbox's steps with the pull request read by the URL of `repository`, a `<host>/<owner>/<repo>`. */
      const byUrlOf = (repository: string) => (box: ReviewSandbox): FakeGhStep[] => sandboxSteps(box).map((step, index) => (index === 0 ? { ...step, endpoint: `repos/${repository.slice(repository.indexOf('/') + 1)}/pulls/42` } : step));
      const request = (repository: string): Extract<NamedScope, { readonly mode: 'pull-request' }>['request'] => ({ pullRequest: { number: 42, repository }, paths: [] });
      const { box, gh } = sandboxWithGh(t, byUrlOf('github.com/old/widgets'));
      const scope: ScopeSource = { named: true, pullRequest: true, choice: () => ({ mode: 'pull-request', request: request('github.com/old/widgets') }), request: () => resolvePullRequestScope(box.repo, request('github.com/old/widgets'), gh) };
      await refused(() => box.review('claude', { scope }), /^GitHub gives pull request #42 of github\.com\/old\/widgets as https:\/\/github\.com\/acme\/widgets\/pull\/42, of github\.com\/acme\/widgets, as it does for a repository that was renamed or moved; give --pr https:\/\/github\.com\/acme\/widgets\/pull\/42 and run the command again$/);
      assert.deepEqual(box.checkpoint.listRuns(), [], 'no run');
      const cased = sandboxWithGh(t, byUrlOf('GitHub.com/ACME/widgets'));
      assert.equal(resolvePullRequestScope(cased.box.repo, request('GitHub.com/ACME/widgets'), cased.gh).pullRequest!.facts.owner, 'acme');
    });

    it('refuses a closed and a merged pull request', async (t) => {
      await refusedReview(t, /^pull request #42 of acme\/widgets is closed, and deep-review reviews an open pull request only$/, (box) => sandboxSteps(box, { pullRequest: { state: 'closed' } }));
      await refusedReview(t, /^pull request #42 of acme\/widgets is merged, and deep-review reviews an open pull request only$/, (box) => sandboxSteps(box, { pullRequest: { state: 'closed', merged: true } }));
    });

    it('refuses a HEAD that is not the head, naming gh pr checkout', async (t) => {
      await refusedReview(t, /^HEAD is [0-9a-f]{40}, not e{40}, the head of pull request #42 of acme\/widgets; check it out, for example with `gh pr checkout 42`, and run the command again$/, (box) => sandboxSteps(box, { pullRequest: { head: { sha: 'e'.repeat(40) } } }));
    });

    it('refuses an uncommitted change and an untracked file', async (t) => {
      const message = /^--pr reviews the head of pull request #42 of acme\/widgets in a clean tree, and this tree has uncommitted changes or untracked files; commit, stash or remove them, or review them with --worktree$/;
      await refusedReview(t, message, (box) => sandboxSteps(box), (box) => write(box.repo, 'src/a.ts', 'changed\n'));
      await refusedReview(t, message, (box) => sandboxSteps(box), (box) => write(box.repo, 'src/new.ts', 'new\n'));
    });

    it('refuses a merge base the clone does not hold, naming a fetch of the history', async (t) => {
      await refusedReview(t, /^the clone does not hold f{40}, the merge base GitHub gives for pull request #42 of acme\/widgets with its base branch main; fetch the history down to it, such as `git fetch --unshallow` in a shallow clone, and run the command again$/, (box) => sandboxSteps(box, { mergeBase: 'f'.repeat(40) }));
    });

    it('refuses a list with an extra path and with a missing path, naming the paths of each side', async (t) => {
      await refusedReview(t, /: GitHub lists 1 changed path that the clone's change does not hold \(src\/extra\.ts\)$/, (box) => sandboxSteps(box, { files: [...sandboxFiles, { filename: 'src/extra.ts', status: 'added' }] }));
      await refusedReview(t, /: the clone's change holds 1 changed path that GitHub does not list \(src\/b\.ts\)$/, (box) => sandboxSteps(box, { files: sandboxFiles.filter((file) => file.filename !== 'src/b.ts') }));
    });

    it('takes a rename as a deleted and an added path, and a copy as an added path that leaves its source in place', async (t) => {
      const modified = sandboxFiles[0]!;
      // A rename lists the removed path as its previous one.
      const renamed = sandboxWithGh(t, (box) => sandboxSteps(box, { files: [modified, { filename: 'src/b.ts', status: 'renamed', previous_filename: 'src/gone.ts' }] }));
      assert.deepEqual(resolvePullRequestScope(renamed.box.repo, byNumber(), renamed.gh).request.range, { from: commitsOf(renamed.box).base, to: 'HEAD', mergeBase: false });
      // A copy does not delete its source, so the removed path must be listed apart.
      const copied = sandboxWithGh(t, (box) => sandboxSteps(box, { files: [modified, { filename: 'src/b.ts', status: 'copied', previous_filename: 'src/gone.ts' }, sandboxFiles[2]] }));
      assert.equal(resolvePullRequestScope(copied.box.repo, byNumber(), copied.gh).pullRequest!.facts.number, 42);
      await refusedReview(t, /the clone's change holds 1 changed path that GitHub does not list \(src\/gone\.ts\)$/, (box) => sandboxSteps(box, { files: [modified, { filename: 'src/b.ts', status: 'copied', previous_filename: 'src/gone.ts' }] }));
    });

    it('reads the head of a base branch whose name holds a slash and a #', async (t) => {
      const { box, gh, script } = sandboxWithGh(t, (sandbox) => sandboxSteps(sandbox, { baseRef: 'release/1.x#2' }));
      assert.equal(resolvePullRequestScope(box.repo, byNumber(), gh).pullRequest!.facts.baseRef, 'release/1.x#2');
      assert.ok(fakeGhCalls(script).some((call) => call.args.includes('repos/acme/widgets/git/ref/heads/release/1.x%232')));
    });

    it('refuses a pull request of more than 3000 files from changed_files, before its files are listed', async (t) => {
      const { script } = await refusedReview(t, /changes 3001 files, and GitHub lists no more than 3000/, (box) => sandboxSteps(box, { pullRequest: { changed_files: 3001 } }));
      assert.ok(!fakeGhCalls(script).some((call) => call.args.some((arg) => arg.endsWith('/files?per_page=100'))));
    });

    it('leaves a server error of GitHub an error, exit 1, not a refusal, on the read of the pull request and on a later read', async (t) => {
      for (const steps of [() => [{ endpoint: 'repos/{owner}/{repo}/pulls/42', pages: [{ status: 502, body: { message: 'Bad Gateway' } }] }], (box: ReviewSandbox) => sandboxSteps(box).map((step) => (step.endpoint.endsWith('/files?per_page=100') ? { ...step, pages: [{ status: 503, body: { message: 'Service Unavailable' } }] } : step))]) {
        const { box, gh } = sandboxWithGh(t, steps);
        await assert.rejects(box.review('claude', { scope: pullRequestSource(box, gh) }), (error: unknown) => error instanceof GitHubCallError && !(error instanceof ReviewRefusedError) && /GitHub answered 50[23]/.test(error.message));
        assert.deepEqual(box.checkpoint.listRuns(), [], 'no run');
      }
    });

    it('names for a 404 on a number both a pull request missing from the repository and the account, and for a 401, a URL or a later read the account alone', async (t) => {
      await refusedReview(t, /^reading pull request #42: GitHub answered 404: Not Found; check that pull request #42 exists in the repository of this clone, or run `gh auth login`, or set GH_TOKEN \(GH_ENTERPRISE_TOKEN for a GitHub Enterprise Server\) with an account that can read pull request #42$/, () => [{ endpoint: 'repos/{owner}/{repo}/pulls/42', pages: [{ status: 404, body: { message: 'Not Found' } }] }]);
      await refusedReview(t, /^reading pull request #42: GitHub answered 401: Bad credentials; run `gh auth login`, or set GH_TOKEN \(GH_ENTERPRISE_TOKEN for a GitHub Enterprise Server\) with an account that can read pull request #42$/, () => [{ endpoint: 'repos/{owner}/{repo}/pulls/42', pages: [{ status: 401, body: { message: 'Bad credentials' } }] }]);
      await refusedReview(t, /: GitHub answered 404: Not Found; run `gh auth login --hostname github\.com`, or set GH_TOKEN with an account that can read pull request #42 of acme\/widgets$/, (box) => sandboxSteps(box).map((step) => (step.endpoint.endsWith('/files?per_page=100') ? { ...step, pages: [{ status: 404, body: { message: 'Not Found' } }] } : step)));
      const { box, gh } = sandboxWithGh(t, () => [{ endpoint: 'repos/acme/widgets/pulls/42', pages: [{ status: 404, body: { message: 'Not Found' } }] }]);
      assert.throws(() => resolvePullRequestScope(box.repo, { pullRequest: { number: 42, repository: 'github.com/acme/widgets' }, paths: [] }, gh), (error: unknown) => error instanceof ReviewRefusedError
        && /; run `gh auth login --hostname github\.com`, or set GH_TOKEN with an account that can read pull request #42 of github\.com\/acme\/widgets$/.test(error.message) && !error.message.includes('check that'));
    });

    it('refuses gh with no account for the host, with its action, and a number gh cannot read, naming the URL', async (t) => {
      await refusedReview(t, /gh has no account for the host of the clone; run `gh auth login`/, () => [{ endpoint: 'repos/{owner}/{repo}/pulls/42', noAccount: true }]);
      await refusedReview(t, /give --pr the URL of the pull request, such as https:\/\/github\.com\/<owner>\/<repo>\/pull\/42/, () => []);
    });
  });
});

describe('the continuation of a run of a pull request (R4 of the review on the pull request)', { timeout: 900_000, concurrency: sandboxConcurrency }, () => {
  /** The range of the sandbox's change, from the merge base with HEAD~1, as `--branch` names it with HEAD~1 its base. */
  const branchRange = (): ScopeRequest => ({ range: { from: 'HEAD~1', to: 'HEAD', mergeBase: true }, paths: [] });

  it('continues the finished run of the pull request a --pr --fix names', async (t) => {
    const { box, gh } = sandboxWithGh(t, (sandbox) => [...sandboxSteps(sandbox), ...sandboxSteps(sandbox)]);
    box.script(reviewScript);
    reportText(await box.review('claude', { scope: pullRequestSource(box, gh) }));
    const finished = box.run();
    reportText(await box.fix('claude', { scope: pullRequestSource(box, gh) }));
    assert.equal(box.run().id, finished.id, 'the run of #42, continued');
    assert.notEqual(box.run().review!.continuedFrom, null);
  });

  it('continues no run of a pull request from --branch --fix or a plain --fix of the same change, which publish could no longer post', async (t) => {
    const { box, gh } = sandboxWithGh(t, (sandbox) => sandboxSteps(sandbox));
    box.script(reviewScript);
    reportText(await box.review('claude', { scope: pullRequestSource(box, gh) }));
    const finished = box.run();
    for (const named of [true, false]) {
      box.logs.length = 0;
      reportText(await box.fix('claude', { scope: scopeSource(branchRange, named) }));
      assert.ok(box.logs.includes(`run ${finished.id}: not continued: it reviewed pull request #42 of acme/widgets, which only a command that names it with --pr continues`), box.logs.join('\n'));
      assert.equal(box.checkpoint.fold(finished.id).review!.fix, null, 'the run of #42 stays read-only, and postable');
    }
    assert.equal(box.checkpoint.foldRuns().length, 3, 'a new run for each');
  });

  it('continues no run of the same change that is not of the pull request a --pr --fix names: a --branch run, or a run of another pull request', async (t) => {
    const { box, gh } = sandboxWithGh(t, (sandbox) => [...sandboxSteps(sandbox, { repository: 'forks/widgets' }), ...sandboxSteps(sandbox), ...sandboxSteps(sandbox)]);
    box.script(reviewScript);
    reportText(await box.review('claude', { scope: pullRequestSource(box, gh) }));
    const otherPullRequest = box.run();
    assert.equal(otherPullRequest.scope!.pullRequest!.owner, 'forks');
    box.logs.length = 0;
    reportText(await box.fix('claude', { scope: pullRequestSource(box, gh) }));
    assert.ok(box.logs.includes(`run ${otherPullRequest.id}: not continued: it reviewed pull request #42 of forks/widgets, not pull request #42 of acme/widgets`), box.logs.join('\n'));
    reportText(await box.review('claude', { scope: scopeSource(branchRange) }));
    const branch = box.checkpoint.foldRuns().at(-1)!;
    assert.equal(branch.scope!.pullRequest, null);
    box.logs.length = 0;
    reportText(await box.fix('claude', { scope: pullRequestSource(box, gh) }));
    assert.ok(box.logs.includes(`run ${branch.id}: not continued: it reviewed no pull request, and this command names pull request #42 of acme/widgets`), box.logs.join('\n'));
    for (const run of [otherPullRequest, branch]) assert.equal(box.checkpoint.fold(run.id).review!.fix, null, `run ${run.id} stays read-only`);
    assert.equal(box.checkpoint.foldRuns().length, 4, 'a new run for each --pr --fix');
  });
});

describe('the executable of gh (R15 of the review on the pull request)', () => {
  it('refuses a shim and a missing gh by name, with the action of github.executable', (t) => {
    const directory = fakeGhWith(t, []).script.replace(/script\.json$/, '');
    const shim = join(directory, 'gh.cmd');
    writeFileSync(shim, '@echo off\n');
    assert.throws(() => resolveExecutable(shim, {}, 'linux', directory, githubExecutableAdvice), (error: unknown) => error instanceof ReviewRefusedError && error.code === null && /is a \.cmd shim, which cannot be spawned without a shell; set github\.executable to gh's own executable/.test(error.message));
    assert.throws(() => resolveExecutable('gh', { PATH: directory }, 'linux', directory, githubExecutableAdvice), /no gh was found on PATH; install the GitHub CLI, gh, or set github\.executable to its path/);
    assert.ok(!existsSync(join(directory, 'gh')));
  });
});
