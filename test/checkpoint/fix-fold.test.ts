import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidHistoryError } from '../../src/checkpoint/errors.ts';
import { clusterClaims, failedAtBaseline, fixesRevisedPaths, heldByOthers, holdersOf, lastAnswerOf, lastRun, ownedFiles, repairTargets, revisionMessageOf, settledClusters } from '../../src/checkpoint/fix-state.ts';
import { foldRun } from '../../src/checkpoint/fold.ts';
import { isAnswered } from '../../src/checkpoint/review-fold.ts';
import { fixPlanOf, secondRoundOf } from '../../src/review/steps.ts';
import { fixPhases } from '../../src/review/vocabulary.ts';
import {
  askDecision,
  baselined,
  checkRun,
  checksPhase,
  claimed,
  configured,
  decidedOf,
  decisions,
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
const launchOf = (workerId: string): Record<string, unknown> => launch(workerId, 'fixer fixes:c1-1');

describe('the fix fold', () => {
  it('starts a run configured with the fix pass with an empty fix state, its five phases pending, and its checks pinned', () => {
    const review = withFixPass(configured()).review();
    assert.equal(review.configuration.fix, true);
    assert.deepEqual(review.configuration.checks, { timeoutMs: 600_000 });
    for (const phase of fixPhases) assert.deepEqual(review.phases[phase], { status: 'pending', attempt: 0 });
    // A version 1 plan names no source; the fold gives each of its checks a null one, as a version 2 plan's flag does.
    assert.deepEqual(review.fix?.checks.planned, { ...plannedChecks, checks: plannedChecks.checks.map((check) => ({ ...check, source: null })) });
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
    assert.equal(isAnswered(review, 'fixes', 'c1-1'), true);
    assert.deepEqual(fix.answers.fixes['c1-1'], fixAnswer(worker(50)));
    assert.deepEqual(fix.revisions, [fixRevision(worker(50))]);
    assert.deepEqual(fixesRevisedPaths(fix), ['src/a.ts']);
    assert.deepEqual(ownedFiles(fix, 'fixes', 'c1-1'), ['src/a.ts']);
    assert.deepEqual(ownedFiles(fix, 'repair', 'repair'), ['src/a.ts'], 'the repair owns everything the fixes revised');
    assert.deepEqual(review.phases.checks, { status: 'completed', attempt: 1 });
  });

  it('repairs a kind the fixes broke, and one that failed before them and still fails, for the failures its output then did not show (R24)', () => {
    const fix = checksPhase(fixed({ lint: 'failed' }), 'checks', { lint: 'failed', test: 'timeout' }).review().fix!;
    assert.deepEqual(repairTargets(fix), ['lint', 'test'], 'lint failed at baseline and after; test timed out after');
    assert.equal(failedAtBaseline(fix, 'lint'), true);
    assert.equal(failedAtBaseline(fix, 'test'), false);
  });

  it('never repairs a kind that failed before the fixes and passes after, nor one that did not start at baseline', () => {
    assert.deepEqual(repairTargets(checksPhase(fixed({ lint: 'failed' }), 'checks').review().fix!), [], 'lint failed at baseline and passes after');
    const missing = checksPhase(fixed({ build: 'not-started' }), 'checks', { build: 'not-started', lint: 'skipped', test: 'skipped' }).review().fix!;
    assert.deepEqual(repairTargets(missing), [], 'a tool missing at baseline is the environment');
    assert.equal(failedAtBaseline(missing, 'build'), false);
  });

  it('folds a repair, a failed cluster with the edits it left, and the commits built after the report', () => {
    const history = checksPhase(fixed(), 'checks', { test: 'failed' })
      .start('repair')
      .worker(60, 'fixer repair:repair')
      .add('attempt.failed', { phase: 'repair', key: 'repair', workerId: worker(60), reason: 'failed' }, 2)
      // What the first attempt left is recorded with its failure (R20 of the fix pass).
      .add('tree.revised', { phase: 'repair', source: { kind: 'attempt', key: 'repair', workerId: worker(60) }, change: { findings: [], message: { subject: 'chore: keep the partial edits of the repair', body: 'b' } }, files: [{ path: 'src/a.ts', status: 'modified', before: { blob: reference('a') }, beforeSymlink: false, symlink: false, after: { blob: reference('9') } }] })
      .add('attempt.failed', { phase: 'repair', key: 'repair', workerId: worker(61), reason: 'failed again' }, 2)
      .add('unit.unattempted', { phase: 'repair', key: 'repair', cause: 'failures', reason: '2 attempts did not complete' })
      .add('worktree.checked', endCheck('repair'), 2)
      .finish('repair', 'degraded');
    checksPhase(history, 'repair-checks', { test: 'failed' })
      .start('report')
      .add('report.written', { report: reference('e', 2048), statistics, patches: [reference('1'), reference('2')] }, 2)
      .finish('report')
      .add('commits.created', { commits: [{ sha: commit('a'), revision: 'change', subject: 'the change' }, { sha: commit('b'), revision: 0, subject: 'fix: Guard the null' }, { sha: commit('c'), revision: 1, subject: 'chore: keep the partial edits of the repair' }], from: '2'.repeat(40), to: commit('c') });
    const review = history.review();
    const fix = review.fix!;
    assert.deepEqual(fix.notAttempted.repair.repair, { cause: 'failures', reason: '2 attempts did not complete' });
    assert.equal(fix.revisions.length, 2);
    assert.deepEqual(review.report?.patches, [reference('1'), reference('2')]);
    assert.equal(fix.commits?.to, commit('c'));
    assert.equal(review.phases.repair.status, 'degraded');
  });

  it('folds an unfinished attempt\'s edits with its failure, and commits them with the message the retry gives on verifying them (R20)', () => {
    const verified = (message: Record<string, unknown> | null): History => failedOnce()
      .add('tree.revised', attemptRevision(worker(51), ['RIPPLE-1']))
      .worker(52, 'fixer fixes:c1-1')
      .add('fix.recorded', fixAnswer(worker(52), { findings: [{ id: 'RIPPLE-1', status: 'already-applied', file: 'src/a.ts', line: 4, note: 'the guard the first attempt added holds', message, files: ['src/a.ts'], corrections: [], validation: [], requiredFiles: [] }] }));
    const fix = verified({ subject: 'fix: Guard the null', body: 'Why.' }).review().fix!;
    assert.equal(fix.revisions.length, 1);
    assert.deepEqual(fix.revisions[0]!.source, { kind: 'attempt', key: 'c1-1', workerId: worker(51) });
    assert.deepEqual(revisionMessageOf(fix, fix.revisions[0]!), { subject: 'fix: Guard the null', body: 'Why.' }, 'the retry\'s message');
    const unverified = verified(null).review().fix!;
    assert.deepEqual(revisionMessageOf(unverified, unverified.revisions[0]!), { subject: 's', body: '' }, 'the attempt\'s own message when the retry gave none');
    assert.deepEqual(ownedFiles(fix, 'fixes', 'c1-1'), ['src/a.ts']);
  });

  // Both ranked findings to fixers, one cluster each: c1-1 answers RIPPLE-1 blocked on c2's src/b.ts, c2-1 applies SWEEP-1.
  const twoClusterPlan = {
    routes: [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }],
    clusters: [{ id: 'c1', findingIds: ['RIPPLE-1'], files: ['src/a.ts'] }, { id: 'c2', findingIds: ['SWEEP-1'], files: ['src/b.ts'] }],
    batches: [{ key: 'c1-1', cluster: 'c1', findingIds: ['RIPPLE-1'] }, { key: 'c2-1', cluster: 'c2', findingIds: ['SWEEP-1'] }],
  };
  const answerOf = (key: string, id: string, status: string, requiredFiles: string[] = [], files: string[] = []): Record<string, unknown> => ({
    key, findings: [{ id, status, file: 'src/a.ts', line: 1, note: `${id} ${status}`, message: status === 'applied' ? { subject: 'fix: x', body: '' } : null, files, corrections: [], validation: [], requiredFiles }],
  });
  const firstRoundDone = (): History => baselined().start('fixes').add('fixes.planned', twoClusterPlan)
    .worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50), answerOf('c1-1', 'RIPPLE-1', 'blocked', ['src/b.ts'])))
    .worker(51, 'fixer fixes:c2-1').add('fix.recorded', fixAnswer(worker(51), answerOf('c2-1', 'SWEEP-1', 'applied', [], ['src/b.ts'])));
  const secondRound = { blocked: [{ id: 'RIPPLE-1', requiredFiles: ['src/b.ts'] }], clusters: [{ id: 'c3', findingIds: ['RIPPLE-1'], files: ['src/a.ts', 'src/b.ts'] }], batches: [{ key: 'c3-1', cluster: 'c3', findingIds: ['RIPPLE-1'] }] };

  it('folds a second round, whose batch owns both files and whose answer is the finding\'s last (R21)', () => {
    const history = firstRoundDone().add('fixes.replanned', secondRound)
      .worker(52, 'fixer fixes:c3-1').add('fix.recorded', fixAnswer(worker(52), answerOf('c3-1', 'RIPPLE-1', 'applied', [], ['src/a.ts', 'src/b.ts'])));
    const fix = history.review().fix!;
    assert.deepEqual(fix.secondRound, secondRound);
    assert.deepEqual(ownedFiles(fix, 'fixes', 'c3-1'), ['src/a.ts', 'src/b.ts']);
    assert.equal(lastAnswerOf(fix, 'RIPPLE-1')?.batch, 'c3-1');
    assert.equal(lastAnswerOf(fix, 'RIPPLE-1')?.finding.status, 'applied');
    assert.equal(lastAnswerOf(fix, 'SWEEP-1')?.batch, 'c2-1');
    assert.deepEqual(firstRoundDone().add('fixes.replanned', { blocked: [], clusters: [], batches: [] }).review().fix!.secondRound, { blocked: [], clusters: [], batches: [] }, 'an empty round folds too');
  });

  const secondRoundPlans: [name: string, build: () => History, message: RegExp][] = [
    ['a second round before the first settled', () => baselined().start('fixes').add('fixes.planned', twoClusterPlan).add('fixes.replanned', secondRound), /before every batch of the first settled/],
    ['a second round twice', () => firstRoundDone().add('fixes.replanned', secondRound).add('fixes.replanned', secondRound), /plans its second round twice/],
    ['a second round for a finding the first round did not block', () => firstRoundDone().add('fixes.replanned', { ...secondRound, blocked: [{ id: 'SWEEP-1', requiredFiles: ['src/a.ts'] }] }), /takes finding SWEEP-1 into its second round, which the first round did not answer blocked/],
    ['a second round naming other files than the finding was blocked on', () => firstRoundDone().add('fixes.replanned', { ...secondRound, blocked: [{ id: 'RIPPLE-1', requiredFiles: ['src/c.ts'] }] }), /gives finding RIPPLE-1 the files \[src\/c\.ts\], not the ones it was blocked on \[src\/b\.ts\]/],
    ['a second-round cluster numbered from 1', () => firstRoundDone().add('fixes.replanned', { ...secondRound, clusters: [{ ...secondRound.clusters[0], id: 'c1' }], batches: [{ key: 'c1-1', cluster: 'c1', findingIds: ['RIPPLE-1'] }] }), /numbers second-round cluster 1 c1, not c3/],
    ['a second-round cluster missing a needed file', () => firstRoundDone().add('fixes.replanned', { ...secondRound, clusters: [{ ...secondRound.clusters[0], files: ['src/a.ts'] }] }), /gives second-round cluster c3 the files \[src\/a\.ts\], not its findings' \[src\/a\.ts, src\/b\.ts\]/],
    ['a second-round finding in no cluster', () => firstRoundDone().add('fixes.replanned', { ...secondRound, clusters: [], batches: [] }), /takes RIPPLE-1 into its second round but clusters none of them/],
    ['a second-round cluster\'s first batch numbered 2',() => firstRoundDone().add('fixes.replanned', { ...secondRound, batches: [{ key: 'c3-2', cluster: 'c3', findingIds: ['RIPPLE-1'] }] }), /numbers batch 1 of cluster c3 c3-2/],
  ];
  for (const [name, build, message] of secondRoundPlans) {
    it(`refuses ${name}`, () => {
      assert.throws(() => build().fold(), (error: unknown) => error instanceof InvalidHistoryError && message.test(error.message), name);
    });
  }

  it('counts a second-round violation against the second round\'s clusters, so an edit to a first-round cluster\'s file is none', () => {
    const second = firstRoundDone().add('fixes.replanned', secondRound).worker(52, 'fixer fixes:c3-1');
    // src/b.ts was c2's in the first round; in the second it is c3's own, so naming it a violation is refused.
    assert.throws(() => second.add('fix.recorded', fixAnswer(worker(52), { ...answerOf('c3-1', 'RIPPLE-1', 'applied', [], ['src/b.ts']), violations: ['src/b.ts'] })).fold(), /records a violation on src\/b\.ts/);
  });

  const ranked = (): History => withFixPass(mergeRanked());
  const fixesRunning = (): History => baselined().start('fixes');
  const planned = (): History => fixesRunning().add('fixes.planned', fixPlan);
  const answered = (): History => planned().worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50)));
  // c1-1's first worker failed: its failure, which an attempt revision of its edits follows.
  const failedOnce = (): History => planned().worker(51, 'fixer fixes:c1-1').add('attempt.failed', { phase: 'fixes', key: 'c1-1', workerId: worker(51), reason: 'timeout' }, 2);
  const attemptRevision = (workerId: string, findings: string[], after = '7'): Record<string, unknown> => ({
    phase: 'fixes',
    source: { kind: 'attempt', key: 'c1-1', workerId },
    change: { findings, message: { subject: 's', body: '' } },
    files: [{ path: 'src/a.ts', status: 'modified', before: { blob: reference('a') }, beforeSymlink: false, symlink: false, after: { blob: reference(after) } }],
  });
  // Both ranked findings routed to a fixer, RIPPLE-1 ranked first: in one cluster of src/a.ts, or in one cluster each.
  const bothRoutes = [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }];
  const bothClustered = [{ id: 'c1', findingIds: ['RIPPLE-1', 'SWEEP-1'], files: ['src/a.ts'] }];
  const twoClusters = [{ id: 'c1', findingIds: ['RIPPLE-1'], files: ['src/a.ts'] }, { id: 'c2', findingIds: ['SWEEP-1'], files: ['src/b.ts'] }];
  const batch = (key: string, cluster: string, findingIds: string[]): Record<string, unknown> => ({ key, cluster, findingIds });
  const batchPlans: [name: string, build: () => History, message: RegExp][] = [
    ['a batch of a cluster the plan does not have', () => fixesRunning().add('fixes.planned', { ...fixPlan, batches: [batch('c1-1', 'c1', ['RIPPLE-1']), batch('c2-1', 'c2', ['SWEEP-1'])] }), /plans batch c2-1 for cluster c2, which it does not plan/],
    ['a cluster\'s first batch numbered 2', () => fixesRunning().add('fixes.planned', { ...fixPlan, batches: [batch('c1-2', 'c1', ['RIPPLE-1'])] }), /numbers batch 1 of cluster c1 c1-2/],
    ['a batch keyed for another cluster', () => fixesRunning().add('fixes.planned', { ...fixPlan, batches: [batch('c2-1', 'c1', ['RIPPLE-1'])] }), /numbers batch 1 of cluster c1 c2-1/],
    ['a batch over the pinned size', () => checksPhase(withFixPass(mergeRanked(), 1), 'baseline-checks').start('fixes').add('fixes.planned', { routes: bothRoutes, clusters: bothClustered, batches: [batch('c1-1', 'c1', ['RIPPLE-1', 'SWEEP-1'])] }), /puts 2 findings in batch c1-1, more than the pinned size 1/],
    ['a batch that skips its cluster\'s order', () => fixesRunning().add('fixes.planned', { routes: bothRoutes, clusters: bothClustered, batches: [batch('c1-1', 'c1', ['SWEEP-1']), batch('c1-2', 'c1', ['RIPPLE-1'])] }), /gives batch c1-1 \[SWEEP-1\], not the next of cluster c1's findings in order/],
    ['a batch that holds a finding twice', () => fixesRunning().add('fixes.planned', { routes: bothRoutes, clusters: bothClustered, batches: [batch('c1-1', 'c1', ['RIPPLE-1', 'RIPPLE-1'])] }), /gives batch c1-1 \[RIPPLE-1, RIPPLE-1\]/],
    ['batches out of the rank of their first findings', () => fixesRunning().add('fixes.planned', { routes: bothRoutes, clusters: twoClusters, batches: [batch('c2-1', 'c2', ['SWEEP-1']), batch('c1-1', 'c1', ['RIPPLE-1'])] }), /plans batch c1-1 after a batch whose first finding ranks below its own/],
    ['a cluster\'s findings left out of every batch', () => fixesRunning().add('fixes.planned', { routes: bothRoutes, clusters: bothClustered, batches: [batch('c1-1', 'c1', ['RIPPLE-1'])] }), /leaves findings of cluster c1 in no batch/],
    ['a plan with no batch at all', () => fixesRunning().add('fixes.planned', { ...fixPlan, batches: [] }), /leaves findings of cluster c1 in no batch/],
  ];
  const invalid: [name: string, build: () => History, message: RegExp][] = [
    ['checks planned on a run without the fix pass', () => configured().add('checks.planned', plannedChecks), /configured without the fix pass/],
    ['checks planned twice', () => ranked().add('checks.planned', plannedChecks), /plans its checks twice/],
    ['a fix plan on a run without the fix pass', () => mergeRanked().add('fixes.planned', fixPlan), /configured without the fix pass/],
    ['a fix plan before the fixes phase runs', () => baselined().add('fixes.planned', fixPlan), /while it is pending/],
    ['a second fix plan', () => planned().add('fixes.planned', fixPlan), /plans its fixes twice/],
    ['a plan that leaves a ranked finding unrouted', () => fixesRunning().add('fixes.planned', { ...fixPlan, routes: [fixPlan.routes[0]] }), /not every ranked finding/],
    ['a plan that routes a finding twice', () => fixesRunning().add('fixes.planned', { ...fixPlan, routes: [...fixPlan.routes, fixPlan.routes[0]] }), /not every ranked finding/],
    ['a plan that clusters a held finding', () => fixesRunning().add('fixes.planned', { routes: fixPlan.routes, clusters: [{ id: 'c1', findingIds: ['RIPPLE-1', 'SWEEP-1'], files: ['src/a.ts'] }], batches: [] }), /clusters finding SWEEP-1, which is not routed to a fixer/],
    ['a plan that gives one file to two clusters', () => fixesRunning().add('fixes.planned', { routes: [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }], clusters: [{ id: 'c1', findingIds: ['RIPPLE-1'], files: ['src/a.ts'] }, { id: 'c2', findingIds: ['SWEEP-1'], files: ['src/a.ts'] }], batches: [] }), /gives file src\/a\.ts to clusters c1 and c2/],
    ['a plan that leaves a fixer-routed finding out of every cluster', () => fixesRunning().add('fixes.planned', { ...fixPlan, routes: [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }] }), /routes SWEEP-1 to a fixer but clusters none of them/],
    ['clusters numbered out of order', () => fixesRunning().add('fixes.planned', { routes: fixPlan.routes, clusters: [{ id: 'c2', findingIds: ['RIPPLE-1'], files: ['src/a.ts'] }], batches: [] }), /numbers cluster 1 c2/],
    ...batchPlans,
    ['a check run for a phase that is not running', () => ranked().add('check.ran', checkRun('baseline-checks', 'build')), /while it is pending/],
    ['two runs of one kind in a phase', () => ranked().start('baseline-checks').add('check.ran', checkRun('baseline-checks', 'build')).add('check.ran', checkRun('baseline-checks', 'build')), /runs the build check twice in baseline-checks/],
    ['a run of a kind with no command', () => ranked().start('baseline-checks').add('check.ran', { ...checkRun('baseline-checks', 'typecheck'), command: 'tsc' }), /runs the typecheck check, which has no command/],
    ['a run of another command than the one pinned', () => ranked().start('baseline-checks').add('check.ran', { ...checkRun('baseline-checks', 'build'), command: 'make' }), /pinned as "npm run build"/],
    ['a passed check that did not exit 0', () => ranked().start('baseline-checks').add('check.ran', { ...checkRun('baseline-checks', 'build'), exitCode: 1 }), /passed check exited with code 0/],
    ['a skipped check with output', () => ranked().start('baseline-checks').add('check.ran', { ...checkRun('baseline-checks', 'lint', 'skipped'), stdout: reference('c') }), /skipped check alone has no termination and no output/],
    ['an answer for a cluster the plan does not have', () => planned().add('fix.recorded', fixAnswer(worker(50), { key: 'c9' })), /which the phase does not have/],
    ['an answer for the repair when no check needs one', () => fixed().start('checks').finish('checks').start('repair').add('fix.recorded', fixAnswer(worker(60), { phase: 'repair', key: 'repair' })), /which the phase does not have/],
    ['an answer that leaves a finding out', () => planned().add('fix.recorded', fixAnswer(worker(50), { findings: [] })), /answers \[\] for fixes:c1-1, which holds \[RIPPLE-1\]/],
    ['an answer recorded twice', () => answered().add('fix.recorded', fixAnswer(worker(51))), /already answered/],
    ['a violation on a file no other cluster owns', () => planned().add('fix.recorded', fixAnswer(worker(50), { violations: ['src/a.ts'] })), /records a violation on src\/a\.ts/],
    ['a revision for an answer never recorded', () => planned().add('tree.revised', fixRevision(worker(50))), /whose answer is not recorded/],
    ['a revision that names a finding its answer does not hold', () => answered().add('tree.revised', { ...fixRevision(worker(50)), change: { findings: ['SWEEP-1'], message: { subject: 's', body: '' } } }), /revises the tree for SWEEP-1, which fixes:c1-1 did not answer/],
    ['two revisions of one finding', () => answered().add('tree.revised', fixRevision(worker(50))).add('tree.revised', fixRevision(worker(50))), /revises the tree for RIPPLE-1 twice/],
    ['a revision with no files', () => answered().add('tree.revised', { ...fixRevision(worker(50)), files: [] }), /schema rejects/],
    ['a revision for a check that did not run', () => fixed().start('checks').add('tree.revised', { phase: 'checks', source: { kind: 'check', check: 'lint' }, change: { findings: [], message: { subject: 's', body: '' } }, files: [{ path: 'src/a.ts', status: 'modified', before: { blob: reference('a') }, beforeSymlink: false, symlink: false, after: { blob: reference('7') } }] }), /which did not run in checks/],
    ['an attempt\'s edits by a worker that did not fail', () => answered().add('tree.revised', attemptRevision(worker(50), [])), /by worker 00000000-0000-4000-8000-000000000050, which did not fail/],
    ['an attempt\'s edits before its failure is folded', () => planned().worker(51, 'fixer fixes:c1-1').add('tree.revised', attemptRevision(worker(51), ['RIPPLE-1'])), /which did not fail/],
    ['an attempt\'s edits for a finding its unit does not hold', () => failedOnce().add('tree.revised', attemptRevision(worker(51), ['SWEEP-1'])), /revises the tree for SWEEP-1, which fixes:c1-1 does not hold/],
    ['an attempt\'s edits for one finding twice', () => failedOnce().add('tree.revised', attemptRevision(worker(51), ['RIPPLE-1'])).add('tree.revised', attemptRevision(worker(51), ['RIPPLE-1'], '8')), /revises the tree for RIPPLE-1 twice for one attempt/],
    ['an attempt\'s revision naming two findings', () => failedOnce().add('tree.revised', attemptRevision(worker(51), ['RIPPLE-1', 'SWEEP-1'])), /schema rejects/],
    ['an attempt\'s edits for a unit the plan does not have', () => failedOnce().add('tree.revised', { ...attemptRevision(worker(51), []), source: { kind: 'attempt', key: 'c9-1', workerId: worker(51) } }), /an attempt of fixes:c9-1, which the phase does not have/],
    ['an attempt\'s edits in a checks phase', () => fixed().start('checks').add('tree.revised', { ...attemptRevision(worker(51), []), phase: 'checks' }), /an attempt in checks, which no fixer runs in/],
    ['a batch not attempted after its answer', () => answered().add('unit.unattempted', { phase: 'fixes', key: 'c1-1', cause: 'failures', reason: 'r' }), /already answered/],
    ['a batch not attempted twice', () => planned().add('unit.unattempted', { phase: 'fixes', key: 'c1-1', cause: 'failures', reason: 'r' }).add('unit.unattempted', { phase: 'fixes', key: 'c1-1', cause: 'failures', reason: 'r' }), /settles fixes:c1-1 as not attempted twice/],
    ['an answer after the batch was not attempted', () => planned().add('unit.unattempted', { phase: 'fixes', key: 'c1-1', cause: 'failures', reason: 'r' }).add('fix.recorded', fixAnswer(worker(50))), /after it failed/],
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

describe('the fix plan of a run with the decision step (R6 of the decision step)', () => {
  /** A decided fix run through its baseline, its fixes phase started and not planned. */
  const decidedFixes = (decided: readonly unknown[] | null = decisions): History => checksPhase(decidedOf(withFixPass(mergeRanked()), decided), 'baseline-checks').start('fixes');
  const askBoth = (edits: boolean): unknown[] => [decisions[0], askDecision('SWEEP-1', edits)];

  it('folds the plan the planner makes from the decisions: a fix and an ask whose default edits to a fixer, a leave and an ask that keeps the code held', () => {
    for (const decided of [decisions, askBoth(true), askBoth(false)]) {
      const history = decidedFixes(decided);
      const plan = fixPlanOf(history.review());
      assert.deepEqual(history.add('fixes.planned', plan).review().fix?.plan, plan);
    }
    assert.deepEqual(fixPlanOf(decidedFixes().review()).routes, [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'held' }], 'the leave');
    assert.deepEqual(fixPlanOf(decidedFixes(askBoth(true)).review()).routes, [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }], 'the ask whose default edits');
    assert.deepEqual(fixPlanOf(decidedFixes(askBoth(false)).review()).routes, [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'held' }], 'the ask whose default keeps the code');
  });

  const toFixer = { routes: [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }], clusters: [{ id: 'c1', findingIds: ['RIPPLE-1'], files: ['src/a.ts'] }, { id: 'c2', findingIds: ['SWEEP-1'], files: [] }], batches: [{ key: 'c1-1', cluster: 'c1', findingIds: ['RIPPLE-1'] }, { key: 'c2-1', cluster: 'c2', findingIds: ['SWEEP-1'] }] };
  const invalid: [name: string, build: () => History, message: RegExp][] = [
    ['a left finding routed to a fixer', () => decidedFixes().add('fixes.planned', toFixer), /routes SWEEP-1 fixer, which its leave decision does not/],
    ['a finding decided fix held', () => decidedFixes().add('fixes.planned', { routes: [{ id: 'RIPPLE-1', route: 'held' }, { id: 'SWEEP-1', route: 'held' }], clusters: [], batches: [] }), /routes RIPPLE-1 held, which its fix decision does not/],
    ['an ask whose default keeps the code routed to a fixer', () => decidedFixes(askBoth(false)).add('fixes.planned', toFixer), /routes SWEEP-1 fixer, which its ask decision does not/],
    ['an ask whose default edits held', () => decidedFixes(askBoth(true)).add('fixes.planned', fixPlan), /routes SWEEP-1 held, which its ask decision does not/],
    ['a plan of findings no decision was recorded for', () => checksPhase(decidedOf(withFixPass(mergeRanked()), null).start('decision').finish('decision'), 'baseline-checks').start('fixes').add('fixes.planned', fixPlan), /plans its fixes before its findings are decided/],
  ];
  for (const [name, build, message] of invalid) {
    it(`refuses ${name}`, () => {
      assert.throws(() => build().fold(), (error: unknown) => error instanceof InvalidHistoryError && message.test(error.message), name);
    });
  }
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
    const lost = { workerId: worker(70), phase: 'fixes', key: 'c1-1', reason: 'the engine exited while the worker ran' };
    const running = baselined().start('fixes').add('fixes.planned', fixPlan).add('worker.launched', { ...launchOf(worker(70)) });
    assert.throws(() => foldRun(running.add('worker.lost', lost).events), /schema rejects/);
    const review = baselined().start('fixes').add('fixes.planned', fixPlan).add('worker.launched', { ...launchOf(worker(70)) }).add('worker.lost', lost, 2).review();
    assert.deepEqual(review.units.fixes['c1-1']?.failures, [{ workerId: worker(70), reason: lost.reason, lost: true, fault: 'environment' }]);
  });
});

// R1, R3, R4, R6 of commit series integrity: c1 owns src/a.ts and c2 src/b.ts, one batch each, both running.
describe('the claims fold', () => {
  const twoClusterPlan = {
    routes: [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }],
    clusters: [{ id: 'c1', findingIds: ['RIPPLE-1'], files: ['src/a.ts'] }, { id: 'c2', findingIds: ['SWEEP-1'], files: ['src/b.ts'] }],
    batches: [{ key: 'c1-1', cluster: 'c1', findingIds: ['RIPPLE-1'] }, { key: 'c2-1', cluster: 'c2', findingIds: ['SWEEP-1'] }],
  };
  const answerOf = (key: string, id: string, status: string, files: string[] = [], requiredFiles: string[] = [], violations: string[] = []): Record<string, unknown> => ({
    key, findings: [{ id, status, file: 'src/a.ts', line: 1, note: `${id} ${status}`, message: files.length > 0 ? { subject: 'fix: x', body: '' } : null, files, corrections: [], validation: [], requiredFiles }], violations,
  });
  const running = (): History => baselined().start('fixes').add('fixes.planned', twoClusterPlan);
  /** c1-1 answers, which settles c1, its one batch. */
  const c1Settled = (history: History, files: string[] = []): History => history.worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50), answerOf('c1-1', 'RIPPLE-1', 'applied', files)));
  const shared = 'test/shared.test.ts';

  it('folds a claim into the fix state and makes its cluster the file\'s holder, which no sibling may edit while it runs', () => {
    const fix = running().add('files.claimed', claimed('c1-1', 'c1', [shared])).review().fix!;
    assert.deepEqual(fix.claims, [{ path: shared, cluster: 'c1', key: 'c1-1', round: 1, claimedAt: '2026-10-09T01:00:00.000Z' }]);
    assert.deepEqual([...holdersOf(fix, 1)], [['src/a.ts', { cluster: 'c1', by: 'plan' }], ['src/b.ts', { cluster: 'c2', by: 'plan' }], [shared, { cluster: 'c1', by: 'claim' }]]);
    assert.deepEqual([...heldByOthers(fix, 'c2-1')], [['src/a.ts', { cluster: 'c1', by: 'plan' }], [shared, { cluster: 'c1', by: 'claim' }]]);
    assert.deepEqual([...heldByOthers(fix, 'c1-1')], [['src/b.ts', { cluster: 'c2', by: 'plan' }]], 'a cluster\'s own claims are its own');
    assert.deepEqual(clusterClaims(fix, 1, 'c1'), [shared]);
    assert.deepEqual([...settledClusters(fix, 1)], []);
  });

  it('frees a settled cluster\'s claimed files, and lets another cluster claim one and hold it', () => {
    const settled = c1Settled(running().add('files.claimed', claimed('c1-1', 'c1', [shared])), [shared]);
    const before = settled.review().fix!;
    assert.deepEqual([...settledClusters(before, 1)], ['c1']);
    assert.deepEqual([...heldByOthers(before, 'c2-1')], [['src/a.ts', { cluster: 'c1', by: 'plan' }]], 'owned files stay owned for the round; claimed ones end with the settle');
    const after = settled.add('files.claimed', claimed('c2-1', 'c2', [shared], '2026-10-09T02:00:00.000Z')).review().fix!;
    assert.deepEqual(holdersOf(after, 1).get(shared), { cluster: 'c2', by: 'claim' });
    assert.equal(after.claims.length, 2);
  });

  it('folds a late claim with no time, and lost claims as their markers named them', () => {
    const fix = running()
      .add('claims.lost', { phase: 'fixes', unit: 'c9-1', cluster: 'c9', files: [{ path: 'docs/x.md', claimedAt: '2026-10-09T01:00:00.000Z', reason: 'unplanned', holder: null }] })
      .add('claims.lost', { phase: 'fixes', unit: 'c2-1', cluster: 'c2', files: [{ path: 'src/a.ts', claimedAt: null, reason: 'owned', holder: 'c1' }] })
      .add('files.claimed', claimed('c1-1', 'c1', ['docs/late.md'], null))
      .review().fix!;
    assert.deepEqual(fix.claims.map((claim) => [claim.path, claim.claimedAt]), [['docs/late.md', null]]);
    assert.deepEqual(fix.lostClaims, [
      { path: 'docs/x.md', claimedAt: '2026-10-09T01:00:00.000Z', reason: 'unplanned', holder: null, unit: 'c9-1', cluster: 'c9' },
      { path: 'src/a.ts', claimedAt: null, reason: 'owned', holder: 'c1', unit: 'c2-1', cluster: 'c2' },
    ]);
  });

  it('folds a violation on a file another cluster claimed when the claim was folded first, and refuses it otherwise (R6)', () => {
    const violating = (history: History): History => history.worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50), answerOf('c1-1', 'RIPPLE-1', 'applied', ['src/a.ts', shared], [], [shared])));
    assert.deepEqual(violating(running().add('files.claimed', claimed('c2-1', 'c2', [shared]))).review().fix!.answers.fixes['c1-1']?.violations, [shared]);
    assert.throws(() => violating(running()).fold(), /records a violation on test\/shared\.test\.ts, which is not a reported file another cluster holds/);
    // A claim of a cluster that settled since holds nothing.
    const c2Settled = running().add('files.claimed', claimed('c2-1', 'c2', [shared])).worker(51, 'fixer fixes:c2-1').add('fix.recorded', fixAnswer(worker(51), answerOf('c2-1', 'SWEEP-1', 'applied', ['src/b.ts', shared])));
    assert.throws(() => violating(c2Settled).fold(), /records a violation on test\/shared\.test\.ts/);
  });

  it('folds a second round for a finding blocked on a file another first-round cluster claimed, settled or not, with its cluster\'s claims among its files (R4)', () => {
    // c2 claims the test, applies SWEEP-1 and settles; c1 claims docs/c1.md and answers RIPPLE-1 blocked on the test.
    const firstRound = running()
      .add('files.claimed', claimed('c2-1', 'c2', [shared]))
      .worker(51, 'fixer fixes:c2-1').add('fix.recorded', fixAnswer(worker(51), answerOf('c2-1', 'SWEEP-1', 'applied', ['src/b.ts', shared])))
      .add('files.claimed', claimed('c1-1', 'c1', ['docs/c1.md']))
      .worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50), answerOf('c1-1', 'RIPPLE-1', 'blocked', ['docs/c1.md'], [shared])));
    const second = { blocked: [{ id: 'RIPPLE-1', requiredFiles: [shared] }], clusters: [{ id: 'c3', findingIds: ['RIPPLE-1'], files: ['docs/c1.md', 'src/a.ts', shared] }], batches: [{ key: 'c3-1', cluster: 'c3', findingIds: ['RIPPLE-1'] }] };
    const fix = firstRound.clone().add('fixes.replanned', second).review().fix!;
    assert.deepEqual(fix.secondRound, second);
    assert.deepEqual(secondRoundOf(firstRound.review()), second, 'the planner makes the plan the fold accepts');
    assert.throws(() => firstRound.clone().add('fixes.replanned', { ...second, clusters: [{ ...second.clusters[0]!, files: ['src/a.ts', shared] }] }).fold(), /gives second-round cluster c3 the files \[src\/a\.ts, test\/shared\.test\.ts\], not its findings' \[docs\/c1\.md, src\/a\.ts, test\/shared\.test\.ts\]/);
  });

  it('refuses a second round for a file only the finding\'s own cluster claimed, or nobody held', () => {
    const blockedOn = (path: string, claims: History = running()): History => claims
      .worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50), answerOf('c1-1', 'RIPPLE-1', 'blocked', [], [path])))
      .worker(51, 'fixer fixes:c2-1').add('fix.recorded', fixAnswer(worker(51), answerOf('c2-1', 'SWEEP-1', 'applied', ['src/b.ts'])))
      .add('fixes.replanned', { blocked: [{ id: 'RIPPLE-1', requiredFiles: [path] }], clusters: [{ id: 'c3', findingIds: ['RIPPLE-1'], files: ['src/a.ts', path] }], batches: [{ key: 'c3-1', cluster: 'c3', findingIds: ['RIPPLE-1'] }] });
    assert.throws(() => blockedOn('docs/own.md', running().add('files.claimed', claimed('c1-1', 'c1', ['docs/own.md']))).fold(), /takes finding RIPPLE-1 into its second round for docs\/own\.md, which no other first-round cluster owned or claimed/);
    assert.throws(() => blockedOn('docs/free.md').fold(), /for docs\/free\.md, which no other first-round cluster owned or claimed/);
  });

  it('holds second-round claims to the second round\'s clusters, where the first round\'s claims are over', () => {
    const second = { blocked: [{ id: 'RIPPLE-1', requiredFiles: ['src/b.ts'] }], clusters: [{ id: 'c3', findingIds: ['RIPPLE-1'], files: ['src/a.ts', 'src/b.ts'] }], batches: [{ key: 'c3-1', cluster: 'c3', findingIds: ['RIPPLE-1'] }] };
    const fix = running()
      .add('files.claimed', claimed('c2-1', 'c2', [shared]))
      .worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50), answerOf('c1-1', 'RIPPLE-1', 'blocked', [], ['src/b.ts'])))
      .worker(51, 'fixer fixes:c2-1').add('fix.recorded', fixAnswer(worker(51), answerOf('c2-1', 'SWEEP-1', 'applied', ['src/b.ts', shared])))
      .add('fixes.replanned', second)
      .add('files.claimed', claimed('c3-1', 'c3', [shared, 'docs/c3.md']))
      .review().fix!;
    assert.deepEqual(fix.claims.slice(1).map((claim) => [claim.path, claim.round]), [[shared, 2], ['docs/c3.md', 2]]);
    assert.deepEqual(holdersOf(fix, 2).get(shared), { cluster: 'c3', by: 'claim' });
    assert.deepEqual(holdersOf(fix, 1).get(shared), { cluster: 'c2', by: 'claim' });
  });

  const refusals: [name: string, build: () => History, message: RegExp][] = [
    ['a claim before the plan', () => baselined().start('fixes').add('files.claimed', claimed('c1-1', 'c1', [shared])), /claims files for c1-1, which the plan does not have/],
    ['a claim by a unit the plan lacks', () => running().add('files.claimed', claimed('c9-1', 'c9', [shared])), /claims files for c9-1, which the plan does not have/],
    ['a claim under another cluster\'s name', () => running().add('files.claimed', claimed('c1-1', 'c2', [shared])), /claims files for c1-1 under cluster c2, not its cluster c1/],
    ['a claim of a file another cluster owns', () => running().add('files.claimed', claimed('c1-1', 'c1', ['src/b.ts'])), /claims src\/b\.ts for c1-1, which cluster c2 owns/],
    ['a claim of a file its own cluster owns', () => running().add('files.claimed', claimed('c1-1', 'c1', ['src/a.ts'])), /claims src\/a\.ts for c1-1, which cluster c1 owns/],
    ['a claim of a file an unsettled cluster claimed', () => running().add('files.claimed', claimed('c1-1', 'c1', [shared])).add('files.claimed', claimed('c2-1', 'c2', [shared])), /claims test\/shared\.test\.ts for c2-1, which cluster c1 holds and has not settled/],
    ['a claim of a file its cluster holds already', () => running().add('files.claimed', claimed('c1-1', 'c1', [shared])).add('files.claimed', claimed('c1-1', 'c1', [shared])), /claims test\/shared\.test\.ts for c1-1, which its cluster holds already/],
    ['a claim while the fixes phase is not running', () => fixed().add('files.claimed', claimed('c1-1', 'c1', [shared])), /while it is completed/],
    ['a claim of one file twice in one event', () => running().add('files.claimed', claimed('c1-1', 'c1', [shared, shared])), /schema rejects/],
    ['a claim of a path outside the repository', () => running().add('files.claimed', claimed('c1-1', 'c1', ['../x.ts'])), /schema rejects/],
    ['a claim on a read-only run', () => mergeRanked().add('files.claimed', claimed('c1-1', 'c1', [shared])), /configured without the fix pass/],
    ['a lost claim while the fixes phase is not running', () => fixed().add('claims.lost', { phase: 'fixes', unit: 'c1-1', cluster: 'c1', files: [{ path: 'x', claimedAt: null, reason: 'unplanned', holder: null }] }), /while it is completed/],
  ];
  for (const [name, build, message] of refusals) {
    it(`refuses ${name}`, () => {
      assert.throws(() => build().fold(), (error: unknown) => error instanceof InvalidHistoryError && message.test(error.message), name);
    });
  }
});
