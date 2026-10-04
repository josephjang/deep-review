import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checksPlannedV2, conventionSourceSchema, plannedCheckSchemaV2, surveyedCheckSchema, surveyFailedV1, surveyRecordedV1 } from '../../src/checkpoint/events.ts';
import { InvalidHistoryError } from '../../src/checkpoint/errors.ts';
import { conventionsKnown, lastSurvey } from '../../src/checkpoint/survey-state.ts';
import { fixPhases, phases } from '../../src/review/vocabulary.ts';
import { configured, launch, plannedChecks, surveyAnswer, surveyConfigured, surveyConfiguredFix, surveyedCheck, worker, type History } from '../helpers/review-history.ts';

const user = '/home/me/.codex/AGENTS.md';
const repositorySource = { path: 'docs/contributing.md', level: 'repository', governs: 'style', appliesTo: null, grounds: null };
const userSource = { path: user, level: 'user', governs: 'the reviewer\'s rules', appliesTo: null, grounds: 'AGENTS.md imports it' };
const fourChecks = [surveyedCheck('build', null), surveyedCheck('typecheck', 'uv run mypy src'), surveyedCheck('lint', 'ruff check .', 'ruff'), surveyedCheck('test', 'uv run pytest')];
const unavailable = { code: 'check-unavailable', detail: 'lint: `ruff check .` (from .github/workflows/ci.yml), ruff not found', action: 'install it' };

/** A survey phase begun, its surveyor launched and finished, ready for its answer. */
const surveying = (history: History, n = 1, attempt = 1): History => (attempt === 1 ? history.start('survey') : history.start('survey', attempt)).worker(n, 'surveyor survey:survey');

/** A plan of four checks, each one decided by the flags or by the survey's answer above. */
const plannedV2 = (lint: Record<string, unknown> = { kind: 'lint', command: null, origin: 'flag', reason: 'dropped by --no-check', source: null }): Record<string, unknown> => ({
  checks: [
    { kind: 'build', command: null, origin: 'none', reason: 'no build step', source: null },
    { kind: 'typecheck', command: 'uv run mypy src', origin: 'survey', reason: null, source: { path: '.github/workflows/ci.yml', quote: 'run: uv run mypy src', basis: 'stated' } },
    lint,
    { kind: 'test', command: 'uv run pytest', origin: 'survey', reason: null, source: { path: '.github/workflows/ci.yml', quote: 'run: uv run pytest', basis: 'stated' } },
  ],
});

describe('the survey fold', () => {
  it('starts a run configured at version 3 with its survey pending and empty, and one at version 1 or 2 with it skipped and none', () => {
    const review = surveyConfigured().review();
    assert.deepEqual(review.phases.survey, { status: 'pending', attempt: 0 });
    assert.deepEqual(review.survey, { answers: [], failure: null, lastBlock: null });
    assert.deepEqual(review.configuration.survey, { userRules: 'judge' });
    for (const phase of fixPhases) assert.equal(review.phases[phase].status, 'skipped', phase);
    const fixing = surveyConfiguredFix().review();
    assert.deepEqual(fixing.phases.survey, { status: 'pending', attempt: 0 });
    for (const phase of fixPhases) assert.equal(fixing.phases[phase].status, 'pending', phase);
    assert.equal(configured().review().survey, null);
    assert.equal(configured().review().phases.survey.status, 'skipped');
    assert.equal(phases[0], 'survey', 'the survey runs before every other phase');
  });

  it('refuses the triage before the survey of a version 3 run, as any phase before its predecessor', () => {
    assert.throws(() => surveyConfigured().start('triage').fold(), /starts phase triage while phase survey is pending/);
  });

  it('folds the answer of a read-only run, its unit answered, and what it says of the conventions', () => {
    const history = surveying(surveyConfigured()).add('survey.recorded', surveyAnswer(worker(1), { conventions: [repositorySource, userSource], userRules: [{ path: user, applied: true, reason: 'imported' }] })).finish('survey');
    const review = history.review();
    assert.equal(review.phases.survey.status, 'completed');
    assert.equal(review.units.survey.survey?.answeredBy, worker(1));
    assert.equal(lastSurvey(review.survey!)?.workerId, worker(1));
    assert.deepEqual(conventionsKnown(review.survey), { status: 'surveyed', sources: [repositorySource, userSource], userRules: [{ path: user, applied: true, reason: 'imported' }] });
    assert.deepEqual(conventionsKnown(null), { status: 'predates-survey' });
    assert.deepEqual(conventionsKnown(surveyConfigured().review().survey), { status: 'pending' });
  });

  it('records the survey phase\'s last blocker, which the next start keeps while it clears the run\'s', () => {
    const blocked = surveying(surveyConfiguredFix()).add('survey.recorded', surveyAnswer(worker(1), { checks: fourChecks })).finish('survey', 'blocked', 1, unavailable);
    assert.deepEqual(blocked.review().survey?.lastBlock, unavailable);
    const reentered = blocked.start('survey', 2).review();
    assert.equal(reentered.blocker, null);
    assert.deepEqual(reentered.survey?.lastBlock, unavailable);
  });

  it('opens a re-entered survey\'s unit again, keeping its answer as the run\'s last, its failures, and accepting a new answer that replaces it', () => {
    const blocked = surveying(surveyConfiguredFix()).add('survey.recorded', surveyAnswer(worker(1), { checks: fourChecks })).finish('survey', 'blocked', 1, unavailable);
    const reentered = blocked.start('survey', 2);
    const review = reentered.review();
    assert.equal(review.units.survey.survey?.answeredBy, null, 'the unit is open in the new attempt');
    assert.equal(review.survey?.answers.length, 1, 'the answer stays the run\'s last survey');
    const resurveyed = reentered.worker(2, 'surveyor survey:survey').add('survey.recorded', surveyAnswer(worker(2), { checks: fourChecks.map((check) => ({ ...check, missingTool: null })) })).review();
    assert.deepEqual(resurveyed.survey?.answers.map((answer) => answer.workerId), [worker(1), worker(2)]);
    assert.equal(lastSurvey(resurveyed.survey!)?.workerId, worker(2));
    // A survey left running by an engine that stopped is opened again too, and an interrupted attempt keeps counting against it.
    const lost = surveyConfigured().start('survey').add('worker.launched', launch(worker(3), 'surveyor survey:survey')).add('worker.lost', { workerId: worker(3), phase: 'survey', key: 'survey', reason: 'the engine exited' }, 3);
    assert.deepEqual(lost.start('survey', 2).review().units.survey.survey, { answeredBy: null, failures: [{ workerId: worker(3), reason: 'the engine exited', lost: true }] });
  });

  it('goes on without a read-only run\'s survey, recording CONVENTIONS as not run when no source is left, and running it on the policy\'s file when one is', () => {
    const failed = surveyConfigured().start('survey').add('survey.failed', { reason: '2 attempts did not complete', conventions: [], userRules: [] }).finish('survey', 'degraded').review();
    assert.equal(failed.phases.survey.status, 'degraded');
    assert.equal(failed.anglesNotRun.CONVENTIONS, 'the survey failed, so no convention source is known: 2 attempts did not complete');
    assert.deepEqual(conventionsKnown(failed.survey), { status: 'failed', reason: '2 attempts did not complete', sources: [], userRules: [] });
    const applied = surveyConfigured({ survey: { userRules: 'apply' } }).start('survey')
      .add('survey.failed', { reason: 'failed', conventions: [{ ...userSource, grounds: 'applied by the policy value apply' }], userRules: [{ path: user, applied: true, reason: 'applied by the policy value apply' }] }).review();
    assert.deepEqual(applied.anglesNotRun, {}, 'CONVENTIONS holds the change to the file the policy applies');
    // Under judge a failed survey leaves every user-level file unjudged, so none applies and CONVENTIONS is not run.
    const unjudged = surveyConfigured().start('survey').add('survey.failed', { reason: 'failed', conventions: [], userRules: [{ path: user, applied: false, reason: 'not judged, since the survey failed' }] }).review();
    assert.deepEqual(conventionsKnown(unjudged.survey), { status: 'failed', reason: 'failed', sources: [], userRules: [{ path: user, applied: false, reason: 'not judged, since the survey failed' }] });
    assert.equal(unjudged.anglesNotRun.CONVENTIONS, 'the survey failed, so no convention source is known: failed');
  });

  it('plans a fix run\'s checks from its survey and the flags while the phase runs, once', () => {
    const recorded = surveying(surveyConfiguredFix()).add('survey.recorded', surveyAnswer(worker(1), { checks: fourChecks }));
    const review = recorded.add('checks.planned', plannedV2(), 2).finish('survey').review();
    assert.deepEqual(review.fix?.checks.planned, { ...plannedV2(), manager: null });
    // A run whose survey failed plans its checks from the flags alone.
    const flagged = { checks: ['build', 'typecheck', 'lint', 'test'].map((kind) => ({ kind, command: `make ${kind}`, origin: 'flag', reason: null, source: null })) };
    const unsurveyed = surveyConfiguredFix().start('survey').add('survey.failed', { reason: 'failed', conventions: [], userRules: [] }).add('checks.planned', flagged, 2).finish('survey', 'degraded').review();
    assert.deepEqual(unsurveyed.fix?.checks.planned?.checks.map((check) => check.command), ['make build', 'make typecheck', 'make lint', 'make test']);
  });

  const refusals: [string, () => History, RegExp][] = [
    ['a survey on a run configured before the survey existed', () => configured().add('survey.recorded', surveyAnswer(worker(1))), /before the survey existed/],
    ['a survey outside its phase', () => surveyConfigured().add('survey.recorded', surveyAnswer(worker(1))), /while it is pending/],
    ['two answers in one attempt', () => surveying(surveyConfigured()).add('survey.recorded', surveyAnswer(worker(1))).add('survey.recorded', surveyAnswer(worker(1))), /already answered/],
    ['checks on a read-only run', () => surveying(surveyConfigured()).add('survey.recorded', surveyAnswer(worker(1), { checks: [] })), /surveyed checks on a run without the fix pass/],
    ['no checks on a fix run', () => surveying(surveyConfiguredFix()).add('survey.recorded', surveyAnswer(worker(1))), /without checks on a run with the fix pass/],
    ['a repository source that is not a repository path', () => surveying(surveyConfigured()).add('survey.recorded', surveyAnswer(worker(1), { conventions: [{ ...repositorySource, path: '../outside.md' }] })), /not a repository path/],
    ['an absolute repository source', () => surveying(surveyConfigured()).add('survey.recorded', surveyAnswer(worker(1), { conventions: [{ ...repositorySource, path: 'C:/repo/AGENTS.md' }] })), /not a repository path/],
    ['a user-level file left out under apply', () => surveying(surveyConfigured({ survey: { userRules: 'apply' } })).add('survey.recorded', surveyAnswer(worker(1), { userRules: [{ path: user, applied: false, reason: 'no' }] })), /under the policy value apply/],
    ['a user-level file applied under ignore', () => surveying(surveyConfigured({ survey: { userRules: 'ignore' } })).add('survey.recorded', surveyAnswer(worker(1), { conventions: [userSource], userRules: [{ path: user, applied: true, reason: 'yes' }] })), /under the policy value ignore/],
    ['a user-level file applied by a failed survey under judge', () => surveyConfigured().start('survey').add('survey.failed', { reason: 'failed', conventions: [userSource], userRules: [{ path: user, applied: true, reason: 'imported' }] }), /applies a user-level rules file with no survey to judge it under the policy value judge/],
    ['an answer after the checks are planned', () => surveying(surveyConfiguredFix()).add('survey.recorded', surveyAnswer(worker(1), { checks: fourChecks })).add('checks.planned', plannedV2(), 2).add('survey.recorded', surveyAnswer(worker(1), { checks: fourChecks })), /after its checks are planned/],
    ['an answer after the run went on without one', () => surveyConfigured().start('survey').add('survey.failed', { reason: 'failed', conventions: [], userRules: [] }).worker(1, 'surveyor survey:survey').add('survey.recorded', surveyAnswer(worker(1))), /after the run went on without its survey/],
    ['going on without a survey after an answer', () => surveying(surveyConfiguredFix()).add('survey.recorded', surveyAnswer(worker(1), { checks: fourChecks })).finish('survey', 'blocked', 1, unavailable).start('survey', 2).add('survey.failed', { reason: 'failed', conventions: [], userRules: [] }), /after recording an answer/],
    ['going on without a survey twice', () => surveyConfigured().start('survey').add('survey.failed', { reason: 'a', conventions: [], userRules: [] }).add('survey.failed', { reason: 'b', conventions: [], userRules: [] }), /after the run went on without its survey/],
    ['a check-unavailable blocker outside the survey', () => surveyConfigured().start('survey').add('survey.failed', { reason: 'a', conventions: [], userRules: [] }).finish('survey', 'degraded').start('triage').add('phase.finished', { phase: 'triage', attempt: 1, outcome: 'blocked', blocker: unavailable }, 3), /which only the survey finds/],
    ['a version 2 plan on a run configured before the survey existed', () => withV2Plan(configured()), /configured without the fix pass|before the survey existed/],
    ['a version 2 plan before the survey answered or failed', () => surveyConfiguredFix().start('survey').add('checks.planned', plannedV2(), 2), /before its survey is recorded/],
    ['a version 2 plan outside the survey phase', () => surveying(surveyConfiguredFix()).add('survey.recorded', surveyAnswer(worker(1), { checks: fourChecks })).add('checks.planned', plannedV2(), 2).finish('survey').add('checks.planned', plannedV2(), 2), /twice/],
    ['a planned survey command the survey did not give', () => surveying(surveyConfiguredFix()).add('survey.recorded', surveyAnswer(worker(1), { checks: fourChecks })).add('checks.planned', plannedV2({ kind: 'lint', command: 'eslint .', origin: 'survey', reason: null, source: { path: '.github/workflows/ci.yml', quote: 'run: ruff check .', basis: 'stated' } }), 2), /not the survey's runnable command/],
    ['a planned survey command whose tool is missing', () => surveying(surveyConfiguredFix()).add('survey.recorded', surveyAnswer(worker(1), { checks: fourChecks })).add('checks.planned', plannedV2({ kind: 'lint', command: 'ruff check .', origin: 'survey', reason: null, source: { path: '.github/workflows/ci.yml', quote: 'run: ruff check .', basis: 'stated' } }), 2), /not the survey's runnable command/],
    ['no check for a kind the survey gave a command', () => surveying(surveyConfiguredFix()).add('survey.recorded', surveyAnswer(worker(1), { checks: fourChecks })).add('checks.planned', plannedV2({ kind: 'lint', command: null, origin: 'none', reason: 'none', source: null }), 2), /plans no lint check, for which the survey gave/],
    ['a survey check for a kind the survey did not answer', () => surveying(surveyConfiguredFix()).add('survey.recorded', surveyAnswer(worker(1), { checks: fourChecks.filter((check) => check.kind !== 'test') })).add('checks.planned', plannedV2(), 2), /surveyed no such kind/],
    ['a version 1 plan on a surveyed run', () => surveyConfiguredFix().add('checks.planned', plannedChecks), /by the manifest rules on a run its survey decides them for/],
  ];

  for (const [name, history, message] of refusals) {
    it(`refuses ${name}`, () => {
      assert.throws(() => history().fold(), (error: unknown) => error instanceof InvalidHistoryError && message.test(error.message), name);
    });
  }
});

/** A run with a version 2 plan of checks appended, for the refusal of one on a run that cannot have it. */
function withV2Plan(history: History): History {
  return history.add('checks.planned', plannedV2(), 2);
}

describe('the survey\'s payloads', () => {
  it('give a user-level source alone its grounds', () => {
    assert.ok(conventionSourceSchema.safeParse(repositorySource).success);
    assert.ok(conventionSourceSchema.safeParse(userSource).success);
    assert.ok(!conventionSourceSchema.safeParse({ ...repositorySource, grounds: 'g' }).success);
    assert.ok(!conventionSourceSchema.safeParse({ ...userSource, grounds: null }).success);
    assert.ok(!conventionSourceSchema.safeParse({ ...repositorySource, appliesTo: [] }).success, 'an empty list of globs is null');
  });

  it('give a surveyed command its basis and source, a missing tool only a command, and a kind with none a reason', () => {
    assert.ok(surveyedCheckSchema.safeParse(surveyedCheck('lint', 'ruff check .', 'ruff')).success);
    assert.ok(surveyedCheckSchema.safeParse(surveyedCheck('build', null)).success);
    assert.ok(!surveyedCheckSchema.safeParse({ ...surveyedCheck('lint', 'ruff check .'), source: null }).success);
    assert.ok(!surveyedCheckSchema.safeParse({ ...surveyedCheck('lint', 'ruff check .'), basis: null }).success);
    assert.ok(!surveyedCheckSchema.safeParse({ ...surveyedCheck('build', null), missingTool: 'make' }).success);
    assert.ok(!surveyedCheckSchema.safeParse({ ...surveyedCheck('build', null), reason: null }).success);
  });

  it('hold the sources and the decisions to each other: no path twice, and the user-level sources exactly the files applied', () => {
    const answer = (change: Record<string, unknown>): boolean => surveyRecordedV1.safeParse(surveyAnswer(worker(1), change)).success;
    assert.ok(answer({ conventions: [repositorySource, userSource], userRules: [{ path: user, applied: true, reason: 'r' }] }));
    assert.ok(answer({ conventions: [repositorySource], userRules: [{ path: user, applied: false, reason: 'r' }] }));
    assert.ok(!answer({ conventions: [userSource], userRules: [{ path: user, applied: false, reason: 'r' }] }), 'listed but not applied');
    assert.ok(!answer({ conventions: [], userRules: [{ path: user, applied: true, reason: 'r' }] }), 'applied but not listed');
    assert.ok(!answer({ conventions: [repositorySource, repositorySource] }), 'a source twice');
    assert.ok(!answer({ userRules: [{ path: user, applied: false, reason: 'a' }, { path: user, applied: false, reason: 'b' }] }), 'a file decided twice');
    assert.ok(!answer({ checks: [surveyedCheck('lint', null), surveyedCheck('lint', null)] }), 'a kind twice');
    assert.ok(!surveyFailedV1.safeParse({ reason: 'r', conventions: [repositorySource], userRules: [] }).success, 'a failed survey names no repository source');
  });

  it('give a planned check a source exactly for the survey\'s command, a reason exactly with no command, and one per kind in run order', () => {
    const survey = { kind: 'test', command: 'npm test', origin: 'survey', reason: null, source: { path: 'package.json', quote: 'q', basis: 'stated' } };
    assert.ok(plannedCheckSchemaV2.safeParse(survey).success);
    assert.ok(!plannedCheckSchemaV2.safeParse({ ...survey, source: null }).success);
    assert.ok(!plannedCheckSchemaV2.safeParse({ ...survey, origin: 'flag' }).success, 'a flag names no source');
    assert.ok(!plannedCheckSchemaV2.safeParse({ ...survey, command: null, reason: 'r' }).success, 'the survey\'s check has a command');
    assert.ok(!plannedCheckSchemaV2.safeParse({ kind: 'test', command: 'x', origin: 'none', reason: null, source: null }).success, 'nobody decided a command');
    assert.ok(!plannedCheckSchemaV2.safeParse({ kind: 'test', command: null, origin: 'flag', reason: null, source: null }).success, 'no command and no reason');
    assert.ok(checksPlannedV2.safeParse(plannedV2()).success);
    const checks = plannedV2().checks as Record<string, unknown>[];
    assert.ok(!checksPlannedV2.safeParse({ checks: [...checks].reverse() }).success, 'out of run order');
    assert.ok(!checksPlannedV2.safeParse({ checks: checks.slice(1) }).success, 'a kind missing');
    assert.ok(!checksPlannedV2.safeParse({ ...plannedV2(), manager: 'npm' }).success, 'no package manager');
  });
});
