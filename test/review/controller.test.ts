import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { RunClosedError } from '../../src/checkpoint/errors.ts';
import type { ReviewOutcome } from '../../src/review/controller.ts';
import { ReviewRefusedError } from '../../src/review/errors.ts';
import { until } from '../helpers/launcher.ts';
import { lockPath } from '../../src/review/lock.ts';
import { phases } from '../../src/review/vocabulary.ts';
import type { Script } from '../helpers/fake-runtime.ts';
import { ReviewSandbox } from '../helpers/review-sandbox.ts';
import { write } from '../helpers/repository.ts';

/** The nine leads with nothing in them. */
const noLeads = ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'].map((angle) => ({ angle, lead: null }));

/** A candidate as a finder returns it. */
const found = (file: string, line: number, summary: string): Record<string, unknown> => ({ file, line, summary, detail: `${summary}: the failure a user would see` });

/**
 * A review in which the triage and RIPPLE find candidates at one line, the
 * SCAN one located and one RIPPLE one unlocated, deduplication folds the
 * located pair, the verifier refutes one and confirms the rest, the sweep
 * adds a design candidate, and merge-rank ranks them.
 */
const fullScript: Script = {
  triage: { output: { candidates: [found('src/a.ts', 2, 'text is dereferenced when null'), found('src\\a.ts', 6, 'other() passes null')], leads: [
    { angle: 'REMOVALS', lead: 'src/gone.ts was deleted' }, { angle: 'RIPPLE', lead: 'callers of parse()' }, { angle: 'FOOTGUNS', lead: null }, { angle: 'WRAPPERS', lead: null },
    { angle: 'EFFICIENCY', lead: null }, { angle: 'DESIGN', lead: null }, { angle: 'DUPLICATION', lead: null }, { angle: 'ALTITUDE', lead: null }, { angle: 'CONVENTIONS', lead: null },
  ] } },
  'finder-RIPPLE': { output: { candidates: [found('/somewhere/src/a.ts', 2, 'parse(null) from other()'), found('src/nowhere.ts', 1, 'a caller outside the scope')] } },
  // WRAPPERS fails once with a malformed answer, then answers.
  'finder-WRAPPERS': [{ malformed: true }, { output: { candidates: [] } }],
  'deduplication:deduplication': { output: { groups: [{ members: [0, 2], keep: 2, reason: 'the same null dereference at line 2' }] } },
  // Group g1 is src/a.ts: [0] SCAN-2 at line 6 and [1] RIPPLE-1 at line 2 sorted by line, so [0] RIPPLE-1, [1] SCAN-2; g2 is the unlocated RIPPLE-2.
  'verifier:verification:g1': { output: { verdicts: [{ index: 0, verdict: 'CONFIRMED', evidence: 'line 2 dereferences text with !' }, { index: 1, verdict: 'REFUTED', evidence: 'other() is never called' }] } },
  'verifier:verification:g2': { output: { verdicts: [{ index: 0, verdict: 'PLAUSIBLE', evidence: 'no such file in the change; a caller elsewhere may exist' }] } },
  sweep: { output: { candidates: [{ ...found('src/b.ts', 1, 'b duplicates a call parse already makes'), angle: 'DUPLICATION' }] } },
  'merge-rank': { output: { findings: [
    { primary: 0, members: [1], severity: 'major', summary: 'parse dereferences null; also at the unlocated caller', reason: 'one root cause' },
    { primary: 2, members: [], severity: 'minor', summary: 'duplicate call', reason: 'a cleanup' },
  ] } },
};

describe('runReview', { timeout: 600_000 }, () => {
  let box: ReviewSandbox;
  beforeEach(() => {
    box = new ReviewSandbox();
  });
  afterEach(() => {
    box.close();
  });

  const report = (outcome: ReviewOutcome): string => {
    assert.equal(outcome.kind, 'report', JSON.stringify(outcome));
    return outcome.kind === 'report' ? readFileSync(outcome.reportPath, 'utf8') : '';
  };

  it('reviews a change through every phase on the fake Claude and writes the report', async () => {
    box.script(fullScript);
    const outcome = await box.review('claude');
    const text = report(outcome);
    const state = box.run();
    assert.equal(state.review?.report !== null, true);
    assert.deepEqual(Object.values(state.review!.phases).map((phase) => phase.status), ['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed']);
    // Workers: triage 1, finders 9 + 1 retry, deduplication 1, verification 2 groups, sweep 1, no sweep deduplication (one candidate), sweep verification 1, merge-rank 1.
    const workers = Object.values(state.workers);
    assert.equal(workers.length, 17);
    assert.ok(workers.every((worker) => worker.status === 'finished'));
    const labels = workers.map((worker) => worker.launch.label);
    assert.equal(labels.filter((label) => label === 'finder-WRAPPERS finders:WRAPPERS').length, 2, 'the malformed WRAPPERS answer was retried once');
    // Every phase started after the previous one finished, and every phase's check came first.
    const events = box.events(state.id);
    const kinds = events.map(([kind]) => kind);
    const order = phases.map((phase) => events.findIndex(([kind, payload]) => kind === 'phase.started' && payload.phase === phase));
    assert.ok(order.every((position) => position >= 0), 'every phase started');
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'phases start in order');
    assert.equal(kinds.filter((kind) => kind === 'worktree.checked').length, 9);
    // Candidates: ids assigned, locations normalized, the unlocated one kept.
    const candidates = state.review!.candidates;
    assert.deepEqual(Object.keys(candidates), ['SCAN-1', 'SCAN-2', 'RIPPLE-1', 'RIPPLE-2', 'SWEEP-1']);
    assert.deepEqual([candidates['SCAN-2']!.file, candidates['SCAN-2']!.line, candidates['SCAN-2']!.located], ['src/a.ts', 6, true], 'a backslash path is normalized');
    assert.deepEqual([candidates['RIPPLE-1']!.file, candidates['RIPPLE-1']!.located], ['src/a.ts', true], 'an absolute prefix is removed');
    assert.deepEqual([candidates['RIPPLE-2']!.file, candidates['RIPPLE-2']!.located, candidates['RIPPLE-2']!.rawFile], [null, false, 'src/nowhere.ts']);
    assert.equal(candidates['SCAN-1']!.duplicateOf, 'RIPPLE-1');
    assert.deepEqual(state.review!.plans.verification, [{ id: 'g1', candidateIds: ['RIPPLE-1', 'SCAN-2'] }, { id: 'g2', candidateIds: ['RIPPLE-2'] }]);
    assert.equal(candidates['RIPPLE-1']!.verdict?.verdict, 'CONFIRMED');
    assert.equal(candidates['SCAN-2']!.verdict?.verdict, 'REFUTED');
    assert.equal(candidates['SWEEP-1']!.angle, 'DUPLICATION');
    assert.deepEqual(state.review!.ranking?.map((finding) => [finding.id, finding.members, finding.severity]), [['RIPPLE-1', ['RIPPLE-2'], 'major'], ['SWEEP-1', [], 'minor']]);
    // The report.
    assert.match(text, /^# Deep review report\n/);
    assert.match(text, /^\| RIPPLE \| run \| callers of parse\(\) \|$/m);
    assert.match(text, /^### 1\. \[major\] CONFIRMED  RIPPLE-1 \(also RIPPLE-2\)  src\/a\.ts:2$/m);
    assert.match(text, /^### 2\. \[minor\] PLAUSIBLE  SWEEP-1  src\/b\.ts:1$/m);
    assert.match(text, /## Refuted at verification\n\n- SCAN-2 \(SCAN\)  src\/a\.ts:6  other\(\) passes null\n  Evidence: other\(\) is never called/);
    assert.match(text, /^\| Total \| 17 \| /m);
    assert.match(text, /- Run budget: 30\.00 USD/);
    assert.match(text, /- Unlocated candidates.*RIPPLE-2 \(src\/nowhere\.ts:1\)/);
    // The prompts: the finder got its lead, the sweep got the lists, the verifier its numbered group, and every worker the scope block and rules file.
    const ripple = box.promptOf(state, 'finder-RIPPLE finders:RIPPLE');
    assert.match(ripple, /^SCAN lead: callers of parse\(\)$/m);
    assert.match(ripple, /^Role: finder-RIPPLE\nUnit: RIPPLE\nPhase: finders$/m);
    assert.match(ripple, /- AGENTS\.md \(repository\)/);
    assert.match(ripple, /\| src\/gone\.ts \| deleted \| .* \| deleted \|/);
    assert.match(ripple, /```diff\n/);
    const sweep = box.promptOf(state, 'sweep sweep:sweep');
    assert.match(sweep, /Every angle ran\./);
    assert.match(sweep, /- RIPPLE-1 \(RIPPLE\) at src\/a\.ts:2: parse\(null\) from other\(\) \[CONFIRMED\]/);
    assert.match(sweep, /- SCAN-2 \(SCAN\) at src\/a\.ts:6: other\(\) passes null; refuted because: other\(\) is never called/);
    assert.match(box.promptOf(state, 'verifier verification:g1'), /\[0\] RIPPLE-1 \(RIPPLE\) at src\/a\.ts:2\n[\s\S]*\[1\] SCAN-2 \(SCAN\) at src\/a\.ts:6/);
    assert.match(box.promptOf(state, 'merge-rank merge-rank:merge-rank'), /3 findings, numbered \[0\] to \[2\]/);
    assert.ok(box.logs.some((line) => /^phase triage: started \(attempt 1\)$/.test(line)));
    assert.ok(box.logs.some((line) => /^worker finder-WRAPPERS finders:WRAPPERS: attempt failed: failed: The answer does not match the output schema/.test(line)));
    assert.equal(existsSync(lockPath(box.checkpoint.root, state.id)), false, 'the lock is released');
  });

  it('reviews on the fake Codex, with no budget and no cost, and the report says the budget did not apply', async () => {
    box.script({});
    const text = report(await box.review('codex'));
    const state = box.run();
    assert.equal(state.review?.configuration.runtime, 'codex');
    assert.equal(state.review?.configuration.runBudgetUsd, null);
    assert.ok(state.review!.configuration.roles.every((role) => role.budgetUsd === null));
    // Nothing found: 1 triage + 9 finders, no deduplication, verification with no group, sweep, no merge-rank.
    assert.equal(Object.values(state.workers).length, 11);
    assert.match(text, /No finding survived verification\./);
    assert.match(text, /- The run budget did not apply: runtime codex reports no cost in USD/);
    assert.match(text, /^\| Total \| 11 \| [0-9.]+ \| - \| \d+ \| 0 \| \d+ \|$/m);
  });

  it('degrades an angle whose finder fails twice, tells the sweep, and names it in the report', async () => {
    box.script({ 'finder-FOOTGUNS': { exit: 3 }, 'finder-DESIGN': [{ malformed: true }, { hang: true }] });
    const text = report(await box.review('claude'));
    const state = box.run();
    assert.deepEqual(Object.keys(state.review!.anglesNotRun).sort(), ['DESIGN', 'FOOTGUNS']);
    assert.match(state.review!.anglesNotRun.FOOTGUNS!, /^2 attempts did not complete: failed: The worker exited with code 3; failed: The worker exited with code 3$/);
    assert.match(state.review!.anglesNotRun.DESIGN!, /failed: The answer does not match the output schema.*; timeout: The worker ran past its timeout/);
    assert.equal(state.review!.phases.finders.status, 'degraded');
    assert.match(text, /^\| FOOTGUNS \| not run \(2 attempts did not complete: .*\) \| none \|$/m);
    assert.match(text, /- Angle DESIGN did not run/);
    assert.match(box.promptOf(state, 'sweep sweep:sweep'), /These angles did not run, so their territory is yours to cover: FOOTGUNS \(.*\); DESIGN \(.*\)\./);
    assert.equal(Object.values(state.workers).filter((worker) => worker.launch.label === 'finder-FOOTGUNS finders:FOOTGUNS').length, 2);
  });

  it('marks a group unverified when its verifier fails twice, and its candidates carry PLAUSIBLE unverified into the report', async () => {
    box.script({ triage: { output: { candidates: [found('src/a.ts', 2, 'null deref'), found('src/b.ts', 1, 'b calls parse')], leads: noLeads } }, 'verifier:verification:g2': { exit: 1 } });
    const text = report(await box.review('claude'));
    const state = box.run();
    assert.deepEqual(state.review!.plans.verification, [{ id: 'g1', candidateIds: ['SCAN-1'] }, { id: 'g2', candidateIds: ['SCAN-2'] }]);
    assert.deepEqual(state.review!.unverifiedGroups, { 'verification:g2': '2 attempts did not complete: failed: The worker exited with code 1; failed: The worker exited with code 1' });
    assert.equal(state.review!.candidates['SCAN-2']!.unverified, true);
    assert.equal(state.review!.phases.verification.status, 'degraded');
    assert.match(text, /PLAUSIBLE  SCAN-2  src\/b\.ts:1 \(unverified\)/);
    assert.match(text, /Evidence: none; the verifier of this group failed twice/);
    assert.match(text, /- Group g2 of verification was not verified/);
  });

  it('blocks with worker-failed when the triage fails twice, and running again retries it and completes', async () => {
    box.script({ triage: { exit: 2 } });
    const blocked = await box.review('claude');
    assert.equal(blocked.kind, 'blocked');
    if (blocked.kind === 'blocked') {
      assert.equal(blocked.blocker.code, 'worker-failed');
      assert.equal(blocked.blocker.phase, 'triage');
      assert.match(blocked.blocker.detail, /the triage worker for triage:SCAN failed twice/);
      assert.match(blocked.blocker.action, /run the command again/);
    }
    let state = box.run();
    assert.equal(state.review!.phases.triage.status, 'blocked');
    assert.equal(Object.values(state.workers).length, 2);
    box.script({});
    report(await box.review('claude'));
    state = box.run();
    assert.deepEqual(state.review!.phases.triage, { status: 'completed', attempt: 2 });
    assert.equal(state.review!.blocker, null);
    assert.equal(box.checkpoint.listRuns().length, 1, 'the same run continued');
    assert.ok(box.logs.some((line) => /^phase triage: re-entered \(attempt 2\), clearing the worker-failed blocker$/.test(line)));
  });

  it('blocks on the run budget before a launch, and completes when run again with a higher --budget-usd', async () => {
    box.script({ '*': { costUsd: 12 } });
    const blocked = await box.review('claude', { flags: { budgetUsd: 20 } });
    assert.equal(blocked.kind, 'blocked');
    if (blocked.kind === 'blocked') {
      assert.equal(blocked.blocker.code, 'budget');
      // The triage spent 12 USD; four finders then launched together under the 20 USD budget, since the check runs before a launch, not during a worker, and spent 48 more.
      assert.match(blocked.blocker.detail, /^spent 60\.00 USD of the 20\.00 USD run budget$/);
      assert.match(blocked.blocker.action, /--budget-usd above 60\.00/);
    }
    let state = box.run();
    assert.equal(Object.values(state.workers).length, 5, 'the triage and one batch of four finders ran before the check stopped the next launch');
    assert.equal(state.review!.configuration.runBudgetUsd, 20, 'the pinned budget is the first invocation\'s');
    const text = report(await box.review('claude', { flags: { budgetUsd: 1000 } }));
    state = box.run();
    assert.equal(state.review!.phases.finders.attempt, 2);
    assert.match(text, /- Run budget: 20\.00 USD, checked before every launch; spent [0-9.]+ USD\./);
  });

  it('blocks with drift when a scope file changes between phases, and completes once it is restored', async () => {
    const marker = join(box.directory, 'triage-may-answer');
    box.script({ triage: { waitFor: marker } });
    const original = readFileSync(join(box.repo, 'src', 'b.ts'), 'utf8');
    const pending = box.review('claude');
    // While the triage worker waits, the tree changes; the check before the finders sees it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    write(box.repo, 'src/b.ts', 'export const b = 2;\n');
    writeFileSync(marker, '');
    const blocked = await pending;
    assert.equal(blocked.kind, 'blocked');
    if (blocked.kind === 'blocked') {
      assert.equal(blocked.blocker.code, 'drift');
      assert.equal(blocked.blocker.phase, 'finders');
      assert.match(blocked.blocker.detail, /src\/b\.ts \(modified\)/);
      assert.match(blocked.blocker.action, /restore the named files/);
    }
    let state = box.run();
    assert.deepEqual(state.review!.checks.at(-1), { phase: 'finders', attempt: 1, drifted: true, files: [{ path: 'src/b.ts', outcome: 'modified' }] });
    assert.equal(state.review!.phases.triage.status, 'completed', 'the triage stands');
    // Still drifted: blocked again at once, without a worker.
    const again = await box.review('claude');
    assert.equal(again.kind, 'blocked');
    assert.equal(Object.values(box.run().workers).length, 1);
    write(box.repo, 'src/b.ts', original);
    box.script({});
    const text = report(await box.review('claude'));
    state = box.run();
    assert.equal(state.review!.phases.finders.attempt, 3);
    assert.match(text, /- Worktree checks: 11, 2 found a difference before finders \(attempt 1: src\/b\.ts modified\); finders \(attempt 2: src\/b\.ts modified\)/);
  });

  it('ends with the launcher\'s error when the run is abandoned under a running worker, and no rejection goes unhandled', async () => {
    const marker = join(box.directory, 'triage-may-answer');
    box.script({ triage: { waitFor: marker } });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const signalListeners = process.listenerCount('SIGINT');
    try {
      const pending = box.review('claude', { flags: { concurrency: 1 } });
      await until(() => box.checkpoint.listRuns().some((run) => Object.values(run.workers).some((worker) => worker.status === 'running')), 'the triage worker on the ledger', 60_000);
      assert.ok(process.listenerCount('SIGINT') > signalListeners, 'an interruption releases the held lock');
      const state = box.run();
      box.checkpoint.append(state.id, state.lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'abandoned under the worker' } }]);
      writeFileSync(marker, '');
      await assert.rejects(pending, RunClosedError);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(unhandled, []);
      assert.equal(box.run().status, 'abandoned');
      assert.equal(existsSync(lockPath(box.checkpoint.root, state.id)), false, 'the lock is released on the way out');
      assert.equal(process.listenerCount('SIGINT'), signalListeners, 'and its signal listener with it');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('refuses a resumed run whose runtime differs, and two active runs', async () => {
    box.script({ triage: { exit: 2 } });
    await box.review('claude');
    await assert.rejects(box.review('codex'), (error: unknown) => error instanceof ReviewRefusedError && /pinned to runtime claude, not codex/.test(error.message));
    box.checkpoint.createRun({ worktree: box.repo });
    await assert.rejects(box.review('claude'), /2 runs are active/);
  });

  it('refuses an unqualified runtime before any run exists', async () => {
    await assert.rejects(box.review('claude', {}, { FAKE_HELP_OMIT: '--json-schema' }), (error: unknown) => error instanceof ReviewRefusedError && error.code === 'runtime-unqualified' && /lacks flags the adapter uses/.test(error.message));
    assert.deepEqual(box.checkpoint.listRuns(), []);
  });
});
