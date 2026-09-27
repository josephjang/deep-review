import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { RunClosedError } from '../../src/checkpoint/errors.ts';
import { describeRun, type ReviewOutcome } from '../../src/review/controller.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { InvalidPolicyError, ReviewRefusedError } from '../../src/review/errors.ts';
import { policyFileName } from '../../src/review/policy.ts';
import { until } from '../helpers/launcher.ts';
import { acquireStartLock, lockPath, startLockPath } from '../../src/review/lock.ts';
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
    // The run keeps the scope it captured: the command's is never resolved, and the log says it is ignored.
    const scope = { named: true, request: (): never => assert.fail('a run that captured its scope asked for another') };
    report(await box.review('claude', { scope }));
    assert.ok(box.logs.includes(`run ${state.id} is active; its scope flags are ignored and the run continues`));
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
    assert.deepEqual(state.review!.limits, { concurrency: 4, runBudgetUsd: 20 }, 'the limits in force start as the configuration\'s');
    const limitsChanges = (): Record<string, unknown>[] => box.events(state.id).filter(([kind]) => kind === 'limits.changed').map(([, payload]) => payload);
    const spendLine = (): string | undefined => describeRun(box.run(), claudeAdapter, () => '').lines.find((line) => line.startsWith('Spend: '));
    assert.match(spendLine() ?? '', / of 20\.00 USD; /);

    // A flag equal to the budget in force changes nothing, so nothing is recorded.
    assert.equal((await box.review('claude', { flags: { budgetUsd: 20 } })).kind, 'blocked');
    assert.deepEqual(limitsChanges(), []);
    // A budget still below the spend is recorded in force, and blocks again with it.
    const still = await box.review('claude', { flags: { budgetUsd: 30 } });
    assert.ok(still.kind === 'blocked' && still.blocker.detail === 'spent 60.00 USD of the 30.00 USD run budget', JSON.stringify(still));
    assert.deepEqual(limitsChanges(), [{ concurrency: 4, runBudgetUsd: 30 }]);
    assert.match(spendLine() ?? '', / of 30\.00 USD; /, 'status shows the budget in force, not the pinned one');
    // Without the flag, the pinned budget is in force again for this invocation, and that is recorded too.
    assert.equal((await box.review('claude')).kind, 'blocked');
    assert.deepEqual(limitsChanges(), [{ concurrency: 4, runBudgetUsd: 30 }, { concurrency: 4, runBudgetUsd: 20 }]);
    assert.ok(box.logs.includes(`run ${state.id}: limits in force: concurrency 4, run budget 20.00 USD`), box.logs.join('\n'));

    const text = report(await box.review('claude', { flags: { budgetUsd: 1000, concurrency: 2 } }));
    state = box.run();
    assert.equal(state.review!.phases.finders.attempt, 5);
    assert.deepEqual(state.review!.limits, { concurrency: 2, runBudgetUsd: 1000 });
    assert.equal(state.review!.configuration.runBudgetUsd, 20, 'the configuration stays as pinned');
    assert.match(text, /- Run budget: 1000\.00 USD, checked before every launch; spent [0-9.]+ USD\./, 'the report records the budget in force at the end');
    assert.equal(state.review!.report!.statistics.budgetApplied, true);
    assert.match(spendLine() ?? '', / of 1000\.00 USD; /);
  });

  it('applies a budget given on a resume to a run pinned without one, and the report says it applied', async () => {
    const policyPath = join(box.rolesRoot, policyFileName);
    const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as { runtimes: { claude: { runBudgetUsd: number | null } } };
    policy.runtimes.claude.runBudgetUsd = null;
    writeFileSync(policyPath, JSON.stringify(policy, null, 2));
    // The triage fails twice, which blocks the first invocation, then answers.
    box.script({ '*': { costUsd: 1 }, triage: [{ malformed: true, costUsd: 1 }, { malformed: true, costUsd: 1 }, { costUsd: 1 }] });
    const blocked = await box.review('claude');
    assert.ok(blocked.kind === 'blocked' && blocked.blocker.code === 'worker-failed', JSON.stringify(blocked));
    assert.equal(box.run().review!.configuration.runBudgetUsd, null, 'the run is pinned without a budget');
    assert.deepEqual(box.run().review!.limits, { concurrency: 4, runBudgetUsd: null });
    const text = report(await box.review('claude', { flags: { budgetUsd: 500 } }));
    const state = box.run();
    assert.deepEqual(state.review!.limits, { concurrency: 4, runBudgetUsd: 500 });
    assert.equal(state.review!.report!.statistics.budgetApplied, true, 'the budget in force was checked before every launch of the second invocation');
    assert.match(text, /- Run budget: 500\.00 USD, checked before every launch; spent [0-9.]+ USD\./);
    assert.doesNotMatch(text, /did not apply|No run budget was set/);
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

  it('waits for the workers still in flight, and records their answers, before a runtime that stops qualifying mid-run refuses the review', async () => {
    const removalsMayAnswer = join(box.directory, 'removals-may-answer');
    const rippleMayAnswer = join(box.directory, 'ripple-may-answer');
    const broken = join(box.directory, 'runtime-broken');
    // REMOVALS and RIPPLE launch together; once RIPPLE answers, the next finder's preflight finds the runtime broken while REMOVALS still runs.
    box.script({ 'finder-REMOVALS': { waitFor: removalsMayAnswer }, 'finder-RIPPLE': { waitFor: rippleMayAnswer } });
    let settled = false;
    const pending = box.review('claude', { flags: { concurrency: 2 } }, { FAKE_UNQUALIFIED_WHEN: broken });
    pending.then(() => (settled = true), () => (settled = true));
    try {
      const running = (): string[] => box.checkpoint.listRuns().flatMap((run) => Object.values(run.workers).filter((worker) => worker.status === 'running').map((worker) => worker.launch.label ?? ''));
      await until(() => running().length === 2, 'REMOVALS and RIPPLE running', 60_000);
      writeFileSync(broken, '');
      writeFileSync(rippleMayAnswer, '');
      await until(() => settled || box.logs.some((line) => /waiting for 1 worker in flight/.test(line)), 'the launcher error', 60_000);
      assert.equal(settled, false, 'the review does not end while REMOVALS runs');
      assert.deepEqual(running(), ['finder-REMOVALS finders:REMOVALS']);
    } finally {
      writeFileSync(removalsMayAnswer, '');
    }
    // Refused as at startup, with the blocker code and the operator's action, not as an engine error.
    await assert.rejects(pending, (error: unknown) => error instanceof ReviewRefusedError && error.code === 'runtime-unqualified' && /does not identify itself as claude: .*; fix the runtime installation/.test(error.message));
    const state = box.run();
    assert.deepEqual(Object.values(state.workers).filter((worker) => worker.status !== 'finished'), [], 'no worker is left running on the ledger');
    assert.notEqual(state.review!.units['finders:REMOVALS']?.answeredBy ?? null, null, 'the answer REMOVALS gave while the review wound down is recorded');
    assert.equal(existsSync(lockPath(box.checkpoint.root, state.id)), false, 'the lock is released after the last worker');
  });

  it('refuses to resume a run from another worktree of the repository, naming the run\'s worktree', async () => {
    box.script({ triage: { exit: 2 } });
    await box.review('claude');
    const runId = box.run().id;
    // A second worktree shares the checkpoint, which lives under the common git directory.
    const other = join(box.directory, 'other');
    execFileSync('git', ['worktree', 'add', '--detach', other, 'HEAD'], { cwd: box.repo, stdio: 'ignore' });
    const otherRoot = realpathSync.native(other);
    box.script({});
    await assert.rejects(box.review('claude', { worktree: otherRoot }), (error: unknown) => error instanceof ReviewRefusedError && error.code === null
      && error.message === `run ${runId} is active in worktree ${box.repo}, not ${otherRoot}; run the command there, or abandon the run with \`deep-review abandon --run ${runId} --reason <text>\``);
    assert.equal(Object.values(box.run().workers).length, 2, 'nothing ran in the other worktree');
    // The run's own worktree still resumes it.
    report(await box.review('claude'));
  });

  it('resumes a configured run from its pinned configuration, whatever the policy file, the model flags and the executable say now', async () => {
    box.script({ triage: { exit: 2 } });
    await box.review('claude');
    const pinned = box.run().review!.configuration;
    // A policy file that no longer resolves, a model flag and an executable that would not qualify: a pinned run reads none of them.
    writeFileSync(join(box.rolesRoot, policyFileName), JSON.stringify({ schemaVersion: 1, roles: {}, runtimes: {}, concurrency: 4 }));
    box.script({});
    report(await box.review('claude', { executable: join(box.directory, 'absent'), executableArgs: [], flags: { strongModel: 'another-model' } }));
    const state = box.run();
    assert.deepEqual(state.review!.configuration, pinned);
    assert.ok(Object.values(state.workers).every((worker) => worker.launch.executable === pinned.executable && worker.launch.model !== 'another-model'), 'every worker ran the pinned executable and models');
    assert.ok(box.logs.includes(`run ${state.id} is pinned to models ${pinned.models.strong} and ${pinned.models.fast}; --strong-model and --fast-model are ignored`));
  });

  it('refuses to resume a run whose role prompts changed since it was configured, naming both digests', async () => {
    box.script({ triage: { exit: 2 } });
    await box.review('claude');
    const state = box.run();
    writeFileSync(join(box.rolesRoot, 'fragments', 'rubrics.md'), `${readFileSync(join(box.rolesRoot, 'fragments', 'rubrics.md'), 'utf8')}\nOne more rule.\n`);
    await assert.rejects(box.review('claude'), (error: unknown) => error instanceof ReviewRefusedError && error.code === null
      && error.message.startsWith(`run ${state.id} was configured with roles digest ${state.review!.configuration.rolesDigest}, and the roles at ${box.rolesRoot} now digest `)
      && error.message.endsWith(`; run it with the roles it started with (--roles <dir>), or abandon it with \`deep-review abandon --run ${state.id} --reason <text>\``));
    assert.equal(Object.values(box.run().workers).length, 2, 'nothing ran');
  });

  it('refuses --budget-usd when resuming a run on a runtime that reports no cost, as a new run does', async () => {
    box.script({ triage: { exit: 2 } });
    await box.review('codex');
    await assert.rejects(box.review('codex', { flags: { budgetUsd: 5 } }), (error: unknown) => error instanceof InvalidPolicyError && /--budget-usd does not apply to runtime codex/.test(error.message));
    await assert.rejects(box.review('codex', { flags: { concurrency: 0 } }), (error: unknown) => error instanceof InvalidPolicyError && /--concurrency must be a whole number from 1 to 16, not 0/.test(error.message));
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

  it('finds or creates the run under the start lock, so an engine starting meanwhile is refused and creates no run of its own', async () => {
    // The parent of this test process is alive and is not this process: an engine between its find and its run lock.
    const release = acquireStartLock(box.checkpoint.root, process.ppid);
    try {
      await assert.rejects(box.review('claude'), (error: unknown) => error instanceof ReviewRefusedError && error.code === 'lock-held' && new RegExp(`^engine ${String(process.ppid)} is starting or ending a run in this repository`).test(error.message));
      assert.deepEqual(box.checkpoint.listRuns(), [], 'no run was created');
    } finally {
      release();
    }
    box.script({});
    report(await box.review('claude'));
    assert.equal(existsSync(startLockPath(box.checkpoint.root)), false, 'the start lock is released once the run is locked');
  });
});
