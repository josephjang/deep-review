import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { repositoryConfigPath } from '../../src/config/files.ts';
import { checkFlagsOf, dedicatedFlagValues } from '../../src/config/flags.ts';
import { flagLayerOf, parseSetFlag } from '../../src/config/resolve.ts';
import { configurationSource, type ConfigurationSource } from '../../src/config/source.ts';
import { flagCheckSettings } from '../../src/review/checks/discover.ts';
import { commitRun } from '../../src/review/commit.ts';
import type { ReviewOutcome } from '../../src/review/controller.ts';
import { describeRun } from '../../src/review/status.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { deciderAnswer, fixerAnswer, type Script } from '../helpers/fake-runtime.ts';
import { fixedA, fixedB, reviewScript } from '../helpers/fix-pass-fixture.ts';
import { fakeClaude, until } from '../helpers/launcher.ts';
import { commitAll, git, write } from '../helpers/repository.ts';
import { afterFind, fakeCheckCommand, loadedRunnerTimeoutMs, reportText, ReviewSandbox, sandboxConcurrency, scopeSource } from '../helpers/review-sandbox.ts';
import { quietSurvey, reported, withSurvey } from '../helpers/review-history.ts';
import { ReviewRefusedError } from '../../src/review/errors.ts';

/** The labels of a run's workers, sorted. */
const labelsOf = (state: RunState): string[] => Object.values(state.workers).map((worker) => worker.launch.label ?? '').sort();

/** `after` less one of each label of `before`, sorted: the workers a later invocation added. */
const addedLabels = (before: readonly string[], after: readonly string[]): string[] => {
  const left = [...before];
  return after.filter((label) => {
    const index = left.indexOf(label);
    if (index === -1) return true;
    left.splice(index, 1);
    return false;
  });
};

// R1 to R10 of fix pass continuation: a read-only run reviewed to its report, then the same command with --fix.
describe('the continuation of a finished read-only run', { timeout: 900_000, concurrency: sandboxConcurrency }, () => {
  /** The review of `reviewScript` with fixers that apply both findings routed to them. */
  const continuedScript: Script = {
    ...reviewScript,
    'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
    'fixer:fixes:c2-1': { edits: [{ writes: { 'src/b.ts': fixedB }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/b.ts'], subject: 'fix(b): Import parse' }]) },
  };
  /** The flags that settle build, typecheck and lint with the stand-in checks, leaving test to the surveyor. */
  const testUnsettled = flagCheckSettings({ build: fakeCheckCommand('build'), typecheck: fakeCheckCommand('typecheck'), lint: fakeCheckCommand('lint') }, []);
  /** A read-only review of the sandbox to its report, returning the report's path. */
  const readOnly = async (box: ReviewSandbox): Promise<string> => {
    const outcome = await box.review('claude');
    reportText(outcome);
    return outcome.kind === 'report' ? outcome.reportPath : '';
  };
  /** The one line the log has that matches `pattern`, or a failure naming the log. */
  const logLine = (box: ReviewSandbox, pattern: RegExp): string => {
    const line = box.logs.find((candidate) => pattern.test(candidate));
    assert.ok(line !== undefined, `${pattern.source} in\n${box.logs.join('\n')}`);
    return line;
  };

  it('continues the run into the fix pass: one surveyor for the checks the flags leave, the fixers, and a second report naming the first, nothing reviewed again (R1, R2, R4, R7, R9)', async (t) => {
    const box = ReviewSandbox.forTest(t, continuedScript);
    const firstPath = await readOnly(box);
    const firstText = readFileSync(firstPath, 'utf8');
    const before = box.run();
    box.logs.length = 0;
    const outcome = await box.review('claude', { fix: testUnsettled, flags: { strongModel: 'another-model' } });
    const text = reportText(outcome);
    const state = box.run();
    const review = state.review!;
    assert.equal(state.id, before.id, 'the same run, continued');
    assert.deepEqual(addedLabels(labelsOf(before), labelsOf(state)), ['fixer fixes:c1-1', 'fixer fixes:c2-1', 'surveyor survey:survey'], 'no worker of a read-only phase ran again');
    // The log names the run, its read-only report and its spend against the budget in force (R2, PD7), and the models flag as ignored (R3).
    logLine(box, new RegExp(`^run ${before.id}: continued into the fix pass; its read-only report is ${RegExp.escape(firstPath)}; spent \\d+\\.\\d\\d USD of the \\d+\\.\\d\\d USD run budget$`));
    logLine(box, /; --strong-model is ignored$/);
    assert.ok(!box.logs.some((line) => /is pinned without the fix pass/.test(line)), 'a continuation is not a resume that ignores --fix');
    // The survey was asked again for the kind the flags left, its conventions standing (R4).
    assert.deepEqual(review.phases.survey, { status: 'completed', attempt: 2 });
    assert.equal(review.survey!.answers.length, 2);
    assert.deepEqual(review.survey!.answers[1]!.conventions, review.survey!.answers[0]!.conventions);
    const surveyors = Object.values(state.workers).filter((worker) => worker.launch.label === 'surveyor survey:survey');
    const asked = box.checkpoint.evidence.read(surveyors.at(-1)!.launch.prompt).toString('utf8');
    assert.match(asked, /^This run was reviewed read-only and is now continued into the fix pass\./m);
    assert.match(asked, /^Kinds to choose: test$/m);
    assert.deepEqual(review.fix!.checks.planned!.checks.map((check) => [check.kind, check.layer ?? check.origin]), [['build', 'flag'], ['typecheck', 'flag'], ['lint', 'flag'], ['test', 'none']]);
    // The fix pass ran on the decisions the read-only run recorded (R1).
    assert.deepEqual(review.fix!.plan!.routes, [{ id: 'SCAN-1', route: 'fixer' }, { id: 'SCAN-2', route: 'fixer' }, { id: 'SWEEP-1', route: 'held' }]);
    assert.equal(review.fix!.revisions.length, 2);
    assert.equal(readFileSync(join(box.repo, 'src', 'a.ts'), 'utf8'), fixedA);
    // A second report beside the first, whose header names it; the first is unchanged (R7, PD10).
    assert.ok(outcome.kind === 'report' && outcome.reportPath !== firstPath);
    assert.equal(readFileSync(firstPath, 'utf8'), firstText);
    // The first report by its name in the store, the same on every machine (R15 of the brief of a run).
    assert.match(text, new RegExp(`^Continued: into the fix pass on ${RegExp.escape(review.continuedFrom!.at)}, after the read-only report artifacts/${review.continuedFrom!.report.report.sha256}$`, 'm'));
    assert.match(text, /^## Fixes$/m);
    assert.equal(review.report!.statistics.phases.find((row) => row.phase === 'survey')?.workers, 2, 'the statistics count both passes');
    const described = describeRun(state, claudeAdapter, (reference) => box.checkpoint.evidence.pathOf(reference));
    assert.ok(described.lines.includes(`Continued from: ${firstPath}, into the fix pass on ${review.continuedFrom!.at}`), described.lines.join('\n'));
    assert.deepEqual(described.json.continuedFrom, { report: firstPath, at: review.continuedFrom!.at });
    assert.equal(described.json.report, outcome.kind === 'report' ? outcome.reportPath : null);
    // The continued run commits as any fix run (R9): one commit per revision, in ledger order, which is the order the two concurrent fixers settled in.
    const committed = commitRun({ checkpoint: box.checkpoint, worktree: box.repo, log: () => {} });
    assert.deepEqual(committed.commits.map((made) => made.subject), review.fix!.revisions.map((revision) => revision.change.message.subject));
    assert.deepEqual(committed.commits.map((made) => made.subject).sort(), ['fix(a): Return 0 for a null text', 'fix(b): Import parse']);
    assert.match(git(box.repo, 'log', '-1', '--format=%B'), new RegExp(`^Deep-review: run ${before.id}, `, 'm'), 'the commit carries the run\'s trailer');
  });

  it('pins the checks the flags settle with the continuation and runs no surveyor (R4, TD3)', async (t) => {
    const box = ReviewSandbox.forTest(t, continuedScript);
    await readOnly(box);
    const before = box.run();
    box.logs.length = 0;
    reportText(await box.fix('claude'));
    const state = box.run();
    assert.deepEqual(addedLabels(labelsOf(before), labelsOf(state)), ['fixer fixes:c1-1', 'fixer fixes:c2-1']);
    assert.deepEqual(state.review!.phases.survey, { status: 'completed', attempt: 1 });
    assert.ok(state.review!.fix!.checks.planned!.checks.every((check) => check.origin === 'setting' && check.layer === 'flag'));
    logLine(box, new RegExp(`^run ${state.id}: check build: ${RegExp.escape(fakeCheckCommand('build'))} \\(flag\\)$`));
  });

  // R6 of the configuration: the continuation resolves the fix side again, at the run's base, and records it with the pin.
  it('pins the fix side of the settings with the continuation: the repository\'s file at the run\'s base, the clone\'s file and the flags, each with its layer', async (t) => {
    const box = ReviewSandbox.forTest(t, continuedScript);
    // The repository's file is at the base of the last commit, which the read-only review reads.
    const flags = ReviewSandbox.checkFlags();
    write(box.repo, repositoryConfigPath, `schema = 1\nchecks.build = ${JSON.stringify(flags.commands.build)}\nchecks.lint = ${JSON.stringify(flags.commands.lint)}\nchecks.test = "npm test"\nchecks.timeout_minutes = 30\n`);
    const base = commitAll(box.repo, 'the policy');
    write(box.repo, 'src/a.ts', 'export function parse(text: string | null) {\n  return text!.length;\n}\n\nexport function other() {\n  return parse(null);\n}\n// again\n');
    commitAll(box.repo, 'a change under the policy');
    await readOnly(box);
    const finished = box.run();
    assert.equal(finished.scope!.base, base);
    const cloneFile = join(box.directory, 'clone.toml');
    writeFileSync(cloneFile, `schema = 1\nchecks.test = ${JSON.stringify(flags.commands.test)}\ntools.path = ["bin"]\nreport.formats = ["html"]\n`);
    const layer = flagLayerOf([...dedicatedFlagValues({ runtime: 'claude', policy: {}, checks: flagCheckSettings({}, ['typecheck']), executableArgs: [fakeClaude] })]);
    const source = configurationSource({ worktree: box.repo, locations: { operator: null, clone: cloneFile, invocation: null }, repositoryConfig: true, flags: layer });
    box.logs.length = 0;
    reportText(await box.review('claude', { configuration: source, fix: checkFlagsOf(layer) }));
    const state = box.run();
    const pin = box.events(finished.id).find(([kind]) => kind === 'fix.pinned')!;
    const pinned = pin[1].settings as Record<string, unknown>;
    assert.deepEqual(pinned.values, { 'checks.build': flags.commands.build, 'checks.typecheck': false, 'checks.lint': flags.commands.lint, 'checks.test': flags.commands.test, 'tools.path': [join(box.repo, 'bin')] });
    assert.deepEqual(pinned.layers, { 'checks.build': 'repository', 'checks.typecheck': 'flag', 'checks.lint': 'repository', 'checks.test': 'clone', 'checks.timeout_minutes': 'repository', 'tools.path': 'clone' });
    // What the continuation read and did not follow is recorded with the pin, for the report (R7 of the configuration).
    assert.deepEqual((pinned.files as { layer: string; commit: string | null }[]).map((file) => [file.layer, file.commit]), [['repository', base], ['clone', null]]);
    assert.deepEqual(pinned.repository, { state: 'read', commit: base, edited: false });
    assert.deepEqual(pinned.notFollowed, [{ name: 'checks.test', repository: 'npm test', value: flags.commands.test, layer: 'clone' }]);
    assert.deepEqual((pinned.ignored as { name: string }[]).map((entry) => entry.name), ['report.formats']);
    const report = box.checkpoint.evidence.read(state.review!.report!.report).toString('utf8');
    // The facts of the run give the settings' lines beside the Settings: line, where the clone's file may be named by its path (R15 of the brief of a run).
    const facts = report.slice(report.indexOf('\n## The run\n'));
    assert.ok(facts.includes(`\nNot followed: checks.test: the repository's "npm test", this run's ${JSON.stringify(flags.commands.test)} from the clone's file.\n`), report);
    assert.match(facts, /^Ignored: report\.formats in .*clone\.toml: no such setting\.$/m);
    assert.deepEqual(state.review!.configuration.checks, { timeoutMs: 30 * 60_000 }, 'the repository\'s check timeout');
    assert.deepEqual(state.review!.fix!.checks.planned!.checks.map((check) => [check.kind, check.layer]), [['build', 'repository'], ['typecheck', 'flag'], ['lint', 'repository'], ['test', 'clone']]);
    assert.deepEqual(state.review!.phases.survey, { status: 'completed', attempt: 1 }, 'the settings settle every kind, so no surveyor runs');
    logLine(box, new RegExp(`^run ${state.id}: check build: ${RegExp.escape(flags.commands.build!)} \\(checks\\.build in the repository's file\\)$`));
  });

  it('continues the newest of two finished runs of the same change', async (t) => {
    const box = ReviewSandbox.forTest(t, continuedScript);
    await readOnly(box);
    await readOnly(box);
    const [older, newer] = box.checkpoint.foldRuns();
    reportText(await box.fix('claude'));
    const runs = box.checkpoint.foldRuns();
    assert.equal(runs.length, 2);
    assert.equal(runs.find((run) => run.id === newer!.id)!.review!.continuedFrom !== null, true, 'the newer run was continued');
    assert.equal(runs.find((run) => run.id === older!.id)!.review!.fix, null, 'the older run is untouched');
  });

  it('resumes a run another engine continued between the find and the lock, rather than creating a second active run beside it', async (t) => {
    const box = ReviewSandbox.forTest(t, continuedScript);
    await readOnly(box);
    const finished = box.run();
    const { checkpoint, acted } = afterFind(box.checkpoint, (target) => {
      target.append(finished.id, finished.lastSequence, [{ kind: 'fix.pinned', version: 1, payload: { checks: { timeoutMs: loadedRunnerTimeoutMs }, fixes: { batchSize: 4 }, plannedChecks: null } }]);
    });
    box.logs.length = 0;
    reportText(await box.review('claude', { checkpoint, fix: ReviewSandbox.checkFlags() }));
    assert.ok(acted(), 'the other engine pinned the run after the find');
    assert.equal(box.checkpoint.foldRuns().length, 1, 'no second run');
    logLine(box, new RegExp(`^run ${finished.id}: resuming$`));
    assert.equal(box.events(finished.id).filter(([kind]) => kind === 'fix.pinned').length, 1, 'this engine pinned nothing more');
    assert.notEqual(box.run().review!.report, null);
  });

  it('counts the user\'s edits outside the --path filter since the read-only report as their own work, which no revision takes and the report names nowhere (R2)', async (t) => {
    const box = ReviewSandbox.forTest(t, continuedScript);
    const scope = scopeSource(() => ({ ref: 'HEAD~1', paths: ['src'] }));
    reportText(await box.review('claude', { scope }));
    const first = box.run();
    // Edits outside src, which the continuation does not compare: a tracked file a formatter in lint rewrites at every run, and an untracked note.
    const agents = readFileSync(join(box.repo, 'AGENTS.md'), 'utf8');
    write(box.repo, 'AGENTS.md', `${agents}\nThe user's own rule.\n`);
    write(box.repo, 'notes.txt', 'n\n');
    box.checks({ lint: { write: { 'AGENTS.md': '# Rules, formatted\n' } } });
    const text = reportText(await box.fix('claude', { scope }));
    const state = box.run();
    assert.equal(state.id, first.id, 'the run was continued');
    const revised = state.review!.fix!.revisions.flatMap((revision) => revision.files.map((file) => file.path));
    assert.deepEqual([...new Set(revised)].sort(), ['src/a.ts', 'src/b.ts'], 'no revision takes the user\'s AGENTS.md, which the lint check rewrote');
    assert.doesNotMatch(text, /Files no answer names/, 'neither file is named as one the run left');
    commitRun({ checkpoint: box.checkpoint, worktree: box.repo, log: () => {} });
    assert.equal(git(box.repo, 'show', 'HEAD:AGENTS.md'), agents.trimEnd(), 'the commits leave AGENTS.md as the change had it');
    assert.equal(readFileSync(join(box.repo, 'AGENTS.md'), 'utf8'), '# Rules, formatted\n', 'and it stays in the tree, uncommitted');
  });

  /** A finished read-only run, then `change` to the repository, then --fix: the new run its triage stops early is created beside it, and the log says why. */
  const notContinued = async (t: TestContext, change: (box: ReviewSandbox) => void, worktreeMode = false): Promise<{ box: ReviewSandbox; first: RunState }> => {
    const box = ReviewSandbox.forTest(t, continuedScript);
    if (worktreeMode) write(box.repo, 'src/a.ts', 'export function parse(text: string | null) {\n  return text?.length;\n}\n');
    await readOnly(box);
    const first = box.run();
    change(box);
    box.logs.length = 0;
    box.script({ triage: { exit: 2 } });
    assert.equal((await box.fix('claude')).kind, 'blocked');
    assert.equal(box.checkpoint.foldRuns().length, 2, 'a new run beside the finished one');
    logLine(box, /^--fix: no finished read-only run of this worktree reviewed this change as it is; a new run is created$/);
    return { box, first };
  };

  it('creates a new run when a file of the scope changed since, naming the run and the file (R2, PD3)', async (t) => {
    const { box, first } = await notContinued(t, (sandbox) => write(sandbox.repo, 'src/a.ts', 'changed again\n'), true);
    logLine(box, new RegExp(`^run ${first.id}: not continued: 1 of its files changed since: src/a\\.ts$`));
  });

  it('creates a new run when a file was added to a worktree scope since', async (t) => {
    const { box, first } = await notContinued(t, (sandbox) => write(sandbox.repo, 'notes.txt', 'n\n'), true);
    logLine(box, new RegExp(`^run ${first.id}: not continued: its files are not the change named: notes\\.txt changed since and not in it$`));
  });

  it('creates a new run when the change named is of another mode', async (t) => {
    const { box, first } = await notContinued(t, (sandbox) => write(sandbox.repo, 'notes.txt', 'n\n'));
    logLine(box, new RegExp(`^run ${first.id}: not continued: its scope is last-commit ${first.scope!.base}\\.\\.${first.scope!.head}, not the one named$`));
  });

  it('creates a new run when HEAD moved, the change otherwise the same', async (t) => {
    const { box, first } = await notContinued(t, (sandbox) => git(sandbox.repo, 'commit', '-q', '--amend', '-m', 'the change under review, reworded'));
    logLine(box, new RegExp(`^run ${first.id}: not continued: HEAD is ${git(box.repo, 'rev-parse', 'HEAD')}, not ${first.scope!.head}$`));
  });

  /** The settings of a review whose --set leaves docs/ out of the change, with no file of the operator's or the clone's. */
  const excludingDocs = (box: ReviewSandbox): ConfigurationSource => {
    const layer = flagLayerOf([...dedicatedFlagValues({ runtime: 'claude', policy: {}, checks: null, executableArgs: [fakeClaude] }), parseSetFlag('scope.exclude=["docs/**"]')]);
    return configurationSource({ worktree: box.repo, locations: { operator: null, clone: join(box.directory, 'absent.toml'), invocation: null }, repositoryConfig: true, flags: layer });
  };

  // A run is compared with the change as its own patterns leave it, and patterns since dropped that refuse it pass that run over rather than refuse the command.
  it('creates a new run when the --path names only what the finished run\'s own scope.exclude leaves out, naming the refusal, and refuses an empty change', async (t) => {
    const box = ReviewSandbox.forTest(t, continuedScript);
    reportText(await box.review('claude', { configuration: excludingDocs(box) }));
    const first = box.run();
    assert.deepEqual(first.scope!.request.exclude, ['docs/**']);
    // The operator has dropped the pattern, and the change now edits only docs/guide.md and src/c.ts.
    write(box.repo, 'docs/guide.md', '# Guide\n');
    write(box.repo, 'src/c.ts', 'export const c = 1;\n');
    commitAll(box.repo, 'a change of the guide');
    box.script({ triage: { exit: 2 } });
    // An empty change is refused with no pattern too, so the command ends there and no run is created.
    const empty = scopeSource(() => ({ range: { from: 'HEAD', to: 'HEAD', mergeBase: false }, paths: [] }));
    await assert.rejects(box.fix('claude', { scope: empty }), (error: unknown) => error instanceof ReviewRefusedError && /^The change is empty: .*; nothing to review$/.test(error.message));
    assert.equal(box.checkpoint.foldRuns().length, 1);
    box.logs.length = 0;
    assert.equal((await box.fix('claude', { scope: scopeSource(() => ({ paths: ['docs'] })) })).kind, 'blocked');
    const created = box.checkpoint.foldRuns().find((run) => run.id !== first.id)!;
    assert.deepEqual(created.scope!.files.map((file) => file.path), ['docs/guide.md'], 'the new run reviews what today\'s settings leave');
    logLine(box, /^--fix: no finished read-only run of this worktree reviewed this change as it is; a new run is created$/);
    logLine(box, new RegExp(`^run ${first.id}: not continued: its scope\\.exclude refuses the change named: Scope path names only changes that scope\\.exclude \\(docs/\\*\\*\\) leaves out: docs$`));
  });

  it('creates a new run when the finished run\'s own scope.exclude leaves out every path of the change now', async (t) => {
    const box = ReviewSandbox.forTest(t, continuedScript);
    reportText(await box.review('claude', { configuration: excludingDocs(box) }));
    const first = box.run();
    write(box.repo, 'docs/guide.md', '# Guide\n');
    commitAll(box.repo, 'a change of the guide alone');
    box.script({ triage: { exit: 2 } });
    box.logs.length = 0;
    assert.equal((await box.fix('claude')).kind, 'blocked');
    const created = box.checkpoint.foldRuns().find((run) => run.id !== first.id)!;
    assert.deepEqual(created.scope!.files.map((file) => file.path), ['docs/guide.md']);
    logLine(box, new RegExp(`^run ${first.id}: not continued: its scope\\.exclude refuses the change named: The change has no path left to review: scope\\.exclude \\(docs/\\*\\*\\) leaves out all 1 of its changed paths$`));
  });

  it('creates a new run beside a finished run configured before the decision step, naming it', async (t) => {
    const box = ReviewSandbox.forTest(t, { triage: { exit: 2 } });
    // A run as an engine before the decision step recorded it, in this worktree; its scope is not this change's, which the reason never reaches.
    // Its synthetic evidence is not in the store, so its events go to the ledger as they are, past the checkpoint's check of every reference.
    const legacy = box.checkpoint.createRun({ worktree: box.repo });
    const history = withSurvey(reported(), quietSurvey(false));
    box.checkpoint.ledger.write((tx) => {
      for (const event of history.events.filter((candidate) => candidate.kind !== 'run.created')) tx.insertEvent({ runId: legacy.id, kind: event.kind, version: event.version, payload: JSON.stringify(event.payload), recordedAt: event.recordedAt, engine: event.engine });
    });
    assert.equal(box.checkpoint.fold(legacy.id).review?.phases.decision.status, 'skipped', 'a complete run configured before the decision step');
    assert.equal((await box.fix('claude')).kind, 'blocked');
    assert.equal(box.checkpoint.foldRuns().length, 2);
    logLine(box, new RegExp(`^run ${legacy.id}: not continued: it was configured before the decision step, which a fix run routes its findings by$`));
  });

  it('creates a new run with --fresh, saying no finished run was considered, and resumes an active run whatever --fresh says (R2, PD2)', async (t) => {
    const box = ReviewSandbox.forTest(t, continuedScript);
    await readOnly(box);
    box.script({ triage: { exit: 2 } });
    box.logs.length = 0;
    assert.equal((await box.fix('claude', { fresh: true })).kind, 'blocked');
    logLine(box, /^--fresh: no finished run is considered; a new run is created$/);
    const runs = box.checkpoint.foldRuns();
    assert.equal(runs.length, 2);
    const active = runs.at(-1)!;
    box.logs.length = 0;
    assert.equal((await box.fix('claude', { fresh: true })).kind, 'blocked');
    assert.equal(box.checkpoint.foldRuns().length, 2, 'the active run resumed');
    logLine(box, new RegExp(`^run ${active.id} is active and resumes; --fresh is ignored$`));
  });

  it('refuses another runtime or roles that digest otherwise, naming --fresh as the way out and leaving the run complete (R3, PD8)', async (t) => {
    const box = ReviewSandbox.forTest(t, continuedScript);
    await readOnly(box);
    const state = box.run();
    await assert.rejects(box.fix('codex'), (error: unknown) => error instanceof ReviewRefusedError
      && error.message === `run ${state.id} is pinned to runtime claude, not codex; run it with --runtime claude, or start a new run with --fresh`);
    writeFileSync(join(box.rolesRoot, 'fragments', 'rubrics.md'), `${readFileSync(join(box.rolesRoot, 'fragments', 'rubrics.md'), 'utf8')}\nOne more rule.\n`);
    await assert.rejects(box.fix('claude'), (error: unknown) => error instanceof ReviewRefusedError
      && /; run it with the roles it started with \(--roles <dir>\), or start a new run with --fresh$/.test(error.message) && !error.message.includes('abandon'));
    assert.equal(box.run().lastSequence, state.lastSequence, 'nothing was appended');
    assert.equal(box.run().review!.fix, null);
  });

  it('refuses a continuation whose pinned executable no longer qualifies, as a resume is refused, and leaves the run complete (R3)', async (t) => {
    const box = ReviewSandbox.forTest(t, continuedScript);
    await readOnly(box);
    const state = box.run();
    // An update replaced the pinned binary with one lacking a flag the adapter uses.
    await assert.rejects(box.fix('claude', {}, { FAKE_HELP_OMIT: '--json-schema' }), (error: unknown) => error instanceof ReviewRefusedError && error.code === 'runtime-unqualified'
      && /lacks flags the adapter uses/.test(error.message)
      && error.message.includes(`the executable run ${state.id} is pinned to`));
    assert.equal(box.run().lastSequence, state.lastSequence, 'nothing was appended');
    assert.equal(box.run().review!.fix, null);
  });

  const refusesNothingToFix = async (t: TestContext, decided: Parameters<typeof deciderAnswer>[0] | null, counts: string): Promise<void> => {
    const box = ReviewSandbox.forTest(t, decided === null ? {} : { ...reviewScript, decider: { output: deciderAnswer(decided) } });
    await readOnly(box);
    const state = box.run();
    await assert.rejects(box.fix('claude'), (error: unknown) => error instanceof ReviewRefusedError
      && error.message === `run ${state.id} has no finding to fix: ${counts}; nothing to continue; start a new run with --fresh to review it again`);
    assert.equal(box.run().lastSequence, state.lastSequence, 'nothing was appended');
    assert.deepEqual(box.checkRuns(), [], 'no check ran');
  };

  it('refuses a run whose decisions send no finding to a fixer, with the counts (R5, PD6)', async (t) => {
    await refusesNothingToFix(t, [{ decision: 'leave' }, { decision: 'ask', edits: false }, { decision: 'leave' }], '0 decided fix, 2 left, 1 asked with the code kept');
  });

  it('refuses a run whose review ranked no finding (R5)', async (t) => {
    await refusesNothingToFix(t, null, 'its review ranked no finding');
  });

  /**
   * A --fix run of the script given, stopped by drift: once the worker
   * `label` is running, its scripted wait on `marker` lets it answer after
   * an empty commit moved HEAD; HEAD is reset to where it was, and the
   * outcome returned.
   */
  const driftDuring = async (box: ReviewSandbox, label: string, marker: string, message: string): Promise<ReviewOutcome> => {
    const pending = box.fix('claude');
    let head: string;
    try {
      await until(() => box.runningWorkers().includes(label), `${label} on the ledger`, 120_000);
      head = git(box.repo, 'rev-parse', 'HEAD');
      git(box.repo, 'commit', '-q', '--allow-empty', '-m', message);
    } finally {
      writeFileSync(marker, '');
    }
    const outcome = await pending;
    git(box.repo, 'reset', '-q', '--soft', head);
    return outcome;
  };

  it('resumes a continuation stopped in its fixes with the same command, as any fix run (R8)', async (t) => {
    const box = ReviewSandbox.forTest(t, continuedScript);
    await readOnly(box);
    const first = box.run();
    const marker = join(box.directory, 'c1-may-answer');
    box.script({ ...continuedScript, 'fixer:fixes:c1-1': { waitFor: marker, output: fixerAnswer([{ status: 'deferred', files: [] }]) } });
    const blocked = await driftDuring(box, 'fixer fixes:c1-1', marker, 'a commit during the run');
    assert.ok(blocked.kind === 'blocked' && blocked.blocker.phase === 'fixes' && blocked.blocker.code === 'drift', JSON.stringify(blocked));
    box.logs.length = 0;
    reportText(await box.fix('claude'));
    const state = box.run();
    assert.equal(state.id, first.id, 'the continued run resumed');
    logLine(box, new RegExp(`^run ${first.id}: resuming$`));
    assert.ok(!box.logs.some((line) => /continued into the fix pass;/.test(line)), 'a resume pins nothing again');
    assert.equal(box.events(first.id).filter(([kind]) => kind === 'fix.pinned').length, 1);
    assert.notEqual(state.review!.continuedFrom, null);
  });

  it('resumes a continuation stopped after its checks, in its repair, with the same command (R8)', async (t) => {
    const box = ReviewSandbox.forTest(t, continuedScript);
    await readOnly(box);
    const first = box.run();
    const marker = join(box.directory, 'repair-may-answer');
    box.checks({ test: { failIfContains: { 'src/a.ts': 'BROKEN' } } });
    box.script({
      ...continuedScript,
      'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': `${fixedA}// BROKEN\n` } }], output: fixerAnswer([{ files: ['src/a.ts'] }]) },
      'fixer:repair:repair': { waitFor: marker, edits: [{ writes: { 'src/a.ts': fixedA }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Drop the line that broke the test' }]) },
    });
    const blocked = await driftDuring(box, 'fixer repair:repair', marker, 'a commit during the repair');
    assert.ok(blocked.kind === 'blocked' && blocked.blocker.phase === 'repair' && blocked.blocker.code === 'drift', JSON.stringify(blocked));
    assert.equal(box.run().review!.fix!.checks.runs.checks.find((run) => run.kind === 'test')?.outcome, 'failed', 'the checks after the fixes ran before the stop');
    box.logs.length = 0;
    reportText(await box.fix('claude'));
    const state = box.run();
    assert.equal(state.id, first.id, 'the continued run resumed');
    logLine(box, new RegExp(`^run ${first.id}: resuming$`));
    assert.deepEqual(state.review!.fix!.checks.runs['repair-checks'].map((run) => [run.kind, run.outcome]), [['build', 'passed'], ['typecheck', 'passed'], ['lint', 'passed'], ['test', 'passed']]);
  });

  it('resumes a continuation stopped in its survey as a fix run, and never continues the continued run again (R8)', async (t) => {
    const box = ReviewSandbox.forTest(t, continuedScript);
    await readOnly(box);
    const first = box.run();
    box.script({ ...continuedScript, surveyor: { exit: 2 } });
    const blocked = await box.review('claude', { fix: testUnsettled });
    assert.ok(blocked.kind === 'blocked' && blocked.blocker.phase === 'survey' && blocked.blocker.code === 'worker-failed', JSON.stringify(blocked));
    box.script(continuedScript);
    box.logs.length = 0;
    reportText(await box.review('claude'));
    assert.equal(box.run().id, first.id, 'the same run resumed');
    logLine(box, new RegExp(`^run ${first.id} is pinned to the fix pass and continues it; the absence of --fix is ignored$`));
    assert.notEqual(box.run().review!.report, null);
    box.script({ triage: { exit: 2 } });
    box.logs.length = 0;
    assert.equal((await box.fix('claude')).kind, 'blocked');
    assert.equal(box.checkpoint.foldRuns().length, 2, 'a new run');
    logLine(box, new RegExp(`^run ${first.id}: not continued: it was continued into the fix pass already$`));
  });
});
