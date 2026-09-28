// Synthetic review histories, built event by event, for the fold, planner,
// spend and report tests: a run created, scoped and configured, then taken
// through its phases one scenario at a time.
import assert from 'node:assert/strict';
import type { ReviewConfiguration, ScopeState } from '../../src/checkpoint/events.ts';
import { foldRun, type DecodedEvent, type RunState } from '../../src/checkpoint/fold.ts';
import type { ReviewState } from '../../src/checkpoint/review-fold.ts';
import { finderAngles, phases } from '../../src/review/vocabulary.ts';

export const reference = (fill: string, bytes = 1): { sha256: string; bytes: number } => ({ sha256: fill.repeat(64), bytes });
export const worker = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const scope: ScopeState = {
  mode: 'worktree',
  request: { paths: [] },
  base: '1'.repeat(40),
  head: '2'.repeat(40),
  files: [{ path: 'src/a.ts', status: 'modified', symlink: false, before: { blob: reference('a') }, after: { blob: reference('b') } }],
  patch: reference('c'),
};

export const configuration: ReviewConfiguration = {
  runtime: 'claude',
  executable: '/bin/claude',
  executableArgs: [],
  version: '2.1.283',
  models: { strong: 'opus', fast: 'sonnet' },
  roles: [{ role: 'triage', model: 'opus', effort: 'high', budgetUsd: 8, timeoutMs: 600_000 }],
  rolesDigest: 'd'.repeat(64),
  concurrency: 4,
  runBudgetUsd: 30,
};

export const launch = (workerId: string, label: string): Record<string, unknown> => ({
  workerId,
  label,
  runtime: 'claude',
  executable: '/bin/claude',
  executableArgs: [],
  version: '2.1.283',
  model: 'opus',
  effort: 'high',
  access: 'read-only',
  shell: true,
  sessionId: null,
  resumes: null,
  scratch: null,
  budgetUsd: null,
  timeoutMs: 60_000,
  prompt: reference('a'),
  schema: reference('b'),
});

/** A finish with a Claude usage of one input, one cached and one output token per `tokens`, costing `costUsd`. */
export const finish = (workerId: string, change: Record<string, unknown> = {}, costUsd = 0.5, tokens = 100): Record<string, unknown> => ({
  workerId,
  outcome: 'completed',
  exitCode: 0,
  signal: null,
  termination: 'exited',
  startedAt: '2026-09-27T00:00:00.000Z',
  endedAt: '2026-09-27T00:00:30.000Z',
  sessionIds: [],
  usage: JSON.stringify({ usage: { input_tokens: tokens, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, output_tokens: tokens }, modelUsage: null, total_cost_usd: costUsd }),
  denials: [],
  error: null,
  stdout: reference('c'),
  stderr: reference('d', 0),
  finalMessage: null,
  output: reference('e'),
  ...change,
});

export const candidate = (id: string, angle: string, change: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  angle,
  file: 'src/a.ts',
  line: 3,
  located: true,
  rawFile: 'src/a.ts',
  rawLine: 3,
  summary: `${id} summary`,
  detail: `${id} detail`,
  ...change,
});
export const unlocated = (id: string, angle: string): Record<string, unknown> => candidate(id, angle, { file: null, line: null, located: false, rawFile: 'C:\\elsewhere\\b.ts', rawLine: 9 });

export const leads = finderAngles.map((angle) => ({ angle, lead: angle === 'RIPPLE' ? 'the callers of parse()' : null }));

/** A history builder that numbers events as it goes, so a scenario reads as its event list. */
export class History {
  readonly events: DecodedEvent[] = [];
  add(kind: string, payload: unknown): this {
    const sequence = this.events.length + 1;
    this.events.push({ sequence, runId: 'run-1', kind, version: 1, payload, recordedAt: `2026-09-27T00:00:${String(sequence % 60).padStart(2, '0')}.000Z`, engine: '0.0.0' });
    return this;
  }
  /** Start a phase at the given attempt and record a clean worktree check for it. */
  start(phase: string, attempt = 1): this {
    return this.add('phase.started', { phase, attempt }).add('worktree.checked', { phase, attempt, drifted: false, files: [] });
  }
  finish(phase: string, outcome = 'completed', attempt = 1, blocker: unknown = null): this {
    return this.add('phase.finished', { phase, attempt, outcome, blocker });
  }
  /** Launch and finish one worker under a review label, so spend and lost-worker tests have a worker to count. */
  worker(n: number, label: string, change: Record<string, unknown> = {}, costUsd = 0.5, tokens = 100): this {
    return this.add('worker.launched', launch(worker(n), label)).add('worker.finished', finish(worker(n), change, costUsd, tokens));
  }
  fold(): RunState {
    return foldRun(this.events);
  }
  review(): ReviewState {
    const review = this.fold().review;
    assert.ok(review !== null, 'the run is configured for review');
    return review;
  }
}

/** A run created, scoped and configured, before any phase. */
export const configured = (): History => new History().add('run.created', { worktree: '/w' }).add('scope.captured', scope).add('review.configured', configuration);

/** The run through its triage, with one SCAN candidate and the leads. */
export const triaged = (): History =>
  configured()
    .start('triage')
    .worker(1, 'triage triage:SCAN')
    .add('candidates.recorded', { phase: 'triage', key: 'SCAN', workerId: worker(1), candidates: [candidate('SCAN-1', 'SCAN')], leads })
    .finish('triage');

/**
 * The run in its finders phase: RIPPLE finds one, FOOTGUNS fails twice
 * (an answer the schema refuses, then a timeout) and is not run, WRAPPERS
 * loses its first worker with the engine and then answers, and every other
 * angle answers with nothing.
 */
export const finding = (): History => {
  const history = triaged().start('finders');
  history.worker(2, 'finder-RIPPLE finders:RIPPLE');
  history.add('candidates.recorded', { phase: 'finders', key: 'RIPPLE', workerId: worker(2), candidates: [candidate('RIPPLE-1', 'RIPPLE', { line: 4, rawLine: 4 })], leads: null });
  history.worker(3, 'finder-FOOTGUNS finders:FOOTGUNS', { outcome: 'failed', output: null, error: 'The answer does not match the output schema' });
  history.add('attempt.failed', { phase: 'finders', key: 'FOOTGUNS', workerId: worker(3), reason: 'failed: The answer does not match the output schema' });
  history.worker(4, 'finder-FOOTGUNS finders:FOOTGUNS', { outcome: 'timeout', termination: 'killed', exitCode: null, signal: 'SIGKILL', output: null, usage: null, error: 'The worker ran past its timeout' });
  history.add('attempt.failed', { phase: 'finders', key: 'FOOTGUNS', workerId: worker(4), reason: 'timeout: The worker ran past its timeout' });
  history.add('angle.failed', { angle: 'FOOTGUNS', reason: '2 attempts did not complete: failed: The answer does not match the output schema; timeout: The worker ran past its timeout' });
  history.add('worker.launched', launch(worker(5), 'finder-WRAPPERS finders:WRAPPERS'));
  history.add('worker.lost', { workerId: worker(5), phase: 'finders', key: 'WRAPPERS', reason: 'the engine exited while the worker ran' });
  for (const angle of finderAngles.filter((name) => name !== 'RIPPLE' && name !== 'FOOTGUNS')) {
    history.worker(10 + finderAngles.indexOf(angle), `finder-${angle} finders:${angle}`);
    history.add('candidates.recorded', { phase: 'finders', key: angle, workerId: worker(10 + finderAngles.indexOf(angle)), candidates: [], leads: null });
  }
  return history;
};
export const found = (): History => finding().finish('finders', 'degraded');

/** The run through deduplication and verification of the first pool. */
export const verified = (): History =>
  found()
    .start('deduplication')
    .worker(20, 'deduplication deduplication:deduplication')
    .add('deduplication.recorded', { phase: 'deduplication', workerId: worker(20), groups: [{ members: ['SCAN-1', 'RIPPLE-1'], keep: 'RIPPLE-1', reason: 'one defect at one line' }] })
    .finish('deduplication')
    .start('verification')
    .add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['RIPPLE-1'] }] })
    .worker(21, 'verifier verification:g1')
    .add('verdicts.recorded', { phase: 'verification', groupId: 'g1', workerId: worker(21), verdicts: [{ id: 'RIPPLE-1', verdict: 'CONFIRMED', evidence: 'line 4 dereferences null' }] })
    .finish('verification');

/** The run through the sweep, its deduplication (no groups) and its verification, whose one group goes unverified. */
export const swept = (): History =>
  verified()
    .start('sweep')
    .worker(30, 'sweep sweep:sweep')
    .add('candidates.recorded', { phase: 'sweep', key: 'sweep', workerId: worker(30), candidates: [unlocated('SWEEP-1', 'DESIGN'), candidate('SWEEP-2', 'SCAN', { line: 7, rawLine: 7 })], leads: null })
    .finish('sweep')
    .start('sweep-deduplication')
    .worker(31, 'deduplication sweep-deduplication:sweep-deduplication')
    .add('deduplication.recorded', { phase: 'sweep-deduplication', workerId: worker(31), groups: [] })
    .finish('sweep-deduplication')
    .start('sweep-verification')
    .add('verification.planned', { phase: 'sweep-verification', groups: [{ id: 'g1', candidateIds: ['SWEEP-1', 'SWEEP-2'] }] })
    .add('attempt.failed', { phase: 'sweep-verification', key: 'g1', workerId: worker(32), reason: 'failed' })
    .add('attempt.failed', { phase: 'sweep-verification', key: 'g1', workerId: worker(33), reason: 'failed again' })
    .add('group.unverified', { phase: 'sweep-verification', groupId: 'g1', reason: '2 attempts did not complete: failed; failed again' })
    .finish('sweep-verification', 'degraded');

export const ranking = [
  { id: 'RIPPLE-1', members: ['SWEEP-2'], severity: 'major', summary: 'null dereference', reason: 'same root cause at lines 4 and 7' },
  { id: 'SWEEP-1', members: [], severity: 'minor', summary: 'extract the helper', reason: 'one improvement' },
];
export const statistics = {
  phases: phases.map((phase) => ({ phase, workers: 1, seconds: 2.5, costUsd: 0.5, costUnreported: phase === 'finders' ? 1 : 0, inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 })),
  total: { workers: 9, seconds: 22.5, costUsd: 4.5, costUnreported: 1, inputTokens: 900, cachedInputTokens: 180, outputTokens: 90 },
  budgetApplied: true,
};

/** The run through merge and rank, its report phase started and checked but not yet written. */
export const ranked = (): History =>
  swept()
    .start('merge-rank')
    .worker(40, 'merge-rank merge-rank:merge-rank')
    .add('ranking.recorded', { workerId: worker(40), findings: ranking })
    .finish('merge-rank')
    .start('report');

/** The whole run, report written. */
export const reported = (): History => ranked().add('report.written', { report: reference('e', 2048), statistics }).finish('report');
