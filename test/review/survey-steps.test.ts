import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { conventionsKnown } from '../../src/checkpoint/survey-state.ts';
import { noCheckFlags, type CheckFlags } from '../../src/review/checks/discover.ts';
import { checkUnavailableBlocker, nextStep, unitsOf, workerFailedBlocker, type Live } from '../../src/review/steps.ts';
import { blockerActions, surveyWorkerFailedAction } from '../../src/review/vocabulary.ts';
import { launch, surveyAnswer, surveyConfigured, surveyConfiguredFix, surveyedCheck, worker, type History } from '../helpers/review-history.ts';

const idle: Live = { running: new Set(), spend: { usd: 0, charged: 0, lost: 0 }, evidencePath: (reference) => `/evidence/${reference.sha256.slice(0, 8)}`, checkFlags: noCheckFlags, claimsLost: null };
const live = (change: Partial<Live>): Live => ({ ...idle, ...change });
const flags = (commands: CheckFlags['commands'], dropped: CheckFlags['dropped'] = []): CheckFlags => ({ commands, dropped });
const allFour = flags({ build: 'make build', typecheck: 'make typecheck', lint: 'make lint', test: 'make test' });

const surveyor = { phase: 'survey' as const, key: 'survey', role: 'surveyor' as const };
const stated = [surveyedCheck('build', null), surveyedCheck('typecheck', 'uv run mypy src'), surveyedCheck('lint', 'ruff check .'), surveyedCheck('test', 'uv run pytest')];
const missingRuff = stated.map((check) => (check.kind === 'lint' ? surveyedCheck('lint', 'ruff check .', 'ruff') : check));

/** The survey phase of a fix run begun and checked, its surveyor answered with `checks`. */
const answered = (checks: readonly Record<string, unknown>[], history: History = surveyConfiguredFix().start('survey'), n = 1): History =>
  history.worker(n, 'surveyor survey:survey').add('survey.recorded', surveyAnswer(worker(n), { checks }));
/** A failed attempt of the surveyor. */
const failedOnce = (history: History, n: number): History => history.worker(n, 'surveyor survey:survey', { outcome: 'failed', output: null, error: 'bad' }).add('attempt.failed', { phase: 'survey', key: 'survey', workerId: worker(n), reason: 'failed: bad' }, 3);

describe('nextStep in the survey', () => {
  it('starts a surveyed run with the survey, checks the tree, then launches its one surveyor, read-only or fixing', () => {
    for (const history of [surveyConfigured(), surveyConfiguredFix()]) {
      assert.deepEqual(nextStep(history.review(), idle), { kind: 'start-phase', phase: 'survey', attempt: 1 });
      assert.deepEqual(nextStep(history.add('phase.started', { phase: 'survey', attempt: 1 }, 3).review(), idle), { kind: 'check-worktree', phase: 'survey', attempt: 1, moment: 'start' });
    }
    assert.deepEqual(unitsOf(surveyConfigured().review(), 'survey'), [surveyor]);
    assert.deepEqual(nextStep(surveyConfigured().start('survey').review(), idle), { kind: 'launch', units: [surveyor] });
    assert.deepEqual(nextStep(surveyConfigured().start('survey').review(), live({ running: new Set(['survey:survey']) })), { kind: 'await' });
  });

  it('finishes a read-only survey once it answered, and never plans a check there', () => {
    const review = surveyConfigured().start('survey').worker(1, 'surveyor survey:survey').add('survey.recorded', surveyAnswer(worker(1))).review();
    assert.deepEqual(nextStep(review, live({ checkFlags: allFour })), { kind: 'finish-phase', phase: 'survey', attempt: 1, outcome: 'completed', blocker: null });
    // An answer an earlier attempt recorded stands for a read-only review re-entered after its engine stopped.
    const reentered = surveyConfigured().start('survey').worker(1, 'surveyor survey:survey').add('survey.recorded', surveyAnswer(worker(1))).start('survey', 2).review();
    assert.deepEqual(nextStep(reentered, idle), { kind: 'finish-phase', phase: 'survey', attempt: 2, outcome: 'completed', blocker: null });
  });

  it('goes on without a read-only review\'s survey that failed twice, and finishes degraded', () => {
    const twice = failedOnce(failedOnce(surveyConfigured().start('survey'), 1), 2);
    const step = nextStep(twice.review(), idle);
    assert.equal(step.kind, 'degrade');
    assert.deepEqual(step.kind === 'degrade' ? step.degradations.map((degradation) => degradation.kind) : [], ['survey.failed']);
    const failed = twice.add('survey.failed', { reason: '2 attempts did not complete', conventions: [], userRules: [] }).review();
    assert.deepEqual(nextStep(failed, idle), { kind: 'finish-phase', phase: 'survey', attempt: 1, outcome: 'degraded', blocker: null });
  });

  it('blocks a read-only survey whose failures hold a worker lost with its engine, as any interrupted unit', () => {
    const lost = failedOnce(surveyConfigured().start('survey'), 1).add('worker.launched', launch(worker(2), 'surveyor survey:survey')).add('worker.lost', { workerId: worker(2), phase: 'survey', key: 'survey', reason: 'the engine exited' }, 3);
    const step = nextStep(lost.review(), idle);
    assert.ok(step.kind === 'finish-phase' && step.blocker?.code === 'worker-failed' && step.blocker.action === blockerActions['worker-failed'], JSON.stringify(step));
  });

  it('plans a fix run\'s checks from the survey it answered and this invocation\'s flags, a flag over the survey', () => {
    const review = answered(stated).review();
    assert.deepEqual(nextStep(review, idle), { kind: 'plan-checks', without: null, checks: [
      { kind: 'build', command: null, origin: 'none', reason: 'no build step', source: null },
      { kind: 'typecheck', command: 'uv run mypy src', origin: 'survey', reason: null, source: { path: '.github/workflows/ci.yml', quote: 'run: uv run mypy src', basis: 'stated' } },
      { kind: 'lint', command: 'ruff check .', origin: 'survey', reason: null, source: { path: '.github/workflows/ci.yml', quote: 'run: ruff check .', basis: 'stated' } },
      { kind: 'test', command: 'uv run pytest', origin: 'survey', reason: null, source: { path: '.github/workflows/ci.yml', quote: 'run: uv run pytest', basis: 'stated' } },
    ] });
    const planned = answered(stated).add('checks.planned', { checks: [
      { kind: 'build', command: null, origin: 'none', reason: 'no build step', source: null },
      { kind: 'typecheck', command: 'uv run mypy src', origin: 'survey', reason: null, source: { path: '.github/workflows/ci.yml', quote: 'run: uv run mypy src', basis: 'stated' } },
      { kind: 'lint', command: 'eslint .', origin: 'flag', reason: null, source: null },
      { kind: 'test', command: 'uv run pytest', origin: 'survey', reason: null, source: { path: '.github/workflows/ci.yml', quote: 'run: uv run pytest', basis: 'stated' } },
    ] }, 2).review();
    assert.deepEqual(nextStep(planned, idle), { kind: 'finish-phase', phase: 'survey', attempt: 1, outcome: 'completed', blocker: null });
  });

  it('blocks with check-unavailable when the answer of this attempt names a missing tool, naming the kind, command, source and tool (R15)', () => {
    const step = nextStep(answered(missingRuff).review(), idle);
    assert.deepEqual(step, { kind: 'finish-phase', phase: 'survey', attempt: 1, outcome: 'blocked', blocker: checkUnavailableBlocker([{ kind: 'lint', command: 'ruff check .', source: '.github/workflows/ci.yml', missingTool: 'ruff' }]) });
    assert.ok(step.kind === 'finish-phase' && step.blocker !== null);
    if (step.kind === 'finish-phase' && step.blocker !== null) {
      assert.equal(step.blocker.detail, 'the project defines a check this machine cannot run: lint: `ruff check .` (from .github/workflows/ci.yml), ruff not found');
      assert.equal(step.blocker.action, blockerActions['check-unavailable']);
    }
    const two = checkUnavailableBlocker([{ kind: 'lint', command: 'a', source: 's', missingTool: 'x' }, { kind: 'test', command: 'b', source: 's', missingTool: 'y' }]);
    assert.equal(two.detail, 'the project defines checks this machine cannot run: lint: `a` (from s), x not found, test: `b` (from s), y not found');
    // A flag of the same invocation settles the kind before the block: nothing blocks.
    assert.equal(nextStep(answered(missingRuff).review(), live({ checkFlags: flags({}, ['lint']) })).kind, 'plan-checks');
  });

  it('plans from the blocked survey with no worker when the re-entering invocation\'s flags settle the block, and surveys again otherwise (TD7)', () => {
    const blocked = answered(missingRuff).finish('survey', 'blocked', 1, checkUnavailableBlocker([{ kind: 'lint', command: 'ruff check .', source: '.github/workflows/ci.yml', missingTool: 'ruff' }])).start('survey', 2);
    const dropped = nextStep(blocked.review(), live({ checkFlags: flags({}, ['lint']) }));
    assert.ok(dropped.kind === 'plan-checks', JSON.stringify(dropped));
    assert.deepEqual(dropped.kind === 'plan-checks' ? dropped.checks.find((check) => check.kind === 'lint') : null, { kind: 'lint', command: null, origin: 'flag', reason: 'dropped by --no-check', source: null });
    const named = nextStep(blocked.review(), live({ checkFlags: flags({ lint: 'npx ruff check .' }) }));
    assert.ok(named.kind === 'plan-checks' && named.checks.find((check) => check.kind === 'lint')?.command === 'npx ruff check .', JSON.stringify(named));
    // With no flag, the tool may have been installed: a fresh surveyor looks again.
    assert.deepEqual(nextStep(blocked.review(), idle), { kind: 'launch', units: [surveyor] });
    // Its new answer, without the missing tool, plans the checks; with it again, blocks again.
    assert.equal(nextStep(answered(stated, blocked.clone(), 2).review(), idle).kind, 'plan-checks');
    const again = nextStep(answered(missingRuff, blocked.clone(), 2).review(), idle);
    assert.ok(again.kind === 'finish-phase' && again.blocker?.code === 'check-unavailable', JSON.stringify(again));
  });

  it('surveys again a re-entered survey whose earlier answer does not cover a kind this invocation\'s flags no longer settle', () => {
    // The first invocation named lint with --check, so the surveyor chose three kinds; the engine stopped before the plan.
    const earlier = answered(stated.filter((check) => check.kind !== 'lint')).start('survey', 2);
    assert.deepEqual(nextStep(earlier.review(), idle), { kind: 'launch', units: [surveyor] });
    assert.equal(nextStep(earlier.review(), live({ checkFlags: flags({ lint: 'eslint .' }) })).kind, 'plan-checks', 'the same flag again plans without a worker');
  });

  it('blocks a fix run\'s survey that failed twice with the action that names the flags, and goes on without it when they settle all four (R9, PD6)', () => {
    const twice = failedOnce(failedOnce(surveyConfiguredFix().start('survey'), 1), 2);
    const step = nextStep(twice.review(), idle);
    assert.ok(step.kind === 'finish-phase' && step.outcome === 'blocked', JSON.stringify(step));
    const blocker = workerFailedBlocker(twice.review(), surveyor, twice.review().units.survey.survey);
    assert.deepEqual(step.kind === 'finish-phase' ? step.blocker : null, blocker);
    assert.equal(blocker.action, surveyWorkerFailedAction);
    // The action is the survey's own, read from the run's mode: a read-only survey and another phase of a fix run keep the generic one.
    assert.equal(workerFailedBlocker(surveyConfigured().review(), surveyor, twice.review().units.survey.survey).action, blockerActions['worker-failed']);
    assert.equal(workerFailedBlocker(twice.review(), { phase: 'triage', key: 'SCAN', role: 'triage' }, twice.review().units.survey.survey).action, blockerActions['worker-failed']);
    const reentered = twice.finish('survey', 'blocked', 1, blocker).start('survey', 2);
    // Three kinds settled is not enough: the survey runs again with fresh attempts.
    assert.deepEqual(nextStep(reentered.review(), live({ checkFlags: flags({ build: 'a', lint: 'b' }, ['test']) })), { kind: 'launch', units: [surveyor] });
    // One step plans the flags' checks and says why the run goes on without the survey, so the two are recorded together.
    const plan = nextStep(reentered.review(), live({ checkFlags: allFour }));
    assert.ok(plan.kind === 'plan-checks' && plan.checks.every((check) => check.origin === 'flag'), JSON.stringify(plan));
    assert.match(plan.kind === 'plan-checks' ? plan.without ?? '' : '', /^the survey blocked, the surveyor worker for survey:survey failed twice: .*; this invocation's --check and --no-check flags settle every check, so the run goes on without it$/);
    // The ledger then finishes the phase degraded.
    const planned = reentered.clone().add('survey.failed', { reason: 'went on without it', conventions: [], userRules: [] }).add('checks.planned', { checks: plan.kind === 'plan-checks' ? plan.checks : [] }, 2).review();
    assert.deepEqual(nextStep(planned, live({ checkFlags: allFour })), { kind: 'finish-phase', phase: 'survey', attempt: 2, outcome: 'degraded', blocker: null });
    // A failure the engine recorded without its plan is a history it never writes.
    assert.throws(() => nextStep(reentered.clone().add('survey.failed', { reason: 'r', conventions: [], userRules: [] }).review(), live({ checkFlags: allFour })), /planned no check/);
  });

  it('goes on without a fix run\'s survey that failed twice in this attempt when this invocation\'s flags settle all four kinds, with no block first (R9)', () => {
    // The first invocation already gave every flag: blocking would only tell the operator to run again with the flags it gave.
    const twice = failedOnce(failedOnce(surveyConfiguredFix().start('survey'), 1), 2);
    const failed = workerFailedBlocker(twice.review(), surveyor, twice.review().units.survey.survey);
    const plan = nextStep(twice.review(), live({ checkFlags: allFour }));
    assert.ok(plan.kind === 'plan-checks' && plan.checks.every((check) => check.origin === 'flag'), JSON.stringify(plan));
    assert.equal(plan.kind === 'plan-checks' ? plan.without : null, `${failed.detail}; this invocation's --check and --no-check flags settle every check, so the run goes on without it`);
    const planned = twice.clone().add('survey.failed', { reason: plan.kind === 'plan-checks' ? plan.without ?? '' : '', conventions: [], userRules: [] }).add('checks.planned', { checks: plan.kind === 'plan-checks' ? plan.checks : [] }, 2).review();
    assert.deepEqual(nextStep(planned, live({ checkFlags: allFour })), { kind: 'finish-phase', phase: 'survey', attempt: 1, outcome: 'degraded', blocker: null });
    // Three kinds settled still block, with the action that names the flags.
    const three = nextStep(twice.review(), live({ checkFlags: flags({ build: 'a', lint: 'b' }, ['test']) }));
    assert.ok(three.kind === 'finish-phase' && three.outcome === 'blocked' && three.blocker?.action === surveyWorkerFailedAction, JSON.stringify(three));
    // A worker lost with its engine is an interruption, not the survey failing: it blocks, and the next invocation surveys afresh or goes on by the block.
    const lost = failedOnce(surveyConfiguredFix().start('survey'), 1).add('worker.launched', launch(worker(2), 'surveyor survey:survey')).add('worker.lost', { workerId: worker(2), phase: 'survey', key: 'survey', reason: 'the engine exited' }, 3);
    const interrupted = nextStep(lost.review(), live({ checkFlags: allFour }));
    assert.ok(interrupted.kind === 'finish-phase' && interrupted.outcome === 'blocked' && interrupted.blocker?.code === 'worker-failed', JSON.stringify(interrupted));
  });

  it('goes on without the survey once the flags settle all four kinds, though a drift blocked the attempt the first flagged invocation re-entered (R9)', () => {
    const twice = failedOnce(failedOnce(surveyConfiguredFix().start('survey'), 1), 2);
    const failed = workerFailedBlocker(twice.review(), surveyor, twice.review().units.survey.survey);
    // The first flagged invocation finds the tree drifted at its attempt's start and blocks before it can plan.
    const drift = { code: 'drift', detail: `the worktree differs from what the run expects: HEAD is ${'b'.repeat(40)}, the run expects ${'a'.repeat(40)}`, action: blockerActions.drift };
    const drifted = twice.finish('survey', 'blocked', 1, failed)
      .add('phase.started', { phase: 'survey', attempt: 2 }, 3)
      .add('worktree.checked', { phase: 'survey', attempt: 2, moment: 'start', drifted: true, head: { expected: 'a'.repeat(40), actual: 'b'.repeat(40) }, files: [], strays: [] }, 3);
    assert.deepEqual(nextStep(drifted.review(), live({ checkFlags: allFour })), { kind: 'finish-phase', phase: 'survey', attempt: 2, outcome: 'blocked', blocker: drift });
    // The operator restores HEAD and runs again with the same flags: the drift said nothing of the survey, whose failure still stands.
    const restored = drifted.finish('survey', 'blocked', 2, drift).start('survey', 3);
    const plan = nextStep(restored.review(), live({ checkFlags: allFour }));
    assert.ok(plan.kind === 'plan-checks' && plan.checks.every((check) => check.origin === 'flag'), JSON.stringify(plan));
    assert.match(plan.kind === 'plan-checks' ? plan.without ?? '' : '', /^the survey blocked, the surveyor worker for survey:survey failed twice: /);
    // Without the flags, the operator's other choice: a fresh surveyor.
    assert.deepEqual(nextStep(restored.review(), idle), { kind: 'launch', units: [surveyor] });
  });

  it('goes on without the survey once the flags settle all four kinds, though a stopped engine left a failure in the re-entered attempt (R9)', () => {
    const twice = failedOnce(failedOnce(surveyConfiguredFix().start('survey'), 1), 2);
    const failed = workerFailedBlocker(twice.review(), surveyor, twice.review().units.survey.survey);
    // An invocation with no flag re-enters the survey, its surveyor fails once, and its engine is killed; the next one finds the attempt running.
    const reentered = twice.finish('survey', 'blocked', 1, failed).start('survey', 2);
    const interrupted = failedOnce(reentered.clone(), 3);
    assert.equal(interrupted.review().units.survey.survey?.failures.length, 1);
    const plan = nextStep(interrupted.review(), live({ checkFlags: allFour }));
    assert.ok(plan.kind === 'plan-checks' && plan.checks.every((check) => check.origin === 'flag'), JSON.stringify(plan));
    // A worker lost with that engine is no different.
    const lost = reentered.clone()
      .add('worker.launched', launch(worker(3), 'surveyor survey:survey'))
      .add('worker.lost', { workerId: worker(3), phase: 'survey', key: 'survey', reason: 'the engine exited' }, 3);
    assert.equal(nextStep(lost.review(), live({ checkFlags: allFour })).kind, 'plan-checks');
    // Flags that leave a kind unsettled retry the surveyor in the attempt.
    assert.deepEqual(nextStep(interrupted.review(), idle), { kind: 'launch', units: [surveyor] });
  });

  it('goes on from an earlier answer, its convention sources standing, when the flags settle a survey that failed twice after it, as the action says (R9)', () => {
    const unavailable = checkUnavailableBlocker([{ kind: 'lint', command: 'ruff check .', source: '.github/workflows/ci.yml', missingTool: 'ruff' }]);
    const resurveyed = answered(missingRuff).finish('survey', 'blocked', 1, unavailable).start('survey', 2);
    const twice = failedOnce(failedOnce(resurveyed, 2), 3);
    const failed = workerFailedBlocker(twice.review(), surveyor, twice.review().units.survey.survey);
    assert.deepEqual(nextStep(twice.review(), idle), { kind: 'finish-phase', phase: 'survey', attempt: 2, outcome: 'blocked', blocker: failed });
    assert.equal(failed.action, surveyWorkerFailedAction);
    assert.match(failed.action, /with the convention sources of an earlier survey of this run if one answered, and with none otherwise/);
    // The flags plan the checks over the earlier answer, and the run records no failure: that answer is still the run's survey.
    const reentered = twice.finish('survey', 'blocked', 2, failed).start('survey', 3);
    const plan = nextStep(reentered.review(), live({ checkFlags: allFour }));
    assert.ok(plan.kind === 'plan-checks' && plan.without === null && plan.checks.every((check) => check.origin === 'flag'), JSON.stringify(plan));
    const planned = reentered.add('checks.planned', { checks: plan.kind === 'plan-checks' ? plan.checks : [] }, 2).review();
    assert.deepEqual(conventionsKnown(planned.survey), { status: 'surveyed', sources: surveyAnswer(worker(1)).conventions, userRules: [] });
    assert.deepEqual(nextStep(planned, live({ checkFlags: allFour })), { kind: 'finish-phase', phase: 'survey', attempt: 3, outcome: 'completed', blocker: null });
  });

  it('launches the surveyor of a fix run whose flags settle all four kinds, on its first attempt, for the conventions', () => {
    assert.deepEqual(nextStep(surveyConfiguredFix().start('survey').review(), live({ checkFlags: allFour })), { kind: 'launch', units: [surveyor] });
    assert.equal(nextStep(answered([]).review(), live({ checkFlags: allFour })).kind, 'plan-checks');
  });

  it('blocks on the run budget before the surveyor launches, as before any launch', () => {
    const step = nextStep(surveyConfiguredFix().start('survey').review(), live({ spend: { usd: 31, charged: 0, lost: 0 } }));
    assert.ok(step.kind === 'finish-phase' && step.blocker?.code === 'budget', JSON.stringify(step));
  });

  it('starts the triage once the survey has finished', () => {
    const done = surveyConfigured().start('survey').worker(1, 'surveyor survey:survey').add('survey.recorded', surveyAnswer(worker(1))).finish('survey').review();
    assert.deepEqual(nextStep(done, idle), { kind: 'start-phase', phase: 'triage', attempt: 1 });
  });
});
