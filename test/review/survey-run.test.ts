import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ReviewOutcome } from '../../src/review/controller.ts';
import { policyFileName } from '../../src/review/policy.ts';
import { blockerActions, surveyWorkerFailedAction } from '../../src/review/vocabulary.ts';
import { fakeCheckCommand, ReviewSandbox, sandboxConcurrency } from '../helpers/review-sandbox.ts';

/** A surveyed check of the sandbox's package.json: the stand-in check's command, stated, with the tool given missing. */
const fromPackage = (kind: 'build' | 'typecheck' | 'lint' | 'test', missingTool: string | null = null, command: string = fakeCheckCommand(kind)): Record<string, unknown> =>
  ({ kind, command, basis: 'stated', source: { path: 'package.json', quote: `"${kind}": "node ..."` }, missingTool, reason: null });

/** The flags that settle build and typecheck with the stand-in checks, leaving lint and test to the surveyor. */
const halfFlagged = { commands: { build: fakeCheckCommand('build'), typecheck: fakeCheckCommand('typecheck') }, dropped: [] as ('build' | 'typecheck' | 'lint' | 'test')[] };

describe('the repository survey in a run', { timeout: 600_000, concurrency: sandboxConcurrency }, () => {
  const report = (outcome: ReviewOutcome): string => {
    assert.equal(outcome.kind, 'report', JSON.stringify(outcome));
    return outcome.kind === 'report' ? readFileSync(outcome.reportPath, 'utf8') : '';
  };
  const surveyors = (box: ReviewSandbox): number => Object.values(box.run().workers).filter((worker) => worker.launch.label === 'surveyor survey:survey').length;

  it('blocks a fix run on a check whose tool is missing before any other worker, and goes on without it after --no-check, with no new survey (R15, PD12, TD7)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    box.script({ surveyor: { output: { conventions: [], userRules: [], checks: [fromPackage('lint', 'ruff', 'ruff check .'), fromPackage('test')], note: '' } } });
    const blocked = await box.review('claude', { fix: halfFlagged });
    assert.ok(blocked.kind === 'blocked', JSON.stringify(blocked));
    if (blocked.kind === 'blocked') {
      assert.equal(blocked.blocker.code, 'check-unavailable');
      assert.equal(blocked.blocker.phase, 'survey');
      assert.equal(blocked.blocker.detail, 'the project defines a check this machine cannot run: lint: `ruff check .` (from package.json), ruff not found');
      assert.equal(blocked.blocker.action, blockerActions['check-unavailable']);
    }
    assert.equal(Object.values(box.run().workers).length, 1, 'only the surveyor was paid for');
    assert.equal(box.run().review!.fix!.checks.planned, null, 'nothing is planned while a defined check cannot run');
    // The operator goes without lint: the flags of the next invocation settle the block, and the recorded survey plans the rest.
    report(await box.review('claude', { fix: { ...halfFlagged, dropped: ['lint'] } }));
    const state = box.run();
    assert.equal(surveyors(box), 1, 'the survey is not repeated when the flags settle its block');
    assert.deepEqual(state.review!.phases.survey, { status: 'completed', attempt: 2 });
    assert.deepEqual(state.review!.fix!.checks.planned!.checks.map((check) => [check.kind, check.origin, check.reason]), [['build', 'flag', null], ['typecheck', 'flag', null], ['lint', 'flag', 'dropped by --no-check'], ['test', 'survey', null]]);
    assert.deepEqual(box.checkRuns(), ['build', 'typecheck', 'test'], 'the baseline ran the flagged checks and the survey\'s, and lint never');
    assert.ok(box.logs.some((line) => /^phase survey: re-entered \(attempt 2\), clearing the check-unavailable blocker$/.test(line)), box.logs.join('\n'));
  });

  it('surveys again a survey blocked on a missing tool when no flag settles it, and goes on once the new answer finds the tool (R15)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    box.script({ surveyor: [
      { output: { conventions: [], userRules: [], checks: [fromPackage('lint', 'ruff', 'ruff check .'), fromPackage('test')], note: '' } },
      { output: { conventions: [], userRules: [], checks: [fromPackage('lint'), fromPackage('test')], note: 'ruff is installed now' } },
    ] });
    const blocked = await box.review('claude', { fix: halfFlagged });
    assert.ok(blocked.kind === 'blocked' && blocked.blocker.code === 'check-unavailable', JSON.stringify(blocked));
    report(await box.review('claude', { fix: halfFlagged }));
    const state = box.run();
    assert.equal(surveyors(box), 2, 'the operator installed the tool and ran again: a fresh surveyor looked');
    assert.deepEqual(state.review!.survey!.answers.map((answer) => answer.note), ['', 'ruff is installed now']);
    assert.deepEqual(state.review!.fix!.checks.planned!.checks.map((check) => check.origin), ['flag', 'flag', 'survey', 'survey']);
    assert.deepEqual(box.checkRuns(), ['build', 'typecheck', 'lint', 'test']);
  });

  it('retries a survey answer that names no file of the repository, and records the second (R8)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    box.script({ surveyor: [
      { output: { conventions: [{ path: 'CONTRIBUTING.md', level: 'repository', governs: 'style', appliesTo: null, grounds: null }], userRules: [], checks: null, note: '' } },
      { output: { conventions: [{ path: 'AGENTS.md', level: 'repository', governs: 'how globs are quoted', appliesTo: null, grounds: null }], userRules: [], checks: null, note: '' } },
    ] });
    report(await box.review('claude'));
    const state = box.run();
    assert.equal(surveyors(box), 2);
    assert.match(box.events(state.id).find(([kind]) => kind === 'attempt.failed')?.[1].reason as string, /^structural check: The convention source "CONTRIBUTING\.md" is not a regular file of the repository$/);
    assert.deepEqual(state.review!.survey!.answers.map((answer) => answer.conventions.map((source) => source.path)), [['AGENTS.md']]);
  });

  it('goes on without a read-only review\'s survey that fails twice, CONVENTIONS not run and the sweep told (R9, PD6)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    box.script({ surveyor: { exit: 2 } });
    const text = report(await box.review('claude'));
    const state = box.run();
    assert.equal(state.review!.phases.survey.status, 'degraded');
    assert.match(state.review!.survey!.failure!.reason, /^2 attempts did not complete: /);
    assert.match(state.review!.anglesNotRun.CONVENTIONS!, /^the survey failed, so no convention source is known: 2 attempts did not complete/);
    assert.equal(Object.values(state.workers).filter((worker) => worker.launch.label === 'finder-CONVENTIONS finders:CONVENTIONS').length, 0, 'no CONVENTIONS finder ran');
    assert.match(box.promptOf(state, 'sweep sweep:sweep'), /These angles did not run, so their territory is yours to cover: CONVENTIONS \(the survey failed/);
    assert.match(box.promptOf(state, 'triage triage:SCAN'), /### Convention sources\n\nThe repository survey failed, so no convention source is known\./);
    assert.match(text, /- Angle CONVENTIONS did not run: the survey failed/);
  });

  it('blocks a fix run whose survey fails twice with the action naming the flags, and goes on without it once they settle all four (R9, PD6)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    box.script({ surveyor: { exit: 2 } });
    const blocked = await box.review('claude', { fix: halfFlagged });
    assert.ok(blocked.kind === 'blocked' && blocked.blocker.code === 'worker-failed' && blocked.blocker.phase === 'survey', JSON.stringify(blocked));
    if (blocked.kind === 'blocked') assert.equal(blocked.blocker.action, surveyWorkerFailedAction);
    assert.equal(surveyors(box), 2);
    // Three kinds settled run the surveyor again; four let the run go on without it.
    report(await box.fix('claude'));
    const state = box.run();
    assert.equal(surveyors(box), 2, 'no surveyor once the flags settle every check');
    assert.equal(state.review!.phases.survey.status, 'degraded');
    assert.match(state.review!.survey!.failure!.reason, /^the survey blocked, the surveyor worker for survey:survey failed twice: .*; this invocation's --check and --no-check flags settle every check, so the run goes on without it$/);
    assert.ok(state.review!.fix!.checks.planned!.checks.every((check) => check.origin === 'flag'));
    // The failure and the plan are one append, so no run is left with one and not the other.
    const failed = box.checkpoint.ledger.events(state.id).find((event) => event.kind === 'survey.failed')!;
    const planned = box.checkpoint.ledger.events(state.id).find((event) => event.kind === 'checks.planned')!;
    assert.equal(planned.sequence, failed.sequence + 1);
    assert.ok(box.logs.some((line) => /^phase survey: going on without the survey: the survey blocked/.test(line)), box.logs.join('\n'));
  });

  it('offers the reviewer\'s own rules file under judge, and lists it for every later worker with its grounds when the surveyor applies it (R3)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    const userFile = join(box.home, '.codex', 'AGENTS.md');
    mkdirSync(join(box.home, '.codex'), { recursive: true });
    writeFileSync(userFile, '# the reviewer\'s rules\n');
    box.script({ surveyor: { output: {
      conventions: [{ path: userFile, level: 'user', governs: 'the reviewer\'s engineering rules', appliesTo: null, grounds: 'the repository\'s AGENTS.md names it' }],
      userRules: [{ path: userFile, applied: true, reason: 'the repository\'s AGENTS.md names it' }],
      checks: null,
      note: '',
    } } });
    report(await box.review('claude'));
    const state = box.run();
    assert.deepEqual(state.review!.configuration.survey, { userRules: 'judge' });
    assert.ok(box.promptOf(state, 'surveyor survey:survey').includes(`User-level rules files offered:\n- ${userFile}\n`));
    assert.ok(box.promptOf(state, 'finder-CONVENTIONS finders:CONVENTIONS').includes(`- ${userFile} (user level, the reviewer's own rules, applied because: the repository's AGENTS.md names it): the reviewer's engineering rules`));
    assert.ok(box.logs.includes(`run ${state.id}: user-level rules ${userFile}: applied, the repository's AGENTS.md names it`), box.logs.join('\n'));
  });

  it('applies the reviewer\'s own rules file under apply and leaves it out under ignore, offering it to neither surveyor, as the run pinned (R3, TD13)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    const userFile = join(box.home, '.claude', 'CLAUDE.md');
    mkdirSync(join(box.home, '.claude'), { recursive: true });
    writeFileSync(userFile, '# the reviewer\'s rules\n');
    const setUserRules = (userRules: string): void => {
      const path = join(box.rolesRoot, policyFileName);
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), survey: { userRules } }, null, 2));
    };
    setUserRules('apply');
    box.script({ triage: { exit: 2 } });
    assert.equal((await box.review('claude')).kind, 'blocked');
    const applied = box.run();
    assert.deepEqual(applied.review!.configuration.survey, { userRules: 'apply' });
    assert.match(box.promptOf(applied, 'surveyor survey:survey'), /^User-level rules files offered: none\n\nThe review policy settles whether the reviewer's own rules apply/m);
    assert.deepEqual(applied.review!.survey!.answers[0]!.userRules, [{ path: userFile, applied: true, reason: 'applied by the policy value apply' }]);
    assert.ok(box.promptOf(applied, 'triage triage:SCAN').includes(`- ${userFile} (user level, the reviewer's own rules, applied because: applied by the policy value apply)`));
    // The resumed run keeps the value it pinned, whatever the policy file says now.
    setUserRules('ignore');
    box.script({});
    report(await box.review('claude'));
    assert.deepEqual(box.run().review!.configuration.survey, { userRules: 'apply' });

    box.checkpoint.append(box.run().id, box.run().lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'next case' } }]);
    report(await box.review('claude'));
    const ignored = box.checkpoint.foldRuns().at(-1)!;
    assert.deepEqual(ignored.review!.configuration.survey, { userRules: 'ignore' });
    assert.deepEqual(ignored.review!.survey!.answers[0]!.userRules, [{ path: userFile, applied: false, reason: 'ignored by the policy value ignore' }]);
    assert.ok(!box.promptOf(ignored, 'triage triage:SCAN').includes(userFile), 'no worker hears of an ignored file');
  });
});
