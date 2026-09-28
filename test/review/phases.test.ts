import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { NewEvent } from '../../src/checkpoint/checkpoint.ts';
import { attemptFailedV1, eventRegistry } from '../../src/checkpoint/events.ts';
import { lookupEvent } from '../../src/checkpoint/registry.ts';
import type { AssembledRole } from '../../src/roles/assemble.ts';
import { contributionOf, groupCandidates, invocationFor, taskFor, type PhaseContext } from '../../src/review/phases.ts';
import { outputSchemaOf } from '../../src/review/schemas.ts';
import type { Unit } from '../../src/review/steps.ts';
import { reviewRoles, type ReviewRole } from '../../src/review/vocabulary.ts';
import type { WorkerReceipt } from '../../src/runtime/launcher.ts';
import { configuration, configured, found, ranked, swept, triaged, verified } from '../helpers/review-history.ts';

const reference = { sha256: 'a'.repeat(64), bytes: 1 };
const receipt = (output: unknown, change: Partial<WorkerReceipt> = {}): WorkerReceipt => ({
  workerId: '00000000-0000-4000-8000-0000000000aa',
  outcome: 'completed',
  error: null,
  process: { exitCode: 0, signal: null, termination: 'exited', startedAt: '2026-09-27T00:00:00.000Z', endedAt: '2026-09-27T00:00:01.000Z' },
  runtime: { name: 'claude', version: '2.1.283', sessionIds: [], usage: null },
  denials: [],
  output,
  evidence: { prompt: reference, schema: reference, stdout: reference, stderr: reference, finalMessage: null, output: reference },
  ...change,
});
const unit = (phase: Unit['phase'], key: string, role: ReviewRole): Unit => ({ phase, key, role });
const leads = ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'].map((angle) => ({ angle, lead: angle === 'DESIGN' ? 'the new helper' : null }));

describe('taskFor', () => {
  it('writes each phase its task from the fold', () => {
    assert.match(taskFor(unit('triage', 'SCAN', 'triage'), configured().review()), /Run the `SCAN` angle/);
    assert.match(taskFor(unit('finders', 'RIPPLE', 'finder-RIPPLE'), triaged().review()), /^Angle: RIPPLE\nSCAN lead: the callers of parse\(\)/);
    assert.match(taskFor(unit('finders', 'DESIGN', 'finder-DESIGN'), triaged().review()), /^Angle: DESIGN\nLead: none/);
    assert.match(taskFor(unit('deduplication', 'deduplication', 'deduplication'), found().review()), /2 candidates, numbered \[0\] to \[1\]\.[\s\S]*\[0\] SCAN-1[\s\S]*\[1\] RIPPLE-1/);
    assert.match(taskFor(unit('verification', 'g1', 'verifier'), verified().review()), /^Group g1: 1 candidate, numbered \[0\] to \[0\][\s\S]*\[0\] RIPPLE-1/);
    const sweep = taskFor(unit('sweep', 'sweep', 'sweep'), verified().review());
    assert.match(sweep, /These angles did not run, so their territory is yours to cover: FOOTGUNS/);
    assert.match(sweep, /- RIPPLE-1 \(RIPPLE\) at src\/a\.ts:4: RIPPLE-1 summary \[CONFIRMED\]/);
    assert.match(taskFor(unit('merge-rank', 'merge-rank', 'merge-rank'), swept().review()), /3 findings, numbered \[0\] to \[2\][\s\S]*\[0\] RIPPLE-1[\s\S]*verdict: CONFIRMED[\s\S]*\[1\] SWEEP-1[\s\S]*verdict: PLAUSIBLE \(unverified\)/);
    assert.throws(() => taskFor(unit('report', 'report', 'merge-rank'), ranked().review()), /no worker/);
    assert.throws(() => groupCandidates(verified().review(), 'verification', 'g9'), /no planned group g9/);
  });
});

describe('invocationFor', () => {
  const roles = new Map<string, AssembledRole>(reviewRoles.map((key) => [key, { key, fragments: [], prompt: `You are ${key}.\n`, sha256: 'b'.repeat(64) }]));
  const context = (state = triaged().fold()): PhaseContext => ({ state, worktree: '/w', roles, configuration: { ...configuration, roles: reviewRoles.map((role) => ({ role, model: role === 'finder-RIPPLE' ? 'sonnet' : 'opus', effort: 'high' as const, budgetUsd: role === 'triage' ? null : 8, timeoutMs: 600_000 })) }, scopeBlock: '## Scope\n\nRepository: /w' });

  it('builds a read-only invocation with a shell from the pinned role, labelled with its unit, prompt composed from the role and task', () => {
    const invocation = invocationFor(unit('finders', 'RIPPLE', 'finder-RIPPLE'), context());
    assert.equal(invocation.runtime, 'claude');
    assert.equal(invocation.executable, '/bin/claude');
    assert.equal(invocation.model, 'sonnet');
    assert.equal(invocation.effort, 'high');
    assert.equal(invocation.access, 'read-only');
    assert.equal(invocation.shell, true);
    assert.equal(invocation.budgetUsd, 8);
    assert.equal(invocation.timeoutMs, 600_000);
    assert.equal(invocation.label, 'finder-RIPPLE finders:RIPPLE');
    assert.equal(invocation.outputSchema, outputSchemaOf('finder-RIPPLE'));
    assert.match(invocation.prompt, /^You are finder-RIPPLE\.\n\n## Task\n\nRole: finder-RIPPLE\nUnit: RIPPLE\nPhase: finders\n\nAngle: RIPPLE\nSCAN lead: the callers of parse\(\)\n[\s\S]*## Scope\n\nRepository: \/w\n\nReturn only the JSON your schema describes\.\n$/);
  });

  it('leaves the budget out for a role pinned without one, and refuses a role without a prompt', () => {
    const invocation = invocationFor(unit('triage', 'SCAN', 'triage'), context(configured().fold()));
    assert.equal('budgetUsd' in invocation, false);
    assert.throws(() => invocationFor(unit('finders', 'RIPPLE', 'finder-RIPPLE'), { ...context(), roles: new Map() }), /No assembled prompt for role finder-RIPPLE/);
  });
});

describe('contributionOf', () => {
  let worktree: string;
  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'deep-review-phases-'));
    mkdirSync(join(worktree, 'src'));
    writeFileSync(join(worktree, 'src', 'a.ts'), 'one\ntwo\nthree\nfour\nfive\n');
  });
  afterEach(() => rmSync(worktree, { recursive: true, force: true }));

  it('records a failed attempt for a receipt that did not complete, with the outcome and error', () => {
    const event = contributionOf(unit('finders', 'RIPPLE', 'finder-RIPPLE'), receipt(null, { outcome: 'timeout', error: 'The worker ran past its timeout' }), triaged().fold(), worktree);
    assert.deepEqual(event, { kind: 'attempt.failed', version: 1, payload: { phase: 'finders', key: 'RIPPLE', workerId: '00000000-0000-4000-8000-0000000000aa', reason: 'timeout: The worker ran past its timeout' } });
  });

  it('cuts a failed attempt\'s reason to what the ledger records, marking the cut', () => {
    const event = contributionOf(unit('finders', 'RIPPLE', 'finder-RIPPLE'), receipt(null, { outcome: 'failed', error: 'e'.repeat(4000) }), triaged().fold(), worktree);
    const payload = attemptFailedV1.parse(event.payload);
    assert.equal(payload.reason.length, 4000);
    assert.match(payload.reason, /^failed: e+ \[truncated\]$/);
  });

  it('records the triage with ids, located candidates, and leads in angle order', () => {
    const output = { candidates: [{ file: 'src\\a.ts', line: 2, summary: 's', detail: 'd' }, { file: 'src/a.ts', line: 9, summary: 'past the end', detail: 'd' }], leads: [...leads].reverse() };
    const event = contributionOf(unit('triage', 'SCAN', 'triage'), receipt(output), configured().fold(), worktree);
    assert.equal(event.kind, 'candidates.recorded');
    const payload = event.payload as { candidates: Record<string, unknown>[]; leads: { angle: string }[]; key: string; phase: string };
    assert.equal(payload.phase, 'triage');
    assert.equal(payload.key, 'SCAN');
    assert.deepEqual(payload.candidates[0], { id: 'SCAN-1', angle: 'SCAN', file: 'src/a.ts', line: 2, located: true, rawFile: 'src\\a.ts', rawLine: 2, summary: 's', detail: 'd' });
    assert.deepEqual(payload.candidates[1], { id: 'SCAN-2', angle: 'SCAN', file: null, line: null, located: false, rawFile: 'src/a.ts', rawLine: 9, summary: 'past the end', detail: 'd' });
    assert.deepEqual(payload.leads.map((lead) => lead.angle), ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS']);
  });

  it('turns a structural failure into a failed attempt naming the check', () => {
    const output = { candidates: [], leads: [...leads.slice(1), leads[1]] };
    const event = contributionOf(unit('triage', 'SCAN', 'triage'), receipt(output), configured().fold(), worktree);
    assert.equal(event.kind, 'attempt.failed');
    assert.match((event.payload as { reason: string }).reason, /^structural check: The triage returned two leads for angle RIPPLE/);
  });

  it('records a finder, a sweep with each candidate\'s angle, and ids numbered from 1 per unit', () => {
    const finder = contributionOf(unit('finders', 'DESIGN', 'finder-DESIGN'), receipt({ candidates: [{ file: 'src/a.ts', line: 1, summary: 's', detail: 'd' }] }), triaged().fold(), worktree);
    assert.deepEqual((finder.payload as { candidates: { id: string; angle: string }[] }).candidates.map((candidate) => [candidate.id, candidate.angle]), [['DESIGN-1', 'DESIGN']]);
    const sweep = contributionOf(unit('sweep', 'sweep', 'sweep'), receipt({ candidates: [{ file: 'src/a.ts', line: 1, summary: 's', detail: 'd', angle: 'CONVENTIONS' }, { file: 'x', line: 1, summary: 's', detail: 'd', angle: 'SCAN' }] }), verified().fold(), worktree);
    assert.deepEqual((sweep.payload as { candidates: { id: string; angle: string; located: boolean }[] }).candidates.map((candidate) => [candidate.id, candidate.angle, candidate.located]), [['SWEEP-1', 'CONVENTIONS', true], ['SWEEP-2', 'SCAN', false]]);
  });

  it('records every contribution under the kind whose schema its payload satisfies', () => {
    const decodes = (event: NewEvent): boolean => lookupEvent(eventRegistry, event.kind, event.version)?.schema.safeParse(event.payload).success === true;
    const contributions = [
      contributionOf(unit('triage', 'SCAN', 'triage'), receipt({ candidates: [], leads }), configured().fold(), worktree),
      contributionOf(unit('finders', 'DESIGN', 'finder-DESIGN'), receipt({ candidates: [] }), triaged().fold(), worktree),
      contributionOf(unit('sweep', 'sweep', 'sweep'), receipt({ candidates: [] }), verified().fold(), worktree),
      contributionOf(unit('deduplication', 'deduplication', 'deduplication'), receipt({ groups: [] }), found().fold(), worktree),
      contributionOf(unit('sweep-deduplication', 'sweep-deduplication', 'deduplication'), receipt({ groups: [{ members: [0, 1], keep: 1, reason: 'same' }] }), swept().fold(), worktree),
      contributionOf(unit('verification', 'g1', 'verifier'), receipt({ verdicts: [{ index: 0, verdict: 'REFUTED', evidence: 'e' }] }), verified().fold(), worktree),
      contributionOf(unit('sweep-verification', 'g1', 'verifier'), receipt({ verdicts: [{ index: 0, verdict: 'PLAUSIBLE', evidence: 'e' }, { index: 1, verdict: 'CONFIRMED', evidence: 'e' }] }), swept().fold(), worktree),
      contributionOf(unit('merge-rank', 'merge-rank', 'merge-rank'), receipt({ findings: [{ primary: 0, members: [1, 2], severity: 'major', summary: 's', reason: 'r' }] }), swept().fold(), worktree),
    ];
    assert.deepEqual(contributions.map((event) => event.kind), ['candidates.recorded', 'candidates.recorded', 'candidates.recorded', 'deduplication.recorded', 'deduplication.recorded', 'verdicts.recorded', 'verdicts.recorded', 'ranking.recorded']);
    for (const event of contributions) assert.ok(decodes(event), `${event.kind} decodes under its own schema: ${JSON.stringify(event.payload)}`);
  });

  it('resolves dedup, verifier and merge-rank indexes against the same fold the task numbered them from', () => {
    const dedup = contributionOf(unit('deduplication', 'deduplication', 'deduplication'), receipt({ groups: [{ members: [1, 0], keep: 1, reason: 'same' }] }), found().fold(), worktree);
    assert.deepEqual(dedup.payload, { phase: 'deduplication', workerId: '00000000-0000-4000-8000-0000000000aa', groups: [{ members: ['RIPPLE-1', 'SCAN-1'], keep: 'RIPPLE-1', reason: 'same' }] });
    const verdicts = contributionOf(unit('verification', 'g1', 'verifier'), receipt({ verdicts: [{ index: 0, verdict: 'REFUTED', evidence: 'e' }] }), verified().fold(), worktree);
    assert.deepEqual(verdicts.payload, { phase: 'verification', groupId: 'g1', workerId: '00000000-0000-4000-8000-0000000000aa', verdicts: [{ id: 'RIPPLE-1', verdict: 'REFUTED', evidence: 'e' }] });
    const outOfRange = contributionOf(unit('verification', 'g1', 'verifier'), receipt({ verdicts: [{ index: 3, verdict: 'REFUTED', evidence: 'e' }] }), verified().fold(), worktree);
    assert.match((outOfRange.payload as { reason: string }).reason, /^structural check: A verdict names index 3/);
    // The working list of the swept run is [RIPPLE-1, SWEEP-1, SWEEP-2]; the worker's order is advisory and the engine's order puts the major CONFIRMED finding first.
    const ranking = contributionOf(unit('merge-rank', 'merge-rank', 'merge-rank'), receipt({ findings: [
      { primary: 1, members: [], severity: 'minor', summary: 'design', reason: 'r' },
      { primary: 0, members: [2], severity: 'major', summary: 'null', reason: 'r' },
    ] }), swept().fold(), worktree);
    assert.deepEqual((ranking.payload as { findings: { id: string; members: string[] }[] }).findings.map((finding) => [finding.id, finding.members]), [['RIPPLE-1', ['SWEEP-2']], ['SWEEP-1', []]]);
  });
});
