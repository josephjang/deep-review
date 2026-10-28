import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidHistoryError } from '../../src/checkpoint/errors.ts';
import { baseKinds, budgetStoppedUnits, clusterClaims, committedRevisions, comparableKinds, cutShortBefore, cutShortChecks, earlierTreeEdit, emptyFixState, exactPath, failedAtBaseline, failingBaselineRun, firstRoundHolders, fixesRevisedPaths, heldByAnother, heldByOthers, heldInRoundByOthers, holdersKeyedBy, isCutAttempt, isOldRun, kindsTakenToBase, lastAnswerOf, lastClaimOf, lastCurrentRun, lastFreshRun, lastRecordedRun, openStart, ownedFiles, repairTargets, revisionMessageOf, runHead, runStanding, secondRoundFiles, settledClusters, takenOnBase, unitIdsOf, type FixState } from '../../src/checkpoint/fix-state.ts';
import type { DocumentationItem, TreeRevised } from '../../src/checkpoint/events.ts';
import { standingAnswer } from '../../src/checkpoint/answer-state.ts';
import { firstUnknownEvent, foldRun } from '../../src/checkpoint/fold.ts';
import { isAnswered, preRunStrays, type ReviewState } from '../../src/checkpoint/review-fold.ts';
import { reviewStatus } from '../../src/review/state.ts';
import { fixPlanOf, secondRoundOf } from '../../src/review/steps.ts';
import { fixPhases } from '../../src/review/vocabulary.ts';
import {
  answer,
  answerableDecisions,
  askDecision,
  baselined,
  baseSkip,
  checkRun,
  checksPhase,
  claimed,
  configured,
  continuedRun,
  foldedChecks,
  continuedToReport,
  decidedFixRun,
  decidedOf,
  decisions,
  documentationAnswer,
  documentationAnswered,
  documentationItems,
  endCheck,
  fixAnswer,
  fixed,
  fixPlan,
  fixRevision,
  flagPlan,
  History,
  launch,
  mergeRanked,
  noSecondRound,
  passToReport,
  pin,
  plannedChecks,
  quietPlannedChecks,
  quietSurvey,
  ranOnBase,
  ranked,
  readOnlyReported,
  reference,
  reported,
  statistics,
  surveyAnswer,
  withBaseChecks,
  withDecisions,
  withDocumentationStep,
  withFixPass,
  withSurvey,
  worker,
} from '../helpers/review-history.ts';
import { documentationStepEntries, modelWithout, resumableRunsEntries } from '../helpers/model.ts';

const commit = (fill: string): string => fill.repeat(40);
const launchOf = (workerId: string): Record<string, unknown> => launch(workerId, 'fixer fixes:c1-1');

describe('the fix fold', () => {
  it('starts a run configured with the fix pass with an empty fix state, its five phases pending, the documentation step and the checks on the base skipped before they existed, and its checks pinned', () => {
    const review = withFixPass(configured()).review();
    assert.equal(review.configuration.fix, true);
    assert.deepEqual(review.configuration.checks, { timeoutMs: 600_000 });
    for (const phase of fixPhases.filter((candidate) => candidate !== 'documentation' && candidate !== 'base-checks')) assert.deepEqual(review.phases[phase], { status: 'pending', attempt: 0 });
    assert.deepEqual(review.phases.documentation, { status: 'skipped', attempt: 0 });
    assert.deepEqual(review.phases['base-checks'], { status: 'skipped', attempt: 0 });
    assert.equal(review.documentationStep, false);
    assert.equal(review.baseChecksStep, false);
    assert.equal(review.fix?.documentation, null);
    // A version 1 plan names no source; the fold gives each of its checks a null one, as a version 2 plan's flag does, and its flag reads as a setting of the flag layer.
    assert.deepEqual(review.fix?.checks.planned, { ...plannedChecks, checks: foldedChecks(plannedChecks.checks) });
    assert.equal(review.fix?.plan, null);
    assert.deepEqual(review.fix?.revisions, []);
  });

  it('folds a fix run: the baseline, the plan, an answer and its revision, the checks after it', () => {
    const history = checksPhase(fixed(), 'checks', { test: 'failed' });
    const review = history.review();
    const fix = review.fix!;
    assert.deepEqual(fix.plan, fixPlan);
    assert.equal(lastFreshRun(fix, 'baseline-checks', 'test')?.outcome, 'passed');
    assert.equal(lastFreshRun(fix, 'checks', 'test')?.outcome, 'failed');
    assert.equal(lastFreshRun(fix, 'checks', 'typecheck'), null, 'a kind with no command never runs');
    assert.deepEqual(repairTargets(fix), ['test'], 'passed before the fixes, failed after');
    assert.equal(isAnswered(review, 'fixes', 'c1-1'), true);
    assert.deepEqual(fix.answers.fixes['c1-1'], { ...fixAnswer(worker(50)), comparisons: [] }, 'an answer before version 4 holds no comparison with the base');
    assert.deepEqual(fix.revisions, [fixRevision(worker(50))]);
    assert.deepEqual(fixesRevisedPaths(fix), ['src/a.ts']);
    assert.deepEqual(ownedFiles(review, 'fixes', 'c1-1'), ['src/a.ts']);
    assert.deepEqual(ownedFiles(review, 'repair', 'repair'), ['src/a.ts'], 'the repair owns everything the fixes revised');
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
    assert.equal(fix.commits.length, 1);
    assert.equal(fix.commits[0]!.to, commit('c'));
    assert.equal(review.phases.repair.status, 'degraded');
  });

  it('folds an unfinished attempt\'s edits with its failure, and commits them with the message the retry gives on verifying them (R20)', () => {
    const verified = (message: Record<string, unknown> | null): History => failedOnce()
      .add('tree.revised', attemptRevision(worker(51), ['RIPPLE-1']))
      .worker(52, 'fixer fixes:c1-1')
      .add('fix.recorded', fixAnswer(worker(52), { findings: [{ id: 'RIPPLE-1', status: 'already-applied', file: 'src/a.ts', line: 4, note: 'the guard the first attempt added holds', message, files: ['src/a.ts'], corrections: [], validation: [], requiredFiles: [] }] }));
    const review = verified({ subject: 'fix: Guard the null', body: 'Why.' }).review();
    const fix = review.fix!;
    assert.equal(fix.revisions.length, 1);
    assert.deepEqual(fix.revisions[0]!.source, { kind: 'attempt', key: 'c1-1', workerId: worker(51) });
    assert.deepEqual(revisionMessageOf(fix, fix.revisions[0]!), { subject: 'fix: Guard the null', body: 'Why.' }, 'the retry\'s message');
    const unverified = verified(null).review().fix!;
    assert.deepEqual(revisionMessageOf(unverified, unverified.revisions[0]!), { subject: 's', body: '' }, 'the attempt\'s own message when the retry gave none');
    assert.deepEqual(ownedFiles(review, 'fixes', 'c1-1'), ['src/a.ts']);
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
    const review = history.review();
    const fix = review.fix!;
    assert.deepEqual(fix.secondRound, secondRound);
    assert.deepEqual(ownedFiles(review, 'fixes', 'c3-1'), ['src/a.ts', 'src/b.ts']);
    assert.equal(lastAnswerOf(fix, 'RIPPLE-1')?.key, 'c3-1');
    assert.equal(lastAnswerOf(fix, 'RIPPLE-1')?.finding.status, 'applied');
    assert.equal(lastAnswerOf(fix, 'SWEEP-1')?.key, 'c2-1');
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
      [{ commits: [change, one], from: '3'.repeat(40), to: commit('b') }, /creates commits on 3{40}, not the run's head 2{40}/],
      [{ commits: [change, one], from: '2'.repeat(40), to: commit('a') }, /not its last/],
    ] as const) {
      assert.throws(() => complete().add('commits.created', payload).fold(), (error: unknown) => error instanceof InvalidHistoryError && message.test(error.message));
    }
    assert.throws(() => complete().add('commits.created', { commits: [change, one], from: '2'.repeat(40), to: commit('b') }).add('commits.created', { commits: [change, one], from: '2'.repeat(40), to: commit('b') }).fold(), /not the run's head b{40}/, 'once a series exists, the run stands on its last commit');
    assert.throws(() => complete().add('commits.created', { commits: [change, one], from: '2'.repeat(40), to: commit('b') }).add('commits.created', { commits: [{ ...one, sha: commit('c') }], from: commit('b'), to: commit('c') }).fold(), /when every one of its 1 revisions is committed/, 'a later series needs a revision no series holds');
  });

  it('folds a later series of commits from the last commit of the one before, of the revisions an answer pass added (R8 of answers)', () => {
    const passed = passToReport(decidedFixRun().add('answer.recorded', answer('RIPPLE-1', 'reject')).add('answer.pass', { ids: ['RIPPLE-1'] }), 1, [['RIPPLE-1', 'applied']], 2);
    const first = { commits: [{ sha: commit('a'), revision: 'change', subject: 'the change' }, { sha: commit('b'), revision: 0, subject: 'fix: Guard the null' }], from: '2'.repeat(40), to: commit('b') };
    const history = decidedFixRun().add('commits.created', first);
    // The same run, its first series committed before the answer.
    const committed = new History();
    for (const event of passed.events) {
      committed.add(event.kind, event.payload, event.version);
      if (event.kind === 'phase.finished' && (event.payload as { phase: string; attempt: number }).phase === 'report' && (event.payload as { attempt: number }).attempt === 1) committed.add('commits.created', first);
    }
    assert.equal(history.review().fix!.commits.length, 1);
    const fix = committed.review().fix!;
    assert.equal(committedRevisions(fix), 1, 'the first series holds revision 0');
    assert.equal(runHead(committed.fold()), commit('b'), 'the run stands on the last commit of the first series');
    const later = { commits: [{ sha: commit('c'), revision: 1, subject: 'fix: Answer RIPPLE-1' }], from: commit('b'), to: commit('c') };
    const both = committed.clone().add('commits.created', later);
    assert.deepEqual(both.review().fix!.commits.map((series) => series.to), [commit('b'), commit('c')]);
    assert.equal(committedRevisions(both.review().fix!), 2);
    assert.equal(runHead(both.fold()), commit('c'));
    for (const [payload, message] of [
      [{ ...later, from: '2'.repeat(40) }, /not the run's head b{40}/],
      [{ ...later, commits: [{ sha: commit('c'), revision: 'change', subject: 'the change' }, ...later.commits] }, /not \[1\]/],
      [{ ...later, commits: [{ ...later.commits[0]!, revision: 0 }] }, /not \[1\]/],
    ] as const) {
      assert.throws(() => committed.clone().add('commits.created', payload).fold(), (error: unknown) => error instanceof InvalidHistoryError && message.test(error.message), message.source);
    }
    assert.throws(() => both.clone().add('commits.created', { ...later, from: commit('c'), to: commit('d'), commits: [{ ...later.commits[0]!, sha: commit('d') }] }).fold(), /every one of its 2 revisions is committed/);
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
    assert.deepEqual(review.units.fixes['c1-1']?.failures, [{ workerId: worker(70), reason: lost.reason, cause: 'lost' }]);
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
    assert.deepEqual([...holdersKeyedBy(fix, 1, exactPath)], [['src/a.ts', { path: 'src/a.ts', cluster: 'c1', by: 'plan' }], ['src/b.ts', { path: 'src/b.ts', cluster: 'c2', by: 'plan' }], [shared, { path: shared, cluster: 'c1', by: 'claim' }]]);
    assert.deepEqual([...heldByOthers(fix, 'c2-1', exactPath)], [['src/a.ts', { cluster: 'c1', by: 'plan' }], [shared, { cluster: 'c1', by: 'claim' }]]);
    assert.deepEqual([...heldByOthers(fix, 'c1-1', exactPath)], [['src/b.ts', { cluster: 'c2', by: 'plan' }]], 'a cluster\'s own claims are its own');
    assert.deepEqual(clusterClaims(fix, 1, 'c1'), [shared]);
    assert.deepEqual([...settledClusters(fix, 1)], []);
  });

  it('frees a settled cluster\'s claimed files, and lets another cluster claim one and hold it', () => {
    const settled = c1Settled(running().add('files.claimed', claimed('c1-1', 'c1', [shared])), [shared]);
    const before = settled.review().fix!;
    assert.deepEqual([...settledClusters(before, 1)], ['c1']);
    assert.deepEqual([...heldByOthers(before, 'c2-1', exactPath)], [['src/a.ts', { cluster: 'c1', by: 'plan' }]], 'owned files stay owned for the round; claimed ones end with the settle');
    assert.deepEqual([...heldInRoundByOthers(before, 'c2-1', exactPath)], [['src/a.ts', { cluster: 'c1', by: 'plan' }], [shared, { cluster: 'c1', by: 'claim' }]], 'an attempt still leaves out what the settled cluster claimed (R5)');
    const after = settled.add('files.claimed', claimed('c2-1', 'c2', [shared], '2026-10-09T02:00:00.000Z')).review().fix!;
    assert.deepEqual(holdersKeyedBy(after, 1, exactPath).get(shared), { path: shared, cluster: 'c2', by: 'claim' });
    assert.equal(after.claims.length, 2);
    assert.deepEqual([...heldInRoundByOthers(after, 'c2-1', exactPath)], [['src/a.ts', { cluster: 'c1', by: 'plan' }]], 'a file c2 claimed after c1 settled is c2\'s own');
    assert.deepEqual([...heldInRoundByOthers(after, 'c1-1', exactPath)], [['src/b.ts', { cluster: 'c2', by: 'plan' }], [shared, { cluster: 'c2', by: 'claim' }]]);
  });

  it('gives a path\'s last claim of a round, or the last by a cluster other than the one named, with its time', () => {
    const fix = c1Settled(running().add('files.claimed', claimed('c1-1', 'c1', [shared])), [shared]).add('files.claimed', claimed('c2-1', 'c2', [shared], '2026-10-09T02:00:00.000Z')).review().fix!;
    assert.deepEqual(lastClaimOf(fix, 1, shared), { path: shared, cluster: 'c2', key: 'c2-1', round: 1, claimedAt: '2026-10-09T02:00:00.000Z' });
    assert.deepEqual(lastClaimOf(fix, 1, shared, 'c2'), { path: shared, cluster: 'c1', key: 'c1-1', round: 1, claimedAt: '2026-10-09T01:00:00.000Z' }, 'the named cluster\'s own claim is passed over');
    assert.equal(lastClaimOf(fix, 1, shared, 'c9')?.cluster, 'c2', 'a cluster that never claimed it passes over nothing');
    assert.equal(lastClaimOf(fix, 1, 'docs/none.md'), undefined, 'a path nobody claimed');
    assert.equal(lastClaimOf(fix, 2, shared), undefined, 'a first-round claim is not the second round\'s');
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

  it('keeps the holder each violation was judged against, which a later claim of the file does not change (R6)', () => {
    const violated = running().add('files.claimed', claimed('c2-1', 'c2', [shared]))
      .worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50), answerOf('c1-1', 'RIPPLE-1', 'applied', ['src/a.ts', 'src/b.ts', shared], [], ['src/b.ts', shared])));
    assert.deepEqual(violated.review().fix!.violationHolders, { 'c1-1': { 'src/b.ts': { cluster: 'c2', by: 'plan' }, [shared]: { cluster: 'c2', by: 'claim' } } });
    // c2 settles, which frees the file, and c1 claims it.
    const reclaimed = violated.worker(51, 'fixer fixes:c2-1').add('fix.recorded', fixAnswer(worker(51), answerOf('c2-1', 'SWEEP-1', 'applied', ['src/b.ts', shared])))
      .add('files.claimed', claimed('c1-1', 'c1', [shared], '2026-10-09T02:00:00.000Z'))
      .review().fix!;
    assert.deepEqual(holdersKeyedBy(reclaimed, 1, exactPath).get(shared), { path: shared, cluster: 'c1', by: 'claim' });
    assert.deepEqual(reclaimed.violationHolders['c1-1']?.[shared], { cluster: 'c2', by: 'claim' });
    assert.deepEqual(running().worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50), answerOf('c1-1', 'RIPPLE-1', 'applied', ['src/a.ts']))).review().fix!.violationHolders, {}, 'an answer without a violation keeps none');
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

  it('gives a second-round finding its cluster\'s files, that cluster\'s claims and the files it needed, sorted, once each (R4)', () => {
    const claims = [{ path: 'docs/z.md', cluster: 'c1' }, { path: shared, cluster: 'c2' }, { path: 'docs/z.md', cluster: 'c1' }, { path: 'docs/a.md', cluster: 'c1' }];
    assert.deepEqual(secondRoundFiles({ id: 'c1', files: ['src/a.ts'] }, claims, [shared, 'src/a.ts']), ['docs/a.md', 'docs/z.md', 'src/a.ts', shared]);
    assert.deepEqual(secondRoundFiles({ id: 'c1', files: [] }, [], []), [], 'a cluster with no files, claims or needs has none');
  });

  it('takes a path into the second round only when a first-round cluster other than the finding\'s own held it, by plan or by any claim (R4)', () => {
    const holders = firstRoundHolders([{ id: 'c1', files: ['src/a.ts'] }, { id: 'c2', files: ['src/b.ts'] }], [{ path: shared, cluster: 'c1' }, { path: shared, cluster: 'c2' }, { path: 'docs/c1.md', cluster: 'c1' }]);
    assert.equal(heldByAnother(holders, 'src/b.ts', 'c1'), true, 'another cluster owns it');
    assert.equal(heldByAnother(holders, shared, 'c1'), true, 'another cluster claimed it too');
    assert.equal(heldByAnother(holders, 'src/a.ts', 'c1'), false, 'only its own cluster owns it');
    assert.equal(heldByAnother(holders, 'docs/c1.md', 'c1'), false, 'only its own cluster claimed it');
    assert.equal(heldByAnother(holders, 'docs/free.md', 'c1'), false, 'nobody held it');
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
    assert.deepEqual(holdersKeyedBy(fix, 2, exactPath).get(shared), { path: shared, cluster: 'c3', by: 'claim' });
    assert.deepEqual(holdersKeyedBy(fix, 1, exactPath).get(shared), { path: shared, cluster: 'c2', by: 'claim' });
  });

  const claimRefusals: [name: string, build: () => History, message: RegExp][] = [
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
  for (const [name, build, message] of claimRefusals) {
    it(`refuses ${name}`, () => {
      assert.throws(() => build().fold(), (error: unknown) => error instanceof InvalidHistoryError && message.test(error.message), name);
    });
  }
});

// R6, TD3, TD7 of fix pass continuation: a complete read-only run, surveyed and decided, continued into the fix pass by fix.pinned.
describe('answers in the fix state (R4, R5 of answers)', () => {
  /** A plan that routes both findings to a fixer, one cluster each: RIPPLE-1 owning src/a.ts, SWEEP-1, unlocated, owning nothing. */
  const bothPlan = {
    routes: [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }],
    clusters: [{ id: 'c1', findingIds: ['RIPPLE-1'], files: ['src/a.ts'] }, { id: 'c2', findingIds: ['SWEEP-1'], files: [] }],
    batches: [{ key: 'c1-1', cluster: 'c1', findingIds: ['RIPPLE-1'] }, { key: 'c2-1', cluster: 'c2', findingIds: ['SWEEP-1'] }],
  };
  /** A read-only run whose SWEEP-1, an ask that keeps the code, is answered with `option`, continued with the flags' checks and through its baseline. */
  const answeredContinuation = (option: number): History => checksPhase(readOnlyReported(answerableDecisions()).add('answer.recorded', answer('SWEEP-1', option)).add('fix.pinned', pin(flagPlan)), 'baseline-checks').start('fixes');

  it('routes a finding whose answer owes an edit to a fixer, whatever its decision, and one the tree holds by its decision', () => {
    assert.doesNotThrow(() => answeredContinuation(1).add('fixes.planned', bothPlan).fold(), 'option 2 of a code-keeping ask goes to a fixer');
    assert.throws(() => answeredContinuation(1).add('fixes.planned', fixPlan).fold(), /routes SWEEP-1 held, which its ask decision and its answer do not/);
    assert.doesNotThrow(() => answeredContinuation(0).add('fixes.planned', fixPlan).fold(), 'the default that keeps the code stays held');
    assert.throws(() => answeredContinuation(0).add('fixes.planned', bothPlan).fold(), /routes SWEEP-1 fixer, which its ask decision and its answer do not/);
  });

  it('marks the answer applied by the fixes-phase batch that made its edit, and leaves one a fixer deferred owed', () => {
    const planned = (): History => answeredContinuation(1).add('fixes.planned', bothPlan).worker(51, 'fixer fixes:c2-1');
    const sweep = (status: string): Record<string, unknown> => fixAnswer(worker(51), { key: 'c2-1', findings: [{ id: 'SWEEP-1', status, file: 'src/a.ts', line: 3, note: 'answered', message: status === 'applied' ? { subject: 'fix: Accept an empty input', body: 'The author chose option 2.' } : null, files: status === 'applied' ? ['src/a.ts'] : [], corrections: [], validation: [], requiredFiles: [] }] });
    assert.deepEqual(standingAnswer(planned().add('fix.recorded', sweep('applied'), 2).review(), 'SWEEP-1')?.appliedBy, { phase: 'fixes', key: 'c2-1' });
    assert.equal(standingAnswer(planned().add('fix.recorded', sweep('deferred'), 2).review(), 'SWEEP-1')?.appliedBy, null);
    assert.equal(standingAnswer(planned().add('fix.recorded', sweep('already-applied'), 2).review(), 'SWEEP-1')?.appliedBy !== null, true, 'found applied already, the tree holds it');
  });

  it('gives an answer pass its findings and every revised path with the files its findings are located in, and reads its answer as the last of the finding', () => {
    const open = decidedFixRun().add('answer.recorded', answer('RIPPLE-1', 'reject')).add('answer.recorded', answer('SWEEP-1', 1)).add('answer.pass', { ids: ['RIPPLE-1', 'SWEEP-1'] });
    const review = open.review();
    assert.deepEqual(unitIdsOf(review, 'answer', 'pass-1'), ['RIPPLE-1', 'SWEEP-1']);
    assert.equal(unitIdsOf(review, 'answer', 'pass-2'), null, 'a key no pass has');
    assert.equal(unitIdsOf(review, 'answer', 'c1-1'), null);
    assert.deepEqual(ownedFiles(review, 'answer', 'pass-1'), ['src/a.ts'], 'the revised path, and RIPPLE-1 and its member are located in it; SWEEP-1 is unlocated');
    const done = passToReport(open, 1, [['RIPPLE-1', 'applied'], ['SWEEP-1', 'deferred']], 2).review();
    const fix = done.fix!;
    assert.deepEqual(lastAnswerOf(fix, 'RIPPLE-1'), { phase: 'answer', key: 'pass-1', finding: fix.answers.answer['pass-1']!.findings[0] }, 'the answer of the pass over the one of c1-1');
    assert.equal(lastAnswerOf(fix, 'SWEEP-1')?.finding.status, 'deferred', 'a held finding the pass worked');
    assert.equal(lastAnswerOf(decidedFixRun().review().fix!, 'RIPPLE-1')?.phase, 'fixes');
    assert.deepEqual(ownedFiles(done, 'answer', 'pass-1'), ['src/a.ts']);
  });
});

describe('the continuation into the fix pass', () => {
  it('folds a read-only run continued with no planned checks into a fix run whose survey, fix phases and report are open again', () => {
    const before = readOnlyReported().review();
    const history = continuedRun();
    const run = history.fold();
    const review = run.review!;
    assert.deepEqual(review.configuration, { ...before.configuration, fix: true, checks: { timeoutMs: 300_000 }, fixes: { batchSize: 4 } }, 'the configuration reads as a fix run\'s');
    assert.equal((history.events.find((event) => event.kind === 'review.configured')!.payload as { fix: boolean }).fix, false, 'the recorded configuration is unchanged');
    for (const phase of fixPhases.filter((candidate) => candidate !== 'documentation' && candidate !== 'base-checks')) assert.deepEqual(review.phases[phase], { status: 'pending', attempt: 0 }, phase);
    assert.deepEqual(review.phases.documentation, { status: 'skipped', attempt: 0 }, 'a run configured before the documentation step does not get it (R11 of the documentation step)');
    assert.deepEqual(review.phases['base-checks'], { status: 'skipped', attempt: 0 }, 'nor the checks on the base (R10 of the facts before a merge)');
    assert.deepEqual(review.phases.report, { status: 'pending', attempt: 1 }, 'the report is pending at its attempt, so its next start is the second');
    assert.deepEqual(review.phases.survey, { status: 'pending', attempt: 1 }, 'the survey is asked for the checks');
    assert.deepEqual(review.phases.decision, before.phases.decision, 'the read-only phases stay as they finished');
    assert.deepEqual(review.fix, emptyFixState());
    assert.equal(review.report, null);
    assert.equal(before.reportSetAsideBy, null, 'a current report is set aside by nothing');
    assert.equal(review.reportSetAsideBy, 'continuation');
    assert.deepEqual(review.continuedFrom, { report: before.report, at: history.events.at(-1)!.recordedAt, checkCount: before.checks.length });
    assert.ok(before.checks.length > 0, 'the read-only phases checked the worktree');
    assert.deepEqual(review.ranking, before.ranking);
    assert.deepEqual(review.decisions, before.decisions);
    assert.deepEqual(review.survey, before.survey, 'the recorded survey stands');
    assert.equal(reviewStatus(run), 'active', 'an active run again, which a review resumes');
  });

  it('counts the strays of the first worktree check since the pin as the user\'s work before the fix pass, and those of no later check (preRunStrays)', () => {
    const pinned = readOnlyReported().add('fix.pinned', pin(flagPlan));
    assert.deepEqual([...preRunStrays(pinned.review())], [], 'no check since the pin yet');
    // The user edited docs/notes.md, outside the scope, after the read-only report; a fixer's build then left dist/x.js.
    const started = pinned.start('baseline-checks', 1, ['docs/notes.md']);
    assert.deepEqual([...preRunStrays(started.review())], ['docs/notes.md']);
    const later = started.add('worktree.checked', { ...endCheck('baseline-checks'), strays: ['dist/x.js', 'docs/notes.md'] }, 2);
    assert.deepEqual([...preRunStrays(later.review())], ['docs/notes.md']);
    // A run never continued counts its first check's alone.
    assert.deepEqual([...preRunStrays({ ...later.review(), continuedFrom: null })], []);
  });

  it('plans the flags\' checks with the pin and leaves the survey completed when they settle every kind (TD3)', () => {
    const review = readOnlyReported().add('fix.pinned', pin(flagPlan)).review();
    assert.deepEqual(review.fix?.checks.planned, { checks: foldedChecks(flagPlan), manager: null });
    assert.deepEqual(review.phases.survey, { status: 'completed', attempt: 1 });
    assert.deepEqual(review.phases.report, { status: 'pending', attempt: 1 });
  });

  it('gives the survey\'s unit fresh attempts, so the read-only survey\'s failures do not exhaust the surveyor asked for the checks', () => {
    const failedFirst = (history: History): History => history
      .start('survey')
      .add('attempt.failed', { phase: 'survey', key: 'survey', workerId: worker(79), reason: 'failed: the answer does not match the output schema' }, 4)
      .worker(80, 'surveyor survey:survey')
      .add('survey.recorded', surveyAnswer(worker(80)))
      .finish('survey');
    const readOnly = withDecisions(withSurvey(reported(), failedFirst));
    assert.equal(readOnly.review().units.survey.survey?.failures.length, 1);
    const pinned = readOnly.add('fix.pinned', pin());
    assert.deepEqual(pinned.review().units.survey.survey, { answeredBy: worker(80), failures: [] }, 'failures forgotten, the answer kept until the attempt starts');
    assert.equal(pinned.start('survey', 2).review().units.survey.survey?.answeredBy, null, 'the second attempt opens the unit');
  });

  it('folds the fix run that follows: a raised budget, the survey\'s checks at its second attempt, the fix phases and a second report', () => {
    const limited = continuedRun().add('limits.changed', { concurrency: 2, runBudgetUsd: 90 });
    assert.deepEqual(limited.review().limits, { concurrency: 2, runBudgetUsd: 90 }, 'the limits change once the report is cleared');
    const run = continuedToReport().fold();
    const review = run.review!;
    assert.deepEqual(review.phases.survey, { status: 'completed', attempt: 2 });
    assert.equal(review.survey?.answers.length, 2);
    assert.deepEqual(review.fix?.checks.planned, { checks: foldedChecks(quietPlannedChecks.checks), manager: null });
    assert.deepEqual(review.fix?.plan, fixPlan);
    assert.equal(review.fix?.revisions.length, 1);
    assert.deepEqual(review.phases.report, { status: 'completed', attempt: 2 });
    assert.deepEqual(review.report?.patches, [reference('1')]);
    assert.deepEqual(review.continuedFrom?.report.report, reference('e', 2048), 'the read-only report stays beside the second');
    assert.equal(review.reportSetAsideBy, null, 'the second report is current');
    assert.equal(reviewStatus(run), 'complete');
  });

  const failedSurvey = (history: History): History => history
    .start('survey')
    .add('survey.failed', { reason: 'the surveyor failed twice', conventions: [{ path: '/home/u/CLAUDE.md', level: 'user', governs: 'the reviewer\'s own rules', appliesTo: null, grounds: 'applied by the policy value apply' }], userRules: [{ path: '/home/u/CLAUDE.md', applied: true, reason: 'applied by the policy value apply' }] })
    .finish('survey', 'degraded');
  const withoutSurvey = (): History => withDecisions(withSurvey(reported(), failedSurvey, 'apply'));

  it('continues a run that went on without its survey only with the checks planned, its survey left as it degraded', () => {
    const review = withoutSurvey().add('fix.pinned', pin(flagPlan)).review();
    assert.deepEqual(review.phases.survey, { status: 'degraded', attempt: 1 });
    assert.deepEqual(review.fix?.checks.planned?.checks, foldedChecks(flagPlan));
  });

  // R6 of the configuration: the fix side of the settings a continuation resolved.
  describe('a version 2 pin', () => {
    const fixSide = {
      values: { 'checks.build': 'npm run build', 'checks.typecheck': false, 'checks.lint': null, 'checks.test': 'npm test', 'tools.path': ['/w/.venv/bin'] },
      layers: { 'checks.build': 'repository', 'checks.typecheck': 'flag', 'checks.lint': 'default', 'checks.test': 'clone', 'checks.timeout_minutes': 'repository', 'tools.path': 'clone' },
      files: [], repository: { state: 'absent', commit: '1'.repeat(40), edited: false }, notFollowed: [], ignored: [],
    };
    const settledPlan = [
      { kind: 'build', command: 'npm run build', origin: 'setting', layer: 'repository', reason: null, source: null },
      { kind: 'typecheck', command: null, origin: 'setting', layer: 'flag', reason: 'dropped by --no-check', source: null },
      { kind: 'lint', command: 'npm run lint', origin: 'setting', layer: 'operator', reason: null, source: null },
      { kind: 'test', command: 'npm test', origin: 'setting', layer: 'clone', reason: null, source: null },
    ];

    it('folds the fix side beside the configuration, the survey asked again for the kinds no setting settles', () => {
      const review = readOnlyReported().add('fix.pinned', { ...pin(), settings: fixSide }, 2).review();
      assert.deepEqual(review.configuration.fixSettings, fixSide);
      assert.deepEqual(review.configuration.checks, { timeoutMs: 300_000 });
      assert.equal(review.fix?.checks.planned, null);
      assert.deepEqual(review.phases.survey, { status: 'pending', attempt: 1 });
    });

    it('plans the settings\' checks with the pin when they settle every kind, each with its layer', () => {
      const review = readOnlyReported().add('fix.pinned', { ...pin(settledPlan), settings: { ...fixSide, values: { ...fixSide.values, 'checks.lint': 'npm run lint' }, layers: { ...fixSide.layers, 'checks.lint': 'operator' } } }, 2).review();
      assert.deepEqual(review.fix?.checks.planned, { checks: settledPlan, manager: null });
      assert.deepEqual(review.phases.survey, { status: 'completed', attempt: 1 });
    });

    it('reads a version 1 pin as recording no fix side, its flags\' checks as settings of the flag layer', () => {
      const review = readOnlyReported().add('fix.pinned', pin(flagPlan)).review();
      assert.equal(review.configuration.fixSettings, null);
      assert.ok(review.fix?.checks.planned?.checks.every((check) => check.origin === 'setting' && check.layer === 'flag'));
    });

    it('refuses a pin whose planned checks are not all settings\', and one without its fix side', () => {
      const withSurvey = [...settledPlan.slice(0, 3), { kind: 'test', command: 'npm test', origin: 'survey', layer: null, reason: null, source: { path: 'package.json', quote: '"test"', basis: 'stated' } }];
      for (const payload of [{ ...pin(withSurvey), settings: fixSide }, pin(settledPlan), { ...pin(), settings: { ...fixSide, layers: { ...fixSide.layers, 'checks.timeout_minutes': undefined } } }]) {
        assert.throws(() => readOnlyReported().add('fix.pinned', payload, 2).fold(), /fix\.pinned@2\) has a payload its schema rejects/);
      }
    });
  });

  const refusals: [name: string, build: () => History, message: RegExp][] = [
    ['a pin before the report', () => decidedOf(ranked()).add('fix.pinned', pin()), /continues into the fix pass before its report/],
    ['a second pin', () => continuedRun().add('fix.pinned', pin()), /continues into the fix pass before its report/],
    ['a pin after the continued run\'s second report', () => continuedToReport().add('fix.pinned', pin()), /continues into the fix pass a run that fixes already/],
    ['a pin on an abandoned run', () => readOnlyReported().add('run.abandoned', { reason: 'r' }).add('fix.pinned', pin()), /was abandoned/],
    ['a pin of a run configured before the survey', () => reported().add('fix.pinned', pin()), /configured before the survey existed/],
    ['a pin of a run configured before the decision step with findings ranked', () => withSurvey(reported(), quietSurvey(false)).add('fix.pinned', pin()), /continues a run configured before the decision step, which routed by verdict and angle/],
    ['a pin of a run that went on without its survey with no checks planned', () => withoutSurvey().add('fix.pinned', pin()), /continues a run that went on without its survey with no checks planned/],
    ['a pin whose plan names the survey\'s checks', () => readOnlyReported().add('fix.pinned', pin(quietPlannedChecks.checks)), /schema rejects/],
    ['the baseline started before the checks are planned', () => continuedRun().start('baseline-checks'), /starts baseline-checks before its checks are planned/],
  ];
  for (const [name, build, message] of refusals) {
    it(`refuses ${name}`, () => {
      assert.throws(() => build().fold(), (error: unknown) => error instanceof InvalidHistoryError && message.test(error.message), name);
    });
  }
});

describe('the records of resumable runs', () => {
  const commandOf = (kind: string): string => plannedChecks.checks.find((check) => check.kind === kind)?.command ?? 'none';
  const started = (phase: string, kind: string, attempt = 1): Record<string, unknown> => ({ phase, attempt, kind, command: commandOf(kind) });
  const ranV3 = (phase: string, kind: string, outcome = 'passed', attempt = 1, replaces: Record<string, unknown> | null = null, change: Record<string, unknown> = {}): Record<string, unknown> => ({ ...checkRun(phase, kind, outcome, attempt), replaces, ...change });
  /** A check that ran at version 3: its start, then its run. */
  const ranWithStart = (history: History, phase: string, kind: string, outcome = 'passed', attempt = 1, replaces: Record<string, unknown> | null = null, change: Record<string, unknown> = {}): History =>
    history.add('check.started', started(phase, kind, attempt)).add('check.ran', ranV3(phase, kind, outcome, attempt, replaces, change), 3);
  const refused = (history: History, message: RegExp): void => {
    assert.throws(() => history.fold(), (error: unknown) => error instanceof InvalidHistoryError && message.test(error.message), message.source);
  };
  /** A fix run in its baseline, at attempt 1, with no check run yet. */
  const inBaseline = (): History => withFixPass(mergeRanked()).start('baseline-checks');
  /** The review as the run-state questions read it, with its fix state. */
  const withFix = (history: History): ReviewState & { readonly fix: FixState } => {
    const review = history.review();
    return { ...review, fix: review.fix! };
  };

  it('folds a check\'s start and its run at version 3 in ledger order, each run with the revisions before it (TD3)', () => {
    const fix = ranWithStart(inBaseline(), 'baseline-checks', 'build').review().fix!;
    assert.deepEqual(fix.checks.starts['baseline-checks'].map((start) => [start.kind, start.attempt, start.runsBefore]), [['build', 1, 0]]);
    assert.deepEqual(fix.checks.runs['baseline-checks'].map((run) => [run.kind, run.outcome, run.replaces, run.revisionsBefore]), [['build', 'passed', null, 0]]);
    const after = fixed().review().fix!;
    assert.deepEqual(after.checks.runs['baseline-checks'].map((run) => [run.replaces, run.revisionsBefore, run.replacedAt]), [[null, 0, null], [null, 0, null], [null, 0, null]], 'a version 2 run replaces nothing');
    assert.deepEqual(after.checks.finished, { 'baseline-checks': 1, checks: 0, 'base-checks': 0, 'repair-checks': 0, 'answer-checks': 0 }, 'the baseline finished its first attempt');
  });

  it('refuses a version 3 run with no start of its own, a start of a kind that ran, and a second start with no run between (R7)', () => {
    refused(inBaseline().add('check.ran', ranV3('baseline-checks', 'build'), 3), /with no start of it in attempt 1/);
    refused(ranWithStart(inBaseline(), 'baseline-checks', 'build').add('check.started', started('baseline-checks', 'build')), /starts the build check in baseline-checks, whose last current run is its result/);
    refused(inBaseline().add('check.started', started('baseline-checks', 'build')).add('check.started', started('baseline-checks', 'build')), /starts the build check twice in attempt 1/);
    refused(inBaseline().add('check.started', { ...started('baseline-checks', 'build'), command: 'make' }), /starts "make" for the build check, pinned as "npm run build"/);
    assert.doesNotThrow(() => inBaseline().add('check.ran', ranV3('baseline-checks', 'lint', 'skipped'), 3).fold(), 'a skipped check never started');
  });

  it('runs again in a cut attempt only a kind whose last current run did not pass, and names it (R3)', () => {
    // Attempt 1 ran build and failed lint, and a stop cut it before test and before its phase.finished.
    const cut = ranWithStart(ranWithStart(inBaseline(), 'baseline-checks', 'build'), 'baseline-checks', 'lint', 'failed').start('baseline-checks', 2);
    const review = withFix(cut);
    assert.equal(isCutAttempt(review, 'baseline-checks', 1), true);
    assert.equal(isCutAttempt(review, 'baseline-checks', 2), false, 'the current attempt is never cut');
    assert.deepEqual(runStanding(review, 'baseline-checks', 'lint'), { kind: 'again', run: review.fix.checks.runs['baseline-checks'][1], why: 'cut-attempt' });
    assert.equal(runStanding(review, 'baseline-checks', 'build'), null, 'a kind that passed stays passed');
    assert.deepEqual(runStanding(review, 'baseline-checks', 'test'), { kind: 'first' });
    const rerun = ranWithStart(cut.clone(), 'baseline-checks', 'lint', 'passed', 2, { attempt: 1, outcome: 'failed' }).review().fix!;
    assert.deepEqual(rerun.checks.runs['baseline-checks'].map((run) => [run.kind, run.attempt, run.outcome, run.replacedAt]), [['build', 1, 'passed', null], ['lint', 1, 'failed', null], ['lint', 2, 'passed', 1]], 'the rerun keeps where the run it replaces is');
    refused(ranWithStart(cut.clone(), 'baseline-checks', 'lint', 'passed', 2), /as its first, when it has a current run there/);
    refused(ranWithStart(cut.clone(), 'baseline-checks', 'lint', 'passed', 2, { attempt: 1, outcome: 'timeout' }), /replacing a timeout run at attempt 1, which is not its last current run/);
    refused(cut.clone().add('check.started', started('baseline-checks', 'build', 2)), /whose last current run is its result/);
    // A failure in a finished attempt is its result: only a cut attempt is run again.
    const finished = ranWithStart(inBaseline(), 'baseline-checks', 'lint', 'failed').finish('baseline-checks', 'blocked', 1, { code: 'drift', detail: 'd', action: 'a' }).start('baseline-checks', 2);
    refused(finished.add('check.started', started('baseline-checks', 'lint', 2)), /whose last current run is its result/);
  });

  it('runs a cut check again in its own attempt, and refuses a second cut of a kind in one attempt (R4)', () => {
    const cut = ranWithStart(inBaseline(), 'baseline-checks', 'build', 'cut', 1, null, { exitCode: 143 });
    assert.equal(runStanding(withFix(cut), 'baseline-checks', 'build')?.kind, 'again');
    assert.doesNotThrow(() => ranWithStart(cut.clone(), 'baseline-checks', 'build', 'passed', 1, { attempt: 1, outcome: 'cut' }).fold());
    refused(ranWithStart(cut.clone(), 'baseline-checks', 'build', 'cut', 1, { attempt: 1, outcome: 'cut' }, { exitCode: 143 }), /second cut of the build check in one attempt/);
    // A cut of an earlier attempt is replaced by a cut of the next one, the next attempt's first.
    assert.doesNotThrow(() => ranWithStart(cut.clone().start('baseline-checks', 2), 'baseline-checks', 'build', 'cut', 2, { attempt: 1, outcome: 'cut' }, { exitCode: 143 }).fold());
  });

  it('runs a check that timed out again once in its attempt, and takes its second timeout as the result (R7, PD7)', () => {
    const timedOut = ranWithStart(inBaseline(), 'baseline-checks', 'test', 'timeout');
    assert.equal(runStanding(withFix(timedOut), 'baseline-checks', 'test')?.kind, 'again');
    const twice = ranWithStart(timedOut.clone(), 'baseline-checks', 'test', 'timeout', 1, { attempt: 1, outcome: 'timeout' });
    assert.equal(runStanding(withFix(twice), 'baseline-checks', 'test'), null, 'the second timeout is the result');
    refused(twice.clone().add('check.started', started('baseline-checks', 'test')), /whose last current run is its result/);
  });

  it('makes a run old only by a later revision of the state its phase checks, never a baseline run (TD3)', () => {
    const review = withFix(checksPhase(fixed(), 'checks'));
    const fix = review.fix;
    const run = fix.checks.runs.checks[0]!;
    assert.equal(isOldRun(fix, 'checks', run), false);
    const revisionIn = (phase: string, source: Record<string, unknown>): TreeRevised => ({ phase, source, change: { findings: [], message: { subject: 's', body: '' } }, files: [] }) as unknown as TreeRevised;
    const later = { ...fix, revisions: [...fix.revisions, revisionIn('answer', { kind: 'attempt', key: 'pass-1', workerId: worker(70) })] };
    assert.equal(isOldRun(later, 'checks', run), true, 'an answer pass revised the tree the checks after the fixes checked');
    assert.equal(isOldRun(later, 'answer-checks', run), false, 'an answer pass runs answer-checks again by its floor, not by age');
    assert.equal(isOldRun(later, 'baseline-checks', fix.checks.runs['baseline-checks'][0]!), false, 'a baseline run checks the tree before every edit');
    assert.equal(isOldRun({ ...fix, revisions: [...fix.revisions, revisionIn('checks', { kind: 'check', check: 'lint' })] }, 'checks', run), false, 'a check\'s own writes make no run old');
    assert.equal(isOldRun({ ...fix, revisions: [...fix.revisions, revisionIn('repair', { kind: 'attempt', key: 'repair', workerId: worker(71) })] }, 'repair-checks', run), true, 'a revision of the repair makes a run after the repair old');
    assert.equal(lastCurrentRun({ ...review, fix: later }, 'checks', 'build'), null);
    assert.equal(lastCurrentRun(review, 'checks', 'build'), run);
  });

  it('folds a write back after a check it knows, and a check of the tree after it (R7, TD7)', () => {
    const file = { path: 'src/a.ts', before: { blob: reference('5') }, beforeSymlink: false, expected: { blob: reference('a') }, expectedSymlink: false };
    const cut = inBaseline().add('check.started', started('baseline-checks', 'lint')).start('baseline-checks', 2);
    const restored = cut.clone().add('tree.restored', { phase: 'baseline-checks', attempt: 2, check: { kind: 'lint', attempt: 1 }, files: [file] }).add('worktree.checked', { phase: 'baseline-checks', attempt: 2, moment: 'restored', drifted: false, head: null, files: [], strays: [] }, 6);
    const review = restored.review();
    assert.deepEqual(review.fix!.restorations.map((restoration) => [restoration.check.kind, restoration.files.length, restoration.checksBefore]), [['lint', 1, review.checks.length - 1]]);
    assert.equal(review.checks.at(-1)!.moment, 'restored');
    refused(cut.clone().add('tree.restored', { phase: 'baseline-checks', attempt: 2, check: { kind: 'test', attempt: 1 }, files: [] }), /after the test check of attempt 1 in baseline-checks, which never started there/);
    refused(cut.clone().add('tree.restored', { phase: 'baseline-checks', attempt: 2, check: { kind: 'lint', attempt: 3 }, files: [] }), /past the phase's attempt 2/);
    refused(cut.clone().add('worktree.checked', { phase: 'baseline-checks', attempt: 2, moment: 'restored', drifted: false, head: null, files: [], strays: [] }, 6), /after a write back in attempt 2 of baseline-checks, which wrote nothing back/);
  });

  it('folds a cut worker and a usage limit as failures of their own causes, and the environment only in the fixes (R4, R14)', () => {
    const inFixes = (): History => baselined().start('fixes').add('fixes.planned', fixPlan);
    const review = inFixes()
      .add('attempt.failed', { phase: 'fixes', key: 'c1-1', workerId: worker(2), reason: 'killed', fault: 'cut' }, 7)
      .add('attempt.failed', { phase: 'fixes', key: 'c1-1', workerId: worker(3), reason: 'the session limit', fault: 'limit' }, 7)
      .review();
    assert.deepEqual(review.units.fixes['c1-1']?.failures.map((failure) => failure.cause), ['cut', 'limit']);
    refused(inBaseline().add('attempt.failed', { phase: 'baseline-checks', key: 'build', workerId: worker(2), reason: 'r', fault: 'environment' }, 7), /for its environment, which only a fixes-phase unit records/);
  });

  /** A complete fix run whose budget left c1-1 not attempted, with no revision, its report written. */
  const budgetStopped = (): History => baselined()
    .start('fixes')
    .add('fixes.planned', fixPlan)
    .add('unit.unattempted', { phase: 'fixes', key: 'c1-1', cause: 'budget', reason: 'spent 61.16 USD of the 60.00 USD run budget' })
    .add('fixes.replanned', { blocked: [], clusters: [], batches: [] })
    .add('worktree.checked', endCheck('fixes'), 2)
    .finish('fixes', 'degraded')
    .start('checks').finish('checks').start('repair').finish('repair').start('repair-checks').finish('repair-checks')
    .start('report').add('report.written', { report: reference('e', 2048), statistics, patches: [] }, 2).finish('report');

  it('reopens a fix pass the run budget stopped: its units launch again, the later phases are pending, and the report is kept beside it (R11)', () => {
    const before = budgetStopped().review();
    assert.equal(reviewStatus(budgetStopped().fold()), 'complete');
    const reopened = budgetStopped().add('fix.reopened', { units: [{ phase: 'fixes', key: 'c1-1' }] });
    const review = reopened.review();
    assert.deepEqual(review.fix!.notAttempted.fixes, {});
    assert.equal(review.report, null);
    assert.equal(review.reportSetAsideBy, 'reopened-fix-pass');
    assert.deepEqual(review.fix!.reopenings.map((reopening) => [reopening.units, reopening.reportBefore]), [[[{ phase: 'fixes', key: 'c1-1' }], before.report]]);
    for (const phase of ['fixes', 'checks', 'repair', 'repair-checks', 'report'] as const) assert.deepEqual(review.phases[phase], { status: 'pending', attempt: before.phases[phase].attempt }, phase);
    assert.equal(review.phases['merge-rank'].status, 'completed', 'no read-only phase opens again');
    assert.equal(reviewStatus(reopened.fold()), 'active');
    assert.doesNotThrow(() => reopened.clone().add('limits.changed', { concurrency: 4, runBudgetUsd: 120 }).fold(), 'the reopened run takes new limits, its report cleared');
    assert.doesNotThrow(() => reopened.clone().start('fixes', 2).fold(), 'the fixes start again');
  });

  it('refuses to reopen a run with no report or with a list other than the units the budget stopped', () => {
    refused(baselined().add('fix.reopened', { units: [{ phase: 'fixes', key: 'c1-1' }] }), /reopens the fix pass before its report/);
    refused(budgetStopped().add('fix.reopened', { units: [{ phase: 'repair', key: 'repair' }] }), /reopens \[repair:repair\], not each unit the run budget left not attempted \[fixes:c1-1\]/);
    refused(complete().add('fix.reopened', { units: [{ phase: 'fixes', key: 'c1-1' }] }), /not each unit the run budget left not attempted \[\]/);
  });

  /** A complete fix run with one revision, ready to commit. */
  function complete(): History {
    return checksPhase(fixed(), 'checks').start('repair').finish('repair').start('repair-checks').finish('repair-checks').start('report').add('report.written', { report: reference('e'), statistics, patches: [reference('1')] }, 2).finish('report');
  }
  const series = { commits: [{ sha: commit('a'), revision: 'change', subject: 'the change' }, { sha: commit('b'), revision: 0, subject: 'fix: Guard the null' }], from: '2'.repeat(40), to: commit('b') };

  it('keeps a prepared series open, the run\'s head where it was, until it is created or dropped (R9)', () => {
    const prepared = complete().add('commits.prepared', series);
    const open = prepared.fold();
    assert.deepEqual(open.review!.fix!.openSeries, series);
    assert.equal(runHead(open), '2'.repeat(40), 'the head does not move for an open series');
    const created = prepared.clone().add('commits.created', series).review().fix!;
    assert.equal(created.openSeries, null);
    assert.deepEqual(created.commits, [series]);
    const dropped = prepared.clone().add('commits.dropped', { from: series.from, to: series.to }).review().fix!;
    assert.equal(dropped.openSeries, null);
    assert.deepEqual(dropped.droppedSeries, [series]);
    assert.deepEqual(dropped.commits, []);
    assert.doesNotThrow(() => prepared.clone().add('commits.dropped', { from: series.from, to: series.to }).add('commits.prepared', series).add('commits.created', series).fold(), 'a dropped series is prepared again');
  });

  it('gives an engine before these records a run that holds one as unreadable, naming the first, which this engine folds (R16)', () => {
    const older = modelWithout(resumableRunsEntries);
    const ranAt2 = (): History => inBaseline().add('check.ran', checkRun('baseline-checks', 'lint', 'failed')).start('baseline-checks', 2);
    const histories: [string, History][] = [
      ['check.started@1', inBaseline().add('check.started', started('baseline-checks', 'build'))],
      ['check.ran@3', inBaseline().add('check.ran', ranV3('baseline-checks', 'lint', 'skipped'), 3)],
      ['tree.restored@1', ranAt2().add('tree.restored', { phase: 'baseline-checks', attempt: 2, check: { kind: 'lint', attempt: 1 }, files: [] })],
      ['worktree.checked@6', inBaseline().add('worktree.checked', { phase: 'baseline-checks', attempt: 1, moment: 'answer', drifted: false, head: null, files: [], strays: [] }, 6)],
      ['attempt.failed@7', baselined().start('fixes').add('fixes.planned', fixPlan).add('attempt.failed', { phase: 'fixes', key: 'c1-1', workerId: worker(2), reason: 'killed', fault: 'cut' }, 7)],
      ['fix.reopened@1', budgetStopped().add('fix.reopened', { units: [{ phase: 'fixes', key: 'c1-1' }] })],
      // A dropped series always follows its prepared one, which an older engine meets first.
      ['commits.prepared@1', complete().add('commits.prepared', series).add('commits.dropped', { from: series.from, to: series.to })],
    ];
    for (const [first, history] of histories) {
      assert.doesNotThrow(() => history.fold(), first);
      const unknown = firstUnknownEvent(history.events, older);
      assert.equal(unknown === null ? null : `${unknown.kind}@${String(unknown.version)}`, first);
    }
    assert.equal(firstUnknownEvent(fixed().events, older), null, 'a run with none of them is read as before');
  });

  it('refuses a series created otherwise than prepared, a second prepared series, and a drop of a series that is not open', () => {
    const prepared = complete().add('commits.prepared', series);
    refused(prepared.clone().add('commits.created', { ...series, commits: [series.commits[0], { ...series.commits[1], sha: commit('c') }], to: commit('c') }), /while the series it prepared to b{40} is open/);
    refused(prepared.clone().add('commits.prepared', series), /prepares a series of commits while the series to b{40} is open/);
    refused(complete().add('commits.dropped', { from: series.from, to: series.to }), /drops the series from 2{40} to b{40}, which is not the open series/);
    refused(complete().add('commits.prepared', { ...series, from: '3'.repeat(40) }), /prepares commits on 3{40}, not the run's head 2{40}/);
  });
});

// R2, R5, R8, TD2, TD11 and TD12 of the documentation step.
describe('the documentation step in the fix state', () => {
  const refused = (history: History, message: RegExp): void => {
    assert.throws(() => history.fold(), (error: unknown) => error instanceof InvalidHistoryError && message.test(error.message), message.source);
  };
  const testingLine = { file: './docs/testing.md', what: 'the echo no longer removes the bytes' };
  const changesLine = { file: 'CHANGES.md', what: 'the bytes are always translated' };
  /** A decided fix run with the step, through its baseline. */
  const atBaseline = (): History => withDocumentationStep(checksPhase(decidedOf(withFixPass(mergeRanked())), 'baseline-checks'), null);
  /** The same run through its fixes: c1-1 answers RIPPLE-1 with `drift`, and revises src/a.ts unless `revised` is false. */
  const throughFixes = (drift: readonly Record<string, unknown>[] = [testingLine, changesLine, testingLine], revised = true): History => {
    const history = atBaseline().start('fixes').add('fixes.planned', fixPlan).worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50), { drift }));
    if (revised) history.add('tree.revised', fixRevision(worker(50)));
    return history.add('fixes.replanned', noSecondRound).add('worktree.checked', endCheck('fixes'), 2).finish('fixes');
  };
  const items = (history: History): DocumentationItem[] => documentationItems(history);
  /** The step started after the fixes and its plan recorded. */
  const planned = (history: History = throughFixes()): History => {
    history.start('documentation');
    return history.add('documentation.planned', { items: items(history) });
  };

  it('records the plan, whose items are the units\' ids, and owns the fixes\' paths and each resolved document', () => {
    const history = planned();
    const review = history.review();
    assert.deepEqual(review.fix?.documentation?.items.map((item) => [item.id, item.file, item.path, item.drift.length]), [['doc-1', './docs/testing.md', 'docs/testing.md', 2], ['doc-2', 'CHANGES.md', 'CHANGES.md', 1], ['search', null, null, 0]]);
    assert.deepEqual(unitIdsOf(review, 'documentation', 'documentation'), ['doc-1', 'doc-2', 'search']);
    assert.equal(unitIdsOf(review, 'documentation', 'other'), null, 'the step has one unit');
    assert.equal(unitIdsOf(throughFixes().review(), 'documentation', 'documentation'), null, 'no unit before the plan');
    assert.deepEqual(ownedFiles(review, 'documentation', 'documentation'), ['CHANGES.md', 'docs/testing.md', 'src/a.ts']);
  });

  it('refuses a plan before the phase runs, a second plan, a plan with no revision of the fixes, and a plan while the run budget leaves a unit of the fixes', () => {
    const fixes = throughFixes();
    refused(fixes.clone().add('documentation.planned', { items: items(fixes) }), /has documentation.planned for phase documentation while it is pending/);
    refused(planned().add('documentation.planned', { items: items(fixes) }), /plans its documentation step twice/);
    const unrevised = throughFixes([testingLine], false).start('documentation');
    refused(unrevised.add('documentation.planned', { items: items(unrevised) }), /plans its documentation step for fixes that revised nothing/);
    const stopped = atBaseline().start('fixes').add('fixes.planned', fixPlan)
      .add('unit.unattempted', { phase: 'fixes', key: 'c1-1', cause: 'budget', reason: 'spent' })
      .add('fixes.replanned', noSecondRound).add('worktree.checked', endCheck('fixes'), 2).finish('fixes', 'degraded')
      .start('documentation');
    refused(stopped.add('documentation.planned', { items: [{ id: 'search', file: null, path: null, drift: [] }] }), /while the run budget leaves c1-1 of the fixes not attempted/);
  });

  it('refuses a plan that lists a line no answer of the fixes holds, lists one more often than it was reported, or leaves one out', () => {
    const fixes = throughFixes();
    const [testing, changes, search] = items(fixes) as [DocumentationItem, DocumentationItem, DocumentationItem];
    const plan = (...given: DocumentationItem[]): History => fixes.clone().start('documentation').add('documentation.planned', { items: given });
    assert.doesNotThrow(() => plan(testing, changes, search).fold());
    assert.doesNotThrow(() => plan({ ...changes, id: 'doc-1' }, { ...testing, id: 'doc-2' }, search).fold(), 'the fold holds the lines, not how they are grouped');
    refused(plan({ ...testing, drift: [...testing.drift, { key: 'c1-1', file: 'README.md', what: 'parse throws' }] }, changes, search), /plans the drift line "parse throws" on README.md for c1-1 under doc-1, which no answer of the fixes holds/);
    refused(plan({ ...testing, drift: [...testing.drift, testing.drift[0]!] }, changes, search), /holds fewer times than the plan lists it/);
    refused(plan({ ...testing, drift: [{ ...testing.drift[0]!, key: 'c2-1' }, testing.drift[1]!] }, changes, search), /for c2-1 under doc-1, which no answer of the fixes holds/);
    refused(plan({ ...testing, drift: [testing.drift[0]!] }, changes, search), /without the drift lines .*the echo no longer removes the bytes.* of the fixes/);
    refused(plan(testing, search), /without the drift lines .*CHANGES\.md.* of the fixes/);
    refused(plan(search), /without the drift lines/);
  });

  it('refuses, by its schema, ids out of order, a search with a file, and two items with one path', () => {
    const fixes = throughFixes();
    const [testing, changes, search] = items(fixes) as [DocumentationItem, DocumentationItem, DocumentationItem];
    const plan = (...given: unknown[]): History => fixes.clone().start('documentation').add('documentation.planned', { items: given });
    refused(plan({ ...changes, id: 'doc-2' }, { ...testing, id: 'doc-1' }, search), /payload its schema rejects/);
    refused(plan(testing, changes, { ...search, file: 'docs/a.md' }), /payload its schema rejects/);
    refused(plan(testing, { ...changes, path: 'docs/testing.md' }, search), /payload its schema rejects/);
  });

  it('records the step\'s answer by its items, with no violation, and refuses one that answers other ids', () => {
    const history = planned();
    const ids = items(history).map((item) => item.id);
    const answered = history.clone().worker(55, 'documentation documentation:documentation').add('fix.recorded', documentationAnswer(worker(55), ids.map((id) => [id, 'already-applied'])), 3);
    const review = answered.review();
    assert.equal(isAnswered(review, 'documentation', 'documentation'), true);
    assert.deepEqual(review.fix?.answers.documentation.documentation?.findings.map((finding) => finding.id), ids);
    refused(history.clone().worker(55, 'documentation documentation:documentation').add('fix.recorded', documentationAnswer(worker(55), [['doc-1', 'applied'], ['search', 'already-applied']]), 3), /answers \[doc-1, search\] for documentation:documentation, which holds \[doc-1, doc-2, search\]/);
    refused(history.clone().worker(55, 'documentation documentation:documentation').add('fix.recorded', documentationAnswer(worker(55), ids.map((id) => [id, 'already-applied'])), 2), /payload its schema rejects/);
    refused(history.clone().worker(55, 'documentation documentation:documentation').add('fix.recorded', documentationAnswer(worker(55), ids.map((id) => [id, 'already-applied']), { violations: ['docs/testing.md'] }), 3), /records a violation on docs\/testing.md, which is not a reported file another cluster holds/);
  });

  it('settles the step\'s unit as not attempted once it has a plan, and only then', () => {
    const settled = planned().add('unit.unattempted', { phase: 'documentation', key: 'documentation', cause: 'failures', reason: '2 attempts did not complete' }, 2).review();
    assert.deepEqual(settled.fix?.notAttempted.documentation, { documentation: { cause: 'failures', reason: '2 attempts did not complete' } });
    assert.deepEqual(budgetStoppedUnits(settled.fix!), [], 'two failures are no stop of the run budget');
    refused(throughFixes().start('documentation').add('unit.unattempted', { phase: 'documentation', key: 'documentation', cause: 'budget', reason: 'spent' }, 2), /settles documentation:documentation, which the phase does not have/);
  });

  /** The rest of a fix run with the step, from the step's end to its report, at the first attempt of each phase. */
  const toReport = (history: History, patches: number): History => checksPhase(history, 'checks')
    .start('repair').finish('repair').start('repair-checks').finish('repair-checks')
    .start('report').add('report.written', { report: reference('e', 2048), statistics, patches: Array.from({ length: patches }, (_, index) => reference(String(index + 1))) }, 2).finish('report');

  it('reopens the step with the fixes when the run budget stopped a batch, so it plans after them (TD12)', () => {
    const stopped = atBaseline().start('fixes').add('fixes.planned', fixPlan)
      .add('unit.unattempted', { phase: 'fixes', key: 'c1-1', cause: 'budget', reason: 'spent' })
      .add('fixes.replanned', noSecondRound).add('worktree.checked', endCheck('fixes'), 2).finish('fixes', 'degraded')
      .start('documentation').finish('documentation', 'degraded');
    const before = toReport(stopped, 0);
    const review = before.clone().add('fix.reopened', { units: [{ phase: 'fixes', key: 'c1-1' }] }).review();
    assert.deepEqual(review.phases.fixes, { status: 'pending', attempt: 1 });
    assert.deepEqual(review.phases.documentation, { status: 'pending', attempt: 1 });
    assert.equal(review.fix?.documentation, null);
  });

  it('reopens the step alone when the run budget left its unit, with its plan, and lists that unit only at version 2', () => {
    const stoppedStep = planned().add('unit.unattempted', { phase: 'documentation', key: 'documentation', cause: 'budget', reason: 'spent' }, 2).add('worktree.checked', endCheck('documentation'), 7).finish('documentation', 'degraded');
    const before = toReport(stoppedStep, 1);
    assert.deepEqual(budgetStoppedUnits(before.review().fix!), [{ phase: 'documentation', key: 'documentation' }]);
    const reopened = before.clone().add('fix.reopened', { units: [{ phase: 'documentation', key: 'documentation' }] }, 2);
    const review = reopened.review();
    assert.deepEqual(review.phases.documentation, { status: 'pending', attempt: 1 });
    assert.deepEqual(review.phases.fixes, { status: 'completed', attempt: 1 }, 'the fixes stay as they finished');
    assert.deepEqual(review.fix?.notAttempted.documentation, {});
    assert.deepEqual(review.fix?.documentation?.items.map((item) => item.id), ['doc-1', 'doc-2', 'search'], 'the plan stands');
    assert.doesNotThrow(() => reopened.clone().start('documentation', 2).fold());
    refused(before.clone().add('fix.reopened', { units: [{ phase: 'documentation', key: 'documentation' }] }, 1), /payload its schema rejects/);
  });

  it('keeps the step skipped when a run configured before it reopens its fixes', () => {
    const stopped = baselined().start('fixes').add('fixes.planned', fixPlan)
      .add('unit.unattempted', { phase: 'fixes', key: 'c1-1', cause: 'budget', reason: 'spent' })
      .add('fixes.replanned', noSecondRound).add('worktree.checked', endCheck('fixes'), 2).finish('fixes', 'degraded');
    const review = toReport(stopped, 0).add('fix.reopened', { units: [{ phase: 'fixes', key: 'c1-1' }] }).review();
    assert.deepEqual(review.phases.documentation, { status: 'skipped', attempt: 0 });
    assert.deepEqual(review.phases.fixes, { status: 'pending', attempt: 1 });
  });

  it('gives an engine before the step a run that holds one of its records as unreadable, and reads a run configured before it as it was', () => {
    const older = modelWithout(documentationStepEntries);
    const run = toReport(planned().worker(55, 'documentation documentation:documentation').add('fix.recorded', documentationAnswer(worker(55), [['doc-1', 'already-applied'], ['doc-2', 'already-applied'], ['search', 'already-applied']]), 3).add('worktree.checked', endCheck('documentation'), 7).finish('documentation'), 1);
    assert.doesNotThrow(() => run.fold());
    const unknown = firstUnknownEvent(run.events, older);
    assert.equal(unknown === null ? null : `${unknown.kind}@${String(unknown.version)}`, 'review.configured@7', 'the configuration comes first');
    assert.equal(firstUnknownEvent(fixed().events, older), null);
    assert.equal(firstUnknownEvent(decidedFixRun().events, older), null);
  });
});

// R1, R2, R10, R11, TD4, TD5, TD6, TD14 and TD15 of the facts before a merge.
describe('the checks on the base in the fix state', () => {
  const refused = (history: History, message: RegExp): void => {
    assert.throws(() => history.fold(), (error: unknown) => error instanceof InvalidHistoryError && message.test(error.message), message.source);
  };
  const withFix = (history: History): ReviewState & { readonly fix: FixState } => {
    const review = history.review();
    return { ...review, fix: review.fix! };
  };
  const startOnBase = (kind: string, attempt = 1): Record<string, unknown> => ({ phase: 'base-checks', attempt, kind, command: plannedChecks.checks.find((check) => check.kind === kind)!.command });
  /** The documentation step with its unit left by the run budget, as `withDocumentationStep` takes a step. */
  const budgetStopped = (history: History): History => {
    history.start('documentation');
    return history.add('documentation.planned', { items: documentationItems(history) })
      .add('unit.unattempted', { phase: 'documentation', key: 'documentation', cause: 'budget', reason: 'spent' }, 2)
      .add('worktree.checked', endCheck('documentation'), 7).finish('documentation', 'degraded');
  };
  /**
   * A decided fix run with the documentation step, configured at version 8
   * with the checks on the base unless `compared` is false, through its
   * fixes, where c1-1 applies RIPPLE-1, and its documentation step as
   * `step` records it, with the checks before the fixes as `before` gives.
   */
  const throughFixes = (before: Readonly<Record<string, string>> = { lint: 'failed' }, compared = true, step: (history: History) => History = documentationAnswered): History => {
    const atBaseline = withDocumentationStep(checksPhase(decidedOf(withFixPass(mergeRanked())), 'baseline-checks', before), null);
    const history = (compared ? withBaseChecks(atBaseline) : atBaseline)
      .start('fixes').add('fixes.planned', fixPlan).worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50))).add('tree.revised', fixRevision(worker(50)))
      .add('fixes.replanned', noSecondRound).add('worktree.checked', endCheck('fixes'), 2).finish('fixes');
    return step(history);
  };
  /** The same run through the checks after its fixes, as `after` gives, and the start of its checks on the base. */
  const onBase = (before: Readonly<Record<string, string>> = { lint: 'failed' }, after: Readonly<Record<string, string>> = { lint: 'failed' }): History => checksPhase(throughFixes(before), 'checks', after).start('base-checks');
  /** The repair's answer, each kind it takes deferred, at version 4 with `comparisons`, or as earlier versions record it when they are null. */
  const repairAnswer = (kinds: readonly string[], comparisons: readonly Record<string, unknown>[] | null): Record<string, unknown> => ({
    ...fixAnswer(worker(60)), phase: 'repair', key: 'repair',
    findings: kinds.map((id) => ({ id, status: 'deferred', file: 'src/a.ts', line: null, note: 'every failure was there before the fixes', message: null, files: [], corrections: [], validation: [], requiredFiles: [] })),
    ...(comparisons === null ? {} : { comparisons }),
  });
  const same = { kind: 'lint', reading: 'same', words: 'the same two lint errors as on the base' };

  it('is pending in a run configured at version 8, and skipped in one at version 7, whose repair follows its checks (R10)', () => {
    const compared = throughFixes().review();
    assert.equal(compared.baseChecksStep, true);
    assert.deepEqual(compared.phases['base-checks'], { status: 'pending', attempt: 0 });
    refused(checksPhase(throughFixes(), 'checks', { lint: 'failed' }).start('repair'), /starts phase repair while phase base-checks is pending/);
    const older = checksPhase(throughFixes({ lint: 'failed' }, false), 'checks', { lint: 'failed' });
    assert.equal(older.review().baseChecksStep, false);
    assert.deepEqual(older.review().phases['base-checks'], { status: 'skipped', attempt: 0 });
    refused(older.clone().start('base-checks'), /starts phase base-checks, which this run skips: it was configured before the checks on the base existed/);
    assert.doesNotThrow(() => older.clone().start('repair').fold());
    assert.deepEqual(baseKinds(withFix(older).fix), ['lint'], 'the fold gives every run its kinds');
    assert.deepEqual(kindsTakenToBase(withFix(older)), [], 'a run configured before the phase takes none to the base');
    assert.deepEqual(kindsTakenToBase(withFix(checksPhase(throughFixes(), 'checks', { lint: 'failed' }))), ['lint']);
  });

  it('takes on the base the kinds that failed before the fixes and after them, and build while another of them is due (R1, TD4)', () => {
    const history = onBase({ lint: 'failed' }, { lint: 'failed', test: 'failed' });
    const fix = history.review().fix!;
    assert.deepEqual(repairTargets(fix), ['lint', 'test']);
    assert.deepEqual(baseKinds(fix), ['lint'], 'test passed before the fixes, so no base can say the change broke it');
    assert.equal(failingBaselineRun(fix, 'lint'), lastFreshRun(fix, 'baseline-checks', 'lint'));
    assert.equal(failingBaselineRun(fix, 'test'), null, 'test passed before the fixes');
    assert.equal(failingBaselineRun(onBase({ lint: 'timeout' }).review().fix!, 'lint')?.outcome, 'timeout', 'a timeout fails as the repair counts it');
    assert.equal(takenOnBase(withFix(history), 'build'), true, 'lint reads what build produces');
    refused(history.clone().add('check.started', startOnBase('test'), 2), /starts the test check on the base, which takes only \[lint\], and build while another of them is due/);
    refused(history.clone().add('check.ran', { ...checkRun('base-checks', 'test', 'skipped'), replaces: null }, 4), /runs the test check on the base, which takes only \[lint\]/);
    refused(history.clone().add('check.started', startOnBase('lint'), 1), /payload its schema rejects/);
    const done = ranOnBase(ranOnBase(history.clone(), 'build', 'passed'), 'lint', 'failed');
    assert.deepEqual(done.review().fix!.checks.runs['base-checks'].map((run) => [run.kind, run.outcome]), [['build', 'passed'], ['lint', 'failed']]);
    assert.equal(takenOnBase(withFix(done), 'build'), false, 'no kind is due once lint has its result');
    refused(done.clone().add('check.started', startOnBase('build'), 2), /starts the build check on the base, which takes only \[lint\]/);
    const unbuilt = ranOnBase(history.clone(), 'build', 'failed').add('check.ran', { ...checkRun('base-checks', 'lint', 'skipped'), replaces: null }, 4);
    assert.equal(lastFreshRun(unbuilt.review().fix!, 'base-checks', 'lint')?.outcome, 'skipped', 'a failed build on the base skips lint there');
  });

  it('takes a timeout on the base as its result, and runs a cut run, or a failure in a cut attempt, again (PD11, TD15)', () => {
    const built = ranOnBase(onBase(), 'build', 'passed');
    const timedOut = ranOnBase(built.clone(), 'lint', 'timeout');
    assert.equal(runStanding(withFix(timedOut), 'base-checks', 'lint'), null, 'no second run after a timeout on the base');
    refused(ranOnBase(timedOut.clone(), 'lint', 'failed', 1, { attempt: 1, outcome: 'timeout' }), /starts the lint check in base-checks, whose last current run is its result/);
    const cut = ranOnBase(built.clone(), 'lint', 'cut', 1, null, { exitCode: 143 });
    assert.equal(runStanding(withFix(cut), 'base-checks', 'lint')?.kind, 'again');
    assert.doesNotThrow(() => ranOnBase(cut.clone(), 'lint', 'failed', 1, { attempt: 1, outcome: 'cut' }).fold());
    const stopped = ranOnBase(built.clone(), 'lint', 'failed').start('base-checks', 2);
    const standing = runStanding(withFix(stopped), 'base-checks', 'lint');
    assert.equal(standing?.kind === 'again' ? standing.why : null, 'cut-attempt', 'a stop says nothing of the check');
  });

  it('builds the base again in a later attempt while another kind is due there, since each attempt makes its worktree anew (TD16)', () => {
    const stopped = ranOnBase(onBase(), 'build', 'passed').start('base-checks', 2);
    const standing = runStanding(withFix(stopped), 'base-checks', 'build');
    assert.deepEqual(standing?.kind === 'again' ? [standing.why, standing.run.attempt, standing.run.outcome] : null, ['earlier-worktree', 1, 'passed'], 'lint has not run, and the worktree that build prepared is gone');
    refused(ranOnBase(stopped.clone(), 'build', 'passed', 2), /runs the build check in base-checks as its first, when it has a current run there/);
    const rebuilt = ranOnBase(stopped.clone(), 'build', 'passed', 2, { attempt: 1, outcome: 'passed' });
    assert.deepEqual(rebuilt.review().fix!.checks.runs['base-checks'].map((run) => [run.kind, run.attempt, run.replacedAt]), [['build', 1, null], ['build', 2, 0]]);
    assert.equal(runStanding(withFix(rebuilt), 'base-checks', 'build'), null, 'built in this attempt');
    const done = ranOnBase(rebuilt.clone(), 'lint', 'failed', 2);
    assert.equal(takenOnBase(withFix(done), 'build'), false, 'nothing more is due once both ran in the attempt');
    refused(done.clone().add('check.started', startOnBase('build', 2), 2), /starts the build check on the base, which takes only \[lint\]/);
    const bothRan = ranOnBase(ranOnBase(onBase(), 'build', 'passed'), 'lint', 'passed').start('base-checks', 2);
    assert.equal(runStanding(withFix(bothRan), 'base-checks', 'build'), null, 'no kind is due in the new attempt, so nothing needs a build');
    const lintAgain = runStanding(withFix(ranOnBase(ranOnBase(onBase(), 'build', 'passed'), 'lint', 'failed').start('base-checks', 2)), 'base-checks', 'build');
    assert.equal(lintAgain?.kind === 'again' ? lintAgain.why : null, 'earlier-worktree', 'lint failed in the attempt the stop cut, so it runs again, and build before it');
    const failedBuild = ranOnBase(onBase(), 'build', 'failed').add('check.ran', { ...checkRun('base-checks', 'lint', 'skipped'), replaces: null }, 4).finish('base-checks');
    assert.equal(runStanding(withFix(failedBuild), 'base-checks', 'build'), null, 'a build that failed on the base in a finished attempt is its result');
  });

  it('never names a run or a start on the base as cut short, so a drift after a stop there blocks and nothing is written back (TD14)', () => {
    const stopped = ranOnBase(onBase(), 'build', 'passed').add('check.started', startOnBase('lint'), 2).start('base-checks', 2);
    const review = withFix(stopped);
    assert.notEqual(openStart(review.fix, 'base-checks', 'lint', 1), null, 'the stop left a start with no run');
    assert.deepEqual(cutShortChecks(review.fix, 'base-checks'), []);
    assert.equal(cutShortBefore(review, 'base-checks'), null);
    const killed = ranOnBase(ranOnBase(onBase(), 'build', 'passed'), 'lint', 'timeout').start('base-checks', 2);
    assert.deepEqual(cutShortChecks(withFix(killed).fix, 'base-checks'), [], 'a run killed at its timeout on the base wrote nothing the run expects');
    assert.equal(cutShortBefore(withFix(killed), 'base-checks'), null);
    refused(stopped.clone().add('tree.restored', { phase: 'base-checks', attempt: 2, check: { kind: 'lint', attempt: 1 }, files: [] }), /payload its schema rejects/);
  });

  it('keeps the repair\'s comparisons with its answer, of a kind that failed or timed out on the base, once each (R2, TD6)', () => {
    // lint and test failed before the fixes and after them; on the base build passes, lint fails and test passes.
    const base = ranOnBase(ranOnBase(ranOnBase(onBase({ lint: 'failed', test: 'failed' }, { lint: 'failed', test: 'failed' }), 'build', 'passed'), 'lint', 'failed'), 'test', 'passed')
      .finish('base-checks').start('repair').worker(60, 'fixer repair:repair');
    const fix = base.review().fix!;
    assert.deepEqual(baseKinds(fix), ['lint', 'test']);
    assert.deepEqual(comparableKinds(fix), ['lint'], 'test passes on the base, which needs no reading');
    assert.deepEqual(base.clone().add('fix.recorded', repairAnswer(['lint', 'test'], [same]), 4).review().fix?.answers.repair.repair?.comparisons, [same]);
    assert.deepEqual(base.clone().add('fix.recorded', repairAnswer(['lint', 'test'], []), 4).review().fix?.answers.repair.repair?.comparisons, [], 'a repair that gave none');
    assert.deepEqual(base.clone().add('fix.recorded', repairAnswer(['lint', 'test'], null), 2).review().fix?.answers.repair.repair?.comparisons, [], 'an answer before version 4 holds none');
    refused(base.clone().add('fix.recorded', repairAnswer(['lint', 'test'], [{ ...same, kind: 'test' }]), 4), /compares the test check with the base, where it did not fail or time out/);
    refused(base.clone().add('fix.recorded', repairAnswer(['lint', 'test'], [{ ...same, kind: 'build' }]), 4), /compares the build check with the base, where it did not fail or time out/);
    refused(base.clone().add('fix.recorded', repairAnswer(['lint', 'test'], [same, { ...same, reading: 'adds' }]), 4), /compares the lint check with the base twice/);
    const timedOut = ranOnBase(ranOnBase(onBase(), 'build', 'passed'), 'lint', 'timeout').finish('base-checks').start('repair').worker(60, 'fixer repair:repair');
    assert.deepEqual(comparableKinds(timedOut.review().fix!), ['lint'], 'a timeout on the base is compared as a failure is');
    const atFixes = withBaseChecks(withDocumentationStep(checksPhase(decidedOf(withFixPass(mergeRanked())), 'baseline-checks', { lint: 'failed' }), null)).start('fixes').add('fixes.planned', fixPlan).worker(50, 'fixer fixes:c1-1');
    refused(atFixes.add('fix.recorded', { ...fixAnswer(worker(50)), comparisons: [same] }, 4), /compares checks with the base in fixes:c1-1, which only the repair does/);
  });

  it('keeps a run on the base as its kind\'s run whatever the run revises after it (TD5)', () => {
    const applied = { id: 'lint', status: 'applied', file: 'src/a.ts', line: 4, note: 'formatted the guard', message: { subject: 'style: Format the guard', body: 'Why.' }, files: ['src/a.ts'], corrections: [], validation: [], requiredFiles: [] };
    const repaired = ranOnBase(ranOnBase(onBase(), 'build', 'passed'), 'lint', 'failed').finish('base-checks').start('repair').worker(60, 'fixer repair:repair')
      .add('fix.recorded', { ...repairAnswer(['lint'], [same]), findings: [applied] }, 4)
      .add('tree.revised', { phase: 'repair', source: { kind: 'fix', key: 'repair', workerId: worker(60) }, change: { findings: ['lint'], message: applied.message }, files: [{ path: 'src/a.ts', status: 'modified', before: { blob: reference('a') }, beforeSymlink: false, symlink: false, after: { blob: reference('8') } }] }, 2);
    const fix = repaired.review().fix!;
    const run = lastRecordedRun(fix, 'base-checks', 'lint')!;
    assert.equal(isOldRun(fix, 'base-checks', run), false);
    assert.equal(lastFreshRun(fix, 'base-checks', 'lint'), run);
    assert.equal(earlierTreeEdit(fix, 'base-checks', run), null, 'the Checks table marks no run on the base as of an earlier tree');
  });

  it('stays skipped when a run configured before it continues into the fix pass, and is pending when one at version 8 does (R10)', () => {
    const older = withDocumentationStep(readOnlyReported()).add('fix.pinned', pin()).review();
    assert.deepEqual(older.phases['base-checks'], { status: 'skipped', attempt: 0 });
    assert.deepEqual(older.phases.documentation, { status: 'pending', attempt: 0 });
    const newer = withBaseChecks(withDocumentationStep(readOnlyReported())).add('fix.pinned', pin()).review();
    assert.equal(newer.baseChecksStep, true);
    assert.deepEqual(newer.phases['base-checks'], { status: 'pending', attempt: 0 });
  });

  it('reopens with the checks after the fixes in a run configured at version 8, and runs there only a kind the reopened pass adds (R10, TD5)', () => {
    // lint and test fail before the fixes; after them lint fails and test passes, so only lint runs on the base; the run budget left the documentation step's unit.
    /** The run through its report, with the runs on the base that `based` records and the repair's comparisons, unless configured before the phase. */
    const toReport = (compared: boolean, based: (history: History) => History = (history) => ranOnBase(ranOnBase(history, 'build', 'passed'), 'lint', 'failed'), comparisons = [same]): History => {
      const checked = checksPhase(throughFixes({ lint: 'failed', test: 'failed' }, compared, budgetStopped), 'checks', { lint: 'failed' });
      return (compared ? based(checked.start('base-checks')).finish('base-checks') : checked)
        .start('repair').worker(60, 'fixer repair:repair').add('fix.recorded', repairAnswer(['lint'], compared ? comparisons : null), compared ? 4 : 2).add('worktree.checked', endCheck('repair'), 2).finish('repair')
        .start('repair-checks').finish('repair-checks')
        .start('report').add('report.written', { report: reference('e', 2048), statistics, patches: [reference('1')] }, 2).finish('report');
    };
    const reopen = { units: [{ phase: 'documentation', key: 'documentation' }] };
    /** The fix pass of a run through its report reopened, its documentation step revising a document, so the checks after it run again and now test fails too, and its checks on the base started again. */
    const reopenedOf = (history: History): History => {
      history.add('fix.reopened', reopen, 2).start('documentation', 2).worker(56, 'documentation documentation:documentation')
        .add('fix.recorded', documentationAnswer(worker(56), [['search', 'applied']]), 3)
        .add('tree.revised', { phase: 'documentation', source: { kind: 'fix', key: 'documentation', workerId: worker(56) }, change: { findings: ['search'], message: { subject: 'docs: Bring search in line', body: 'The fixes changed the behavior it states.' } }, files: [{ path: 'docs/testing.md', status: 'modified', before: { blob: reference('a') }, beforeSymlink: false, symlink: false, after: { blob: reference('9') } }] }, 3)
        .add('worktree.checked', endCheck('documentation', 2), 7).finish('documentation', 'completed', 2)
        .start('checks', 2);
      for (const kind of ['build', 'lint', 'test']) history.add('check.ran', checkRun('checks', kind, kind === 'build' ? 'passed' : 'failed', 2));
      return history.finish('checks', 'completed', 2).start('base-checks', 2);
    };
    assert.deepEqual(toReport(false).add('fix.reopened', reopen, 2).review().phases['base-checks'], { status: 'skipped', attempt: 0 });
    assert.deepEqual(toReport(true).add('fix.reopened', reopen, 2).review().phases['base-checks'], { status: 'pending', attempt: 1 });
    const reopened = reopenedOf(toReport(true));
    const review = withFix(reopened);
    assert.deepEqual(baseKinds(review.fix), ['lint', 'test']);
    assert.equal(runStanding(review, 'base-checks', 'lint'), null, 'lint\'s run on the base stands');
    assert.deepEqual(runStanding(review, 'base-checks', 'test'), { kind: 'first' });
    const rebuild = runStanding(review, 'base-checks', 'build');
    assert.equal(rebuild?.kind === 'again' ? rebuild.why : null, 'earlier-worktree', 'test reads what build produces, and the worktree of attempt 1 is gone (TD16)');
    refused(reopened.clone().add('check.started', startOnBase('lint', 2), 2), /starts the lint check in base-checks, whose last current run is its result/);
    const rebuilt = ranOnBase(ranOnBase(reopened.clone(), 'build', 'passed', 2, { attempt: 1, outcome: 'passed' }), 'test', 'failed', 2);
    assert.deepEqual(rebuilt.review().fix?.checks.runs['base-checks'].map((run) => [run.kind, run.attempt, run.outcome]), [['build', 1, 'passed'], ['lint', 1, 'failed'], ['build', 2, 'passed'], ['test', 2, 'failed']]);
    // Attempt 1 could make no worktree, so build and lint were skipped there, and the reopened attempt tries again for test.
    const noWorktree = (kind: string) => (history: History): History => history.add('check.ran', { ...checkRun('base-checks', kind, 'skipped'), ...baseSkip('no-worktree', 'fatal: x'), replaces: null }, 4);
    const unmade = withFix(reopenedOf(toReport(true, (history) => noWorktree('lint')(noWorktree('build')(history)), [])));
    const again = runStanding(unmade, 'base-checks', 'build');
    assert.deepEqual(again?.kind === 'again' ? [again.why, again.run.outcome] : null, ['earlier-worktree', 'skipped'], 'a build skipped for want of a worktree runs once a worktree can be made');
    // The base is the empty tree, of which no attempt makes a worktree, so build's skip at attempt 1 stands and test is skipped alone.
    const emptyTree = (kind: string) => (history: History): History => history.add('check.ran', { ...checkRun('base-checks', kind, 'skipped'), ...baseSkip('empty-tree'), replaces: null }, 4);
    const rootCommit = reopenedOf(toReport(true, (history) => emptyTree('lint')(emptyTree('build')(history)), []));
    assert.equal(runStanding(withFix(rootCommit), 'base-checks', 'build'), null, 'a build skipped for the empty tree would only be skipped again');
    assert.equal(takenOnBase(withFix(rootCommit), 'build'), true, 'build is still among the kinds the phase may name');
    refused(rootCommit.clone().add('check.ran', { ...checkRun('base-checks', 'build', 'skipped', 2), ...baseSkip('empty-tree'), replaces: { attempt: 1, outcome: 'skipped' } }, 4), /runs the build check again in base-checks, whose last current run is its result/);
    const skippedAgain = rootCommit.clone().add('check.ran', { ...checkRun('base-checks', 'test', 'skipped', 2), ...baseSkip('empty-tree'), replaces: null }, 4);
    assert.deepEqual(skippedAgain.review().fix?.checks.runs['base-checks'].map((run) => [run.kind, run.attempt]), [['build', 1], ['lint', 1], ['test', 2]], 'the reopened attempt adds no run of build');
  });
});
