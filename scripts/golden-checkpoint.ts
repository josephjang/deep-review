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
import { reviewVocabularyV1, reviewVocabularyV2, reviewVocabularyV3, type RecordedCandidate, type ReviewConfigurationV1, type ScopeState, type WorkerFinish, type WorkerLaunch } from '../src/checkpoint/events.ts';
import { checkpointIdentity } from '../src/checkpoint/identity.ts';
import { ledgerFileName } from '../src/checkpoint/ledger.ts';
import { finderAngles, phases, type Angle, type Phase } from '../src/review/vocabulary.ts';

const { values } = parseArgs({ options: { output: { type: 'string' } }, strict: true });
if (values.output === undefined) throw new Error('--output DIRECTORY is required');
const output = resolve(values.output);
if (existsSync(output)) throw new Error(`Fixture output must not exist yet: ${output}`);

/** What a phase that finishes blocked records as its blocker. */
interface PhaseBlocker {
  readonly code: string;
  readonly detail: string;
  readonly action: string;
}

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

  add(kind: string, payload: unknown, version = 1): void {
    const event: NewEvent = { kind, version, payload };
    this.#lastSequence = this.#checkpoint.append(this.#runId, this.#lastSequence, [event]).lastSequence;
  }

  /** Start a phase at its next attempt with a clean worktree check at version 2, as the fix pass's engine wrote them, run `body`, and finish it. */
  phaseV2(phase: Phase, body: () => void, outcome: 'completed' | 'degraded' = 'completed', check: { strays?: string[]; end?: boolean } = {}): void {
    this.phaseAt(2, phase, body, outcome, check);
  }

  /** The same at version 3, as the survey's engine wrote them. */
  phaseV3(phase: Phase, body: () => void, outcome: 'completed' | 'degraded' = 'completed', check: { strays?: string[]; end?: boolean } = {}): void {
    this.phaseAt(3, phase, body, outcome, check);
  }

  /** The same at version 4, as the decision step's engine wrote them. */
  phaseV4(phase: Phase, body: () => void, outcome: 'completed' | 'degraded' = 'completed', check: { strays?: string[]; end?: boolean } = {}): void {
    this.phaseAt(4, phase, body, outcome, check);
  }

  /** The same as the engine now writes them: started and checked at version 4, finished at version 5, which a blocker of the claims needs. */
  phaseV5(phase: Phase, body: () => void, finish: 'completed' | 'degraded' | PhaseBlocker = 'completed', check: { strays?: string[]; end?: boolean } = {}): void {
    this.phaseAt(4, phase, body, finish, check, 5);
  }

  /** Start a phase at its next attempt at version 3 with a clean check and finish it blocked, as a survey that blocks does. */
  blockedV3(phase: Phase, body: () => void, blocker: PhaseBlocker): void {
    this.phaseAt(3, phase, body, blocker);
  }

  /**
   * Start a phase at its next attempt with a clean worktree check at
   * `version`, run `body`, optionally check the worktree again at the end,
   * and finish it at `finishedVersion`, `version` unless given:
   * `completed` or `degraded`, or `blocked` on a blocker.
   */
  phaseAt(version: 2 | 3 | 4, phase: Phase, body: () => void, finish: 'completed' | 'degraded' | PhaseBlocker = 'completed', check: { strays?: string[]; end?: boolean } = {}, finishedVersion: number = version): void {
    const number = (this.#attempts[phase] ?? 0) + 1;
    this.#attempts[phase] = number;
    this.add('phase.started', { phase, attempt: number }, version);
    this.add('worktree.checked', { phase, attempt: number, moment: 'start', drifted: false, head: null, files: [], strays: [] }, version);
    body();
    if (check.end === true) this.add('worktree.checked', { phase, attempt: number, moment: 'end', drifted: false, head: null, files: [], strays: check.strays ?? [] }, version);
    const finished = typeof finish === 'string' ? { outcome: finish, blocker: null } : { outcome: 'blocked', blocker: finish };
    this.add('phase.finished', { phase, attempt: number, ...finished }, finishedVersion);
  }

  /** One check as it ran in a checks phase, four seconds long. */
  check(phase: 'baseline-checks' | 'checks' | 'repair-checks', kind: string, command: string, outcome: 'passed' | 'failed'): void {
    const attempt = this.#attempts[phase] ?? 1;
    this.add('check.ran', {
      phase, attempt, kind, command, outcome,
      exitCode: outcome === 'passed' ? 0 : 1, signal: null, termination: 'exited',
      startedAt: '2026-10-01T02:00:00.000Z', endedAt: '2026-10-01T02:00:04.000Z',
      stdout: this.#checkpoint.evidence.put(`${kind} ${outcome}\n`), stderr: this.#checkpoint.evidence.put(''), error: null,
    });
  }

  /** A file's state frozen as a blob. */
  frozen(text: string): { blob: { sha256: string; bytes: number } } {
    return { blob: this.#checkpoint.evidence.put(text) };
  }

  configure(): void {
    const role = (name: string, tier: 'strong' | 'fast', effort: 'high' | 'medium' = 'high') => ({ role: name, model: tier === 'strong' ? 'opus' : 'sonnet', effort, budgetUsd: 8, timeoutMs: 600_000 });
    const configuration: ReviewConfigurationV1 = {
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
    return { id, angle, file: 'src/changed.ts', line, located: true, inScope: true, rawFile: 'src/changed.ts', rawLine: line, summary: `${id}: what is wrong at line ${String(line)}`, detail: `${id}: the failure or the value, as the angle asks` };
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
  // finder phase degraded by an angle that failed twice, with a lost worker
  // whose angle answered on its second attempt and a candidate on an
  // unchanged caller outside the change, deduplication, verification,
  // a sweep whose one group goes unverified, a budget block that a raised
  // budget and a later start clear, a ranking and the report.
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
    review.add('candidates.recorded', { phase: 'finders', key: 'RIPPLE', workerId: review.id('002'), candidates: [review.candidate('RIPPLE-1', 'RIPPLE', 2), review.candidate('RIPPLE-2', 'RIPPLE', 1), { ...review.candidate('RIPPLE-3', 'RIPPLE', 7), file: 'src/caller.ts', inScope: false, rawFile: '/fixture/reviewed/src/caller.ts' }], leads: null });
    review.launch('003', 'finder-FOOTGUNS finders:FOOTGUNS');
    review.finishWorker('003', 'failed');
    review.add('attempt.failed', { phase: 'finders', key: 'FOOTGUNS', workerId: review.id('003'), reason: 'failed: The answer does not match the output schema' });
    review.launch('004', 'finder-FOOTGUNS finders:FOOTGUNS');
    review.finishWorker('004', 'timeout');
    review.add('attempt.failed', { phase: 'finders', key: 'FOOTGUNS', workerId: review.id('004'), reason: 'timeout: The worker ran past its timeout of 600000 ms' });
    review.add('angle.failed', { angle: 'FOOTGUNS', reason: 'two attempts did not complete: failed; timeout' });
    // WRAPPERS loses its first worker with the engine, which uses one of its attempts; its second answers below.
    review.launch('005', 'finder-WRAPPERS finders:WRAPPERS');
    review.add('worker.lost', { workerId: review.id('005'), phase: 'finders', key: 'WRAPPERS', reason: 'the engine exited while the worker ran' });
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
    // The unchanged caller sorts before the changed file, so its group comes first.
    review.add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['RIPPLE-3'] }, { id: 'g2', candidateIds: ['RIPPLE-2', 'RIPPLE-1'] }] });
    review.launch('021', 'verifier verification:g1');
    review.finishWorker('021');
    review.add('verdicts.recorded', { phase: 'verification', groupId: 'g1', workerId: review.id('021'), verdicts: [{ id: 'RIPPLE-3', verdict: 'PLAUSIBLE', evidence: 'line 7 passes the result of changed() on unchecked' }] });
    review.launch('022', 'verifier verification:g2');
    review.finishWorker('022');
    review.add('verdicts.recorded', { phase: 'verification', groupId: 'g2', workerId: review.id('022'), verdicts: [{ id: 'RIPPLE-2', verdict: 'REFUTED', evidence: 'line 1 is a comment' }, { id: 'RIPPLE-1', verdict: 'CONFIRMED', evidence: 'line 2 dereferences the null returned above' }] });
  });
  // The sweep blocks on the run budget once; the next invocation raises the
  // budget in force, and its start clears the blocker.
  review.add('phase.started', { phase: 'sweep', attempt: 1 });
  review.add('worktree.checked', { phase: 'sweep', attempt: 1, drifted: false, files: [] });
  review.add('phase.finished', { phase: 'sweep', attempt: 1, outcome: 'blocked', blocker: { code: 'budget', detail: 'spent 31.20 USD of 30.00 USD', action: 'run the command again with --budget-usd above 31.20, or abandon the run' } });
  review.add('limits.changed', { concurrency: 4, runBudgetUsd: 60 });
  review.phase('sweep', () => {
    review.launch('030', 'sweep sweep:sweep');
    review.finishWorker('030');
    review.add('candidates.recorded', { phase: 'sweep', key: 'sweep', workerId: review.id('030'), candidates: [{ ...review.candidate('SWEEP-1', 'DESIGN', 1), file: null, line: null, located: false, inScope: false, rawFile: 'C:\\elsewhere\\changed.ts' }], leads: null });
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
      { id: 'RIPPLE-3', members: [], severity: 'minor', summary: 'the caller in src/caller.ts passes the null from changed() on', reason: 'the crash reaches a second site' },
      { id: 'SWEEP-1', members: [], severity: 'minor', summary: 'the two branches of changed() duplicate their parsing', reason: 'one helper reads better' },
    ] });
  });
  review.phase('report', () => {
    // The failed, the timed-out and the lost finder, and the two failed verifiers, reported no cost.
    const spend = (workers: number, costUnreported = 0) => ({ workers, seconds: workers * 30, costUsd: workers * 0.5, costUnreported, inputTokens: workers * 1000, cachedInputTokens: workers * 200, outputTokens: workers * 100 });
    const workersPerPhase: Record<(typeof reviewVocabularyV1.phases)[number], number> = { triage: 1, finders: 10, deduplication: 1, verification: 2, sweep: 1, 'sweep-deduplication': 0, 'sweep-verification': 2, 'merge-rank': 1, report: 0 };
    const unreportedPerPhase: Partial<Record<(typeof reviewVocabularyV1.phases)[number], number>> = { finders: 3, 'sweep-verification': 2 };
    review.add('report.written', {
      report: checkpoint.evidence.put('# Deep review\n\nfixture report\n'),
      statistics: { phases: reviewVocabularyV1.phases.map((phase) => ({ phase, ...spend(workersPerPhase[phase], unreportedPerPhase[phase]) })), total: spend(18, 5), budgetApplied: true },
    });
  });
  // A fourth run through the fix pass, every event at the version the
  // engine wrote before the survey arrived, the configuration at version
  // 2, which reads as a Claude Code run with no survey and no Codex Windows
  // sandbox: a review whose plan holds one held finding and
  // two clusters, one of three findings run as three batches of one, its
  // second batch timing out after one snapshot, whose edits are recorded
  // with the failure and verified by the retry, its third not attempted
  // once the run budget was reached; a finding blocked on the other
  // cluster's file, taken by a second round that the budget leaves
  // unattempted too; a lint check that rewrites a file at baseline and a
  // test that fails there; a fixer that reports an edit to the other
  // cluster's file (a violation) and leaves a stray; the lint the fixers
  // broke, repaired, and the test still failing; the report with one patch
  // per revision; and the commits built from it afterwards.
  const fixedRun = checkpoint.createRun({ worktree: '/fixture/fixed' });
  const fixScope: ScopeState = { ...scope, files: [scope.files[0]!], request: { paths: [] } };
  const fix = new ReviewHistory(checkpoint, fixedRun.id, checkpoint.append(fixedRun.id, fixedRun.lastSequence, [{ kind: 'scope.captured', version: 1, payload: fixScope }]).lastSequence);
  const pinned = (name: string, tier: 'strong' | 'fast', effort: 'high' | 'medium' = 'high', timeoutMs = 600_000) => ({ role: name, model: tier === 'strong' ? 'opus' : 'sonnet', effort, budgetUsd: 8, timeoutMs });
  fix.add('review.configured', {
    runtime: 'claude',
    executable: '/fixture/bin/claude',
    executableArgs: [],
    version: '2.1.283',
    models: { strong: 'opus', fast: 'sonnet' },
    roles: [
      pinned('triage', 'strong'),
      ...finderAngles.map((angle) => pinned(`finder-${angle}`, ['REMOVALS', 'DESIGN', 'ALTITUDE'].includes(angle) ? 'strong' : 'fast', angle === 'CONVENTIONS' ? 'medium' : 'high')),
      pinned('deduplication', 'strong'),
      pinned('verifier', 'strong'),
      pinned('sweep', 'strong'),
      pinned('merge-rank', 'strong'),
      pinned('fixer', 'strong', 'high', 1_200_000),
    ],
    rolesDigest: '5'.repeat(64),
    concurrency: 4,
    runBudgetUsd: 30,
    fix: true,
    checks: { timeoutMs: 1_200_000 },
    // One finding per batch, so the cluster of three findings runs as three batches, one after another.
    fixes: { batchSize: 1 },
  }, 2);
  const checks = { build: 'npm run build', lint: 'npm run lint:check', test: 'npm run test' };
  fix.add('checks.planned', {
    checks: [
      { kind: 'build', command: checks.build, origin: 'package', reason: null },
      { kind: 'typecheck', command: null, origin: 'none', reason: 'no --check flag, Taskfile task, Makefile target, justfile recipe, package.json script or language default names it' },
      { kind: 'lint', command: checks.lint, origin: 'package', reason: null },
      { kind: 'test', command: checks.test, origin: 'package', reason: null },
    ],
    manager: 'npm',
  });
  fix.phaseV2('triage', () => {
    fix.launch('101', 'triage triage:SCAN');
    fix.finishWorker('101');
    fix.add('candidates.recorded', { phase: 'triage', key: 'SCAN', workerId: fix.id('101'), candidates: [fix.candidate('SCAN-1', 'SCAN', 1), fix.candidate('SCAN-2', 'SCAN', 1), fix.candidate('SCAN-3', 'SCAN', 1)], leads: finderAngles.map((angle) => ({ angle, lead: null })) });
  });
  fix.phaseV2('finders', () => {
    for (const angle of finderAngles) {
      const tag = String(110 + finderAngles.indexOf(angle));
      fix.launch(tag, `finder-${angle} finders:${angle}`);
      fix.finishWorker(tag);
      const found = angle === 'RIPPLE'
        ? [{ ...fix.candidate('RIPPLE-1', 'RIPPLE', 3), file: 'src/caller.ts', inScope: false, rawFile: 'src/caller.ts' }]
        : angle === 'DESIGN' ? [fix.candidate('DESIGN-1', 'DESIGN', 1)] : [];
      fix.add('candidates.recorded', { phase: 'finders', key: angle, workerId: fix.id(tag), candidates: found, leads: null });
    }
  });
  fix.phaseV2('deduplication', () => {
    fix.launch('120', 'deduplication deduplication:deduplication');
    fix.finishWorker('120');
    fix.add('deduplication.recorded', { phase: 'deduplication', workerId: fix.id('120'), groups: [] });
  });
  fix.phaseV2('verification', () => {
    fix.add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['RIPPLE-1'] }, { id: 'g2', candidateIds: ['DESIGN-1', 'SCAN-1', 'SCAN-2', 'SCAN-3'] }] });
    fix.launch('121', 'verifier verification:g1');
    fix.finishWorker('121');
    fix.add('verdicts.recorded', { phase: 'verification', groupId: 'g1', workerId: fix.id('121'), verdicts: [{ id: 'RIPPLE-1', verdict: 'CONFIRMED', evidence: 'line 3 passes the null on' }] });
    fix.launch('122', 'verifier verification:g2');
    fix.finishWorker('122');
    fix.add('verdicts.recorded', { phase: 'verification', groupId: 'g2', workerId: fix.id('122'), verdicts: [{ id: 'DESIGN-1', verdict: 'PLAUSIBLE', evidence: 'the helper would read better' }, { id: 'SCAN-1', verdict: 'CONFIRMED', evidence: 'line 1 dereferences the null' }, { id: 'SCAN-2', verdict: 'CONFIRMED', evidence: 'line 1 also skips the guard' }, { id: 'SCAN-3', verdict: 'CONFIRMED', evidence: 'line 1 logs the raw value' }] });
  });
  fix.phaseV2('sweep', () => {
    fix.launch('130', 'sweep sweep:sweep');
    fix.finishWorker('130');
    fix.add('candidates.recorded', { phase: 'sweep', key: 'sweep', workerId: fix.id('130'), candidates: [], leads: null });
  });
  fix.phaseV2('sweep-deduplication', () => {});
  fix.phaseV2('sweep-verification', () => {
    fix.add('verification.planned', { phase: 'sweep-verification', groups: [] });
  });
  fix.phaseV2('merge-rank', () => {
    fix.launch('140', 'merge-rank merge-rank:merge-rank');
    fix.finishWorker('140');
    fix.add('ranking.recorded', { workerId: fix.id('140'), findings: [
      { id: 'SCAN-1', members: [], severity: 'major', summary: 'changed() dereferences a null', reason: 'a crash on reachable input' },
      { id: 'RIPPLE-1', members: [], severity: 'minor', summary: 'the caller passes the null on', reason: 'the crash reaches a second site' },
      { id: 'SCAN-2', members: [], severity: 'minor', summary: 'changed() skips its guard', reason: 'the guard is part of the fix' },
      { id: 'SCAN-3', members: [], severity: 'minor', summary: 'changed() logs the raw value', reason: 'the log leaks the input' },
      { id: 'DESIGN-1', members: [], severity: 'minor', summary: 'extract the helper', reason: 'one helper reads better' },
    ] });
  });
  // The lint check rewrites the changed file at baseline, and the test fails there already.
  fix.phaseV2('baseline-checks', () => {
    fix.check('baseline-checks', 'build', checks.build, 'passed');
    fix.check('baseline-checks', 'lint', checks.lint, 'passed');
    fix.add('tree.revised', { phase: 'baseline-checks', source: { kind: 'check', check: 'lint' }, change: { findings: [], message: { subject: 'chore: apply the lint check\'s rewrite', body: 'The lint check rewrote these files.' } }, files: [{ path: 'src/changed.ts', status: 'modified', before: fix.frozen('after\n'), beforeSymlink: false, symlink: false, after: fix.frozen('after;\n') }] });
    fix.check('baseline-checks', 'test', checks.test, 'failed');
  });
  const message = (subject: string) => ({ subject, body: `Why: ${subject}.` });
  const finding = (id: string, status: 'applied' | 'already-applied' | 'deferred' | 'blocked', files: string[], subject: string | null, requiredFiles: string[] = []) => ({
    id, status, file: files[0] ?? 'src/changed.ts', line: 1, note: `${id} ${status}`, message: subject === null ? null : message(subject), files,
    corrections: [], validation: [{ method: 'old-code', source: 'test/changed.test.ts', evidence: 'red before the fix, green after' }], requiredFiles,
  });
  fix.phaseV2('fixes', () => {
    fix.add('fixes.planned', {
      routes: [{ id: 'SCAN-1', route: 'fixer' }, { id: 'RIPPLE-1', route: 'fixer' }, { id: 'SCAN-2', route: 'fixer' }, { id: 'SCAN-3', route: 'fixer' }, { id: 'DESIGN-1', route: 'held' }],
      clusters: [{ id: 'c1', findingIds: ['SCAN-1', 'SCAN-2', 'SCAN-3'], files: ['src/changed.ts'] }, { id: 'c2', findingIds: ['RIPPLE-1'], files: ['src/caller.ts'] }],
      batches: [
        { key: 'c1-1', cluster: 'c1', findingIds: ['SCAN-1'] },
        { key: 'c2-1', cluster: 'c2', findingIds: ['RIPPLE-1'] },
        { key: 'c1-2', cluster: 'c1', findingIds: ['SCAN-2'] },
        { key: 'c1-3', cluster: 'c1', findingIds: ['SCAN-3'] },
      ],
    });
    fix.launch('150', 'fixer fixes:c1-1');
    fix.finishWorker('150');
    fix.add('fix.recorded', { phase: 'fixes', key: 'c1-1', workerId: fix.id('150'), findings: [finding('SCAN-1', 'applied', ['src/caller.ts', 'src/changed.ts', 'test/changed.test.ts'], 'fix: Guard the null in changed()')], drift: [{ file: 'README.md', what: 'changed() no longer throws on null' }], tests: [{ file: 'test/changed.test.ts', covers: 'changed(null) returns 0' }], suite: { result: 'pass', command: 'npm test', failures: '' }, violations: ['src/caller.ts'] });
    fix.add('tree.revised', { phase: 'fixes', source: { kind: 'fix', key: 'c1-1', workerId: fix.id('150') }, change: { findings: ['SCAN-1'], message: message('fix: Guard the null in changed()') }, files: [
      // src/caller.ts is outside the change: its state before is what the scope's head held.
      { path: 'src/caller.ts', status: 'modified', before: fix.frozen('caller(null);\n'), beforeSymlink: false, symlink: false, after: fix.frozen('caller();\n') },
      { path: 'src/changed.ts', status: 'modified', before: fix.frozen('after;\n'), beforeSymlink: false, symlink: false, after: fix.frozen('after; // guarded\n') },
      { path: 'test/changed.test.ts', status: 'created', before: null, beforeSymlink: false, symlink: false, after: fix.frozen('test();\n') },
    ] });
    fix.launch('151', 'fixer fixes:c2-1');
    fix.finishWorker('151');
    fix.add('fix.recorded', { phase: 'fixes', key: 'c2-1', workerId: fix.id('151'), findings: [finding('RIPPLE-1', 'blocked', [], null, ['src/changed.ts'])], drift: [], tests: [], suite: { result: 'not-run', command: '', failures: '' }, violations: [] });
    // c1's later batches run once c1-1 settled, on the tree it left.
    // c1-2's first attempt times out after snapshotting SCAN-2; its edits are recorded with the failure, and the retry
    // verifies them as already applied and gives the message their commit carries.
    fix.launch('152', 'fixer fixes:c1-2');
    fix.finishWorker('152', 'timeout');
    fix.add('attempt.failed', { phase: 'fixes', key: 'c1-2', workerId: fix.id('152'), reason: 'timeout: The worker ran past its timeout of 1200000 ms' }, 2);
    fix.add('tree.revised', { phase: 'fixes', source: { kind: 'attempt', key: 'c1-2', workerId: fix.id('152') }, change: { findings: ['SCAN-2'], message: { subject: 'chore: keep the edits an unfinished attempt made for SCAN-2', body: 'An attempt of batch c1-2 ended without an answer after snapshotting SCAN-2.' } }, files: [
      { path: 'src/changed.ts', status: 'modified', before: fix.frozen('after; // guarded\n'), beforeSymlink: false, symlink: false, after: fix.frozen('after; // guarded, checked\n') },
    ] });
    fix.launch('154', 'fixer fixes:c1-2');
    fix.finishWorker('154');
    fix.add('fix.recorded', { phase: 'fixes', key: 'c1-2', workerId: fix.id('154'), findings: [finding('SCAN-2', 'already-applied', ['src/changed.ts'], 'fix: Check the guard in changed()')], drift: [], tests: [], suite: { result: 'pass', command: 'npm test', failures: '' }, violations: [] });
    // The run budget is reached before c1-3 launches: it is not attempted, and the pass goes on to its checks and report.
    fix.add('unit.unattempted', { phase: 'fixes', key: 'c1-3', cause: 'budget', reason: 'spent 30.10 USD of the 30.00 USD run budget' });
    // RIPPLE-1 was blocked on c1's file, so the second round takes it into c3, owning both files; the budget is spent, so c3-1 is not attempted either.
    fix.add('fixes.replanned', { blocked: [{ id: 'RIPPLE-1', requiredFiles: ['src/changed.ts'] }], clusters: [{ id: 'c3', findingIds: ['RIPPLE-1'], files: ['src/caller.ts', 'src/changed.ts'] }], batches: [{ key: 'c3-1', cluster: 'c3', findingIds: ['RIPPLE-1'] }] });
    fix.add('unit.unattempted', { phase: 'fixes', key: 'c3-1', cause: 'budget', reason: 'spent 30.10 USD of the 30.00 USD run budget' });
  }, 'degraded', { end: true, strays: ['notes.txt'] });
  // The fixers broke lint, which the repair takes; test failed before any fix and still fails, so the
  // repair reads it too and finds every failure there before (R24).
  fix.phaseV2('checks', () => {
    fix.check('checks', 'build', checks.build, 'passed');
    fix.check('checks', 'lint', checks.lint, 'failed');
    fix.check('checks', 'test', checks.test, 'failed');
  });
  fix.phaseV2('repair', () => {
    fix.launch('160', 'fixer repair:repair');
    fix.finishWorker('160');
    fix.add('fix.recorded', { phase: 'repair', key: 'repair', workerId: fix.id('160'), findings: [finding('lint', 'applied', ['src/changed.ts'], 'style: Format the guard as lint asks'), finding('test', 'deferred', [], null)], drift: [], tests: [], suite: { result: 'pass', command: 'npm run lint:check', failures: '' }, violations: [] });
    fix.add('tree.revised', { phase: 'repair', source: { kind: 'fix', key: 'repair', workerId: fix.id('160') }, change: { findings: ['lint'], message: message('style: Format the guard as lint asks') }, files: [{ path: 'src/changed.ts', status: 'modified', before: fix.frozen('after; // guarded, checked\n'), beforeSymlink: false, symlink: false, after: fix.frozen('after; /* guarded */\n') }] });
  }, 'completed', { end: true });
  fix.phaseV2('repair-checks', () => {
    fix.check('repair-checks', 'build', checks.build, 'passed');
    fix.check('repair-checks', 'lint', checks.lint, 'passed');
    fix.check('repair-checks', 'test', checks.test, 'failed');
  });
  fix.phaseV2('report', () => {
    const spend = (workers: number) => ({ workers, seconds: workers * 30, costUsd: workers * 0.5, costUnreported: 0, inputTokens: workers * 1000, cachedInputTokens: workers * 200, outputTokens: workers * 100 });
    const workersPerPhase: Record<(typeof reviewVocabularyV2.phases)[number], number> = { triage: 1, finders: 9, deduplication: 1, verification: 2, sweep: 1, 'sweep-deduplication': 0, 'sweep-verification': 0, 'merge-rank': 1, 'baseline-checks': 0, fixes: 4, checks: 0, repair: 1, 'repair-checks': 0, report: 0 };
    fix.add('report.written', {
      report: checkpoint.evidence.put('# Deep review report\n\nfixture report of a fix run\n'),
      statistics: { phases: reviewVocabularyV2.phases.map((phase) => ({ phase, ...spend(workersPerPhase[phase]), ...(['baseline-checks', 'checks', 'repair-checks'].includes(phase) ? { seconds: 12 } : {}) })), total: spend(20), budgetApplied: true },
      patches: ['lint rewrite', 'guard', 'check the guard', 'format'].map((name) => checkpoint.evidence.put(`From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001\nSubject: [PATCH] ${name}\n\n---\n`)),
    }, 2);
  });
  fix.add('commits.created', {
    commits: [
      { sha: 'a'.repeat(40), revision: 'change', subject: 'feat: The change under review' },
      { sha: 'b'.repeat(40), revision: 0, subject: 'chore: apply the lint check\'s rewrite' },
      { sha: 'c'.repeat(40), revision: 1, subject: 'fix: Guard the null in changed()' },
      { sha: 'd'.repeat(40), revision: 2, subject: 'fix: Check the guard in changed()' },
      { sha: 'e'.repeat(40), revision: 3, subject: 'style: Format the guard as lint asks' },
    ],
    from: fixScope.head,
    to: 'e'.repeat(40),
  });
  // A fifth run through the survey, every event at the version the engine
  // wrote when the survey arrived, the configuration at version 3, which
  // reads as a Claude Code run with no Codex Windows sandbox: a fix run
  // whose policy judges the reviewer's own rules; its
  // surveyor names a contributing guide and applies the reviewer's own
  // rules file, and chooses a lint command whose tool is missing, so the
  // survey blocks with check-unavailable; the next invocation drops lint
  // with --no-check, and the re-entered survey plans the checks from the
  // recorded answer with no new worker. The run goes on to an empty review,
  // its baseline checks and its report, with the survey's row in the
  // statistics.
  const surveyedRun = checkpoint.createRun({ worktree: '/fixture/surveyed' });
  const surveyed = new ReviewHistory(checkpoint, surveyedRun.id, checkpoint.append(surveyedRun.id, surveyedRun.lastSequence, [{ kind: 'scope.captured', version: 1, payload: fixScope }]).lastSequence);
  const userRules = '/fixture/home/.codex/AGENTS.md';
  surveyed.add('review.configured', {
    runtime: 'claude',
    executable: '/fixture/bin/claude',
    executableArgs: [],
    version: '2.1.290',
    models: { strong: 'opus', fast: 'sonnet' },
    roles: [
      pinned('surveyor', 'strong', 'medium'),
      pinned('triage', 'strong'),
      ...finderAngles.map((angle) => pinned(`finder-${angle}`, ['REMOVALS', 'DESIGN', 'ALTITUDE'].includes(angle) ? 'strong' : 'fast', angle === 'CONVENTIONS' ? 'medium' : 'high')),
      pinned('deduplication', 'strong'),
      pinned('verifier', 'strong'),
      pinned('sweep', 'strong'),
      pinned('merge-rank', 'strong'),
      pinned('fixer', 'strong', 'high', 1_800_000),
    ],
    rolesDigest: '6'.repeat(64),
    concurrency: 4,
    runBudgetUsd: 60,
    fix: true,
    checks: { timeoutMs: 1_200_000 },
    fixes: { batchSize: 4 },
    survey: { userRules: 'judge' },
  }, 3);
  const surveyedChecks = [
    { kind: 'build', command: null, basis: null, source: null, missingTool: null, reason: 'the project has no build step' },
    { kind: 'typecheck', command: 'uv run mypy src', basis: 'stated', source: { path: '.github/workflows/tests.yaml', quote: 'run: uv run mypy src' }, missingTool: null, reason: null },
    { kind: 'lint', command: 'pre-commit run --all-files', basis: 'stated', source: { path: '.github/workflows/tests.yaml', quote: 'run: pre-commit run --all-files' }, missingTool: 'pre-commit', reason: null },
    { kind: 'test', command: 'uv run pytest', basis: 'stated', source: { path: 'pyproject.toml', quote: 'commands = [["pytest"]]' }, missingTool: null, reason: null },
  ];
  surveyed.blockedV3('survey', () => {
    surveyed.launch('201', 'surveyor survey:survey');
    surveyed.finishWorker('201');
    surveyed.add('survey.recorded', {
      workerId: surveyed.id('201'),
      conventions: [
        { path: 'docs/contributing.md', level: 'repository', governs: 'code style, dependencies and the wrapping of Markdown', appliesTo: null, grounds: null },
        { path: 'src/AGENTS.md', level: 'repository', governs: 'how the sources are commented', appliesTo: ['src/**'], grounds: null },
        { path: userRules, level: 'user', governs: 'the reviewer\'s engineering rules', appliesTo: null, grounds: 'the repository\'s AGENTS.md imports it' },
      ],
      userRules: [{ path: userRules, applied: true, reason: 'the repository\'s AGENTS.md imports it' }],
      checks: surveyedChecks,
      note: 'docs/contributing.md links to a style page outside the repository',
    });
  }, { code: 'check-unavailable', detail: 'the project defines a check this machine cannot run: lint: `pre-commit run --all-files` (from .github/workflows/tests.yaml), pre-commit not found', action: 'install the missing tool and run the command again, or run it again with --no-check <kind> to go without that check, or with --check <kind>=<command> to name one that runs' });
  surveyed.phaseV3('survey', () => {
    surveyed.add('checks.planned', { checks: [
      { kind: 'build', command: null, origin: 'none', reason: 'the project has no build step', source: null },
      { kind: 'typecheck', command: 'uv run mypy src', origin: 'survey', reason: null, source: { path: '.github/workflows/tests.yaml', quote: 'run: uv run mypy src', basis: 'stated' } },
      { kind: 'lint', command: null, origin: 'flag', reason: 'dropped by --no-check', source: null },
      { kind: 'test', command: 'uv run pytest', origin: 'survey', reason: null, source: { path: 'pyproject.toml', quote: 'commands = [["pytest"]]', basis: 'stated' } },
    ] }, 2);
  });
  surveyed.phaseV3('triage', () => {
    surveyed.launch('202', 'triage triage:SCAN');
    surveyed.finishWorker('202');
    surveyed.add('candidates.recorded', { phase: 'triage', key: 'SCAN', workerId: surveyed.id('202'), candidates: [], leads: finderAngles.map((angle) => ({ angle, lead: null })) });
  });
  surveyed.phaseV3('finders', () => {
    for (const angle of finderAngles) {
      const tag = String(210 + finderAngles.indexOf(angle));
      surveyed.launch(tag, `finder-${angle} finders:${angle}`);
      surveyed.finishWorker(tag);
      surveyed.add('candidates.recorded', { phase: 'finders', key: angle, workerId: surveyed.id(tag), candidates: [], leads: null });
    }
  });
  surveyed.phaseV3('deduplication', () => {});
  surveyed.phaseV3('verification', () => surveyed.add('verification.planned', { phase: 'verification', groups: [] }));
  surveyed.phaseV3('sweep', () => {
    surveyed.launch('230', 'sweep sweep:sweep');
    surveyed.finishWorker('230');
    surveyed.add('candidates.recorded', { phase: 'sweep', key: 'sweep', workerId: surveyed.id('230'), candidates: [], leads: null });
  });
  surveyed.phaseV3('sweep-deduplication', () => {});
  surveyed.phaseV3('sweep-verification', () => surveyed.add('verification.planned', { phase: 'sweep-verification', groups: [] }));
  surveyed.phaseV3('merge-rank', () => {});
  surveyed.phaseV3('baseline-checks', () => {
    surveyed.check('baseline-checks', 'typecheck', 'uv run mypy src', 'passed');
    surveyed.check('baseline-checks', 'test', 'uv run pytest', 'passed');
  });
  surveyed.phaseV3('fixes', () => {
    surveyed.add('fixes.planned', { routes: [], clusters: [], batches: [] });
    surveyed.add('fixes.replanned', { blocked: [], clusters: [], batches: [] });
  });
  surveyed.phaseV3('checks', () => {});
  surveyed.phaseV3('repair', () => {});
  surveyed.phaseV3('repair-checks', () => {});
  surveyed.phaseV3('report', () => {
    const spend = (workers: number) => ({ workers, seconds: workers * 30, costUsd: workers * 0.5, costUnreported: 0, inputTokens: workers * 1000, cachedInputTokens: workers * 200, outputTokens: workers * 100 });
    const workersPerPhase: Record<(typeof reviewVocabularyV3.phases)[number], number> = { survey: 1, triage: 1, finders: 9, deduplication: 0, verification: 0, sweep: 1, 'sweep-deduplication': 0, 'sweep-verification': 0, 'merge-rank': 0, 'baseline-checks': 0, fixes: 0, checks: 0, repair: 0, 'repair-checks': 0, report: 0 };
    surveyed.add('report.written', {
      report: checkpoint.evidence.put('# Deep review report\n\nfixture report of a surveyed run\n'),
      statistics: { phases: reviewVocabularyV3.phases.map((phase) => ({ phase, ...spend(workersPerPhase[phase]), ...(phase === 'baseline-checks' ? { seconds: 8 } : {}) })), total: spend(12), budgetApplied: true },
      patches: [],
    }, 3);
  });
  // A sixth run, read-only and left active, on Codex and configured at
  // version 3 from a worktree rooted at /, so it reads as a run off
  // Windows that pins no Windows sandbox (a Windows worktree would read
  // as one under the unelevated sandbox):
  // its policy applies the reviewer's own rules, its surveyor fails twice,
  // and the run goes on without the survey, the policy's file its one
  // convention source, so CONVENTIONS still runs.
  const unsurveyedRun = checkpoint.createRun({ worktree: '/fixture/unsurveyed' });
  const unsurveyed = new ReviewHistory(checkpoint, unsurveyedRun.id, checkpoint.append(unsurveyedRun.id, unsurveyedRun.lastSequence, [{ kind: 'scope.captured', version: 1, payload: fixScope }]).lastSequence);
  unsurveyed.add('review.configured', {
    runtime: 'codex',
    executable: '/fixture/bin/codex',
    executableArgs: [],
    version: '0.157.1',
    models: { strong: 'gpt-6-astra', fast: 'gpt-5.6-terra' },
    roles: [pinned('surveyor', 'strong', 'medium'), pinned('triage', 'strong')],
    rolesDigest: '7'.repeat(64),
    concurrency: 2,
    runBudgetUsd: null,
    fix: false,
    checks: null,
    fixes: null,
    survey: { userRules: 'apply' },
  }, 3);
  unsurveyed.phaseV3('survey', () => {
    unsurveyed.launch('301', 'surveyor survey:survey');
    unsurveyed.finishWorker('301', 'failed');
    unsurveyed.add('attempt.failed', { phase: 'survey', key: 'survey', workerId: unsurveyed.id('301'), reason: 'failed: The answer does not match the output schema' }, 3);
    unsurveyed.launch('302', 'surveyor survey:survey');
    unsurveyed.finishWorker('302', 'timeout');
    unsurveyed.add('attempt.failed', { phase: 'survey', key: 'survey', workerId: unsurveyed.id('302'), reason: 'timeout: The worker ran past its timeout' }, 3);
    unsurveyed.add('survey.failed', {
      reason: '2 attempts did not complete: failed: The answer does not match the output schema; timeout: The worker ran past its timeout',
      conventions: [{ path: userRules, level: 'user', governs: 'the reviewer\'s own rules, which the review policy applies to every run', appliesTo: null, grounds: 'applied by the policy value apply' }],
      userRules: [{ path: userRules, applied: true, reason: 'applied by the policy value apply' }],
    });
  }, 'degraded');
  // A seventh run, configured at version 4, as the engine wrote it when
  // the Codex Windows sandbox arrived: a Codex fix run on Windows whose editors run in no sandbox, pinned with
  // --codex-windows-sandbox none; abandoned as its survey starts.
  const unsandboxedRun = checkpoint.createRun({ worktree: 'C:\\fixture\\unsandboxed' });
  const unsandboxed = new ReviewHistory(checkpoint, unsandboxedRun.id, checkpoint.append(unsandboxedRun.id, unsandboxedRun.lastSequence, [{ kind: 'scope.captured', version: 1, payload: fixScope }]).lastSequence);
  unsandboxed.add('review.configured', {
    runtime: 'codex',
    executable: 'C:\\fixture\\bin\\codex.exe',
    executableArgs: [],
    version: '0.160.0',
    models: { strong: 'gpt-6-astra', fast: 'gpt-6.1-sol' },
    roles: [pinned('surveyor', 'strong', 'medium'), pinned('fixer', 'strong', 'high', 1_800_000)],
    rolesDigest: '8'.repeat(64),
    concurrency: 4,
    runBudgetUsd: null,
    fix: true,
    checks: { timeoutMs: 1_200_000 },
    fixes: { batchSize: 4 },
    survey: { userRules: 'judge' },
    codex: { windowsSandbox: 'none' },
  }, 4);
  unsandboxed.add('phase.started', { phase: 'survey', attempt: 1 }, 3);
  unsandboxed.add('run.abandoned', { reason: 'fixture run abandoned as its survey starts' });
  // An eighth run, configured at the version the engine now writes and
  // every event at the version it writes them: a Claude Code fix run with
  // the decision step. Its review ranks three findings; the decider fixes
  // the first, departing from a comment's rule, leaves the second as
  // superseded by the first, and asks the author about the third with a
  // default that keeps the code; the plan gives a fixer the first alone,
  // which applies it; and the report is written with its one patch.
  const decidedRun = checkpoint.createRun({ worktree: '/fixture/decided' });
  const decided = new ReviewHistory(checkpoint, decidedRun.id, checkpoint.append(decidedRun.id, decidedRun.lastSequence, [{ kind: 'scope.captured', version: 1, payload: fixScope }]).lastSequence);
  decided.add('review.configured', {
    runtime: 'claude',
    executable: '/fixture/bin/claude',
    executableArgs: [],
    version: '2.1.292',
    models: { strong: 'opus', fast: 'sonnet' },
    roles: [
      pinned('surveyor', 'strong', 'medium'),
      pinned('triage', 'strong'),
      ...finderAngles.map((angle) => pinned(`finder-${angle}`, ['REMOVALS', 'DESIGN', 'ALTITUDE'].includes(angle) ? 'strong' : 'fast', angle === 'CONVENTIONS' ? 'medium' : 'high')),
      pinned('deduplication', 'strong'),
      pinned('verifier', 'strong'),
      pinned('sweep', 'strong'),
      pinned('merge-rank', 'strong'),
      pinned('decider', 'strong', 'high', 1_800_000),
      pinned('fixer', 'strong', 'high', 1_800_000),
    ],
    rolesDigest: '9'.repeat(64),
    concurrency: 4,
    runBudgetUsd: 60,
    fix: true,
    checks: { timeoutMs: 1_200_000 },
    fixes: { batchSize: 4 },
    survey: { userRules: 'judge' },
    codex: null,
  }, 5);
  const decidedChecks = { build: 'npm run build', test: 'npm test' };
  decided.phaseV4('survey', () => {
    decided.launch('401', 'surveyor survey:survey');
    decided.finishWorker('401');
    decided.add('survey.recorded', {
      workerId: decided.id('401'),
      conventions: [{ path: 'CONTRIBUTING.md', level: 'repository', governs: 'code style and tests', appliesTo: null, grounds: null }],
      userRules: [],
      checks: [
        { kind: 'build', command: decidedChecks.build, basis: 'stated', source: { path: 'CONTRIBUTING.md', quote: '`npm run build`' }, missingTool: null, reason: null },
        { kind: 'typecheck', command: null, basis: null, source: null, missingTool: null, reason: 'the build typechecks' },
        { kind: 'lint', command: null, basis: null, source: null, missingTool: null, reason: 'the project has no linter' },
        { kind: 'test', command: decidedChecks.test, basis: 'stated', source: { path: 'CONTRIBUTING.md', quote: '`npm test`' }, missingTool: null, reason: null },
      ],
      note: '',
    });
    decided.add('checks.planned', { checks: [
      { kind: 'build', command: decidedChecks.build, origin: 'survey', reason: null, source: { path: 'CONTRIBUTING.md', quote: '`npm run build`', basis: 'stated' } },
      { kind: 'typecheck', command: null, origin: 'none', reason: 'the build typechecks', source: null },
      { kind: 'lint', command: null, origin: 'none', reason: 'the project has no linter', source: null },
      { kind: 'test', command: decidedChecks.test, origin: 'survey', reason: null, source: { path: 'CONTRIBUTING.md', quote: '`npm test`', basis: 'stated' } },
    ] }, 2);
  });
  decided.phaseV4('triage', () => {
    decided.launch('402', 'triage triage:SCAN');
    decided.finishWorker('402');
    decided.add('candidates.recorded', { phase: 'triage', key: 'SCAN', workerId: decided.id('402'), candidates: [decided.candidate('SCAN-1', 'SCAN', 1), decided.candidate('SCAN-2', 'SCAN', 1)], leads: finderAngles.map((angle) => ({ angle, lead: null })) });
  });
  decided.phaseV4('finders', () => {
    for (const angle of finderAngles) {
      const tag = String(410 + finderAngles.indexOf(angle));
      decided.launch(tag, `finder-${angle} finders:${angle}`);
      decided.finishWorker(tag);
      decided.add('candidates.recorded', { phase: 'finders', key: angle, workerId: decided.id(tag), candidates: angle === 'DESIGN' ? [decided.candidate('DESIGN-1', 'DESIGN', 1)] : [], leads: null });
    }
  });
  decided.phaseV4('deduplication', () => {
    decided.launch('420', 'deduplication deduplication:deduplication');
    decided.finishWorker('420');
    decided.add('deduplication.recorded', { phase: 'deduplication', workerId: decided.id('420'), groups: [] });
  });
  decided.phaseV4('verification', () => {
    decided.add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['DESIGN-1', 'SCAN-1', 'SCAN-2'] }] });
    decided.launch('421', 'verifier verification:g1');
    decided.finishWorker('421');
    decided.add('verdicts.recorded', { phase: 'verification', groupId: 'g1', workerId: decided.id('421'), verdicts: [
      { id: 'DESIGN-1', verdict: 'PLAUSIBLE', evidence: 'Not CONFIRMED: whether callers may see the helper is the author\'s. Needs the author: a public helper or a private one.' },
      { id: 'SCAN-1', verdict: 'CONFIRMED', evidence: 'line 1 dereferences the null an empty input gives' },
      { id: 'SCAN-2', verdict: 'CONFIRMED', evidence: 'line 1 never checks the guard SCAN-1 adds' },
    ] });
  });
  decided.phaseV4('sweep', () => {
    decided.launch('430', 'sweep sweep:sweep');
    decided.finishWorker('430');
    decided.add('candidates.recorded', { phase: 'sweep', key: 'sweep', workerId: decided.id('430'), candidates: [], leads: null });
  });
  decided.phaseV4('sweep-deduplication', () => {});
  decided.phaseV4('sweep-verification', () => decided.add('verification.planned', { phase: 'sweep-verification', groups: [] }));
  decided.phaseV4('merge-rank', () => {
    decided.launch('440', 'merge-rank merge-rank:merge-rank');
    decided.finishWorker('440');
    decided.add('ranking.recorded', { workerId: decided.id('440'), findings: [
      { id: 'SCAN-1', members: [], severity: 'major', summary: 'changed() dereferences a null', reason: 'a crash on reachable input' },
      { id: 'SCAN-2', members: [], severity: 'minor', summary: 'changed() never checks its guard', reason: 'the guard is part of the fix' },
      { id: 'DESIGN-1', members: [], severity: 'minor', summary: 'extract the helper', reason: 'one helper reads better' },
    ] });
  });
  decided.phaseV4('decision', () => {
    decided.launch('445', 'decider decision:decision');
    decided.finishWorker('445');
    decided.add('decisions.recorded', { workerId: decided.id('445'), decisions: [
      {
        id: 'SCAN-1', decision: 'fix', grounds: 'an empty input reaches the dereference, and the change means to accept one',
        fix: { approach: 'guard the null in changed() before it is read, and drop the comment that says callers never pass one', rejected: [{ option: 'guard in every caller', reason: 'three copies of one rule' }] },
        leave: null, ask: null,
        departure: { rule: 'callers never pass null', source: 'src/changed.ts:1', reason: 'the comment came with a caller that is gone, and its reason does not reach the empty input' },
      },
      { id: 'SCAN-2', decision: 'leave', grounds: 'the guard SCAN-1 adds is the check SCAN-2 asks for', fix: null, leave: { reason: 'superseded', supersededBy: 'SCAN-1' }, ask: null, departure: null },
      {
        id: 'DESIGN-1', decision: 'ask', grounds: 'nothing in the repository says whether the helper is public', fix: null, leave: null, departure: null,
        ask: {
          question: 'Should the extracted helper be exported?',
          options: [
            { option: 'keep the code as it is', cost: 'the two copies stay', rule: 'helpers stay inline until a third caller needs one', edits: false },
            { option: 'extract a private helper', cost: 'one more function to read', rule: 'shared code moves to a private helper', edits: true },
          ],
          recommended: 1,
          applied: 0,
          searched: ['CONTRIBUTING.md', 'the change\'s commit message', 'test/changed.test.ts'],
        },
      },
    ] });
  });
  decided.phaseV4('baseline-checks', () => {
    decided.check('baseline-checks', 'build', decidedChecks.build, 'passed');
    decided.check('baseline-checks', 'test', decidedChecks.test, 'passed');
  });
  decided.phaseV4('fixes', () => {
    decided.add('fixes.planned', {
      routes: [{ id: 'SCAN-1', route: 'fixer' }, { id: 'SCAN-2', route: 'held' }, { id: 'DESIGN-1', route: 'held' }],
      clusters: [{ id: 'c1', findingIds: ['SCAN-1'], files: ['src/changed.ts'] }],
      batches: [{ key: 'c1-1', cluster: 'c1', findingIds: ['SCAN-1'] }],
    });
    decided.launch('450', 'fixer fixes:c1-1');
    decided.finishWorker('450');
    decided.add('fix.recorded', { phase: 'fixes', key: 'c1-1', workerId: decided.id('450'), findings: [finding('SCAN-1', 'applied', ['src/changed.ts'], 'fix: Guard the null in changed()')], drift: [], tests: [], suite: { result: 'pass', command: decidedChecks.test, failures: '' }, violations: [] });
    decided.add('tree.revised', { phase: 'fixes', source: { kind: 'fix', key: 'c1-1', workerId: decided.id('450') }, change: { findings: ['SCAN-1'], message: message('fix: Guard the null in changed()') }, files: [
      { path: 'src/changed.ts', status: 'modified', before: decided.frozen('after\n'), beforeSymlink: false, symlink: false, after: decided.frozen('after; // guarded\n') },
    ] });
    decided.add('fixes.replanned', { blocked: [], clusters: [], batches: [] });
  }, 'completed', { end: true });
  decided.phaseV4('checks', () => {
    decided.check('checks', 'build', decidedChecks.build, 'passed');
    decided.check('checks', 'test', decidedChecks.test, 'passed');
  });
  decided.phaseV4('repair', () => {});
  decided.phaseV4('repair-checks', () => {});
  decided.phaseV4('report', () => {
    const spend = (workers: number) => ({ workers, seconds: workers * 30, costUsd: workers * 0.5, costUnreported: 0, inputTokens: workers * 1000, cachedInputTokens: workers * 200, outputTokens: workers * 100 });
    const workersPerPhase: Record<Phase, number> = { survey: 1, triage: 1, finders: 9, deduplication: 1, verification: 1, sweep: 1, 'sweep-deduplication': 0, 'sweep-verification': 0, 'merge-rank': 1, decision: 1, 'baseline-checks': 0, fixes: 1, checks: 0, repair: 0, 'repair-checks': 0, report: 0 };
    decided.add('report.written', {
      report: checkpoint.evidence.put('# Deep review report\n\nfixture report of a decided run\n'),
      statistics: { phases: phases.map((phase) => ({ phase, ...spend(workersPerPhase[phase]), ...(phase === 'baseline-checks' || phase === 'checks' ? { seconds: 8 } : {}) })), total: spend(17), budgetApplied: true },
      patches: [checkpoint.evidence.put('From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001\nSubject: [PATCH] fix: Guard the null in changed()\n\n---\n')],
    }, 4);
  });
  // A seventh run with claims, every event at the version the engine now
  // writes: a fix run of two clusters, one finding per batch. c1-1 claims a
  // shared test file and applies SCAN-1; c2-1's claim of it is refused, its
  // marker on c1's own file is left out of the ledger as lost, and it
  // answers RIPPLE-1 blocked on the test file; c1-2 edits a file nobody held
  // without claiming it, a late claim; c2-2's claims directory is removed
  // while it runs, so its attempt fails for the environment and the phase
  // blocks with claims-lost; the re-entered phase gives c2-2 a fresh attempt,
  // which answers; and the second round takes RIPPLE-1 into c3, owning c2's
  // file and the test file c1 had claimed, where c3-1 claims one more file.
  const claimedRun = checkpoint.createRun({ worktree: '/fixture/claimed' });
  const claimed = new ReviewHistory(checkpoint, claimedRun.id, checkpoint.append(claimedRun.id, claimedRun.lastSequence, [{ kind: 'scope.captured', version: 1, payload: fixScope }]).lastSequence);
  claimed.add('review.configured', {
    runtime: 'claude',
    executable: '/fixture/bin/claude',
    executableArgs: [],
    version: '2.1.297',
    models: { strong: 'opus', fast: 'sonnet' },
    roles: [
      pinned('surveyor', 'strong', 'medium'),
      pinned('triage', 'strong'),
      ...finderAngles.map((angle) => pinned(`finder-${angle}`, ['REMOVALS', 'DESIGN', 'ALTITUDE'].includes(angle) ? 'strong' : 'fast', angle === 'CONVENTIONS' ? 'medium' : 'high')),
      pinned('deduplication', 'strong'),
      pinned('verifier', 'strong'),
      pinned('sweep', 'strong'),
      pinned('merge-rank', 'strong'),
      pinned('decider', 'strong', 'high', 1_800_000),
      pinned('fixer', 'strong', 'high', 1_800_000),
    ],
    rolesDigest: 'a'.repeat(64),
    concurrency: 4,
    runBudgetUsd: 60,
    fix: true,
    checks: { timeoutMs: 1_200_000 },
    fixes: { batchSize: 1 },
    survey: { userRules: 'ignore' },
    codex: null,
  }, 5);
  claimed.phaseV5('survey', () => {
    claimed.launch('601', 'surveyor survey:survey');
    claimed.finishWorker('601');
    claimed.add('survey.recorded', {
      workerId: claimed.id('601'),
      conventions: [],
      userRules: [],
      checks: [
        { kind: 'build', command: decidedChecks.build, basis: 'stated', source: { path: 'CONTRIBUTING.md', quote: '`npm run build`' }, missingTool: null, reason: null },
        { kind: 'typecheck', command: null, basis: null, source: null, missingTool: null, reason: 'the build typechecks' },
        { kind: 'lint', command: null, basis: null, source: null, missingTool: null, reason: 'the project has no linter' },
        { kind: 'test', command: decidedChecks.test, basis: 'stated', source: { path: 'CONTRIBUTING.md', quote: '`npm test`' }, missingTool: null, reason: null },
      ],
      note: '',
    });
    claimed.add('checks.planned', { checks: [
      { kind: 'build', command: decidedChecks.build, origin: 'survey', reason: null, source: { path: 'CONTRIBUTING.md', quote: '`npm run build`', basis: 'stated' } },
      { kind: 'typecheck', command: null, origin: 'none', reason: 'the build typechecks', source: null },
      { kind: 'lint', command: null, origin: 'none', reason: 'the project has no linter', source: null },
      { kind: 'test', command: decidedChecks.test, origin: 'survey', reason: null, source: { path: 'CONTRIBUTING.md', quote: '`npm test`', basis: 'stated' } },
    ] }, 2);
  });
  claimed.phaseV5('triage', () => {
    claimed.launch('602', 'triage triage:SCAN');
    claimed.finishWorker('602');
    claimed.add('candidates.recorded', { phase: 'triage', key: 'SCAN', workerId: claimed.id('602'), candidates: [claimed.candidate('SCAN-1', 'SCAN', 1), claimed.candidate('SCAN-2', 'SCAN', 1)], leads: finderAngles.map((angle) => ({ angle, lead: null })) });
  });
  claimed.phaseV5('finders', () => {
    for (const angle of finderAngles) {
      const tag = String(610 + finderAngles.indexOf(angle));
      claimed.launch(tag, `finder-${angle} finders:${angle}`);
      claimed.finishWorker(tag);
      const candidates = angle === 'RIPPLE'
        ? [1, 2].map((number) => ({ ...claimed.candidate(`RIPPLE-${String(number)}`, 'RIPPLE', number), file: 'src/caller.ts', inScope: false, rawFile: 'src/caller.ts' }))
        : [];
      claimed.add('candidates.recorded', { phase: 'finders', key: angle, workerId: claimed.id(tag), candidates, leads: null });
    }
  });
  claimed.phaseV5('deduplication', () => {
    claimed.launch('620', 'deduplication deduplication:deduplication');
    claimed.finishWorker('620');
    claimed.add('deduplication.recorded', { phase: 'deduplication', workerId: claimed.id('620'), groups: [] });
  });
  claimed.phaseV5('verification', () => {
    claimed.add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['RIPPLE-1', 'RIPPLE-2', 'SCAN-1', 'SCAN-2'] }] });
    claimed.launch('621', 'verifier verification:g1');
    claimed.finishWorker('621');
    claimed.add('verdicts.recorded', { phase: 'verification', groupId: 'g1', workerId: claimed.id('621'), verdicts: [
      { id: 'RIPPLE-1', verdict: 'CONFIRMED', evidence: 'line 1 passes the null on' },
      { id: 'RIPPLE-2', verdict: 'CONFIRMED', evidence: 'line 2 logs the raw value' },
      { id: 'SCAN-1', verdict: 'CONFIRMED', evidence: 'line 1 dereferences the null' },
      { id: 'SCAN-2', verdict: 'CONFIRMED', evidence: 'line 1 skips the guard' },
    ] });
  });
  claimed.phaseV5('sweep', () => {
    claimed.launch('630', 'sweep sweep:sweep');
    claimed.finishWorker('630');
    claimed.add('candidates.recorded', { phase: 'sweep', key: 'sweep', workerId: claimed.id('630'), candidates: [], leads: null });
  });
  claimed.phaseV5('sweep-deduplication', () => {});
  claimed.phaseV5('sweep-verification', () => claimed.add('verification.planned', { phase: 'sweep-verification', groups: [] }));
  claimed.phaseV5('merge-rank', () => {
    claimed.launch('640', 'merge-rank merge-rank:merge-rank');
    claimed.finishWorker('640');
    claimed.add('ranking.recorded', { workerId: claimed.id('640'), findings: [
      { id: 'SCAN-1', members: [], severity: 'major', summary: 'changed() dereferences a null', reason: 'a crash on reachable input' },
      { id: 'RIPPLE-1', members: [], severity: 'minor', summary: 'the caller passes the null on', reason: 'the crash reaches a second site' },
      { id: 'SCAN-2', members: [], severity: 'minor', summary: 'changed() skips its guard', reason: 'the guard is part of the fix' },
      { id: 'RIPPLE-2', members: [], severity: 'minor', summary: 'the caller logs the raw value', reason: 'the log leaks the input' },
    ] });
  });
  claimed.phaseV5('decision', () => {
    claimed.launch('645', 'decider decision:decision');
    claimed.finishWorker('645');
    const fixIt = (id: string, approach: string) => ({ id, decision: 'fix', grounds: `${id} is reachable`, fix: { approach, rejected: [] }, leave: null, ask: null, departure: null });
    claimed.add('decisions.recorded', { workerId: claimed.id('645'), decisions: [
      fixIt('SCAN-1', 'guard the null in changed()'),
      fixIt('RIPPLE-1', 'stop passing the null in the caller, with the shared test'),
      fixIt('SCAN-2', 'check the guard, noting it in docs/notes.md'),
      fixIt('RIPPLE-2', 'log the checked value'),
    ] });
  });
  claimed.phaseV5('baseline-checks', () => {
    claimed.check('baseline-checks', 'build', decidedChecks.build, 'passed');
    claimed.check('baseline-checks', 'test', decidedChecks.test, 'passed');
  });
  const modified = (path: string, before: string, after: string) => ({ path, status: 'modified', before: claimed.frozen(before), beforeSymlink: false, symlink: false, after: claimed.frozen(after) });
  const added = (path: string, after: string) => ({ path, status: 'created', before: null, beforeSymlink: false, symlink: false, after: claimed.frozen(after) });
  const fixRevision = (key: string, tag: string, id: string, subject: string, files: unknown[]) => claimed.add('tree.revised', { phase: 'fixes', source: { kind: 'fix', key, workerId: claimed.id(tag) }, change: { findings: [id], message: message(subject) }, files });
  const answer = (key: string, tag: string, answered: ReturnType<typeof finding>, violations: string[] = []) => claimed.add('fix.recorded', { phase: 'fixes', key, workerId: claimed.id(tag), findings: [answered], drift: [], tests: [], suite: { result: answered.status === 'blocked' ? 'not-run' : 'pass', command: answered.status === 'blocked' ? '' : decidedChecks.test, failures: '' }, violations });
  const plan = {
    routes: [{ id: 'SCAN-1', route: 'fixer' }, { id: 'RIPPLE-1', route: 'fixer' }, { id: 'SCAN-2', route: 'fixer' }, { id: 'RIPPLE-2', route: 'fixer' }],
    clusters: [{ id: 'c1', findingIds: ['SCAN-1', 'SCAN-2'], files: ['src/changed.ts'] }, { id: 'c2', findingIds: ['RIPPLE-1', 'RIPPLE-2'], files: ['src/caller.ts'] }],
    batches: [
      { key: 'c1-1', cluster: 'c1', findingIds: ['SCAN-1'] },
      { key: 'c2-1', cluster: 'c2', findingIds: ['RIPPLE-1'] },
      { key: 'c1-2', cluster: 'c1', findingIds: ['SCAN-2'] },
      { key: 'c2-2', cluster: 'c2', findingIds: ['RIPPLE-2'] },
    ],
  };
  claimed.phaseV5('fixes', () => {
    claimed.add('fixes.planned', plan);
    claimed.launch('650', 'fixer fixes:c1-1');
    claimed.launch('651', 'fixer fixes:c2-1');
    // c1-1 settles first: its claim of the shared test reaches the ledger with its answer.
    claimed.finishWorker('650');
    claimed.add('files.claimed', { phase: 'fixes', key: 'c1-1', cluster: 'c1', files: [{ path: 'test/shared.test.ts', claimedAt: '2026-10-09T01:00:05.000Z' }] });
    answer('c1-1', '650', finding('SCAN-1', 'applied', ['src/changed.ts', 'test/shared.test.ts'], 'fix: Guard the null in changed()'));
    fixRevision('c1-1', '650', 'SCAN-1', 'fix: Guard the null in changed()', [modified('src/changed.ts', 'after\n', 'after; // guarded\n'), modified('test/shared.test.ts', 'shared();\n', 'shared(null);\n')]);
    // c2-1's marker on c1's own file is one the fold would refuse, so it is recorded as lost; its claim of the test was refused, so it answers blocked on it with no edit.
    claimed.finishWorker('651');
    claimed.add('claims.lost', { phase: 'fixes', unit: 'c2-1', cluster: 'c2', files: [{ path: 'src/changed.ts', claimedAt: '2026-10-09T01:00:07.000Z', reason: 'owned', holder: 'c1' }] });
    answer('c2-1', '651', finding('RIPPLE-1', 'blocked', [], null, ['test/shared.test.ts']));
    // c1-2 edited docs/notes.md, which nobody held, without claiming it: a late claim, appended before its answer.
    claimed.launch('652', 'fixer fixes:c1-2');
    claimed.launch('653', 'fixer fixes:c2-2');
    claimed.finishWorker('652');
    claimed.add('files.claimed', { phase: 'fixes', key: 'c1-2', cluster: 'c1', files: [{ path: 'docs/notes.md', claimedAt: null }] });
    answer('c1-2', '652', finding('SCAN-2', 'applied', ['docs/notes.md', 'src/changed.ts'], 'fix: Check the guard in changed()'));
    fixRevision('c1-2', '652', 'SCAN-2', 'fix: Check the guard in changed()', [added('docs/notes.md', 'the guard is checked\n'), modified('src/changed.ts', 'after; // guarded\n', 'after; // guarded, checked\n')]);
    // The claims directory was removed while c2-2 ran: whatever it answered, its attempt failed for the environment, with its edits kept.
    claimed.finishWorker('653');
    claimed.add('attempt.failed', { phase: 'fixes', key: 'c2-2', workerId: claimed.id('653'), reason: 'the claims directory was removed while the unit ran', fault: 'environment' }, 5);
    claimed.add('tree.revised', { phase: 'fixes', source: { kind: 'attempt', key: 'c2-2', workerId: claimed.id('653') }, change: { findings: [], message: { subject: 'chore: keep the edits an unfinished attempt left', body: 'An attempt of batch c2-2 ended without an answer after its last snapshot.' } }, files: [modified('src/caller.ts', 'caller(null);\n', 'caller(null); // checked\n')] });
  }, { code: 'claims-lost', detail: 'the claims directory /fixture/scratch/claims/round-1 was removed while the run was editing', action: 'run the command again, which seeds the claims directory from the ledger and gives the units that ran without it fresh attempts, or abandon the run' });
  claimed.phaseV5('fixes', () => {
    claimed.launch('654', 'fixer fixes:c2-2');
    claimed.finishWorker('654');
    answer('c2-2', '654', finding('RIPPLE-2', 'already-applied', ['src/caller.ts'], 'fix: Log the checked value in the caller'));
    // RIPPLE-1 was blocked on the test c1 claimed, so the second round takes it into c3, which owns c2's file and that test.
    claimed.add('fixes.replanned', { blocked: [{ id: 'RIPPLE-1', requiredFiles: ['test/shared.test.ts'] }], clusters: [{ id: 'c3', findingIds: ['RIPPLE-1'], files: ['src/caller.ts', 'test/shared.test.ts'] }], batches: [{ key: 'c3-1', cluster: 'c3', findingIds: ['RIPPLE-1'] }] });
    claimed.launch('655', 'fixer fixes:c3-1');
    claimed.finishWorker('655');
    claimed.add('files.claimed', { phase: 'fixes', key: 'c3-1', cluster: 'c3', files: [{ path: 'docs/caller.md', claimedAt: '2026-10-09T01:20:00.000Z' }] });
    answer('c3-1', '655', finding('RIPPLE-1', 'applied', ['docs/caller.md', 'src/caller.ts', 'test/shared.test.ts'], 'fix: Stop passing the null in the caller'));
    fixRevision('c3-1', '655', 'RIPPLE-1', 'fix: Stop passing the null in the caller', [added('docs/caller.md', 'the caller passes no null\n'), modified('src/caller.ts', 'caller(null); // checked\n', 'caller(); // checked\n'), modified('test/shared.test.ts', 'shared(null);\n', 'shared(null);\nshared();\n')]);
  }, 'completed', { end: true });
  claimed.phaseV5('checks', () => {
    claimed.check('checks', 'build', decidedChecks.build, 'passed');
    claimed.check('checks', 'test', decidedChecks.test, 'passed');
  });
  claimed.phaseV5('repair', () => {});
  claimed.phaseV5('repair-checks', () => {});
  claimed.phaseV5('report', () => {
    const spend = (workers: number) => ({ workers, seconds: workers * 30, costUsd: workers * 0.5, costUnreported: 0, inputTokens: workers * 1000, cachedInputTokens: workers * 200, outputTokens: workers * 100 });
    const workersPerPhase: Record<Phase, number> = { survey: 1, triage: 1, finders: 9, deduplication: 1, verification: 1, sweep: 1, 'sweep-deduplication': 0, 'sweep-verification': 0, 'merge-rank': 1, decision: 1, 'baseline-checks': 0, fixes: 6, checks: 0, repair: 0, 'repair-checks': 0, report: 0 };
    claimed.add('report.written', {
      report: checkpoint.evidence.put('# Deep review report\n\nfixture report of a run with claims\n'),
      statistics: { phases: phases.map((phase) => ({ phase, ...spend(workersPerPhase[phase]), ...(phase === 'baseline-checks' || phase === 'checks' ? { seconds: 8 } : {}) })), total: spend(22), budgetApplied: true },
      patches: ['guard', 'check the guard', 'keep the attempt', 'stop passing the null'].map((name) => checkpoint.evidence.put(`From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001\nSubject: [PATCH] ${name}\n\n---\n`)),
    }, 4);
  });
  const evidence = checkpoint.evidence.put('fixture evidence\r\nwith two lines\n');
  const expected = { runs: checkpoint.foldRuns(), evidence: [evidence, scope.patch, finish.stdout, finish.stderr] };
  writeFileSync(join(output, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
  writeFileSync(join(output, 'identity.json'), `${JSON.stringify(checkpointIdentity(), null, 2)}\n`);
} finally {
  checkpoint.close();
}
const leftovers = readdirSync(output).filter((name) => name.startsWith(ledgerFileName) && name !== ledgerFileName);
if (leftovers.length > 0) throw new Error(`Closing the ledger left ${leftovers.join(', ')}; the fixture must be a single file`);
console.log(`wrote ${output}`);
