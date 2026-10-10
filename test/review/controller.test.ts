import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Checkpoint } from '../../src/checkpoint/checkpoint.ts';
import { RunClosedError, StaleRevisionError } from '../../src/checkpoint/errors.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { presurveyRulesFiles, type ReviewOutcome } from '../../src/review/controller.ts';
import { captureScope } from '../../src/scope/capture.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { InvalidPolicyError, ReviewRefusedError } from '../../src/review/errors.ts';
import { maxConcurrency, policyFileName } from '../../src/review/policy.ts';
import { until } from '../helpers/launcher.ts';
import { finish, launch, worker } from '../helpers/review-history.ts';
import { acquireRunLock, acquireStartLock, type ReleaseLock } from '../../src/review/lock.ts';
import { describeRun } from '../../src/review/status.ts';
import { policyWords } from '../../src/review/survey.ts';
import { fixPhases, phases } from '../../src/review/vocabulary.ts';
import { deciderAnswer, type Script } from '../helpers/fake-runtime.ts';
import { afterFind, fakeCheckCommand, otherEngine, ReviewSandbox } from '../helpers/review-sandbox.ts';
import { git, write } from '../helpers/repository.ts';

/** How a configured run's `runtime-unqualified` refusal ends: an action that works on a resume, which ignores --executable. */
const pinnedAction = (state: RunState): string => {
  const { executable } = state.review!.configuration;
  return `; make ${executable}, the executable run ${state.id} is pinned to, qualify again (reinstall the runtime version the run started with) and run the command again, or abandon the run with \`deep-review abandon --run ${state.id} --reason <text>\` and start a new one; a configured run ignores --executable`;
};

/** The nine leads with nothing in them. */
const noLeads = ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'].map((angle) => ({ angle, lead: null }));

/** A candidate as a finder returns it. */
const found = (file: string, line: number, summary: string): Record<string, unknown> => ({ file, line, summary, detail: `${summary}: the failure a user would see` });

/** The surveyor's answer of a read-only run that names the sandbox's AGENTS.md as its one convention source. */
const surveyedAgents = { output: { conventions: [{ path: 'AGENTS.md', level: 'repository', governs: 'how globs are quoted', appliesTo: null, grounds: null }], userRules: [], checks: null, note: '' } };

/**
 * A review in which the surveyor names the rules file, the triage and RIPPLE find candidates at one line, the
 * SCAN one located and one RIPPLE one unlocated, deduplication folds the
 * located pair, the verifier refutes one and confirms the rest, the sweep
 * adds a design candidate, and merge-rank ranks them.
 */
const fullScript: Script = {
  surveyor: surveyedAgents,
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
  // RIPPLE-1 is decided fix; SWEEP-1 asks the author, keeping the code by default.
  decider: { output: deciderAnswer([{}, { decision: 'ask', edits: false }]) },
};

/** A worker launch as another writer appends it, its prompt and schema frozen in the checkpoint's evidence store, which the append verifies. */
const frozenLaunch = (checkpoint: Checkpoint, workerId: string, label: string): Record<string, unknown> => ({ ...launch(workerId, label), prompt: checkpoint.evidence.put('a prompt'), schema: checkpoint.evidence.put('{}') });
/** A worker finish as another writer appends it, its outputs frozen in the checkpoint's evidence store. */
const frozenFinish = (checkpoint: Checkpoint, workerId: string): Record<string, unknown> => ({ ...finish(workerId), stdout: checkpoint.evidence.put('out'), stderr: checkpoint.evidence.put(''), output: checkpoint.evidence.put('{}') });

/** Whether a lock is free: this process takes it and lets it go at once, where a lock still held, by another connection in this process too, is refused. */
const lockFree = (acquire: () => ReleaseLock): boolean => {
  try {
    acquire()();
    return true;
  } catch (error) {
    if (error instanceof ReviewRefusedError && error.code === 'lock-held') return false;
    throw error;
  }
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
    // A run without --fix surveys first, decides its findings, skips the five phases of the fix pass, and has no fix state.
    assert.deepEqual(Object.values(state.review!.phases).map((phase) => phase.status), ['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'completed']);
    assert.equal(state.review!.fix, null);
    assert.equal(state.review!.configuration.fix, false);
    // Workers: survey 1, triage 1, finders 9 + 1 retry, deduplication 1, verification 2 groups, sweep 1, no sweep deduplication (one candidate), sweep verification 1, merge-rank 1, decider 1.
    const workers = Object.values(state.workers);
    assert.equal(workers.length, 19);
    assert.ok(workers.every((worker) => worker.status === 'finished'));
    const labels = workers.map((worker) => worker.launch.label);
    assert.equal(labels.filter((label) => label === 'finder-WRAPPERS finders:WRAPPERS').length, 2, 'the malformed WRAPPERS answer was retried once');
    // Every phase started after the previous one finished, and every phase's check came first.
    const events = box.events(state.id);
    const kinds = events.map(([kind]) => kind);
    const run = phases.filter((phase) => !(fixPhases as readonly string[]).includes(phase));
    const order = run.map((phase) => events.findIndex(([kind, payload]) => kind === 'phase.started' && payload.phase === phase));
    assert.ok(order.every((position) => position >= 0), 'every phase it runs started');
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'phases start in order');
    assert.ok(!events.some(([kind, payload]) => kind === 'phase.started' && (fixPhases as readonly string[]).includes(payload.phase as string)), 'no phase of the fix pass started');
    assert.equal(kinds.filter((kind) => kind === 'worktree.checked').length, 11);
    // The engine writes only the fourth version of each kind that carries a phase, and the fifth of the configuration.
    const written: Record<string, number> = { 'review.configured': 5, 'phase.started': 4, 'phase.finished': 4, 'worktree.checked': 4, 'attempt.failed': 4, 'report.written': 4 };
    assert.deepEqual(box.checkpoint.ledger.events(state.id).filter((event) => event.kind in written && event.version !== written[event.kind]).map((event) => `${event.kind}@${String(event.version)}`), []);
    assert.ok(kinds.includes('review.configured'));
    // The survey is recorded once, and a read-only run plans no check.
    assert.deepEqual(state.review!.survey?.answers.map((answer) => answer.conventions.map((source) => source.path)), [['AGENTS.md']]);
    assert.ok(!kinds.includes('checks.planned'));
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
    // The decisions, by finding, in the ranking's order, and the decider's task numbered them so (R2, R3, R10 of the decision step).
    assert.deepEqual(state.review!.decisions?.map((decision) => [decision.id, decision.decision]), [['RIPPLE-1', 'fix'], ['SWEEP-1', 'ask']]);
    const decider = box.promptOf(state, 'decider decision:decision');
    assert.match(decider, /^\[0\] RIPPLE-1 \[major\] CONFIRMED: parse dereferences null; also at the unlocated caller\n {4}merge and rank: one root cause\n {4}- RIPPLE-1 \(RIPPLE\) primary at src\/a\.ts:2: CONFIRMED\n[\s\S]* {8}evidence: line 2 dereferences text with !\n {4}- RIPPLE-2 \(RIPPLE\) at src\/nowhere\.ts:1 \(unlocated[^\n]*\): PLAUSIBLE\n/m);
    assert.ok(workers.some((worker) => worker.launch.label === 'decider decision:decision' && worker.launch.access === 'read-only' && worker.launch.shell), 'one decider, read-only with a shell');
    assert.ok(box.logs.includes('worker decider decision:decision: decided 1 to fix, 0 to leave, 1 to ask the author'), box.logs.join('\n'));
    // The report.
    assert.match(text, /^# Deep review report\n/);
    assert.match(text, /^\| RIPPLE \| run \| callers of parse\(\) \|$/m);
    assert.match(text, /^### 1\. \[major\] CONFIRMED  RIPPLE-1 \(also RIPPLE-2\)  src\/a\.ts:2$/m);
    assert.match(text, /^### 2\. \[minor\] PLAUSIBLE  SWEEP-1  src\/b\.ts:1$/m);
    // A read-only run says what it decided right after the header, and under each finding (R8 of the decision step).
    assert.match(text, /^Findings: 2 \(1 CONFIRMED, 1 PLAUSIBLE\); 1 refuted at verification\n\n## Decisions\n\nBefore any fix, the decision step decided each finding: 1 to fix, 0 to leave, 1 to ask the author\./m);
    assert.match(text, /^### Questions for the author\n\n[^\n]*\n\n- \[ \] 2\\\. SWEEP-1: fake question for \[1\]\?\n  - Default: fake default \(no edit\)$/m);
    assert.match(text, /^### To fix\n\n- 1\\\. RIPPLE-1: fake approach for \[0\]\. Grounds: fake grounds for \[0\]$/m);
    assert.match(text, /^Decision: fix: fake grounds for \[0\]$/m);
    assert.match(text, /^Decision: ask the author, defaulting to fake default \(no edit\); see Decisions: fake grounds for \[1\]$/m);
    assert.doesNotMatch(text, /^## Fixes$/m, 'a read-only run has no fix pass to report');
    assert.match(text, /## Refuted at verification\n\n- SCAN-2 \(SCAN\)  src\/a\.ts:6  other\(\) passes null\n  Evidence: other\(\) is never called/);
    assert.match(text, /^\| Total \| 19 \| /m);
    assert.match(text, /^\| decision \| 1 \| /m);
    assert.match(text, /^\| survey \| 1 \| /m);
    assert.match(text, /- Run budget: 60\.00 USD/);
    assert.match(text, /- Unlocated candidates.*RIPPLE-2 \(src\/nowhere\.ts:1\)/);
    // The prompts: the finder got its lead, the sweep got the lists, the verifier its numbered group, and every worker after the survey the scope block and the source it named.
    const ripple = box.promptOf(state, 'finder-RIPPLE finders:RIPPLE');
    assert.match(ripple, /^SCAN lead: callers of parse\(\)$/m);
    assert.match(ripple, /^Role: finder-RIPPLE\nUnit: RIPPLE\nPhase: finders$/m);
    assert.match(ripple, /### Convention sources\n\nThe repository survey named these files as stating the conventions a change here must follow:\n\n- AGENTS\.md \(repository\): how globs are quoted\n/);
    assert.match(box.promptOf(state, 'triage triage:SCAN'), /- AGENTS\.md \(repository\): how globs are quoted/);
    // The surveyor's own block has no such section, and a read-only run asks it for no check.
    const surveyor = box.promptOf(state, 'surveyor survey:survey');
    assert.doesNotMatch(surveyor, /### Convention sources/);
    assert.match(surveyor, /^Kinds to choose: none; this run does not fix/m);
    assert.match(surveyor, /\| src\/gone\.ts \| deleted \| .* \| deleted \|/);
    // It judges a source's reach by the changed paths, so it is given no patch; every later worker is.
    assert.doesNotMatch(surveyor, /### Patch/);
    assert.doesNotMatch(surveyor, /```diff\n/);
    assert.ok(box.logs.includes(`run ${state.id}: convention source AGENTS.md (repository): how globs are quoted`), box.logs.join('\n'));
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
    assert.equal(lockFree(() => acquireRunLock(box.checkpoint.root, state.id)), true, 'the lock is released');
  });

  it('reviews on the fake Codex, with no budget and no cost, and the report says the budget did not apply', async () => {
    box.script({});
    const text = report(await box.review('codex'));
    const state = box.run();
    assert.equal(state.review?.configuration.runtime, 'codex');
    assert.equal(state.review?.configuration.runBudgetUsd, null);
    assert.ok(state.review!.configuration.roles.every((role) => role.budgetUsd === null));
    // Nothing found: 1 survey + 1 triage + 9 finders, no deduplication, verification with no group, sweep, no merge-rank.
    assert.equal(Object.values(state.workers).length, 12);
    assert.match(text, /No finding survived verification\./);
    assert.match(text, /- The run budget did not apply: runtime codex reports no cost in USD/);
    assert.match(text, /^\| Total \| 12 \| [0-9.]+ \| - \| \d+ \| 0 \| \d+ \|$/m);
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
    assert.deepEqual(state.review!.unverifiedGroups.verification, { g2: '2 attempts did not complete: failed: The worker exited with code 1; failed: The worker exited with code 1' });
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
    assert.equal(Object.values(state.workers).length, 3, 'the surveyor and the two triage workers');
    box.script({});
    // The run keeps the scope it captured: the command's is never resolved, and the log says it is ignored.
    const scope = { named: true, request: (): never => assert.fail('a run that captured its scope asked for another') };
    report(await box.review('claude', { scope }));
    assert.ok(box.logs.includes(`run ${state.id} is active; its scope flags are ignored and the run continues`));
    state = box.run();
    assert.deepEqual(state.review!.phases.triage, { status: 'completed', attempt: 2 });
    assert.equal(state.review!.blocker, null);
    assert.equal(box.checkpoint.foldRuns().length, 1, 'the same run continued');
    assert.ok(box.logs.some((line) => /^phase triage: re-entered \(attempt 2\), clearing the worker-failed blocker$/.test(line)));
  });

  it('blocks with worker-failed when the decider fails twice, with no degrade, and running again decides and completes (R9 of the decision step)', async () => {
    box.script({ ...fullScript, decider: { exit: 2 } });
    const blocked = await box.review('claude');
    assert.ok(blocked.kind === 'blocked' && blocked.blocker.code === 'worker-failed' && blocked.blocker.phase === 'decision', JSON.stringify(blocked));
    assert.match(blocked.kind === 'blocked' ? blocked.blocker.detail : '', /^the decider worker for decision:decision failed twice/);
    const failed = box.run();
    assert.equal(failed.review!.phases.decision.status, 'blocked');
    assert.equal(failed.review!.decisions, null, 'nothing is decided, and nothing is reported');
    assert.equal(Object.values(failed.workers).filter((worker) => worker.launch.label === 'decider decision:decision').length, 2);
    box.script(fullScript);
    const text = report(await box.review('claude'));
    const decided = box.run();
    assert.deepEqual(decided.review!.phases.decision, { status: 'completed', attempt: 2 });
    assert.deepEqual(decided.review!.decisions?.map((decision) => decision.decision), ['fix', 'ask']);
    assert.match(text, /^## Decisions$/m);
  });

  it('decides nothing and launches no decider for a run whose ranking holds no finding', async () => {
    box.script({});
    report(await box.review('claude'));
    const state = box.run();
    assert.deepEqual(state.review!.phases.decision, { status: 'completed', attempt: 1 });
    assert.equal(state.review!.decisions, null);
    assert.ok(!Object.values(state.workers).some((worker) => worker.launch.label === 'decider decision:decision'));
  });

  it('refuses to resume a fix run configured before the decision step that has not planned its fixes, before anything is recorded, even with its own roles (R6 of the decision step)', async () => {
    // A run of this engine gives the configuration such a run pinned: the same one, recorded at version 4.
    box.script({ triage: { exit: 2 } });
    const first = await box.fix('claude');
    assert.ok(first.kind === 'blocked', JSON.stringify(first));
    const pinned = box.events(first.runId).find(([kind]) => kind === 'review.configured')![1];
    box.checkpoint.append(first.runId, box.checkpoint.fold(first.runId).lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'stand in for an older engine' } }]);
    const older = box.checkpoint.createRun({ worktree: box.repo });
    const captured = captureScope(box.checkpoint, older.id, { paths: [] });
    box.checkpoint.append(older.id, captured.lastSequence, [{ kind: 'review.configured', version: 4, payload: pinned }]);
    assert.equal(box.checkpoint.fold(older.id).review!.phases.decision.status, 'skipped', 'the run predates the decision step');
    const before = box.checkpoint.fold(older.id).lastSequence;
    await assert.rejects(box.fix('claude'), (error: unknown) => error instanceof ReviewRefusedError && new RegExp(`^run ${older.id} was configured before the decision step, which a fix run now routes its findings by, and has not planned its fixes; abandon it with \`deep-review abandon --run ${older.id} --reason <text>\` and start a new run$`).test(error.message));
    assert.equal(box.checkpoint.fold(older.id).lastSequence, before, 'nothing is recorded');
    // The same run without --fix pinned is a read-only review, which resumes and reads as it did.
    box.checkpoint.append(older.id, before, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'refused' } }]);
    const readOnly = box.checkpoint.createRun({ worktree: box.repo });
    box.checkpoint.append(readOnly.id, captureScope(box.checkpoint, readOnly.id, { paths: [] }).lastSequence, [{ kind: 'review.configured', version: 4, payload: { ...pinned, fix: false, checks: null, fixes: null } }]);
    box.script({});
    const text = report(await box.review('claude'));
    assert.equal(box.checkpoint.fold(readOnly.id).review!.phases.decision.status, 'skipped');
    assert.doesNotMatch(text, /^## Decisions$/m);
  });

  it('goes on without a fix run\'s failed survey on flags alone, reading only the user-level files, so a git history it cannot read does not stop it (R9 of the repository survey)', async () => {
    box.script({ surveyor: { exit: 2 } });
    const halfFlagged = { commands: { build: ReviewSandbox.checkFlags().commands.build! }, dropped: [] };
    const blocked = await box.review('claude', { fix: halfFlagged });
    assert.ok(blocked.kind === 'blocked' && blocked.blocker.code === 'worker-failed' && blocked.blocker.phase === 'survey', JSON.stringify(blocked));
    // The reviewer's authorship, which only the surveyor's task tells, is read with `git log`, which now fails; the escape hatch needs none of it.
    git(box.repo, 'config', 'log.date', 'not-a-date-format');
    assert.throws(() => git(box.repo, 'log', '-1', 'HEAD', '--'), 'git log fails in the repository');
    box.script({});
    report(await box.fix('claude'));
    const state = box.run();
    assert.equal(state.review!.phases.survey.status, 'degraded');
    assert.match(state.review!.survey!.failure!.reason, /^the survey blocked, /);
    assert.ok(state.review!.fix!.checks.planned!.checks.every((check) => check.origin === 'flag'));
    assert.equal(box.logs.filter((line) => line.startsWith('phase survey: going on without the survey: the survey blocked, ')).length, 1, box.logs.join('\n'));
    assert.ok(box.logs.includes(`run ${state.id}: survey: no convention source`), box.logs.join('\n'));
    // No survey answered, so the engine cannot tell which flags an earlier invocation gave: it says they must be given again.
    assert.deepEqual(box.logs.filter((line) => line.includes('has not planned its checks')), [`run ${state.id} has not planned its checks yet; --check and --no-check apply to each invocation until it does, so give again every one an earlier invocation gave`]);
    assert.ok(!box.logs.some((line) => line.includes('its survey was asked with')), box.logs.join('\n'));
  });

  it('names the kinds an earlier invocation\'s flags settled for the survey when a resume before the checks are planned leaves them unsettled (TD6 of the repository survey)', async () => {
    const stated = (kind: 'build' | 'typecheck' | 'lint' | 'test', missingTool: string | null = null): Record<string, unknown> =>
      ({ kind, command: missingTool === null ? fakeCheckCommand(kind) : `${missingTool} check .`, basis: 'stated', source: { path: 'package.json', quote: `"${kind}": "node ..."` }, missingTool, reason: null });
    box.script({ surveyor: [
      { output: { conventions: [], userRules: [], checks: [stated('lint', 'ruff'), stated('test')], note: '' } },
      { output: { conventions: [], userRules: [], checks: [stated('build'), stated('typecheck'), stated('test')], note: 'asked again' } },
    ] });
    const flags = ReviewSandbox.checkFlags();
    const blocked = await box.review('claude', { fix: { commands: { build: flags.commands.build!, typecheck: flags.commands.typecheck! }, dropped: [] } });
    assert.ok(blocked.kind === 'blocked' && blocked.blocker.code === 'check-unavailable', JSON.stringify(blocked));
    // The resume answers the block with --no-check lint, and gives neither of the --check flags the survey was asked with.
    report(await box.review('claude', { fix: { commands: {}, dropped: ['lint'] } }));
    const state = box.run();
    assert.ok(box.logs.includes(`run ${state.id}: its survey was asked with --check or --no-check settling build, typecheck, which this invocation leaves unsettled, so the survey is asked again for them; give those flags again to keep them`), box.logs.join('\n'));
    assert.deepEqual(state.review!.survey!.answers.map((answer) => answer.note), ['', 'asked again']);
    assert.deepEqual(state.review!.fix!.checks.planned!.checks.map((check) => [check.kind, check.origin]), [['build', 'survey'], ['typecheck', 'survey'], ['lint', 'flag'], ['test', 'survey']]);
  });

  it('lists, for a run configured before the survey existed and resumed, the rules files the engine found for it then, as its pinned role prompts expect', async () => {
    // A run of this engine gives the configuration such a run pinned: the same one, without the survey's setting or the Codex Windows sandbox.
    box.script({ triage: { exit: 2 } });
    const first = await box.review('claude');
    assert.ok(first.kind === 'blocked', JSON.stringify(first));
    const pinned = { ...box.events(first.runId).find(([kind]) => kind === 'review.configured')![1] };
    delete pinned.survey;
    delete pinned.codex;
    box.checkpoint.append(first.runId, box.checkpoint.fold(first.runId).lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'stand in for an older engine' } }]);
    const older = box.checkpoint.createRun({ worktree: box.repo });
    const captured = captureScope(box.checkpoint, older.id, { paths: [] });
    box.checkpoint.append(older.id, captured.lastSequence, [{ kind: 'review.configured', version: 2, payload: pinned }]);
    assert.equal(box.checkpoint.fold(older.id).review!.survey, null, 'the run predates the survey');
    const userFile = join(box.home, '.codex', 'AGENTS.md');
    write(box.home, '.codex/AGENTS.md', '# the reviewer\'s rules\n');
    // Resumed, it blocks in the triage again, whose prompt is the one to read.
    const resumed = await box.review('claude');
    assert.ok(resumed.kind === 'blocked' && resumed.runId === older.id, JSON.stringify(resumed));
    const state = box.checkpoint.fold(older.id);
    assert.equal(state.review!.phases.survey.status, 'skipped');
    const triage = box.promptOf(state, 'triage triage:SCAN');
    assert.ok(triage.includes(`### Rules files that govern the change\n\n- ${userFile} (user level)\n- AGENTS.md (repository)\n\n### Patch\n`), triage);
    assert.doesNotMatch(triage, /### Convention sources/);
  });

  it('records and logs a run going on without its survey the same way in a read-only review as in a fix run, the user-level files decided by the policy alone (R3, R9 of the repository survey)', async () => {
    const userFile = join(box.home, '.claude', 'CLAUDE.md');
    write(box.home, '.claude/CLAUDE.md', '# the reviewer\'s rules\n');
    box.script({ surveyor: { exit: 2 } });
    report(await box.review('claude'));
    const state = box.run();
    assert.equal(state.review!.phases.survey.status, 'degraded');
    const failed = box.events(state.id).filter(([kind]) => kind === 'survey.failed');
    assert.equal(failed.length, 1);
    assert.deepEqual(failed[0]![1].userRules, [{ path: userFile, applied: false, reason: policyWords.unjudged }]);
    const going = box.logs.filter((line) => line.startsWith('phase survey: going on without the survey: '));
    assert.deepEqual(going, [`phase survey: going on without the survey: ${state.review!.survey!.failure!.reason}`]);
    assert.match(going[0]!, /: 2 attempts did not complete: /);
    assert.ok(box.logs.includes(`run ${state.id}: survey: no convention source`), box.logs.join('\n'));
    assert.ok(box.logs.includes(`run ${state.id}: user-level rules ${userFile}: not applied, ${policyWords.unjudged}`), box.logs.join('\n'));
  });

  it('blocks on the run budget before a launch, and completes when run again with a higher --budget-usd', async () => {
    // The surveyor reports no cost, so the budget meets the triage and the finders as it did before the survey.
    box.script({ '*': { costUsd: 12 }, surveyor: { costUsd: 0 } });
    const blocked = await box.review('claude', { flags: { budgetUsd: 20 } });
    assert.equal(blocked.kind, 'blocked');
    if (blocked.kind === 'blocked') {
      assert.equal(blocked.blocker.code, 'budget');
      // The triage spent 12 USD; four finders then launched together under the 20 USD budget, since the check runs before a launch, not during a worker, and spent 48 more.
      assert.match(blocked.blocker.detail, /^spent 60\.00 USD of the 20\.00 USD run budget$/);
      assert.match(blocked.blocker.action, /--budget-usd above 60\.00/);
    }
    let state = box.run();
    assert.equal(Object.values(state.workers).length, 6, 'the surveyor, the triage and one batch of four finders ran before the check stopped the next launch');
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

  it('charges a timed-out worker, which reports no cost, at its per-worker cap, so timeouts reach the run budget', async () => {
    // Every worker reports 0.5 USD but REMOVALS, which hangs until its timeout; every role is capped at 8 USD.
    // One worker at a time, so REMOVALS, the first angle, is the only finder launched before its timeout settles.
    box.script({ '*': { costUsd: 0.5 }, surveyor: { costUsd: 0 }, 'finder-REMOVALS': { hang: true } });
    const blocked = await box.review('claude', { flags: { budgetUsd: 8, concurrency: 1 } });
    assert.ok(blocked.kind === 'blocked' && blocked.blocker.code === 'budget', JSON.stringify(blocked));
    // The triage reported 0.50 USD and the timeout counts its 8 USD cap, so REMOVALS is not tried again.
    assert.equal(blocked.blocker.detail, 'spent 8.50 USD of the 8.00 USD run budget, counting 1 worker that reported no cost at its per-worker cap');
    const state = box.run();
    assert.equal(Object.values(state.workers).length, 3, 'the surveyor, the triage and the one REMOVALS worker');
    assert.equal(state.review!.anglesNotRun.REMOVALS, undefined, 'the angle is blocked on the budget, not given up');
    const lines = describeRun(state, claudeAdapter, () => '').lines;
    assert.ok(lines.includes('Budget check: 8.50 USD of 8.00 USD, counting 1 worker that reported no cost at its per-worker cap'), lines.join('\n'));
    assert.ok(lines.some((line) => /^Spend: 0\.50 USD; /.test(line)), lines.join('\n'));
  });

  it('blocks with drift when a scope file changes while the triage runs, sets its answer aside, and completes once the tree is restored', async () => {
    const marker = join(box.directory, 'triage-may-answer');
    box.script({ triage: { waitFor: marker } });
    const original = readFileSync(join(box.repo, 'src', 'b.ts'), 'utf8');
    const pending = box.review('claude');
    // While the triage worker waits, the tree changes; the check before its answer is recorded sees it. The
    // edit waits for the triage worker on the ledger, which launches only after the scope is captured and the
    // survey answered: an edit made before the capture would be part of the scope, and one made while the
    // surveyor ran would block the survey instead.
    await until(() => box.checkpoint.foldRuns().some((run) => Object.values(run.workers).some((worker) => worker.status === 'running' && worker.launch.label === 'triage triage:SCAN')), 'the triage worker on the ledger', 60_000);
    write(box.repo, 'src/b.ts', 'export const b = 2;\n');
    writeFileSync(marker, '');
    const blocked = await pending;
    assert.equal(blocked.kind, 'blocked');
    let expectedAt = '';
    if (blocked.kind === 'blocked') {
      assert.equal(blocked.blocker.code, 'drift');
      assert.equal(blocked.blocker.phase, 'triage');
      // The detail names where the bytes the run expected are, so the operator can put the file back (R7 of the fix pass).
      const named = /src\/b\.ts \(modified; expected at (.+)\)$/.exec(blocked.blocker.detail);
      assert.ok(named !== null, blocked.blocker.detail);
      expectedAt = named[1]!;
      assert.match(blocked.blocker.action, /restore the named files to the bytes the run expected/);
    }
    assert.equal(readFileSync(expectedAt, 'utf8'), original, 'the evidence path holds the bytes the run expected');
    let state = box.run();
    const check = state.review!.checks.at(-1)!;
    assert.deepEqual({ ...check, files: check.files.map((file) => ({ path: file.path, outcome: file.outcome })) }, { phase: 'triage', attempt: 1, moment: 'answer', drifted: true, head: null, files: [{ path: 'src/b.ts', outcome: 'modified' }], strays: [] });
    assert.equal(state.review!.leads, null, 'the answer computed against the edited tree is not recorded');
    assert.deepEqual(state.review!.units.triage, {}, 'nor counted as a failure');
    assert.ok(box.logs.some((line) => /^worker triage triage:SCAN: answer set aside: the worktree drifted from what the run expects: src\/b\.ts \(modified\)$/.test(line)), box.logs.join('\n'));
    // Still drifted: the check at the re-entered attempt's start blocks again at once, without a worker.
    const again = await box.review('claude');
    assert.ok(again.kind === 'blocked' && again.blocker.code === 'drift', JSON.stringify(again));
    assert.equal(Object.values(box.run().workers).length, 2, 'the surveyor and the first triage worker');
    // Restored from the path the blocker named.
    writeFileSync(join(box.repo, 'src', 'b.ts'), readFileSync(expectedAt));
    box.script({});
    const text = report(await box.review('claude'));
    state = box.run();
    assert.deepEqual(state.review!.phases.triage, { status: 'completed', attempt: 3 });
    assert.equal(Object.values(state.workers).filter((worker) => worker.launch.label === 'triage triage:SCAN').length, 2, 'the triage is launched once more');
    assert.deepEqual(box.events(state.id).filter(([kind]) => kind === 'attempt.failed'), []);
    // The survey's one check; triage attempt 1 has its clean check at the start and the drifted one before its answer; attempts 2 and 3 one each; nine more phases, the decision among them.
    assert.match(text, /- Worktree checks: 14, 2 found a difference in triage \(attempt 1: src\/b\.ts modified\); triage \(attempt 2: src\/b\.ts modified\)/);
  });

  it('sets aside a finder\'s answer when a scope file changes while it runs, lets the others settle, and relaunches it without using an attempt', async () => {
    const marker = join(box.directory, 'removals-may-answer');
    box.script({ 'finder-REMOVALS': { waitFor: marker } });
    const original = readFileSync(join(box.repo, 'src', 'b.ts'), 'utf8');
    const pending = box.review('claude');
    const removals = 'finder-REMOVALS finders:REMOVALS';
    await until(() => box.checkpoint.foldRuns().some((run) => Object.values(run.workers).some((worker) => worker.launch.label === removals && worker.status === 'running')), 'the REMOVALS worker on the ledger', 60_000);
    write(box.repo, 'src/b.ts', 'export const b = 2;\n');
    writeFileSync(marker, '');
    const blocked = await pending;
    assert.ok(blocked.kind === 'blocked' && blocked.blocker.code === 'drift' && blocked.blocker.phase === 'finders', JSON.stringify(blocked));
    const state = box.run();
    const drifted = state.review!.checks.filter((check) => check.drifted);
    assert.deepEqual(drifted.map((check) => [check.phase, check.attempt, check.moment, check.files.map((file) => `${file.path} ${file.outcome}`)]), [['finders', 1, 'answer', ['src/b.ts modified']]], 'one drifted check for the attempt, however many answers settle after it');
    assert.equal(state.review!.units.finders.REMOVALS, undefined, 'REMOVALS has no answer and no failure');
    assert.equal(Object.values(state.workers).filter((worker) => worker.status === 'running').length, 0, 'every worker in flight settled before the phase blocked');
    assert.deepEqual(state.review!.phases.finders, { status: 'blocked', attempt: 1 });

    write(box.repo, 'src/b.ts', original);
    box.script({});
    report(await box.review('claude'));
    const after = box.run();
    assert.equal(Object.values(after.workers).filter((worker) => worker.launch.label === removals).length, 2, 'REMOVALS ran once more');
    assert.equal(typeof after.review!.units.finders.REMOVALS?.answeredBy, 'string', 'and its answer is recorded');
    assert.deepEqual(after.review!.anglesNotRun, {});
    assert.deepEqual(box.events(after.id).filter(([kind]) => kind === 'attempt.failed'), [], 'the set-aside answer used no attempt');
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
      await until(() => box.checkpoint.foldRuns().some((run) => Object.values(run.workers).some((worker) => worker.status === 'running')), 'the triage worker on the ledger', 60_000);
      assert.ok(process.listenerCount('SIGINT') > signalListeners, 'an interruption releases the held lock');
      const state = box.run();
      box.checkpoint.append(state.id, state.lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'abandoned under the worker' } }]);
      writeFileSync(marker, '');
      await assert.rejects(pending, RunClosedError);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(unhandled, []);
      assert.equal(box.run().status, 'abandoned');
      assert.equal(lockFree(() => acquireRunLock(box.checkpoint.root, state.id)), true, 'the lock is released on the way out');
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
      const running = (): string[] => box.checkpoint.foldRuns().flatMap((run) => Object.values(run.workers).filter((worker) => worker.status === 'running').map((worker) => worker.launch.label ?? ''));
      await until(() => running().length === 2, 'REMOVALS and RIPPLE running', 60_000);
      writeFileSync(broken, '');
      writeFileSync(rippleMayAnswer, '');
      await until(() => settled || box.logs.some((line) => /waiting for 1 worker in flight/.test(line)), 'the launcher error', 60_000);
      assert.equal(settled, false, 'the review does not end while REMOVALS runs');
      assert.deepEqual(running(), ['finder-REMOVALS finders:REMOVALS']);
    } finally {
      writeFileSync(removalsMayAnswer, '');
    }
    // Refused as at startup, with the blocker code, not as an engine error; the run is configured, so the action is one a resume can take.
    const configured = box.run();
    await assert.rejects(pending, (error: unknown) => error instanceof ReviewRefusedError && error.code === 'runtime-unqualified' && /does not identify itself as claude: /.test(error.message)
      && error.message.endsWith(pinnedAction(configured)));
    const state = box.run();
    assert.deepEqual(Object.values(state.workers).filter((worker) => worker.status !== 'finished'), [], 'no worker is left running on the ledger');
    assert.notEqual(state.review!.units.finders.REMOVALS?.answeredBy ?? null, null, 'the answer REMOVALS gave while the review wound down is recorded');
    assert.equal(lockFree(() => acquireRunLock(box.checkpoint.root, state.id)), true, 'the lock is released after the last worker');
  });

  it('refuses to resume a run from another worktree of the repository, naming the run\'s worktree', async () => {
    box.script({ triage: { exit: 2 } });
    await box.review('claude');
    const runId = box.run().id;
    // A second worktree shares the checkpoint, which lives under the common git directory.
    const other = join(box.directory, 'other');
    git(box.repo, 'worktree', 'add', '--detach', other, 'HEAD');
    const otherRoot = realpathSync.native(other);
    box.script({});
    await assert.rejects(box.review('claude', { worktree: otherRoot }), (error: unknown) => error instanceof ReviewRefusedError && error.code === null
      && error.message === `run ${runId} is active in worktree ${box.repo}, not ${otherRoot}; run the command there, or abandon the run with \`deep-review abandon --run ${runId} --reason <text>\``);
    assert.equal(Object.values(box.run().workers).length, 3, 'nothing ran in the other worktree');
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

  it('refuses to resume a run whose pinned executable no longer qualifies, with an action a resumed run can take', async () => {
    box.script({ triage: { exit: 2 } });
    await box.review('claude');
    const state = box.run();
    // An update replaced the pinned binary with one lacking a flag; --executable names one that would qualify, which a configured run ignores.
    await assert.rejects(box.review('claude', { executable: process.execPath }, { FAKE_HELP_OMIT: '--json-schema' }), (error: unknown) => error instanceof ReviewRefusedError && error.code === 'runtime-unqualified'
      && /lacks flags the adapter uses/.test(error.message)
      && error.message.endsWith(pinnedAction(state))
      && !/pass --executable/.test(error.message));
    assert.equal(Object.values(box.run().workers).length, 3, 'nothing ran');
  });

  it('resolves the command\'s executable only for a run not yet configured, and a refusal of it creates no run', async () => {
    const refused = (): never => {
      throw new ReviewRefusedError('the executable was refused', 'runtime-unqualified');
    };
    await assert.rejects(box.review('claude', { executable: refused }), (error: unknown) => error instanceof ReviewRefusedError && error.message === 'the executable was refused');
    assert.deepEqual(box.checkpoint.foldRuns(), [], 'no run was created');
    assert.equal(lockFree(() => acquireStartLock(box.checkpoint.root)), true, 'the start lock is released');
    let resolved = 0;
    const resolve = (): string => {
      resolved += 1;
      return process.execPath;
    };
    box.script({ triage: { exit: 2 } });
    assert.equal((await box.review('claude', { executable: resolve })).kind, 'blocked');
    assert.equal(resolved, 1, 'a new run resolves it once');
    assert.equal(box.run().review!.configuration.executable, process.execPath, 'and pins what it resolved');
    box.script({});
    report(await box.review('claude', { executable: () => assert.fail('a configured run resolved the command\'s executable') }));
  });

  it('refuses to resume a run whose role prompts changed since it was configured, naming both digests', async () => {
    box.script({ triage: { exit: 2 } });
    await box.review('claude');
    const state = box.run();
    writeFileSync(join(box.rolesRoot, 'fragments', 'rubrics.md'), `${readFileSync(join(box.rolesRoot, 'fragments', 'rubrics.md'), 'utf8')}\nOne more rule.\n`);
    await assert.rejects(box.review('claude'), (error: unknown) => error instanceof ReviewRefusedError && error.code === null
      && error.message.startsWith(`run ${state.id} was configured with roles digest ${state.review!.configuration.rolesDigest}, and the roles at ${box.rolesRoot} now digest `)
      && error.message.endsWith(`; run it with the roles it started with (--roles <dir>), or abandon it with \`deep-review abandon --run ${state.id} --reason <text>\``));
    assert.equal(Object.values(box.run().workers).length, 3, 'nothing ran');
  });

  it('refuses --budget-usd when resuming a run on a runtime that reports no cost, as a new run does', async () => {
    box.script({ triage: { exit: 2 } });
    await box.review('codex');
    await assert.rejects(box.review('codex', { flags: { budgetUsd: 5 } }), (error: unknown) => error instanceof InvalidPolicyError && /--budget-usd does not apply to runtime codex/.test(error.message));
    await assert.rejects(box.review('codex', { flags: { concurrency: 0 } }), (error: unknown) => error instanceof InvalidPolicyError && error.message === `--concurrency must be a whole number from 1 to ${String(maxConcurrency)}, not 0`);
  });

  it('refuses a resumed run whose runtime differs, and two active runs', async () => {
    box.script({ triage: { exit: 2 } });
    await box.review('claude');
    await assert.rejects(box.review('codex'), (error: unknown) => error instanceof ReviewRefusedError && /pinned to runtime claude, not codex/.test(error.message));
    box.checkpoint.createRun({ worktree: box.repo });
    await assert.rejects(box.review('claude'), /2 runs are active/);
  });

  it('refuses an unqualified runtime before any run exists', async () => {
    await assert.rejects(box.review('claude', {}, { FAKE_HELP_OMIT: '--json-schema' }), (error: unknown) => error instanceof ReviewRefusedError && error.code === 'runtime-unqualified' && /lacks flags the adapter uses/.test(error.message)
      && error.message.endsWith('; fix the runtime installation or pass --executable with a qualifying binary, then run the command again'));
    assert.deepEqual(box.checkpoint.foldRuns(), []);
  });

  it('finds or creates the run under the start lock, so an engine starting meanwhile is refused and creates no run of its own', async () => {
    // Another holder of the start lock, as an engine between its find and its run lock holds it; a second connection in this process is refused like another process.
    const release = acquireStartLock(box.checkpoint.root);
    try {
      await assert.rejects(box.review('claude'), (error: unknown) => error instanceof ReviewRefusedError && error.code === 'lock-held' && new RegExp(`^engine ${String(process.pid)} is starting or ending a run in this repository`).test(error.message));
      assert.deepEqual(box.checkpoint.foldRuns(), [], 'no run was created');
    } finally {
      release();
    }
    box.script({});
    report(await box.review('claude'));
    assert.equal(lockFree(() => acquireStartLock(box.checkpoint.root)), true, 'the start lock is released once the run is locked');
  });

  it('appends every event once: a foreign append between its plan and its append is refused as stale, not re-sent, and the lock is released', async () => {
    let foreign = 0;
    const log = (line: string): void => {
      box.logs.push(line);
      // Another writer breaks in between the plan that starts the first phase and its append.
      if (line === 'phase survey: started (attempt 1)') {
        const state = box.run();
        box.checkpoint.append(state.id, state.lastSequence, [{ kind: 'worker.launched', version: 1, payload: frozenLaunch(box.checkpoint, worker(90), 'another writer') }]);
        foreign += 1;
      }
    };
    await assert.rejects(box.review('claude', { log }), (error: unknown) => error instanceof StaleRevisionError);
    assert.equal(foreign, 1);
    const state = box.run();
    assert.deepEqual(box.events(state.id).filter(([kind]) => kind === 'phase.started'), [], 'the phase.started planned before the foreign append is not re-sent over it');
    assert.equal(state.workers[worker(90)]?.status, 'running', 'the foreign event stands');
    assert.equal(lockFree(() => acquireRunLock(box.checkpoint.root, state.id)), true, 'the lock is released');
  });

  it('reads a found run again once its lock is held, so a worker finished after the find is not recorded lost', async () => {
    box.script({ triage: { exit: 2 } });
    assert.equal((await box.review('claude')).kind, 'blocked');
    const runId = box.run().id;
    // A worker another engine launched and still runs, as the ledger says when this engine looks for its run.
    box.checkpoint.append(runId, box.run().lastSequence, [{ kind: 'worker.launched', version: 1, payload: frozenLaunch(box.checkpoint, worker(91), 'another engine') }]);
    // That engine records the worker's finish right after the find, before this one takes the run lock.
    const late = afterFind(box.checkpoint, (target) => {
      target.append(runId, target.fold(runId).lastSequence, [{ kind: 'worker.finished', version: 1, payload: frozenFinish(target, worker(91)) }]);
    });
    box.script({});
    report(await box.review('claude', { checkpoint: late.checkpoint }));
    assert.equal(late.acted(), true);
    const state = box.run();
    assert.equal(state.workers[worker(91)]?.status, 'finished', 'the late finish stands');
    assert.deepEqual(box.events(runId).filter(([kind]) => kind === 'worker.lost'), [], 'no worker is recorded lost');
    assert.ok(!box.logs.some((line) => /lost with the previous engine/.test(line)), box.logs.join('\n'));
  });

  it('creates a new run when the found run stops being resumable before its lock is taken, and leaves that run as it is', async () => {
    box.script({ triage: { exit: 2 } });
    assert.equal((await box.review('claude')).kind, 'blocked');
    const first = box.run();
    // The run is closed right after the find, as the report an engine writes as it ends would close it to a review.
    const late = afterFind(box.checkpoint, (target) => {
      target.append(first.id, target.fold(first.id).lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'closed after the find' } }]);
    });
    box.script({});
    const outcome = await box.review('claude', { checkpoint: late.checkpoint });
    assert.equal(late.acted(), true);
    report(outcome);
    const runs = box.checkpoint.foldRuns();
    assert.deepEqual(runs.map((run) => [run.id === first.id, run.status]), [[true, 'abandoned'], [false, 'active']]);
    assert.equal(outcome.runId, runs[1]!.id, 'the review ran a run of its own');
    assert.equal(box.checkpoint.fold(first.id).lastSequence, first.lastSequence + 1, 'nothing but the close was appended to the first run');
    assert.ok(box.logs.includes(`run ${first.id}: abandoned before its lock was taken; a new run is created`), box.logs.join('\n'));
    assert.equal(lockFree(() => acquireRunLock(box.checkpoint.root, first.id)), true, 'its lock is released');
  });

  // Issue #37: one run another engine build wrote, holding an event this engine does not declare, stopped every review of the repository.
  describe('a run this engine cannot read', () => {
    const passedOver = (runId: string): string[] => box.logs.filter((line) => line.startsWith(`run ${runId}: passed over: `));

    it('is passed over, with one line naming its event and the engine that wrote it, and the review runs a run of its own', async () => {
      const unreadable = box.unreadableRun();
      box.script({});
      const outcome = await box.review('claude');
      report(outcome);
      assert.notEqual(outcome.runId, unreadable);
      assert.deepEqual(passedOver(unreadable), [`run ${unreadable}: passed over: it holds phase.finished@99 at sequence 2, written by engine ${otherEngine}, which this engine (0.0.0-test) does not declare; an engine that declares it, such as the one that wrote it, can read the run`]);
      assert.equal(box.checkpoint.ledger.lastSequence(unreadable), 2, 'nothing was appended to the run passed over');
      assert.deepEqual(box.checkpoint.listRuns().map((run) => run.id), [unreadable, outcome.runId]);
    });

    it('takes no part in finding the run to resume: the readable active run beside it resumes', async () => {
      box.script({ triage: { exit: 2 } });
      assert.equal((await box.review('claude')).kind, 'blocked');
      const first = box.run();
      const unreadable = box.unreadableRun();
      // Sequences are global to the ledger, so the run's last one follows the blocked run's events.
      const before = box.checkpoint.ledger.lastSequence(unreadable);
      box.script({});
      const outcome = await box.review('claude');
      report(outcome);
      assert.equal(outcome.runId, first.id, 'the blocked run resumed');
      assert.equal(passedOver(unreadable).length, 1, box.logs.join('\n'));
      assert.equal(box.checkpoint.ledger.lastSequence(unreadable), before, 'nothing was appended to the run passed over');
    });

    it('takes no part in the refusal of two active runs, which names the readable ones only', async () => {
      box.script({ triage: { exit: 2 } });
      assert.equal((await box.review('claude')).kind, 'blocked');
      const first = box.run().id;
      box.unreadableRun();
      const second = box.checkpoint.createRun({ worktree: box.repo }).id;
      await assert.rejects(box.review('claude'), (error: unknown) => error instanceof ReviewRefusedError && error.message.startsWith(`2 runs are active (${first}, ${second});`));
    });

    it('is passed over when another engine makes the found run unreadable before its lock is taken, and the lock is released', async () => {
      box.script({ triage: { exit: 2 } });
      assert.equal((await box.review('claude')).kind, 'blocked');
      const first = box.run();
      // The engine that held the run appends an event this one does not declare right after the find.
      const late = afterFind(box.checkpoint, () => {
        box.addUnknownEvent(first.id);
      });
      box.script({});
      const outcome = await box.review('claude', { checkpoint: late.checkpoint });
      assert.equal(late.acted(), true);
      report(outcome);
      assert.notEqual(outcome.runId, first.id, 'the review ran a run of its own');
      assert.equal(box.checkpoint.ledger.lastSequence(first.id), first.lastSequence + 1, 'nothing but the event of the other engine was appended to the found run');
      assert.equal(passedOver(first.id).length, 1, box.logs.join('\n'));
      assert.ok(passedOver(first.id)[0]!.includes(`it holds phase.finished@99 at sequence ${String(first.lastSequence + 1)}, written by engine ${otherEngine},`), box.logs.join('\n'));
      assert.ok(!box.logs.some((line) => line.includes('before its lock was taken')), box.logs.join('\n'));
      assert.equal(lockFree(() => acquireRunLock(box.checkpoint.root, first.id)), true, 'its lock is released');
    });
  });
});

describe('presurveyRulesFiles', () => {
  let sandbox: string;
  let home: string;
  let worktree: string;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'deep-review-presurvey-'));
    home = join(sandbox, 'home');
    worktree = join(sandbox, 'repo');
    mkdirSync(home);
    mkdirSync(worktree);
  });
  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));
  const rulesFile = (root: string, path: string): void => write(root, path, `# ${path}\n`);

  it('lists nothing when no rules file exists, and the root alone for no changed path', () => {
    assert.deepEqual(presurveyRulesFiles(worktree, ['src/a.ts'], home), []);
    rulesFile(worktree, 'AGENTS.md');
    rulesFile(worktree, 'src/AGENTS.md');
    assert.deepEqual(presurveyRulesFiles(worktree, [], home), [{ level: 'repository', path: 'AGENTS.md' }]);
  });

  it('lists the user files first, then the root and each ancestor directory of a changed file, shallowest first, as the engine did before the survey', () => {
    rulesFile(home, '.claude/CLAUDE.md');
    rulesFile(home, '.codex/AGENTS.md');
    rulesFile(worktree, 'AGENTS.md');
    rulesFile(worktree, 'CLAUDE.local.md');
    rulesFile(worktree, 'src/CLAUDE.md');
    rulesFile(worktree, 'src/deep/AGENTS.md');
    rulesFile(worktree, 'lib/CLAUDE.md');
    // A directory that holds no changed file is not an ancestor, and its rules file is left out.
    rulesFile(worktree, 'other/CLAUDE.md');
    assert.deepEqual(presurveyRulesFiles(worktree, ['src/deep/a.ts', 'src/b.ts', 'lib/c.ts', 'src/deep/d.ts'], home), [
      { level: 'user', path: join(home, '.claude', 'CLAUDE.md') },
      { level: 'user', path: join(home, '.codex', 'AGENTS.md') },
      { level: 'repository', path: 'CLAUDE.local.md' },
      { level: 'repository', path: 'AGENTS.md' },
      { level: 'repository', path: 'lib/CLAUDE.md' },
      { level: 'repository', path: 'src/CLAUDE.md' },
      { level: 'repository', path: 'src/deep/AGENTS.md' },
    ]);
  });

  it('passes over a directory named like a rules file', () => {
    mkdirSync(join(worktree, 'CLAUDE.md'));
    rulesFile(worktree, 'src/AGENTS.md');
    assert.deepEqual(presurveyRulesFiles(worktree, ['src/a.ts'], home), [{ level: 'repository', path: 'src/AGENTS.md' }]);
  });
});
