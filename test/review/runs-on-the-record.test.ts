import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VerdictsRecordedV2 } from '../../src/checkpoint/events.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { UnsupportedCapabilityError } from '../../src/runtime/errors.ts';
import { RuntimeRegistry } from '../../src/runtime/registry.ts';
import { defaultRuntimes } from '../../src/runtime/runtimes.ts';
import type { Script } from '../helpers/fake-runtime.ts';
import { ReviewSandbox, sandboxConcurrency } from '../helpers/review-sandbox.ts';

const noLeads = ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'].map((angle) => ({ angle, lead: null }));

/** A review whose triage finds one candidate, src/a.ts line 2, verified in group g1; every other worker answers the fake's default. */
const oneCandidate: Script = {
  triage: { output: { candidates: [{ file: 'src/a.ts', line: 2, summary: 'text is dereferenced when null', detail: 'parse(null) throws' }], leads: noLeads, change: null } },
};

/** A verifier's answer that rests on a run it never made. */
const unmadeRun = { output: { verdicts: [{ index: 0, verdict: 'CONFIRMED', evidence: 'the probe threw', basis: 'ran', runs: [{ command: 'node probe-9.mjs', printed: ['TypeError: never printed'], probe: null }] }] } };

/** The events of run `runId` as kind, version and payload, in ledger order. */
const ledgerOf = (box: ReviewSandbox, runId: string): { kind: string; version: number; payload: unknown }[] => box.checkpoint.ledger.events(runId).map((event) => ({ kind: event.kind, version: event.version, payload: JSON.parse(event.payload) as unknown }));

/** The schema g1's verifiers of a run were launched with, as text, in launch order. */
const verifierSchemas = (box: ReviewSandbox, state: RunState): string[] =>
  Object.values(state.workers).filter((worker) => worker.launch.label === 'verifier verification:g1').map((worker) => box.checkpoint.evidence.read(worker.launch.schema).toString('utf8'));

// R1, R4, R5, R9, R11 and PD3 of runs on the record.
describe('a review with runs on the record', { timeout: 600_000, concurrency: sandboxConcurrency }, () => {
  it('records a verifier\'s verdict with the run it rests on, found in its record, and the probe it ran frozen', async (t) => {
    const box = ReviewSandbox.forTest(t, oneCandidate);
    const outcome = await box.review('claude');
    assert.equal(outcome.kind, 'report', box.logs.join('\n'));
    const state = box.run();
    assert.equal(state.review!.citedRuns, true);
    for (const schema of verifierSchemas(box, state)) assert.match(schema, /"basis"/);
    const recorded = ledgerOf(box, state.id).filter((event) => event.kind === 'verdicts.recorded');
    assert.deepEqual(recorded.map((event) => event.version), [2]);
    const [verdict] = (recorded[0]!.payload as VerdictsRecordedV2).verdicts;
    assert.equal(verdict?.basis, 'ran');
    assert.deepEqual(verdict?.runs.map((run) => [run.command.endsWith('probe-0.mjs'), run.printed, run.at, run.exitCode, run.probe?.name]), [[true, ['fake probe for [0] ran'], 1, 0, 'probe-0.mjs']]);
    assert.equal(box.checkpoint.evidence.read(verdict!.runs[0]!.probe!.blob).toString('utf8'), 'console.log("fake probe for [0] ran");\n');
    assert.deepEqual(state.review!.candidates['SCAN-1']!.verdict?.runs, verdict?.runs, 'the fold holds the verdict with its run');
  });

  it('runs a verifier again when its answer cites a run its record does not hold, and records the second answer', async (t) => {
    const box = ReviewSandbox.forTest(t, { ...oneCandidate, 'verifier:verification:g1': [unmadeRun, {}] });
    assert.equal((await box.review('claude')).kind, 'report', box.logs.join('\n'));
    const events = ledgerOf(box, box.run().id);
    const failed = events.filter((event) => event.kind === 'attempt.failed').map((event) => (event.payload as { reason: string }).reason);
    assert.deepEqual(failed, ['structural check: The verdict for index 0 cites a run that the record of its shell runs does not hold: node probe-9.mjs']);
    assert.ok(box.logs.some((line) => line.includes('node probe-9.mjs')), 'the log names the run not found');
    assert.equal(box.run().review!.candidates['SCAN-1']!.verdict?.basis, 'ran');
  });

  it('leaves a group unverified when the second answer also cites a run its record does not hold', async (t) => {
    const box = ReviewSandbox.forTest(t, { ...oneCandidate, 'verifier:verification:g1': unmadeRun });
    assert.equal((await box.review('claude')).kind, 'report', box.logs.join('\n'));
    const review = box.run().review!;
    assert.deepEqual(Object.keys(review.unverifiedGroups.verification), ['g1']);
    assert.equal(review.candidates['SCAN-1']!.unverified, true);
    assert.equal(review.candidates['SCAN-1']!.verdict, null);
    assert.equal(ledgerOf(box, box.run().id).filter((event) => event.kind === 'attempt.failed').length, 2);
  });

  it('records a reading Codex verifier\'s run, which names no probe since it has no scratch directory', async (t) => {
    const box = ReviewSandbox.forTest(t, oneCandidate);
    assert.equal((await box.review('codex')).kind, 'report', box.logs.join('\n'));
    const state = box.run();
    assert.match(box.promptOf(state, 'verifier verification:g1'), /When your rubric has you run a probe, run it as a command: you have no scratch directory/);
    const verdict = state.review!.candidates['SCAN-1']!.verdict;
    assert.deepEqual(verdict?.runs.map((run) => [run.at, run.probe]), [[1, null]]);
  });

  it('keeps a run configured before runs on the record on its answers when this engine resumes it: the old schema, and no event at a version runs on the record adds', async (t) => {
    const box = ReviewSandbox.forTest(t);
    const runId = await box.configuredAt(8);
    box.script(oneCandidate);
    const outcome = await box.review('claude');
    assert.ok(outcome.kind === 'report' && outcome.runId === runId, box.logs.join('\n'));
    const state = box.checkpoint.fold(runId);
    assert.equal(state.review!.citedRuns, false);
    for (const schema of verifierSchemas(box, state)) assert.doesNotMatch(schema, /"basis"/);
    assert.doesNotMatch(box.promptOf(state, 'verifier verification:g1'), /basis/);
    const added = new Set(['review.configured@9', 'verdicts.recorded@2', 'fix.recorded@5']);
    assert.deepEqual(ledgerOf(box, runId).map((event) => `${event.kind}@${String(event.version)}`).filter((key) => added.has(key)), []);
    assert.equal(state.review!.candidates['SCAN-1']!.verdict?.basis, null);
  });

  it('refuses a runtime whose record holds no shell runs when it configures a run, before the run exists', async (t) => {
    const box = ReviewSandbox.forTest(t, oneCandidate);
    const claude = defaultRuntimes().get('claude');
    const blind = new RuntimeRegistry([{ ...claude, capabilities: { ...claude.capabilities, shellRecord: false } }]);
    await assert.rejects(box.review('claude', { runtimes: blind }), (error: unknown) => error instanceof UnsupportedCapabilityError && error.capability === 'shellRecord' && error.runtime === 'claude');
    assert.deepEqual(box.checkpoint.listRuns(), []);
  });
});
