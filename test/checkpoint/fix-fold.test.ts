import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidHistoryError } from '../../src/checkpoint/errors.ts';
import { fixesRevisedPaths, lastRun, ownedFiles, repairTargets } from '../../src/checkpoint/fix-state.ts';
import { foldRun } from '../../src/checkpoint/fold.ts';
import { isAnswered } from '../../src/checkpoint/review-fold.ts';
import { fixPhases } from '../../src/review/vocabulary.ts';
import {
  baselined,
  checkRun,
  checksPhase,
  configured,
  endCheck,
  fixAnswer,
  fixed,
  fixPlan,
  fixRevision,
  History,
  launch,
  mergeRanked,
  plannedChecks,
  reference,
  reported,
  statistics,
  withFixPass,
  worker,
} from '../helpers/review-history.ts';

const commit = (fill: string): string => fill.repeat(40);
const launchOf = (workerId: string): Record<string, unknown> => launch(workerId, 'fixer fixes:c1');

describe('the fix fold', () => {
  it('starts a run configured with the fix pass with an empty fix state, its five phases pending, and its checks pinned', () => {
    const review = withFixPass(configured()).review();
    assert.equal(review.configuration.fix, true);
    assert.deepEqual(review.configuration.checks, { timeoutMs: 600_000 });
    for (const phase of fixPhases) assert.deepEqual(review.phases[phase], { status: 'pending', attempt: 0 });
    assert.deepEqual(review.fix?.checks.planned, plannedChecks);
    assert.equal(review.fix?.plan, null);
    assert.deepEqual(review.fix?.revisions, []);
  });

  it('folds a fix run: the baseline, the plan, an answer and its revision, the checks after it', () => {
    const history = checksPhase(fixed(), 'checks', { test: 'failed' });
    const review = history.review();
    const fix = review.fix!;
    assert.deepEqual(fix.plan, fixPlan);
    assert.equal(lastRun(fix, 'baseline-checks', 'test')?.outcome, 'passed');
    assert.equal(lastRun(fix, 'checks', 'test')?.outcome, 'failed');
    assert.equal(lastRun(fix, 'checks', 'typecheck'), null, 'a kind with no command never runs');
    assert.deepEqual(repairTargets(fix), ['test'], 'passed before the fixes, failed after');
    assert.equal(isAnswered(review, 'fixes', 'c1'), true);
    assert.deepEqual(fix.answers.fixes.c1, fixAnswer(worker(50)));
    assert.deepEqual(fix.revisions, [fixRevision(worker(50))]);
    assert.deepEqual(fixesRevisedPaths(fix), ['src/a.ts']);
    assert.deepEqual(ownedFiles(fix, 'fixes', 'c1'), ['src/a.ts']);
    assert.deepEqual(ownedFiles(fix, 'repair', 'repair'), ['src/a.ts'], 'the repair owns everything the fixes revised');
    assert.deepEqual(review.phases.checks, { status: 'completed', attempt: 1 });
  });

  it('never repairs a kind that failed before the fixes', () => {
    const fix = checksPhase(fixed({ lint: 'failed' }), 'checks', { lint: 'failed', test: 'timeout' }).review().fix!;
    assert.deepEqual(repairTargets(fix), ['test'], 'lint failed at baseline; test timed out after');
  });

  it('folds a repair, a failed cluster with the edits it left, and the commits built after the report', () => {
    const history = checksPhase(fixed(), 'checks', { test: 'failed' })
      .start('repair')
      .worker(60, 'fixer repair:repair')
      .add('attempt.failed', { phase: 'repair', key: 'repair', workerId: worker(60), reason: 'failed' }, 2)
      .add('attempt.failed', { phase: 'repair', key: 'repair', workerId: worker(61), reason: 'failed again' }, 2)
      .add('cluster.failed', { phase: 'repair', key: 'repair', reason: '2 attempts did not complete' })
      .add('tree.revised', { phase: 'repair', source: { kind: 'unanswered', key: 'repair' }, change: { findings: [], message: { subject: 'chore: keep the partial edits of the repair', body: 'b' } }, files: [{ path: 'src/a.ts', status: 'modified', before: { blob: reference('a') }, beforeSymlink: false, symlink: false, after: { blob: reference('9') } }] })
      .add('worktree.checked', endCheck('repair'), 2)
      .finish('repair', 'degraded');
    checksPhase(history, 'repair-checks', { test: 'failed' })
      .start('report')
      .add('report.written', { report: reference('e', 2048), statistics, patches: [reference('1'), reference('2')] }, 2)
      .finish('report')
      .add('commits.created', { commits: [{ sha: commit('a'), revision: 'change', subject: 'the change' }, { sha: commit('b'), revision: 0, subject: 'fix: Guard the null' }, { sha: commit('c'), revision: 1, subject: 'chore: keep the partial edits of the repair' }], from: '2'.repeat(40), to: commit('c') });
    const review = history.review();
    const fix = review.fix!;
    assert.equal(fix.notAttempted.repair.repair, '2 attempts did not complete');
    assert.equal(fix.revisions.length, 2);
    assert.deepEqual(review.report?.patches, [reference('1'), reference('2')]);
    assert.equal(fix.commits?.to, commit('c'));
    assert.equal(review.phases.repair.status, 'degraded');
  });

  const ranked = (): History => withFixPass(mergeRanked());
  const fixesRunning = (): History => baselined().start('fixes');
  const planned = (): History => fixesRunning().add('fixes.planned', fixPlan);
  const answered = (): History => planned().worker(50, 'fixer fixes:c1').add('fix.recorded', fixAnswer(worker(50)));
  const invalid: [name: string, build: () => History, message: RegExp][] = [
    ['checks planned on a run without the fix pass', () => configured().add('checks.planned', plannedChecks), /configured without the fix pass/],
    ['checks planned twice', () => ranked().add('checks.planned', plannedChecks), /plans its checks twice/],
    ['a fix plan on a run without the fix pass', () => mergeRanked().add('fixes.planned', fixPlan), /configured without the fix pass/],
    ['a fix plan before the fixes phase runs', () => baselined().add('fixes.planned', fixPlan), /while it is pending/],
    ['a second fix plan', () => planned().add('fixes.planned', fixPlan), /plans its fixes twice/],
    ['a plan that leaves a ranked finding unrouted', () => fixesRunning().add('fixes.planned', { routes: [fixPlan.routes[0]], clusters: fixPlan.clusters }), /not every ranked finding/],
    ['a plan that routes a finding twice', () => fixesRunning().add('fixes.planned', { routes: [...fixPlan.routes, fixPlan.routes[0]], clusters: fixPlan.clusters }), /not every ranked finding/],
    ['a plan that clusters a held finding', () => fixesRunning().add('fixes.planned', { routes: fixPlan.routes, clusters: [{ id: 'c1', findingIds: ['RIPPLE-1', 'SWEEP-1'], files: ['src/a.ts'] }] }), /clusters finding SWEEP-1, which is not routed to a fixer/],
    ['a plan that gives one file to two clusters', () => fixesRunning().add('fixes.planned', { routes: [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }], clusters: [{ id: 'c1', findingIds: ['RIPPLE-1'], files: ['src/a.ts'] }, { id: 'c2', findingIds: ['SWEEP-1'], files: ['src/a.ts'] }] }), /gives file src\/a\.ts to clusters c1 and c2/],
    ['a plan that leaves a fixer-routed finding out of every cluster', () => fixesRunning().add('fixes.planned', { routes: [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }], clusters: fixPlan.clusters }), /routes SWEEP-1 to a fixer but clusters none of them/],
    ['clusters numbered out of order', () => fixesRunning().add('fixes.planned', { routes: fixPlan.routes, clusters: [{ id: 'c2', findingIds: ['RIPPLE-1'], files: ['src/a.ts'] }] }), /numbers cluster 1 c2/],
    ['a check run for a phase that is not running', () => ranked().add('check.ran', checkRun('baseline-checks', 'build')), /while it is pending/],
    ['two runs of one kind in a phase', () => ranked().start('baseline-checks').add('check.ran', checkRun('baseline-checks', 'build')).add('check.ran', checkRun('baseline-checks', 'build')), /runs the build check twice in baseline-checks/],
    ['a run of a kind with no command', () => ranked().start('baseline-checks').add('check.ran', { ...checkRun('baseline-checks', 'typecheck'), command: 'tsc' }), /runs the typecheck check, which has no command/],
    ['a run of another command than the one pinned', () => ranked().start('baseline-checks').add('check.ran', { ...checkRun('baseline-checks', 'build'), command: 'make' }), /pinned as "npm run build"/],
    ['a passed check that did not exit 0', () => ranked().start('baseline-checks').add('check.ran', { ...checkRun('baseline-checks', 'build'), exitCode: 1 }), /passed check exited with code 0/],
    ['a skipped check with output', () => ranked().start('baseline-checks').add('check.ran', { ...checkRun('baseline-checks', 'lint', 'skipped'), stdout: reference('c') }), /skipped check alone has no termination and no output/],
    ['an answer for a cluster the plan does not have', () => planned().add('fix.recorded', fixAnswer(worker(50), { key: 'c9' })), /which the phase does not have/],
    ['an answer for the repair when no check needs one', () => fixed().start('checks').finish('checks').start('repair').add('fix.recorded', fixAnswer(worker(60), { phase: 'repair', key: 'repair' })), /which the phase does not have/],
    ['an answer that leaves a finding out', () => planned().add('fix.recorded', fixAnswer(worker(50), { findings: [] })), /answers \[\] for fixes:c1, which holds \[RIPPLE-1\]/],
    ['an answer recorded twice', () => answered().add('fix.recorded', fixAnswer(worker(51))), /already answered/],
    ['a violation on a file no other cluster owns', () => planned().add('fix.recorded', fixAnswer(worker(50), { violations: ['src/a.ts'] })), /records a violation on src\/a\.ts/],
    ['a revision for an answer never recorded', () => planned().add('tree.revised', fixRevision(worker(50))), /whose answer is not recorded/],
    ['a revision that names a finding its answer does not hold', () => answered().add('tree.revised', { ...fixRevision(worker(50)), change: { findings: ['SWEEP-1'], message: { subject: 's', body: '' } } }), /revises the tree for SWEEP-1, which fixes:c1 did not answer/],
    ['two revisions of one finding', () => answered().add('tree.revised', fixRevision(worker(50))).add('tree.revised', fixRevision(worker(50))), /revises the tree for RIPPLE-1 twice/],
    ['a revision with no files', () => answered().add('tree.revised', { ...fixRevision(worker(50)), files: [] }), /schema rejects/],
    ['a revision for a check that did not run', () => fixed().start('checks').add('tree.revised', { phase: 'checks', source: { kind: 'check', check: 'lint' }, change: { findings: [], message: { subject: 's', body: '' } }, files: [{ path: 'src/a.ts', status: 'modified', before: { blob: reference('a') }, beforeSymlink: false, symlink: false, after: { blob: reference('7') } }] }), /which did not run in checks/],
    ['the partial edits of a unit that did not fail', () => answered().add('tree.revised', { phase: 'fixes', source: { kind: 'unanswered', key: 'c1' }, change: { findings: [], message: { subject: 's', body: '' } }, files: [{ path: 'src/a.ts', status: 'modified', before: { blob: reference('a') }, beforeSymlink: false, symlink: false, after: { blob: reference('7') } }] }), /which did not fail twice/],
    ['a cluster failed after its answer', () => answered().add('cluster.failed', { phase: 'fixes', key: 'c1', reason: 'r' }), /already answered/],
    ['a cluster failed twice', () => planned().add('cluster.failed', { phase: 'fixes', key: 'c1', reason: 'r' }).add('cluster.failed', { phase: 'fixes', key: 'c1', reason: 'r' }), /fails fixes:c1 twice/],
    ['an answer after the cluster failed', () => planned().add('cluster.failed', { phase: 'fixes', key: 'c1', reason: 'r' }).add('fix.recorded', fixAnswer(worker(50))), /after it failed/],
    ['a report with a patch per revision missing', () => fixed().start('checks').finish('checks').start('repair').finish('repair').start('repair-checks').finish('repair-checks').start('report').add('report.written', { report: reference('e'), statistics, patches: [] }, 2), /writes 0 patches for 1 revisions/],
    ['commits before the report', () => fixed().add('commits.created', { commits: [{ sha: commit('a'), revision: 'change', subject: 's' }, { sha: commit('b'), revision: 0, subject: 's' }], from: '2'.repeat(40), to: commit('b') }), /before its report/],
    ['commits on a read-only run', () => reported().add('commits.created', { commits: [{ sha: commit('a'), revision: 0, subject: 's' }], from: '2'.repeat(40), to: commit('a') }), /configured without the fix pass/],
  ];
  for (const [name, build, message] of invalid) {
    it(`refuses ${name}`, () => {
      assert.throws(() => build().fold(), (error: unknown) => error instanceof InvalidHistoryError && message.test(error.message), name);
    });
  }

  it('refuses commits that skip a revision, start from another head, or end elsewhere', () => {
    const complete = (): History => checksPhase(fixed(), 'checks').start('repair').finish('repair').start('repair-checks').finish('repair-checks').start('report').add('report.written', { report: reference('e'), statistics, patches: [reference('1')] }, 2).finish('report');
    const change = { sha: commit('a'), revision: 'change', subject: 'the change' };
    const one = { sha: commit('b'), revision: 0, subject: 'fix: Guard the null' };
    assert.doesNotThrow(() => complete().add('commits.created', { commits: [change, one], from: '2'.repeat(40), to: commit('b') }).fold());
    for (const [payload, message] of [
      [{ commits: [one], from: '2'.repeat(40), to: commit('b') }, /not \[change, 0\]/],
      [{ commits: [change, one], from: '3'.repeat(40), to: commit('b') }, /not the scope's head/],
      [{ commits: [change, one], from: '2'.repeat(40), to: commit('a') }, /not its last/],
    ] as const) {
      assert.throws(() => complete().add('commits.created', payload).fold(), (error: unknown) => error instanceof InvalidHistoryError && message.test(error.message));
    }
    assert.throws(() => complete().add('commits.created', { commits: [change, one], from: '2'.repeat(40), to: commit('b') }).add('commits.created', { commits: [change, one], from: '2'.repeat(40), to: commit('b') }).fold(), /creates its commits twice/);
  });
});

describe('the versions of the events that carry a phase', () => {
  /** A history's events with each named kind recorded at version 2 instead, its payload written the way version 2 writes it. */
  const atVersion2 = (history: History): History => {
    const rewritten = new History();
    const seen = new Set<string>();
    for (const event of history.events) {
      const payload = event.payload as Record<string, unknown>;
      switch (event.kind) {
        case 'review.configured':
          rewritten.add(event.kind, { ...payload, fix: false, checks: null, fixes: null }, 2);
          break;
        case 'worktree.checked': {
          const key = `${String(payload.phase)}:${String(payload.attempt)}`;
          rewritten.add(event.kind, { ...payload, moment: seen.has(key) ? 'answer' : 'start', head: null, strays: [] }, 2);
          seen.add(key);
          break;
        }
        case 'report.written':
          rewritten.add(event.kind, { ...payload, patches: [] }, 2);
          break;
        case 'phase.started':
        case 'phase.finished':
        case 'attempt.failed':
        case 'worker.lost':
          rewritten.add(event.kind, payload, 2);
          break;
        default:
          rewritten.add(event.kind, payload, event.version);
      }
    }
    return rewritten;
  };

  it('fold the same history to one state whichever version recorded it', () => {
    const v1 = reported();
    const v2 = atVersion2(v1);
    assert.ok(v2.events.some((event) => event.version === 2));
    assert.deepEqual(foldRun(v2.events), foldRun(v1.events));
  });

  it('fold a lost worker and a failed attempt of a fix phase only at version 2', () => {
    const lost = { workerId: worker(70), phase: 'fixes', key: 'c1', reason: 'the engine exited while the worker ran' };
    const running = baselined().start('fixes').add('fixes.planned', fixPlan).add('worker.launched', { ...launchOf(worker(70)) });
    assert.throws(() => foldRun(running.add('worker.lost', lost).events), /schema rejects/);
    const review = baselined().start('fixes').add('fixes.planned', fixPlan).add('worker.launched', { ...launchOf(worker(70)) }).add('worker.lost', lost, 2).review();
    assert.deepEqual(review.units.fixes.c1?.failures, [{ workerId: worker(70), reason: lost.reason, lost: true }]);
  });
});
