import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { repositoryConfigPath } from '../../src/config/files.ts';
import { dedicatedFlagValues } from '../../src/config/flags.ts';
import { flagLayerOf, parseSetFlag } from '../../src/config/resolve.ts';
import { configurationSource, type ConfigurationSource } from '../../src/config/source.ts';
import type { Gh } from '../../src/github/gh.ts';
import { recordedAnswerOf } from '../../src/review/explanation.ts';
import { resolvePullRequestScope, type ScopeSource } from '../../src/review/controller.ts';
import { fakeGhWith, type FakeGhStep } from '../helpers/fake-gh.ts';
import { deciderAnswer, writerAnswer, type Script } from '../helpers/fake-runtime.ts';
import { reviewScript } from '../helpers/fix-pass-fixture.ts';
import { fakeClaude } from '../helpers/launcher.ts';
import { commitAll, git, write } from '../helpers/repository.ts';
import { reportText, ReviewSandbox, sandboxConcurrency, scopeSource } from '../helpers/review-sandbox.ts';

/** A file as GitHub lists it for a pull request. */
interface ListedFile {
  readonly filename: string;
  readonly status: string;
  readonly patch?: string;
}

/** The files GitHub lists for the sandbox's own change: one modified, one added, one removed. */
const sandboxFiles: readonly ListedFile[] = [
  { filename: 'src/a.ts', status: 'modified', patch: '@@ -1,3 +1,7 @@' },
  { filename: 'src/b.ts', status: 'added', patch: '@@ -0,0 +1 @@' },
  { filename: 'src/gone.ts', status: 'removed', patch: '@@ -1 +0,0 @@' },
];

/** What `gh` answers for pull request #42 of the sandbox, whose change is the last commit, with `files` as GitHub lists them. */
function pullRequestSteps(box: ReviewSandbox, files: readonly ListedFile[] = sandboxFiles): FakeGhStep[] {
  const head = git(box.repo, 'rev-parse', 'HEAD');
  const baseHead = 'd'.repeat(40);
  return [
    { endpoint: 'repos/{owner}/{repo}/pulls/42', pages: [{ body: { html_url: 'https://github.com/acme/widgets/pull/42', number: 42, state: 'open', merged: false, head: { sha: head }, base: { ref: 'main' }, changed_files: files.length, title: 'Parse with a guard', body: 'Why the parser needs a guard.' } }] },
    { endpoint: 'repos/acme/widgets/git/ref/heads/main', pages: [{ body: { object: { sha: baseHead } } }] },
    { endpoint: `repos/acme/widgets/compare/${baseHead}...${head}`, pages: [{ body: { merge_base_commit: { sha: git(box.repo, 'rev-parse', 'HEAD~1') } } }] },
    { endpoint: 'repos/acme/widgets/pulls/42/files?per_page=100', pages: [{ body: files }] },
  ];
}

/** The scope of `review --pr 42`, read through `gh`. */
const pullRequestSource = (box: ReviewSandbox, gh: Gh): ScopeSource => ({
  named: true,
  pullRequest: true,
  choice: () => ({ mode: 'pull-request', request: { pullRequest: { number: 42, repository: null }, paths: [] } }),
  request: () => resolvePullRequestScope(box.repo, { pullRequest: { number: 42, repository: null }, paths: [] }, gh),
});

/** A sandbox scripted with `script` whose `gh` answers for pull request #42 of its last commit, listed as `files`. */
function pullRequestSandbox(t: TestContext, script: Script, files?: readonly ListedFile[], prepare: (box: ReviewSandbox) => void = () => {}): { box: ReviewSandbox; scope: ScopeSource } {
  const box = ReviewSandbox.forTest(t, script);
  prepare(box);
  const { gh } = fakeGhWith(t, pullRequestSteps(box, files));
  return { box, scope: pullRequestSource(box, gh) };
}

/** The files and flags of one invocation, as the command line builds them, the fake runtime's argument a flag as --executable-arg is; a file given is written, and one not given is left as it is. */
interface SourceOptions {
  readonly operator?: string;
  readonly clone?: string;
  readonly sets?: readonly string[];
  readonly fix?: boolean;
}

function sourceFor(box: ReviewSandbox, options: SourceOptions = {}): ConfigurationSource {
  const directory = join(box.directory, 'config');
  mkdirSync(directory, { recursive: true });
  const file = (name: string, text: string | undefined): string => {
    const path = join(directory, name);
    if (text !== undefined) writeFileSync(path, text);
    return path;
  };
  const flags = flagLayerOf([...dedicatedFlagValues({ runtime: 'claude', policy: {}, checks: options.fix === true ? ReviewSandbox.checkFlags() : null, executableArgs: [fakeClaude] }), ...(options.sets ?? []).map(parseSetFlag)]);
  return configurationSource({ worktree: box.repo, locations: { operator: file('operator.toml', options.operator), clone: file('clone.toml', options.clone), invocation: null }, repositoryConfig: true, flags });
}

/** The repository's file committed as the base of a pull request whose change adds src/c.ts. */
function repositoryFileAtBase(text: string): (box: ReviewSandbox) => void {
  return (box) => {
    write(box.repo, repositoryConfigPath, text);
    commitAll(box.repo, 'the policy');
    write(box.repo, 'src/c.ts', 'export const c = 1;\n');
    commitAll(box.repo, 'the change under review');
  };
}

/** What GitHub lists for the change `repositoryFileAtBase` makes. */
const addedC: readonly ListedFile[] = [{ filename: 'src/c.ts', status: 'added', patch: '@@ -0,0 +1 @@' }];

/** The run's events as kind and version. */
const kindsOf = (box: ReviewSandbox): { kind: string; version: number; payload: Record<string, unknown> }[] =>
  box.checkpoint.ledger.events(box.run().id).map((event) => ({ kind: event.kind, version: event.version, payload: JSON.parse(event.payload) as Record<string, unknown> }));

/** The settings the run recorded at its configuration. */
const recordedSettings = (box: ReviewSandbox): { values: Record<string, unknown>; layers: Record<string, string> } => kindsOf(box).find((event) => event.kind === 'review.configured')!.payload.settings as never;

/** The writer's explanation of SCAN-1, which cites the head's src/a.ts. */
const scanOneExplained = {
  title: 'parse() reads the length of a null text',
  problem: 'A caller that passes null meets a crash.',
  cases: [{ sentence: 'other() passes null to parse(), which reads its length.', lines: { side: 'head', path: 'src/a.ts', from: 1, to: 3 } }],
  diagram: null,
  decision: 'deep-review would guard the null before parse() reads it.',
};

// R18, R19, TD8 of the review on the pull request.
describe('the explanation of a read-only run of a pull request', { timeout: 600_000, concurrency: sandboxConcurrency }, () => {
  it('records review.configured@10 with the second record of the settings, plans explanation right after decision, launches the writer without a shell and records its answer', async (t) => {
    const { box, scope } = pullRequestSandbox(t, { ...reviewScript, writer: { output: writerAnswer(['SCAN-1', 'SCAN-2'], { 'SCAN-1': scanOneExplained }) } });
    const recordFile = join(box.directory, 'writer.json');
    reportText(await box.review('claude', { scope }, { FAKE_RECORD: recordFile, FAKE_RECORD_ROLE: 'writer' }));
    const events = kindsOf(box);
    const configured = events.find((event) => event.kind === 'review.configured')!;
    assert.equal(configured.version, 10);
    const settings = recordedSettings(box);
    assert.deepEqual([settings.values['review.language'], settings.values['github.executable'], settings.values['github.args']], ['en', 'gh', []]);
    assert.deepEqual([settings.layers['review.language'], settings.layers['github.executable'], settings.layers['github.args']], ['default', 'default', 'default']);
    // The phases started in order, explanation right after decision.
    const started = events.filter((event) => event.kind === 'phase.started').map((event) => [event.payload.phase, event.version]);
    const decision = started.findIndex(([phase]) => phase === 'decision');
    assert.deepEqual(started.slice(decision, decision + 2).map(([phase]) => phase), ['decision', 'explanation']);
    assert.equal(started[decision + 1]![1], 8, 'phase.started@8, the first version that names the phase');
    // The writer's answer is the one recorded, with SCAN-2 marked unexplained and nothing dropped.
    const recorded = events.find((event) => event.kind === 'explanation.recorded')!;
    assert.equal(recorded.version, 1);
    const state = box.run();
    const writer = Object.values(state.workers).find((worker) => worker.launch.label === 'writer explanation:explanation')!;
    assert.deepEqual([recorded.payload.workerId, recorded.payload.dropped, recorded.payload.unexplained], [writer.launch.workerId, [], ['SCAN-2']]);
    const answer = recordedAnswerOf(state.explanation!, box.checkpoint.evidence)!;
    assert.deepEqual(answer.findings.map((finding) => [finding.id, finding.unexplained]), [['SCAN-1', false], ['SCAN-2', true]]);
    // The report counts the phase among the statistics, at report.written@8.
    assert.equal(events.find((event) => event.kind === 'report.written')!.version, 8);
    assert.ok((events.find((event) => event.kind === 'report.written')!.payload.statistics as { phases: { phase: string }[] }).phases.some((row) => row.phase === 'explanation'));
    // On Claude Code the writer reads files and runs no shell, and its prompt holds neither the title nor the body of the pull request (PD8).
    const seen = JSON.parse(readFileSync(recordFile, 'utf8')) as { argv: string[]; stdin: string };
    assert.equal(seen.argv[seen.argv.indexOf('--tools') + 1], 'Read,Glob,Grep');
    assert.doesNotMatch(seen.stdin, /Parse with a guard|Why the parser needs a guard/);
    assert.ok(box.logs.some((line) => line.startsWith(`run ${state.id}: configured for `) && line.endsWith('; it explains its review in en')), box.logs.join('\n'));
  });

  it('neither records version 10 nor plans the explanation for a --branch run or a fix run of a pull request', async (t) => {
    const branch = ReviewSandbox.forTest(t, { triage: { exit: 2 } });
    await branch.review('claude', { scope: scopeSource(() => ({ range: { from: 'HEAD~1', to: 'HEAD', mergeBase: true }, paths: [] })) });
    const fixing = pullRequestSandbox(t, { triage: { exit: 2 } });
    await fixing.box.review('claude', { scope: fixing.scope, configuration: sourceFor(fixing.box, { fix: true }), fix: ReviewSandbox.checkFlags() });
    for (const box of [branch, fixing.box]) {
      assert.equal(kindsOf(box).find((event) => event.kind === 'review.configured')!.version, 9);
      assert.equal(box.run().review!.phases.explanation.status, 'skipped');
      assert.equal('review.language' in recordedSettings(box).values, false);
    }
    assert.notEqual(fixing.box.run().scope!.pullRequest, null, 'the fix run is of the pull request');
  });

  it('records each part dropped and writes the report when the writer fails twice', async (t) => {
    const { box, scope } = pullRequestSandbox(t, { ...reviewScript, writer: { exit: 1 } });
    reportText(await box.review('claude', { scope }));
    const recorded = kindsOf(box).find((event) => event.kind === 'explanation.recorded')!.payload as { workerId: string | null; answer: unknown; dropped: { part: string; finding?: string; failures: string[] }[] };
    assert.equal(recorded.workerId, null);
    assert.equal(recorded.answer, null, 'no answer passed any part');
    assert.deepEqual(recorded.dropped.map((part) => part.finding ?? part.part), ['conclusion', 'account', 'SCAN-1', 'SCAN-2']);
    assert.ok(recorded.dropped.every((part) => part.failures.some((failure) => /exited with code 1|exit code 1|exit 1/.test(failure))), JSON.stringify(recorded.dropped));
    assert.equal(box.run().review!.phases.explanation.status, 'degraded');
    assert.ok(box.logs.some((line) => line.startsWith('phase explanation: 4 parts of the explanation dropped: ')), box.logs.join('\n'));
    assert.notEqual(box.run().review!.report, null, 'the run wrote its report');
  });

  it('records each part dropped and writes the report when the run meets its budget before the writer', async (t) => {
    const { box, scope } = pullRequestSandbox(t, { ...reviewScript, decider: { output: deciderAnswer([{}, {}, { decision: 'leave' }]), costUsd: 5 } });
    reportText(await box.review('claude', { scope, flags: { budgetUsd: 5 } }));
    const state = box.run();
    assert.equal(Object.values(state.workers).some((worker) => worker.launch.label === 'writer explanation:explanation'), false, 'no writer launched');
    const recorded = kindsOf(box).find((event) => event.kind === 'explanation.recorded')!.payload as { dropped: { part: string; finding?: string; failures: string[] }[] };
    assert.deepEqual(recorded.dropped.map((part) => part.finding ?? part.part), ['conclusion', 'account', 'SCAN-1', 'SCAN-2']);
    assert.ok(recorded.dropped.every((part) => part.failures.some((failure) => failure.includes('budget'))), JSON.stringify(recorded.dropped));
  });
});

// R20, PD12 of the review on the pull request.
describe('the language of the review', { timeout: 600_000, concurrency: sandboxConcurrency }, () => {
  /** The language a read-only run of a pull request recorded under these files and flags, with its layer, the run blocked at its triage. */
  async function recordedLanguage(t: TestContext, repository: string, options: SourceOptions): Promise<[unknown, string | undefined]> {
    const { box, scope } = pullRequestSandbox(t, { triage: { exit: 2 } }, addedC, repositoryFileAtBase(repository));
    const outcome = await box.review('claude', { scope, configuration: sourceFor(box, options) });
    assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome));
    const settings = recordedSettings(box);
    return [settings.values['review.language'], settings.layers['review.language']];
  }

  it('takes the repository\'s file over the operator\'s, and the clone\'s file and --set over both', async (t) => {
    const repository = 'schema = 1\nreview.language = "ja"\n';
    assert.deepEqual(await recordedLanguage(t, 'schema = 1\n', { operator: 'schema = 1\nreview.language = "ko"\n' }), ['ko', 'operator'], 'the operator\'s file decides where the repository\'s sets none');
    assert.deepEqual(await recordedLanguage(t, repository, { operator: 'schema = 1\nreview.language = "ko"\n' }), ['ja', 'repository']);
    assert.deepEqual(await recordedLanguage(t, repository, { operator: 'schema = 1\nreview.language = "ko"\n', clone: 'schema = 1\nreview.language = "fr"\n' }), ['fr', 'clone']);
    assert.deepEqual(await recordedLanguage(t, repository, { clone: 'schema = 1\nreview.language = "fr"\n', sets: ['review.language="de"'] }), ['de', 'flag']);
  });

  it('records the language before the first worker, and a resume writes in it after the operator\'s file changes', async (t) => {
    const { box, scope } = pullRequestSandbox(t, { triage: { exit: 2 } });
    const first = await box.review('claude', { scope, configuration: sourceFor(box, { operator: 'schema = 1\nreview.language = "ko"\n' }) });
    assert.equal(first.kind, 'blocked', JSON.stringify(first));
    const kinds = kindsOf(box).map((event) => event.kind);
    assert.ok(kinds.indexOf('review.configured') < kinds.indexOf('worker.launched'), kinds.join(', '));
    assert.equal(recordedSettings(box).values['review.language'], 'ko');
    box.script({});
    reportText(await box.review('claude', { scope, configuration: sourceFor(box, { operator: 'schema = 1\nreview.language = "ja"\n' }) }));
    const state = box.run();
    assert.match(box.promptOf(state, 'writer explanation:explanation'), /^Write every text of your answer in the language `ko` \(Korean\)\.$/m);
    assert.ok(box.logs.includes(`run ${state.id}: review.language is now "ja" from the operator's file, which is not applied; the run keeps "ko" from the operator's file`), box.logs.join('\n'));
  });
});
