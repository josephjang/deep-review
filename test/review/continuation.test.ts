import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ReviewRefusedError } from '../../src/review/errors.ts';
import { deciderAnswer, type Script } from '../helpers/fake-runtime.ts';
import { reportText, ReviewSandbox, sandboxConcurrency } from '../helpers/review-sandbox.ts';

/** A review whose triage finds one defect in src/a.ts, which the decider decides to fix, every worker reporting 1 USD. */
const oneFix: Script = {
  '*': { costUsd: 1 },
  triage: { costUsd: 1, output: { candidates: [{ file: 'src/a.ts', line: 2, summary: 'text is dereferenced when null', detail: 'parse(null) throws' }], leads: ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'].map((angle) => ({ angle, lead: null })) } },
  decider: { costUsd: 1, output: deciderAnswer([{}]) },
};

// Fix pass continuation: what a finished read-only run is held to before it is continued.
describe('the continuation of a finished read-only run', { timeout: 900_000, concurrency: sandboxConcurrency }, () => {
  it('refuses a run whose spend reaches the run budget in force before anything is pinned or checked, and continues it once --budget-usd is raised (PD7)', async (t) => {
    const box = ReviewSandbox.forTest(t, oneFix);
    reportText(await box.review('claude'));
    const finished = box.run();
    const spent = Object.keys(finished.workers).length;
    assert.ok(spent > 2, 'the read-only run spent more than the budget the continuation is given');
    // Every check is settled by a flag, so no worker would launch before the fixes phase, whose budget gate marks every fixer unattempted.
    await assert.rejects(box.fix('claude', { flags: { budgetUsd: 2 } }), (error: unknown) => error instanceof ReviewRefusedError
      && error.message === `run ${finished.id} spent ${spent.toFixed(2)} USD of the 2.00 USD run budget, so no fixer could launch; nothing to continue; run it again with --budget-usd above ${spent.toFixed(2)}, or start a new run with --fresh`);
    assert.equal(box.run().lastSequence, finished.lastSequence, 'nothing was appended');
    assert.equal(box.run().review!.fix, null, 'the run stays read-only and complete');
    assert.deepEqual(box.checkRuns(), [], 'no check ran');
    reportText(await box.fix('claude', { flags: { budgetUsd: 100 } }));
    const state = box.run();
    assert.equal(state.id, finished.id, 'the same run, continued');
    assert.notEqual(state.review!.continuedFrom, null);
    assert.deepEqual(box.events(state.id).filter(([kind]) => kind === 'unit.unattempted'), [], 'no fixer was left unattempted for the budget');
    assert.ok(Object.values(state.workers).some((worker) => worker.launch.label === 'fixer fixes:c1-1'), 'the fixer launched');
  });

  it('refuses a run with nothing to fix for that, not for a pinned executable that no longer qualifies, whose preflight comes last', async (t) => {
    const box = ReviewSandbox.forTest(t, { ...oneFix, decider: { output: deciderAnswer([{ decision: 'leave' }]) } });
    reportText(await box.review('claude'));
    const finished = box.run();
    await assert.rejects(box.fix('claude', {}, { FAKE_HELP_OMIT: '--json-schema' }), (error: unknown) => error instanceof ReviewRefusedError
      && error.message === `run ${finished.id} has no finding to fix: 0 decided fix, 1 left, 0 asked with the code kept; nothing to continue; start a new run with --fresh to review it again`);
    assert.equal(box.run().lastSequence, finished.lastSequence, 'nothing was appended');
  });

  it('refuses a run that went on without its survey for its unsettled checks, not for a pinned executable that no longer qualifies', async (t) => {
    const box = ReviewSandbox.forTest(t, { ...oneFix, surveyor: { exit: 2 } });
    reportText(await box.review('claude'));
    const finished = box.run();
    await assert.rejects(box.fix('claude', { fix: { commands: {}, dropped: ['build', 'typecheck'] } }, { FAKE_HELP_OMIT: '--json-schema' }), (error: unknown) => error instanceof ReviewRefusedError
      && error.message === `run ${finished.id} went on without its survey, so a continuation needs every check settled: give --check <kind>=<command> or --no-check <kind> for lint, test, or start a new run with --fresh`);
    assert.equal(box.run().lastSequence, finished.lastSequence, 'nothing was appended');
  });

  it('says how to continue an active read-only run resumed with --fix only when it was configured with the decision step, which a continuation needs (R10)', async (t) => {
    const box = ReviewSandbox.forTest(t, { triage: { exit: 2 } });
    assert.equal((await box.review('claude')).kind, 'blocked');
    const current = box.run();
    // The same run as an engine before the decision step configured it: review.configured@4 folds with the decision phase skipped.
    const events = box.events(current.id);
    const payloadOf = (kind: string): Record<string, unknown> => events.find(([candidate]) => candidate === kind)![1];
    const legacy = box.checkpoint.createRun({ worktree: box.repo });
    box.checkpoint.append(legacy.id, legacy.lastSequence, [{ kind: 'scope.captured', version: 1, payload: payloadOf('scope.captured') }, { kind: 'review.configured', version: 4, payload: payloadOf('review.configured') }]);
    box.checkpoint.append(current.id, current.lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'replaced by the legacy run' } }]);
    assert.equal(box.checkpoint.fold(legacy.id).review?.phases.decision.status, 'skipped');
    box.logs.length = 0;
    assert.equal((await box.fix('claude')).kind, 'blocked');
    assert.ok(box.logs.includes(`run ${legacy.id} is pinned without the fix pass; --fix, --check and --no-check are ignored`), box.logs.join('\n'));
    assert.ok(!box.logs.some((line) => line.includes('to continue it into the fix pass')), 'no continuation is promised to a run that can never be continued');
    // The current engine's run is promised one, as it can be continued once its report is written.
    box.checkpoint.append(legacy.id, box.checkpoint.fold(legacy.id).lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'done' } }]);
    assert.equal((await box.review('claude')).kind, 'blocked');
    const decided = box.checkpoint.foldRuns().at(-1)!;
    assert.notEqual(decided.review?.phases.decision.status, 'skipped');
    box.logs.length = 0;
    assert.equal((await box.fix('claude')).kind, 'blocked');
    assert.ok(box.logs.includes(`run ${decided.id} is pinned without the fix pass; --fix, --check and --no-check are ignored; once its report is written, run again with --fix to continue it into the fix pass`), box.logs.join('\n'));
  });
});
