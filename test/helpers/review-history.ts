// Synthetic review histories, built event by event, for the fold, planner,
// spend and report tests: a run created, scoped and configured, then taken
// through its phases one scenario at a time.
import assert from 'node:assert/strict';
import { reviewVocabularyV1, type ReviewConfiguration, type ReviewConfigurationV1, type ScopeState } from '../../src/checkpoint/events.ts';
import { foldRun, type DecodedEvent, type RunState } from '../../src/checkpoint/fold.ts';
import type { ReviewState } from '../../src/checkpoint/review-fold.ts';
import { finderAngles, fixPhases } from '../../src/review/vocabulary.ts';

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

/** The configuration as version 1 records it, before the fix pass existed; the histories here record it so. */
export const configurationV1: ReviewConfigurationV1 = {
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

/** The configuration as the fold holds it: version 1's, read as a run without the fix pass that applied the reviewer's own rules, and was not surveyed. */
export const configuration: ReviewConfiguration = { ...configurationV1, fix: false, checks: null, fixes: null, survey: { userRules: 'apply' } };

/** A launch under a review label, capped at the 8 USD per-worker budget the configuration's roles pin, as Claude Code's launches are. */
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
  budgetUsd: 8,
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
  inScope: true,
  rawFile: 'src/a.ts',
  rawLine: 3,
  summary: `${id} summary`,
  detail: `${id} detail`,
  ...change,
});
export const unlocated = (id: string, angle: string): Record<string, unknown> => candidate(id, angle, { file: null, line: null, located: false, inScope: false, rawFile: 'C:\\elsewhere\\b.ts', rawLine: 9 });

export const leads = finderAngles.map((angle) => ({ angle, lead: angle === 'RIPPLE' ? 'the callers of parse()' : null }));

/** The lowest version of the events that carry a phase that can name it: 3 for the survey, 2 for a phase of the fix pass, 1 for the rest. */
const phaseVersion = (phase: string): 1 | 2 | 3 => (phase === 'survey' ? 3 : (fixPhases as readonly string[]).includes(phase) ? 2 : 1);

/** A history builder that numbers events as it goes, so a scenario reads as its event list. */
export class History {
  readonly events: DecodedEvent[] = [];
  /** Add an event, at version 1 unless another is given. */
  add(kind: string, payload: unknown, version = 1): this {
    const sequence = this.events.length + 1;
    this.events.push({ sequence, runId: 'run-1', kind, version, payload, recordedAt: `2026-09-27T00:00:${String(sequence % 60).padStart(2, '0')}.000Z`, engine: '0.0.0' });
    return this;
  }
  /**
   * Start a phase at the given attempt and record a clean worktree check
   * for it: at version 1 for a read-only phase, as the histories here were
   * recorded, version 2 for a phase of the fix pass, and version 3 for the
   * survey, which only version 3 can name.
   */
  start(phase: string, attempt = 1): this {
    const version = phaseVersion(phase);
    if (version === 1) return this.add('phase.started', { phase, attempt }).add('worktree.checked', { phase, attempt, drifted: false, files: [] });
    return this.add('phase.started', { phase, attempt }, version).add('worktree.checked', { phase, attempt, moment: 'start', drifted: false, head: null, files: [], strays: [] }, version);
  }
  finish(phase: string, outcome = 'completed', attempt = 1, blocker: unknown = null): this {
    return this.add('phase.finished', { phase, attempt, outcome, blocker }, phaseVersion(phase));
  }
  /** Launch and finish one worker under a review label, so spend and lost-worker tests have a worker to count. */
  worker(n: number, label: string, change: Record<string, unknown> = {}, costUsd = 0.5, tokens = 100): this {
    return this.add('worker.launched', launch(worker(n), label)).add('worker.finished', finish(worker(n), change, costUsd, tokens));
  }
  /** Another history with the same events, to go on from without changing this one. */
  clone(): History {
    const copy = new History();
    copy.events.push(...this.events);
    return copy;
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
export const configured = (): History => new History().add('run.created', { worktree: '/w' }).add('scope.captured', scope).add('review.configured', configurationV1);

/** The configuration as version 3 records it: a read-only run that is surveyed, its policy judging the reviewer's own rules. */
export const configurationV3: ReviewConfiguration = { ...configuration, survey: { userRules: 'judge' } };

/** A run configured at version 3, so its survey runs first: read-only unless `change` says otherwise. */
export const surveyConfigured = (change: Partial<ReviewConfiguration> = {}): History =>
  new History().add('run.created', { worktree: '/w' }).add('scope.captured', scope).add('review.configured', { ...configurationV3, ...change }, 3);

/** The same, with the fix pass and its batch size of four. */
export const surveyConfiguredFix = (change: Partial<ReviewConfiguration> = {}): History => surveyConfigured({ fix: true, checks: { timeoutMs: 600_000 }, fixes: { batchSize: 4 }, ...change });

/** A surveyed answer: no convention source and no user-level file unless given, and the checks given, null in a read-only run. */
export const surveyAnswer = (workerId: string, change: Record<string, unknown> = {}): Record<string, unknown> => ({ workerId, conventions: [], userRules: [], checks: null, note: '', ...change });

/** A surveyed check of one kind: its command from a workflow, stated, with the tool given missing; or none, with a reason. */
export const surveyedCheck = (kind: string, command: string | null, missingTool: string | null = null): Record<string, unknown> =>
  command === null
    ? { kind, command: null, basis: null, source: null, missingTool: null, reason: `no ${kind} step` }
    : { kind, command, basis: 'stated', source: { path: '.github/workflows/ci.yml', quote: `run: ${command}` }, missingTool, reason: null };

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
  phases: reviewVocabularyV1.phases.map((phase) => ({ phase, workers: 1, seconds: 2.5, costUsd: 0.5, costUnreported: phase === 'finders' ? 1 : 0, inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 })),
  total: { workers: 9, seconds: 22.5, costUsd: 4.5, costUnreported: 1, inputTokens: 900, cachedInputTokens: 180, outputTokens: 90 },
  budgetApplied: true,
};

/** The run through merge and rank, before its report phase. */
export const mergeRanked = (): History =>
  swept()
    .start('merge-rank')
    .worker(40, 'merge-rank merge-rank:merge-rank')
    .add('ranking.recorded', { workerId: worker(40), findings: ranking })
    .finish('merge-rank');

/** The run through merge and rank, its report phase started and checked but not yet written. */
export const ranked = (): History => mergeRanked().start('report');

/** The whole run, report written. */
export const reported = (): History => ranked().add('report.written', { report: reference('e', 2048), statistics }).finish('report');

/** The checks a fix run pins in these histories: a package script for build, lint and test, and no typecheck. */
export const plannedChecks = {
  checks: [
    { kind: 'build', command: 'npm run build', origin: 'package', reason: null },
    { kind: 'typecheck', command: null, origin: 'none', reason: 'nothing names it' },
    { kind: 'lint', command: 'npm run lint', origin: 'package', reason: null },
    { kind: 'test', command: 'npm run test', origin: 'package', reason: null },
  ],
  manager: 'npm',
};

/** The same history, configured with the fix pass: its configuration recorded at version 2 with `fix` and the batch size, the checks pinned beside it. */
export function withFixPass(history: History, batchSize = 4): History {
  const fixed = new History();
  for (const event of history.events) {
    if (event.kind !== 'review.configured') {
      fixed.add(event.kind, event.payload, event.version);
      continue;
    }
    fixed.add('review.configured', { ...(event.payload as object), fix: true, checks: { timeoutMs: 600_000 }, fixes: { batchSize } }, 2);
    fixed.add('checks.planned', plannedChecks);
  }
  return fixed;
}

/** A run configured with the fix pass at version 2, before the survey existed, with no plan of checks recorded yet. */
export const configuredFixBeforeSurvey = (batchSize = 4): History =>
  new History().add('run.created', { worktree: '/w' }).add('scope.captured', scope).add('review.configured', { ...configurationV1, fix: true, checks: { timeoutMs: 600_000 }, fixes: { batchSize } }, 2);

/** A check's run as `check.ran` records it: passed, failed, timed out, not started, or skipped because build did not pass. */
export function checkRun(phase: string, kind: string, outcome = 'passed', attempt = 1): Record<string, unknown> {
  const command = plannedChecks.checks.find((check) => check.kind === kind)?.command ?? 'none';
  const at = { startedAt: '2026-09-27T01:00:00.000Z', endedAt: '2026-09-27T01:00:04.000Z' };
  if (outcome === 'skipped') return { phase, attempt, kind, command, outcome, exitCode: null, signal: null, termination: null, ...at, stdout: null, stderr: null, error: 'build failed' };
  return {
    phase, attempt, kind, command, outcome,
    exitCode: outcome === 'passed' ? 0 : outcome === 'failed' ? 1 : null,
    signal: outcome === 'timeout' ? 'SIGKILL' : null,
    termination: outcome === 'timeout' ? 'killed' : outcome === 'not-started' ? 'not-started' : 'exited',
    ...at,
    stdout: reference('c'),
    stderr: reference('d', 0),
    error: outcome === 'not-started' ? 'spawn ENOENT' : null,
  };
}

/** A checks phase whose available kinds ran with the outcomes given, passed otherwise. */
export function checksPhase(history: History, phase: string, outcomes: Readonly<Record<string, string>> = {}): History {
  history.start(phase);
  for (const kind of ['build', 'lint', 'test']) history.add('check.ran', checkRun(phase, kind, outcomes[kind] ?? 'passed'));
  return history.finish(phase);
}

/** The fix plan of these histories: RIPPLE-1, CONFIRMED with SWEEP-2 merged in, to a fixer that owns src/a.ts, in one batch; SWEEP-1, a PLAUSIBLE design finding, held. */
export const fixPlan = {
  routes: [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'held' }],
  clusters: [{ id: 'c1', findingIds: ['RIPPLE-1'], files: ['src/a.ts'] }],
  batches: [{ key: 'c1-1', cluster: 'c1', findingIds: ['RIPPLE-1'] }],
};

/** The second round of these histories: none, since no finding was blocked. */
export const noSecondRound = { blocked: [], clusters: [], batches: [] };

/** The answer c1-1's fixer recorded, applying RIPPLE-1. */
export const fixAnswer = (workerId: string, change: Record<string, unknown> = {}): Record<string, unknown> => ({
  phase: 'fixes', key: 'c1-1', workerId,
  findings: [{ id: 'RIPPLE-1', status: 'applied', file: 'src/a.ts', line: 4, note: 'guarded the null', message: { subject: 'fix: Guard the null', body: 'Why.' }, files: ['src/a.ts'], corrections: [], validation: [], requiredFiles: [] }],
  drift: [], tests: [], suite: { result: 'pass', command: 'npm test', failures: '' }, violations: [],
  ...change,
});

/** The revision c1-1's answer made of src/a.ts. */
export const fixRevision = (workerId: string, after = reference('f')): Record<string, unknown> => ({
  phase: 'fixes',
  source: { kind: 'fix', key: 'c1-1', workerId },
  change: { findings: ['RIPPLE-1'], message: { subject: 'fix: Guard the null', body: 'Why.' } },
  files: [{ path: 'src/a.ts', status: 'modified', before: { blob: reference('a') }, beforeSymlink: false, symlink: false, after: { blob: after } }],
});

/** A clean check at an editing phase's end. */
export const endCheck = (phase: string, attempt = 1): Record<string, unknown> => ({ phase, attempt, moment: 'end', drifted: false, head: null, files: [], strays: [] });

/** A fix run through its baseline checks, each passing unless `outcomes` says otherwise. */
export const baselined = (outcomes: Readonly<Record<string, string>> = {}): History => checksPhase(withFixPass(mergeRanked()), 'baseline-checks', outcomes);

/** A fix run through its fixes: c1-1 answered and revised src/a.ts, no second round, and the end check was clean. */
export const fixed = (baseline: Readonly<Record<string, string>> = {}): History =>
  baselined(baseline)
    .start('fixes')
    .add('fixes.planned', fixPlan)
    .worker(50, 'fixer fixes:c1-1')
    .add('fix.recorded', fixAnswer(worker(50)))
    .add('tree.revised', fixRevision(worker(50)))
    .add('fixes.replanned', noSecondRound)
    .add('worktree.checked', endCheck('fixes'), 2)
    .finish('fixes');

/**
 * A whole fix run up to its report: the lint check rewrites the changed
 * file at baseline and test fails there; c1 applies RIPPLE-1 with a
 * correction, a validation, a drift line and a test, and leaves a stray;
 * lint fails after the fixes, the repair makes it pass and finds every
 * failure of test there before the fixes, and test still fails; SWEEP-1
 * is held for the author.
 */
export function fixRun(): History {
  return withFixPass(mergeRanked())
    .start('baseline-checks')
    .add('check.ran', checkRun('baseline-checks', 'build'))
    .add('check.ran', checkRun('baseline-checks', 'lint'))
    .add('tree.revised', { phase: 'baseline-checks', source: { kind: 'check', check: 'lint' }, change: { findings: [], message: { subject: 'chore: apply the lint check\'s rewrite', body: 'b' } }, files: [{ path: 'src/a.ts', status: 'modified', before: { blob: reference('a') }, beforeSymlink: false, symlink: false, after: { blob: reference('5') } }] })
    .add('check.ran', checkRun('baseline-checks', 'test', 'failed'))
    .finish('baseline-checks')
    .start('fixes')
    .add('fixes.planned', fixPlan)
    .worker(50, 'fixer fixes:c1-1')
    .add('fix.recorded', fixAnswer(worker(50), {
      findings: [{
        id: 'RIPPLE-1', status: 'applied', file: 'src/a.ts', line: 4, note: 'guarded the null before its use', message: { subject: 'fix: Guard the null in parse', body: 'Why.' },
        files: ['src/a.ts', 'test/a.test.ts'],
        corrections: [{ file: 'src/a.ts', anchor: 'parse', claim: 'parse is at line 4', fact: 'it moved to line 6', evidence: 'git blame' }],
        validation: [{ method: 'old-code', source: 'test/a.test.ts', evidence: 'failed on the old code for the null, passed on the fix' }],
        requiredFiles: [],
      }],
      drift: [{ file: 'README.md', what: 'parse no longer throws on null' }],
      tests: [{ file: 'test/a.test.ts', covers: 'parse(null) returns 0' }],
    }))
    .add('tree.revised', { ...fixRevision(worker(50)), change: { findings: ['RIPPLE-1'], message: { subject: 'fix: Guard the null in parse', body: 'Why.' } }, files: [
      { path: 'src/a.ts', status: 'modified', before: { blob: reference('a') }, beforeSymlink: false, symlink: false, after: { blob: reference('f') } },
      { path: 'test/a.test.ts', status: 'created', before: null, beforeSymlink: false, symlink: false, after: { blob: reference('7') } },
    ] })
    .add('worktree.checked', { ...endCheck('fixes'), strays: ['notes.txt'] }, 2)
    .finish('fixes')
    .start('checks')
    .add('check.ran', checkRun('checks', 'build'))
    .add('check.ran', checkRun('checks', 'lint', 'failed'))
    .add('check.ran', checkRun('checks', 'test', 'failed'))
    .finish('checks')
    .start('repair')
    .worker(60, 'fixer repair:repair')
    .add('fix.recorded', { ...fixAnswer(worker(60)), phase: 'repair', key: 'repair', findings: [{ id: 'lint', status: 'applied', file: 'src/a.ts', line: 4, note: 'formatted the guard', message: { subject: 'style: Format the guard', body: 'Why.' }, files: ['src/a.ts'], corrections: [], validation: [], requiredFiles: [] }, { id: 'test', status: 'deferred', file: 'test/a.test.ts', line: null, note: 'every failure was there before the fixes', message: null, files: [], corrections: [], validation: [], requiredFiles: [] }] })
    .add('tree.revised', { phase: 'repair', source: { kind: 'fix', key: 'repair', workerId: worker(60) }, change: { findings: ['lint'], message: { subject: 'style: Format the guard', body: 'Why.' } }, files: [{ path: 'src/a.ts', status: 'modified', before: { blob: reference('a') }, beforeSymlink: false, symlink: false, after: { blob: reference('8') } }] })
    .add('worktree.checked', endCheck('repair'), 2)
    .finish('repair')
    .start('repair-checks')
    .add('check.ran', checkRun('repair-checks', 'build'))
    .add('check.ran', checkRun('repair-checks', 'lint'))
    .add('check.ran', checkRun('repair-checks', 'test', 'failed'))
    .finish('repair-checks')
    .start('report');
}

export const fixStatistics = {
  ...statistics,
  phases: [
    ...statistics.phases.filter((row) => row.phase !== 'report'),
    ...(['baseline-checks', 'fixes', 'checks', 'repair', 'repair-checks', 'report'] as const).map((phase) => ({ phase, workers: ['fixes', 'repair'].includes(phase) ? 1 : 0, seconds: 8, costUsd: null, costUnreported: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null })),
  ],
};

/**
 * The same history surveyed first: configured at version 3 under
 * `userRules`, with the fix pass when the history has it, and the survey
 * phase's events, which `survey` adds, before its first phase. A version 1
 * plan of checks is left out, since a surveyed run plans its checks in its
 * survey.
 */
export function withSurvey(history: History, survey: (history: History) => History, userRules: 'ignore' | 'apply' | 'judge' = 'judge'): History {
  const surveyed = new History();
  for (const event of history.events) {
    if (event.kind === 'checks.planned' && event.version === 1) continue;
    if (event.kind !== 'review.configured') {
      surveyed.add(event.kind, event.payload, event.version);
      continue;
    }
    surveyed.add('review.configured', { fix: false, checks: null, fixes: null, ...(event.payload as object), survey: { userRules } }, 3);
    survey(surveyed);
  }
  return surveyed;
}
