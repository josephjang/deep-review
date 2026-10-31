import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { FixRecordedV5, VerdictsRecordedV2 } from '../../src/checkpoint/events.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { UnsupportedCapabilityError } from '../../src/runtime/errors.ts';
import { RuntimeRegistry } from '../../src/runtime/registry.ts';
import { defaultRuntimes } from '../../src/runtime/runtimes.ts';
import { fixerAnswer, type Script } from '../helpers/fake-runtime.ts';
import { fixedA, fixedB, reviewScript } from '../helpers/fix-pass-fixture.ts';
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

/** The `fix.recorded` of unit `key` in run `runId`, with its version. */
const fixRecordedOf = (box: ReviewSandbox, runId: string, key: string): { version: number; payload: FixRecordedV5 } => {
  const event = ledgerOf(box, runId).find((candidate) => candidate.kind === 'fix.recorded' && (candidate.payload as FixRecordedV5).key === key);
  if (event === undefined) throw new Error(`No answer of ${key} is recorded`);
  return { version: event.version, payload: event.payload as FixRecordedV5 };
};

/** The fix pass of fix-pass-fixture.ts, each fixer editing its file. */
const fixingScript = (c1: object = {}, c2: object = {}): Script => ({
  ...reviewScript,
  'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'] }]), ...c1 },
  'fixer:fixes:c2-1': { edits: [{ writes: { 'src/b.ts': fixedB }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/b.ts'] }]), ...c2 },
});

// R6, R7, PD4 and TD7 of runs on the record.
describe('a fix pass with runs on the record', { timeout: 600_000, concurrency: sandboxConcurrency }, () => {
  it('gives a fixer the runs its finding\'s verdict rests on and the probe to run, records the runs its validation cites with where its record holds each, and keeps its edits when one is not there', async (t) => {
    const box = ReviewSandbox.forTest(t, fixingScript());
    assert.equal((await box.fix('claude')).kind, 'report', box.logs.join('\n'));
    const state = box.run();
    const prompt = box.promptOf(state, 'fixer fixes:c1-1');
    assert.match(prompt, /^ {8}evidence: fake evidence for \[0\]\n {8}how its verifier established it: it ran code\n {8}run: node \S+probe-0\.mjs printed "fake probe for \[0\] ran", exit 0; its probe, probe-0\.mjs, is frozen at \S+$/m);
    const frozen = /its probe, probe-0\.mjs, is frozen at (\S+)$/m.exec(prompt)![1]!;
    assert.equal(readFileSync(frozen, 'utf8'), 'console.log("fake probe for [0] ran");\n', 'the path names the frozen probe');
    assert.match(prompt, /^In each validation entry, cite in `runs` each shell run the entry rests on, at most four/m);
    assert.match(prompt, /^A candidate above whose verifier ran a probe names the probe and where it is frozen\. Copy that probe into a directory of its own inside your scratch directory, one for each candidate and named for the candidate's id, keeping the probe's name, so that two candidates' probes of the same name never overwrite each other; run it on the code before your fix and again after it/m);
    for (const label of ['fixer fixes:c1-1', 'documentation documentation:documentation']) {
      const schema = Object.values(state.workers).find((worker) => worker.launch.label === label)!.launch.schema;
      assert.match(box.checkpoint.evidence.read(schema).toString('utf8'), /"runs"/, `${label} answers with the runs of its validation`);
    }
    const recorded = fixRecordedOf(box, state.id, 'c1-1');
    assert.equal(recorded.version, 5);
    assert.deepEqual(recorded.payload.findings[0]!.validation[0]!.runs.map((run) => [run.command, run.found]), [['node fake-test.mjs', { at: 1, exitCode: 0 }], ['node fake-test-never-run.mjs', null]]);
    assert.deepEqual(recorded.payload.comparisons, []);
    assert.ok(box.logs.some((line) => line.includes('the validation of finding [0] cites a run that the record of its shell runs does not hold: node fake-test-never-run.mjs')), box.logs.join('\n'));
    const fix = state.review!.fix!;
    assert.deepEqual(fix.answers.fixes['c1-1']!.findings[0]!.validation[0]!.runs, recorded.payload.findings[0]!.validation[0]!.runs, 'the fold holds the runs');
    assert.ok(fix.revisions.some((revision) => revision.change.findings.includes('SCAN-1')), 'the edits of an answer citing a run not found stand');
    assert.equal(readFileSync(`${box.repo}/src/a.ts`, 'utf8'), fixedA);
  });

  it('freezes the probe a fixer cites from its scratch directory, records a probe it cannot freeze as none, and writes an answer whose entries cite no run at the version of today', async (t) => {
    const probeRun = { command: 'node probe-0.mjs', printed: ['the null is guarded'], probe: 'probe-0.mjs' };
    const missingRun = { command: 'node missing.mjs', printed: ['still failing'], probe: 'missing.mjs' };
    const cited = fixerAnswer([{ files: ['src/a.ts'] }]) as { findings: { validation: object[] }[] };
    cited.findings[0]!.validation = [{ method: 'old-code', source: 'probe-0.mjs', evidence: 'the probe passes after the fix', runs: [probeRun, missingRun] }];
    const box = ReviewSandbox.forTest(t, fixingScript(
      { probes: { 'probe-0.mjs': 'console.log("the null is guarded");\n' }, runs: [{ command: 'node probe-0.mjs', output: 'the null is guarded\n', exitCode: 0 }, { command: 'node missing.mjs', output: 'still failing\n', exitCode: 1 }], output: cited },
      { runs: [] },
    ));
    assert.equal((await box.fix('claude')).kind, 'report', box.logs.join('\n'));
    const state = box.run();
    const [probe, missing] = fixRecordedOf(box, state.id, 'c1-1').payload.findings[0]!.validation[0]!.runs;
    assert.deepEqual([probe?.found, probe?.probe?.name], [{ at: 1, exitCode: 0 }, 'probe-0.mjs']);
    assert.equal(box.checkpoint.evidence.read(probe!.probe!.blob).toString('utf8'), 'console.log("the null is guarded");\n');
    assert.deepEqual([missing?.found, missing?.probe], [{ at: 2, exitCode: 1 }, null]);
    assert.ok(box.logs.some((line) => line.includes('cites a probe the engine cannot freeze: the probe missing.mjs names no file')), box.logs.join('\n'));
    const uncited = fixRecordedOf(box, state.id, 'c2-1');
    assert.equal(uncited.version, 2, 'an answer citing no run keeps the version of today');
    assert.equal('runs' in (uncited.payload.findings[0]!.validation[0] as object), false);
    assert.deepEqual(state.review!.fix!.answers.fixes['c2-1']!.findings[0]!.validation[0]!.runs, []);
  });
});
