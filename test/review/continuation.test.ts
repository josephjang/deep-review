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
});
