// Write a golden checkpoint fixture: a ledger and evidence store produced by
// this engine, with the fold results and identity a later engine must
// reproduce. Run it when the schema or the event registry changes:
//   npm run golden -- --output test/fixtures/checkpoints/schema-<schema>-<serial>
// The serial advances whenever the registry changes; older fixtures stay and
// must still open, which is the forward-compatibility proof.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Checkpoint, type NewEvent } from '../src/checkpoint/checkpoint.ts';
import type { RecordedCandidate, ReviewConfiguration, ScopeState, WorkerFinish, WorkerLaunch } from '../src/checkpoint/events.ts';
import { checkpointIdentity } from '../src/checkpoint/identity.ts';
import { ledgerFileName } from '../src/checkpoint/ledger.ts';
import { finderAngles, phases, type Angle, type Phase } from '../src/review/vocabulary.ts';

const { values } = parseArgs({ options: { output: { type: 'string' } }, strict: true });
if (values.output === undefined) throw new Error('--output DIRECTORY is required');
const output = resolve(values.output);
if (existsSync(output)) throw new Error(`Fixture output must not exist yet: ${output}`);

/**
 * Appends the reviewed run's events one at a time, as the controller does,
 * so a fixture reader sees one event per sequence; and keeps the launch and
 * finish of each synthetic worker to one line each here.
 */
class ReviewHistory {
  #lastSequence: number;
  readonly #checkpoint: Checkpoint;
  readonly #runId: string;
  readonly #attempts: Record<string, number> = {};

  constructor(checkpoint: Checkpoint, runId: string, lastSequence: number) {
    this.#checkpoint = checkpoint;
    this.#runId = runId;
    this.#lastSequence = lastSequence;
  }

  /** A worker id from a short tag, so the events read against the code that wrote them. */
  id(tag: string): string {
    return `00000000-0000-4000-8000-0000000${tag.padStart(5, '0')}`;
  }

  add(kind: string, payload: unknown): void {
    const event: NewEvent = { kind, version: 1, payload };
    this.#lastSequence = this.#checkpoint.append(this.#runId, this.#lastSequence, [event]).lastSequence;
  }

  configure(): void {
    const role = (name: string, tier: 'strong' | 'fast', effort: 'high' | 'medium' = 'high') => ({ role: name, model: tier === 'strong' ? 'opus' : 'sonnet', effort, budgetUsd: 8, timeoutMs: 600_000 });
    const configuration: ReviewConfiguration = {
      runtime: 'claude',
      executable: '/fixture/bin/claude',
      executableArgs: [],
      version: '2.1.283',
      models: { strong: 'opus', fast: 'sonnet' },
      roles: [
        role('triage', 'strong'),
        ...finderAngles.map((angle) => role(`finder-${angle}`, ['REMOVALS', 'DESIGN', 'ALTITUDE'].includes(angle) ? 'strong' : 'fast', angle === 'CONVENTIONS' ? 'medium' : 'high')),
        role('deduplication', 'strong'),
        role('verifier', 'strong'),
        role('sweep', 'strong'),
        role('merge-rank', 'strong'),
      ],
      rolesDigest: '4'.repeat(64),
      concurrency: 4,
      runBudgetUsd: 30,
    };
    this.add('review.configured', configuration);
  }

  /** Start the phase at its next attempt with a clean worktree check, run `body`, and finish it. */
  phase(phase: Phase, body: () => void, outcome: 'completed' | 'degraded' = 'completed', attempt?: number): void {
    const number = attempt ?? (this.#attempts[phase] ?? 0) + 1;
    this.#attempts[phase] = number;
    this.add('phase.started', { phase, attempt: number });
    this.add('worktree.checked', { phase, attempt: number, drifted: false, files: [] });
    body();
    this.add('phase.finished', { phase, attempt: number, outcome, blocker: null });
  }

  candidate(id: string, angle: Angle, line: number): RecordedCandidate {
    return { id, angle, file: 'src/changed.ts', line, located: true, rawFile: 'src/changed.ts', rawLine: line, summary: `${id}: what is wrong at line ${String(line)}`, detail: `${id}: the failure or the value, as the angle asks` };
  }

  launch(tag: string, label: string): void {
    const workerId = this.id(tag);
    const launch: WorkerLaunch = {
      workerId,
      label,
      runtime: 'claude',
      executable: '/fixture/bin/claude',
      executableArgs: [],
      version: '2.1.283',
      model: label.startsWith('finder-RIPPLE') || label.startsWith('finder-FOOTGUNS') ? 'sonnet' : 'opus',
      effort: 'high',
      access: 'read-only',
      shell: true,
      sessionId: `11111111-2222-4333-8444-${tag.padStart(12, '0')}`,
      resumes: null,
      scratch: `/fixture/scratch/${workerId}`,
      budgetUsd: 8,
      timeoutMs: 600_000,
      prompt: this.#checkpoint.evidence.put(`You are ${label}.\n`),
      schema: this.#checkpoint.evidence.put('{"type":"object","properties":{},"required":[],"additionalProperties":false}'),
    };
    this.add('worker.launched', launch);
  }

  finishWorker(tag: string, outcome: 'completed' | 'failed' | 'timeout' = 'completed'): void {
    const finish: WorkerFinish = {
      workerId: this.id(tag),
      outcome,
      exitCode: outcome === 'completed' ? 0 : outcome === 'failed' ? 1 : null,
      signal: outcome === 'timeout' ? 'SIGKILL' : null,
      termination: outcome === 'timeout' ? 'killed' : 'exited',
      startedAt: '2026-09-27T01:00:00.000Z',
      endedAt: '2026-09-27T01:00:30.000Z',
      sessionIds: [`11111111-2222-4333-8444-${tag.padStart(12, '0')}`],
      usage: outcome === 'completed' ? '{"usage":{"input_tokens":800,"cache_read_input_tokens":200,"cache_creation_input_tokens":0,"output_tokens":100},"modelUsage":null,"total_cost_usd":0.5}' : null,
      denials: [],
      error: outcome === 'completed' ? null : outcome === 'failed' ? 'The answer does not match the output schema' : 'The worker ran past its timeout of 600000 ms and was killed with its process tree',
      stdout: this.#checkpoint.evidence.put(outcome === 'completed' ? '{"type":"result","subtype":"success"}\n' : ''),
      stderr: this.#checkpoint.evidence.put(''),
      finalMessage: null,
      output: outcome === 'completed' ? this.#checkpoint.evidence.put('{}') : null,
    };
    this.add('worker.finished', finish);
  }
}

// Deterministic time and ids, so the fixture's expected state is stable text.
let tick = 0;
let nextId = 0;
const checkpoint = Checkpoint.open(output, {
  engine: 'golden',
  clock: () => `2026-09-26T00:00:${String(tick++).padStart(2, '0')}.000Z`,
  ids: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
});
try {
  const active = checkpoint.createRun({ worktree: '/fixture/active' });
  const closed = checkpoint.createRun({ worktree: '/fixture/abandoned' });
  // A synthetic scope, so the fixture needs no git repository: one modified
  // file with both states frozen, one added file too large to freeze, one
  // deleted file, and the patch a reader would see.
  const scope: ScopeState = {
    mode: 'worktree',
    request: { paths: [] },
    base: '1111111111111111111111111111111111111111',
    head: '2222222222222222222222222222222222222222',
    files: [
      { path: 'src/changed.ts', status: 'modified', symlink: false, before: { blob: checkpoint.evidence.put('before\n') }, after: { blob: checkpoint.evidence.put('after\n') } },
      { path: 'assets/huge.bin', status: 'added', symlink: false, before: null, after: { oversized: { sha256: '3'.repeat(64), size: 9_000_000 } } },
      { path: 'src/removed.ts', status: 'deleted', symlink: false, before: { blob: checkpoint.evidence.put('removed\n') }, after: null },
    ],
    patch: checkpoint.evidence.put('--- a/src/changed.ts\n+++ b/src/changed.ts\n@@ -1 +1 @@\n-before\n+after\n'),
  };
  const scoped = checkpoint.append(active.id, active.lastSequence, [{ kind: 'scope.captured', version: 1, payload: scope }]);
  // Two synthetic workers on the active run: one finished with every piece
  // of evidence a receipt holds, one launched and still running, as a worker
  // whose launcher died would be.
  const launch = (workerId: string, runtime: string, sessionId: string | null): WorkerLaunch => ({
    workerId,
    label: `golden ${runtime} worker`,
    runtime,
    executable: `/fixture/bin/${runtime}`,
    executableArgs: [],
    version: '1.2.3',
    model: 'fixture-model',
    effort: 'high',
    access: 'read-only',
    shell: true,
    sessionId,
    resumes: null,
    scratch: `/fixture/checkpoint/scratch/${workerId}`,
    budgetUsd: runtime === 'claude' ? 1.5 : null,
    timeoutMs: 600_000,
    prompt: checkpoint.evidence.put(`Review the change as ${runtime}.\n`),
    schema: checkpoint.evidence.put('{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}'),
  });
  const finishedId = '00000000-0000-4000-8000-00000000f001';
  const runningId = '00000000-0000-4000-8000-00000000f002';
  const session = '11111111-2222-4333-8444-555555555555';
  const finish: WorkerFinish = {
    workerId: finishedId,
    outcome: 'completed',
    exitCode: 0,
    signal: null,
    termination: 'exited',
    startedAt: '2026-09-27T00:00:00.000Z',
    endedAt: '2026-09-27T00:01:00.000Z',
    sessionIds: [session],
    usage: '{"input_tokens":12,"output_tokens":3}',
    denials: [{ tool: 'Bash', detail: 'rm -rf build' }],
    error: null,
    stdout: checkpoint.evidence.put('{"type":"result","subtype":"success"}\n'),
    stderr: checkpoint.evidence.put(''),
    finalMessage: null,
    output: checkpoint.evidence.put('{"answer":"ok"}'),
  };
  checkpoint.append(active.id, scoped.lastSequence, [
    { kind: 'worker.launched', version: 1, payload: launch(finishedId, 'claude', session) },
    { kind: 'worker.finished', version: 1, payload: finish },
    { kind: 'worker.launched', version: 1, payload: launch(runningId, 'codex', null) },
  ]);
  checkpoint.append(closed.id, closed.lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'fixture run closed on purpose' } }]);
  // A third run through every kind of the read-only review: a triage, a
  // degraded finder phase with a lost worker, deduplication, verification,
  // a sweep whose one group goes unverified, a budget block that a later
  // start clears, a ranking and the report.
  const reviewed = checkpoint.createRun({ worktree: '/fixture/reviewed' });
  const reviewScope: ScopeState = { ...scope, files: [scope.files[0]!], request: { paths: ['src'] } };
  const review = new ReviewHistory(checkpoint, reviewed.id, checkpoint.append(reviewed.id, reviewed.lastSequence, [{ kind: 'scope.captured', version: 1, payload: reviewScope }]).lastSequence);
  review.configure();
  review.phase('triage', () => {
    review.launch('001', 'triage triage:SCAN');
    review.finishWorker('001');
    review.add('candidates.recorded', { phase: 'triage', key: 'SCAN', workerId: review.id('001'), candidates: [review.candidate('SCAN-1', 'SCAN', 2)], leads: finderAngles.map((angle) => ({ angle, lead: angle === 'RIPPLE' ? 'callers of changed()' : null })) });
  });
  review.phase('finders', () => {
    review.launch('002', 'finder-RIPPLE finders:RIPPLE');
    review.finishWorker('002');
    review.add('candidates.recorded', { phase: 'finders', key: 'RIPPLE', workerId: review.id('002'), candidates: [review.candidate('RIPPLE-1', 'RIPPLE', 2), review.candidate('RIPPLE-2', 'RIPPLE', 1)], leads: null });
    review.launch('003', 'finder-FOOTGUNS finders:FOOTGUNS');
    review.add('worker.lost', { workerId: review.id('003'), phase: 'finders', key: 'FOOTGUNS', reason: 'the engine exited while the worker ran' });
    review.launch('004', 'finder-FOOTGUNS finders:FOOTGUNS');
    review.finishWorker('004', 'timeout');
    review.add('attempt.failed', { phase: 'finders', key: 'FOOTGUNS', workerId: review.id('004'), reason: 'timeout: The worker ran past its timeout of 600000 ms' });
    review.add('angle.failed', { angle: 'FOOTGUNS', reason: 'two attempts did not complete: lost; timeout' });
    for (const angle of finderAngles.filter((name) => name !== 'RIPPLE' && name !== 'FOOTGUNS')) {
      const workerId = `0${String(10 + finderAngles.indexOf(angle))}`;
      review.launch(workerId, `finder-${angle} finders:${angle}`);
      review.finishWorker(workerId);
      review.add('candidates.recorded', { phase: 'finders', key: angle, workerId: review.id(workerId), candidates: [], leads: null });
    }
  }, 'degraded');
  review.phase('deduplication', () => {
    review.launch('020', 'deduplication deduplication:deduplication');
    review.finishWorker('020');
    review.add('deduplication.recorded', { phase: 'deduplication', workerId: review.id('020'), groups: [{ members: ['SCAN-1', 'RIPPLE-1'], keep: 'RIPPLE-1', reason: 'the same null dereference, at the same line' }] });
  });
  review.phase('verification', () => {
    review.add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['RIPPLE-2', 'RIPPLE-1'] }] });
    review.launch('021', 'verifier verification:g1');
    review.finishWorker('021');
    review.add('verdicts.recorded', { phase: 'verification', groupId: 'g1', workerId: review.id('021'), verdicts: [{ id: 'RIPPLE-2', verdict: 'REFUTED', evidence: 'line 1 is a comment' }, { id: 'RIPPLE-1', verdict: 'CONFIRMED', evidence: 'line 2 dereferences the null returned above' }] });
  });
  // The sweep blocks on the run budget once, and the next start clears the blocker.
  review.add('phase.started', { phase: 'sweep', attempt: 1 });
  review.add('worktree.checked', { phase: 'sweep', attempt: 1, drifted: false, files: [] });
  review.add('phase.finished', { phase: 'sweep', attempt: 1, outcome: 'blocked', blocker: { code: 'budget', detail: 'spent 31.20 USD of 30.00 USD', action: 'run the command again with --budget-usd above 31.20, or abandon the run' } });
  review.phase('sweep', () => {
    review.launch('030', 'sweep sweep:sweep');
    review.finishWorker('030');
    review.add('candidates.recorded', { phase: 'sweep', key: 'sweep', workerId: review.id('030'), candidates: [{ ...review.candidate('SWEEP-1', 'DESIGN', 1), file: null, line: null, located: false, rawFile: 'C:\\elsewhere\\changed.ts' }], leads: null });
  }, 'completed', 2);
  review.phase('sweep-deduplication', () => {});
  review.phase('sweep-verification', () => {
    review.add('verification.planned', { phase: 'sweep-verification', groups: [{ id: 'g1', candidateIds: ['SWEEP-1'] }] });
    review.launch('031', 'verifier sweep-verification:g1');
    review.finishWorker('031', 'failed');
    review.add('attempt.failed', { phase: 'sweep-verification', key: 'g1', workerId: review.id('031'), reason: 'failed: The answer does not match the output schema' });
    review.launch('032', 'verifier sweep-verification:g1');
    review.finishWorker('032', 'failed');
    review.add('attempt.failed', { phase: 'sweep-verification', key: 'g1', workerId: review.id('032'), reason: 'failed: Claude Code printed no result envelope' });
    review.add('group.unverified', { phase: 'sweep-verification', groupId: 'g1', reason: 'two attempts did not complete' });
  }, 'degraded');
  review.phase('merge-rank', () => {
    review.launch('040', 'merge-rank merge-rank:merge-rank');
    review.finishWorker('040');
    review.add('ranking.recorded', { workerId: review.id('040'), findings: [
      { id: 'RIPPLE-1', members: [], severity: 'major', summary: 'changed() dereferences a null on the empty path', reason: 'a crash on reachable input' },
      { id: 'SWEEP-1', members: [], severity: 'minor', summary: 'the two branches of changed() duplicate their parsing', reason: 'one helper reads better' },
    ] });
  });
  review.phase('report', () => {
    // The timed-out and the lost finder, and the two failed verifiers, reported no cost.
    const spend = (workers: number, costUnreported = 0) => ({ workers, seconds: workers * 30, costUsd: workers * 0.5, costUnreported, inputTokens: workers * 1000, cachedInputTokens: workers * 200, outputTokens: workers * 100 });
    const workersPerPhase: Record<Phase, number> = { triage: 1, finders: 9, deduplication: 1, verification: 1, sweep: 1, 'sweep-deduplication': 0, 'sweep-verification': 2, 'merge-rank': 1, report: 0 };
    const unreportedPerPhase: Partial<Record<Phase, number>> = { finders: 2, 'sweep-verification': 2 };
    review.add('report.written', {
      report: checkpoint.evidence.put('# Deep review\n\nfixture report\n'),
      statistics: { phases: phases.map((phase) => ({ phase, ...spend(workersPerPhase[phase], unreportedPerPhase[phase]) })), total: spend(16, 4), budgetApplied: true },
    });
  });
  const evidence = checkpoint.evidence.put('fixture evidence\r\nwith two lines\n');
  const expected = { runs: checkpoint.listRuns(), evidence: [evidence, scope.patch, finish.stdout, finish.stderr] };
  writeFileSync(join(output, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
  writeFileSync(join(output, 'identity.json'), `${JSON.stringify(checkpointIdentity(), null, 2)}\n`);
} finally {
  checkpoint.close();
}
const leftovers = readdirSync(output).filter((name) => name.startsWith(ledgerFileName) && name !== ledgerFileName);
if (leftovers.length > 0) throw new Error(`Closing the ledger left ${leftovers.join(', ')}; the fixture must be a single file`);
console.log(`wrote ${output}`);
