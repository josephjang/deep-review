import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ListedRun } from '../../src/checkpoint/checkpoint.ts';
import { flagCheckSettings } from '../../src/review/checks/discover.ts';
import { ReviewRefusedError } from '../../src/review/errors.ts';
import { deciderAnswer, fixerAnswer, type Script } from '../helpers/fake-runtime.ts';
import { commitAll, write } from '../helpers/repository.ts';
import { reportText, ReviewSandbox, sandboxConcurrency } from '../helpers/review-sandbox.ts';

/** A review whose triage finds one defect in src/a.ts, which the decider decides to fix, every worker reporting 1 USD. */
const oneFix: Script = {
  '*': { costUsd: 1 },
  triage: { costUsd: 1, output: { candidates: [{ file: 'src/a.ts', line: 2, summary: 'text is dereferenced when null', detail: 'parse(null) throws' }], leads: ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'].map((angle) => ({ angle, lead: null })) } },
  decider: { costUsd: 1, output: deciderAnswer([{}]) },
};

/** The same review, its one finding an ask whose default keeps the code, and the fixer of a continuation answering it applied with an edit of src/a.ts. */
const oneQuestion: Script = {
  ...oneFix,
  decider: { costUsd: 1, output: deciderAnswer([{ decision: 'ask', edits: false }]) },
  'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': 'export function parse(text: string | null) {\n  return text?.length ?? 0;\n}\n\nexport function other() {\n  return parse(null);\n}\n' }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Take the other way the author chose' }]) },
};

/** Record a person's answer on a run as `deep-review answer --record-only` would. */
function answerOn(box: ReviewSandbox, runId: string, id: string, option: number): void {
  box.checkpoint.append(runId, box.checkpoint.fold(runId).lastSequence, [{ kind: 'answer.recorded', version: 1, payload: { id, answer: { kind: 'option', option }, note: 'the author chose it' } }]);
}

// Answers: a read-only run's answers ride the continuation into the fix pass (R4, PD4 of answers).
describe('the continuation of an answered read-only run', { timeout: 900_000, concurrency: sandboxConcurrency }, () => {
  it('routes a held question whose answer owes an edit to a fixer, tells the fixer the answer, and marks it applied by that batch', async (t) => {
    const box = ReviewSandbox.forTest(t, oneQuestion);
    reportText(await box.review('claude'));
    const finished = box.run();
    const id = finished.review!.decisions![0]!.id;
    await assert.rejects(box.fix('claude'), (error: unknown) => error instanceof ReviewRefusedError && error.message.startsWith(`run ${finished.id} has no finding to fix: 0 decided fix, 0 left, 1 asked with the code kept`), 'unanswered, the question keeps the code');
    answerOn(box, finished.id, id, 1);
    reportText(await box.fix('claude'));
    const state = box.run();
    assert.equal(state.id, finished.id, 'the answered run is continued');
    assert.deepEqual(state.review!.fix!.plan!.routes, [{ id, route: 'fixer' }]);
    assert.match(box.promptOf(state, 'fixer fixes:c1-1'), /^ {8}answered by the author: option 2, "fake other way", for which the decider wrote the rule "fake rule for the other way"\. Note: the author chose it\n {8}before the answer: no fixer saw it before$/m);
    assert.deepEqual(state.review!.answers.at(-1)!.appliedBy, { phase: 'fixes', key: 'c1-1' });
  });

  it('still finds nothing to fix when the answer confirms the default that keeps the code', async (t) => {
    const box = ReviewSandbox.forTest(t, oneQuestion);
    reportText(await box.review('claude'));
    const finished = box.run();
    answerOn(box, finished.id, finished.review!.decisions![0]!.id, 0);
    assert.equal(box.run().review!.answers[0]!.appliedBy, 'tree');
    await assert.rejects(box.fix('claude'), (error: unknown) => error instanceof ReviewRefusedError && error.message.includes('has no finding to fix'));
  });

  it('says the answers of a run it does not continue, its change having moved, stay with that run', async (t) => {
    const box = ReviewSandbox.forTest(t, oneQuestion);
    reportText(await box.review('claude'));
    const finished = box.run();
    answerOn(box, finished.id, finished.review!.decisions![0]!.id, 1);
    write(box.repo, 'src/b.ts', 'export const b = 1;\n');
    commitAll(box.repo, 'feat: Add b');
    box.logs.length = 0;
    reportText(await box.fix('claude'));
    assert.ok(box.logs.includes(`run ${finished.id}: its answers to 1 finding stay recorded on it and do not carry to the new run`), box.logs.join('\n'));
    assert.equal(box.checkpoint.foldRuns().length, 2, 'a new run');
  });

  it('says the answers of a run --fresh passes over stay with that run', async (t) => {
    const box = ReviewSandbox.forTest(t, oneQuestion);
    reportText(await box.review('claude'));
    const finished = box.run();
    answerOn(box, finished.id, finished.review!.decisions![0]!.id, 1);
    box.logs.length = 0;
    reportText(await box.fix('claude', { fresh: true }));
    assert.ok(box.logs.includes('--fresh: no finished run is considered; a new run is created'), box.logs.join('\n'));
    assert.ok(box.logs.includes(`run ${finished.id}: its answers to 1 finding stay recorded on it and do not carry to the new run`), box.logs.join('\n'));
    assert.equal(box.checkpoint.foldRuns().length, 2, 'a new run');
  });
});

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

  it('refuses a continuation whose pinned executable no longer qualifies with --fresh as the way out, since a complete run cannot be abandoned (R3, TD6)', async (t) => {
    const box = ReviewSandbox.forTest(t, oneFix);
    reportText(await box.review('claude'));
    const finished = box.run();
    const executable = finished.review!.configuration.executable;
    await assert.rejects(box.fix('claude', {}, { FAKE_HELP_OMIT: '--json-schema' }), (error: unknown) => error instanceof ReviewRefusedError && error.code === 'runtime-unqualified'
      && error.message.endsWith(`; make ${executable}, the executable run ${finished.id} is pinned to, qualify again (reinstall the runtime version the run started with) and run the command again, or start a new run with --fresh; a configured run ignores --executable`)
      && !error.message.includes('abandon'));
    assert.equal(box.run().lastSequence, finished.lastSequence, 'nothing was appended');
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
    await assert.rejects(box.fix('claude', { fix: flagCheckSettings({}, ['build', 'typecheck']) }, { FAKE_HELP_OMIT: '--json-schema' }), (error: unknown) => error instanceof ReviewRefusedError
      && error.message === `run ${finished.id} went on without its survey, so a continuation needs every check settled: give --check <kind>=<command> or --no-check <kind>, or set checks.<kind>, for lint, test, or start a new run with --fresh`);
    assert.equal(box.run().lastSequence, finished.lastSequence, 'nothing was appended');
  });

  it('continues a read-only run another engine finished between the find and the lock, rather than skipping it for the find\'s stale read', async (t) => {
    const box = ReviewSandbox.forTest(t, { triage: { exit: 2 } });
    assert.equal((await box.review('claude')).kind, 'blocked');
    // What the find of the next command reads: the run active, before the other engine resumes it to its report.
    const found = box.checkpoint.listRuns();
    box.script(oneFix);
    reportText(await box.review('claude'));
    const finished = box.run();
    let served = false;
    const late = new Proxy(box.checkpoint, {
      get(target, property): unknown {
        if (property === 'listRuns') {
          return (): ListedRun[] => {
            if (served) return target.listRuns();
            served = true;
            return found;
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    box.logs.length = 0;
    reportText(await box.fix('claude', { checkpoint: late }));
    assert.ok(served, 'the find read the run as active');
    assert.equal(box.checkpoint.foldRuns().length, 1, 'no new run');
    assert.ok(box.logs.includes(`run ${finished.id}: complete before its lock was taken`), box.logs.join('\n'));
    assert.ok(!box.logs.some((line) => line.endsWith('a new run is created')), 'no line says a run is created');
    assert.notEqual(box.run().review!.continuedFrom, null, 'the run just finished was continued');
  });

  it('says how to continue an active read-only run resumed with --fix only when it was configured with the decision step, which a continuation needs (R10)', async (t) => {
    const box = ReviewSandbox.forTest(t, { triage: { exit: 2 } });
    assert.equal((await box.review('claude')).kind, 'blocked');
    const current = box.run();
    // The same run as an engine before the decision step configured it: review.configured@4 folds with the decision phase skipped.
    const events = box.events(current.id);
    const payloadOf = (kind: string): Record<string, unknown> => events.find(([candidate]) => candidate === kind)![1];
    const legacy = box.checkpoint.createRun({ worktree: box.repo });
    // Version 4 recorded no settings, which version 6 adds.
    const configuredV4 = { ...payloadOf('review.configured') };
    delete configuredV4.settings;
    box.checkpoint.append(legacy.id, legacy.lastSequence, [{ kind: 'scope.captured', version: 2, payload: payloadOf('scope.captured') }, { kind: 'review.configured', version: 4, payload: configuredV4 }]);
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
