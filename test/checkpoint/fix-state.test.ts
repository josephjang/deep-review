import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FixRecordedV4, TreeRevised } from '../../src/checkpoint/events.ts';
import { baseKinds, cutShortBefore, cutShortChecks, documentationItemsOf, documentationReadiness, earlierTreeEdit, emptyFixState, failedAtBaseline, fixesRevisedPaths, fixPassRevisedPaths, isOldRun, lastFreshRun, lastRecordedRun, lastRestorationAt, ownedFiles, repairTargets, secondCut, unitRevisions, type CheckRunState, type FixState, type PlannedBatch, type RestorationState } from '../../src/checkpoint/fix-state.ts';
import { checkPhases, type CheckKind, type CheckPhase, type TreeCheckPhase } from '../../src/review/vocabulary.ts';

/** A revision of `src/a.ts` by `source` in `phase`; its message and bytes play no part in whose it is. */
const revision = (phase: TreeRevised['phase'], source: TreeRevised['source']): TreeRevised => ({
  phase,
  source,
  change: { findings: [], message: { subject: 's', body: '' } },
  files: [{ path: 'src/a.ts', status: 'modified', before: null, beforeSymlink: false, symlink: false, after: null }],
});

const worker = '00000000-0000-4000-8000-000000000001';
const fixOf = (revisions: readonly TreeRevised[]): FixState => ({ ...emptyFixState(), revisions });

describe('unitRevisions', () => {
  it('holds a unit\'s fixer and attempt revisions, in ledger order', () => {
    const own = [revision('answer', { kind: 'attempt', key: 'pass-1', workerId: worker }), revision('answer', { kind: 'fix', key: 'pass-1', workerId: worker })];
    assert.deepEqual(unitRevisions(fixOf(own), 'answer', 'pass-1'), own);
  });

  it('leaves out another unit\'s, the same key in another phase, and a check\'s', () => {
    const fix = fixOf([
      revision('answer', { kind: 'fix', key: 'pass-2', workerId: worker }),
      revision('fixes', { kind: 'fix', key: 'pass-1', workerId: worker }),
      revision('answer-checks', { kind: 'check', check: 'lint' }),
    ]);
    assert.deepEqual(unitRevisions(fix, 'answer', 'pass-1'), []);
  });

  it('holds none for a run without revisions', () => {
    assert.deepEqual(unitRevisions(emptyFixState(), 'fixes', 'c1-1'), []);
  });
});

/** A run of `kind` in `phase` at `attempt`, folded with `revisionsBefore` revisions before it. */
const run = (phase: CheckPhase, kind: CheckKind, outcome: CheckRunState['outcome'], attempt: number, revisionsBefore: number): CheckRunState => ({
  phase, attempt, kind, command: `npm run ${kind}`, outcome, exitCode: outcome === 'passed' ? 0 : 1, signal: null, termination: outcome === 'timeout' ? 'killed' : 'exited',
  startedAt: '2026-10-19T00:00:00.000Z', endedAt: '2026-10-19T00:00:01.000Z', stdout: null, stderr: null, error: null, replaces: null, revisionsBefore, replacedAt: null,
});
const withRuns = (fix: FixState, runs: Partial<Record<CheckPhase, readonly CheckRunState[]>>): FixState => ({ ...fix, checks: { ...fix.checks, runs: { ...fix.checks.runs, ...runs } } });

describe('the last current run of a check (TD3 of resumable runs)', () => {
  const fixes = revision('fixes', { kind: 'fix', key: 'c1-1', workerId: worker });
  const repair = revision('repair', { kind: 'fix', key: 'repair', workerId: worker });
  const answer = revision('answer', { kind: 'fix', key: 'pass-1', workerId: worker });
  const lint = revision('checks', { kind: 'check', check: 'lint' });
  const documentation = revision('documentation', { kind: 'fix', key: 'documentation', workerId: worker });

  it('keeps a baseline run current after every edit, so the baseline failures stay what the fixers are told', () => {
    const fix = withRuns(fixOf([fixes, repair, answer]), { 'baseline-checks': [run('baseline-checks', 'test', 'failed', 1, 0)] });
    assert.equal(lastFreshRun(fix, 'baseline-checks', 'test')?.outcome, 'failed');
    assert.equal(failedAtBaseline(fix, 'test'), true);
  });

  it('makes a run after the fixes old by a later revision of the fixes, the documentation step or an answer pass, never of the repair or a check', () => {
    const checks = run('checks', 'test', 'failed', 1, 1);
    for (const [later, old] of [[fixes, true], [documentation, true], [answer, true], [repair, false], [lint, false]] as const) {
      const fix = withRuns(fixOf([fixes, later]), { checks: [checks] });
      assert.equal(isOldRun(fix, 'checks', checks), old, later.phase);
      assert.equal(lastFreshRun(fix, 'checks', 'test'), old ? null : checks, later.phase);
      assert.equal(lastRecordedRun(fix, 'checks', 'test'), checks, `${later.phase}: the table still shows it`);
    }
  });

  it('makes a run after the repair old by a later revision of the fixes, the documentation step, the repair or an answer pass, and one after answers by the fixes, the documentation step or the repair', () => {
    for (const [phase, later, old] of [['repair-checks', repair, true], ['repair-checks', answer, true], ['repair-checks', documentation, true], ['answer-checks', repair, true], ['answer-checks', answer, false], ['answer-checks', fixes, true], ['answer-checks', documentation, true]] as const) {
      const ran = run(phase, 'build', 'passed', 1, 0);
      assert.equal(isOldRun(fixOf([later]), phase, ran), old, `${phase} after ${later.phase}`);
    }
  });

  it('says a run checked an earlier tree after every revision that made it old but an answer pass\'s, naming the first such revision\'s phase', () => {
    for (const phase of checkPhases) {
      const ran = run(phase, 'build', 'passed', 1, 0);
      for (const later of [fixes, documentation, repair, answer, lint]) {
        const marked = later !== answer && isOldRun(fixOf([later]), phase, ran);
        assert.equal(earlierTreeEdit(fixOf([later]), phase, ran), marked ? later.phase : null, `${phase} after ${later.phase}`);
      }
    }
    assert.equal(earlierTreeEdit(fixOf([answer, lint, repair, fixes]), 'repair-checks', run('repair-checks', 'build', 'passed', 1, 0)), 'repair');
    assert.equal(earlierTreeEdit(fixOf([fixes, answer]), 'checks', run('checks', 'build', 'passed', 1, 1)), null, 'a revision before the run marks nothing');
  });

  it('reads the repair\'s targets from the baseline and the current runs after the fixes, so an answer pass that revised the tree leaves none to repair', () => {
    const runs = { 'baseline-checks': [run('baseline-checks', 'test', 'passed', 1, 0)], checks: [run('checks', 'test', 'failed', 1, 1)] };
    const planned = { checks: [{ kind: 'test' as const, command: 'npm run test', origin: 'setting' as const, layer: 'flag' as const, reason: null, source: null }], manager: null };
    const fix = (revisions: readonly TreeRevised[]): FixState => { const state = withRuns(fixOf(revisions), runs); return { ...state, checks: { ...state.checks, planned } }; };
    assert.deepEqual(repairTargets(fix([fixes])), ['test']);
    assert.deepEqual(repairTargets(fix([fixes, answer])), [], 'the run after the fixes checked a tree the answer pass changed');
  });

  it('keeps a kind on the base, read as recorded, after an answer pass made the run after the fixes old (R2, TD13 of the facts before a merge)', () => {
    const runs = { 'baseline-checks': [run('baseline-checks', 'test', 'failed', 1, 0)], checks: [run('checks', 'test', 'failed', 1, 1)] };
    const planned = { checks: [{ kind: 'test' as const, command: 'npm run test', origin: 'setting' as const, layer: 'flag' as const, reason: null, source: null }], manager: null };
    const fix = (revisions: readonly TreeRevised[]): FixState => { const state = withRuns(fixOf(revisions), runs); return { ...state, checks: { ...state.checks, planned } }; };
    assert.deepEqual(baseKinds(fix([fixes])), ['test']);
    assert.deepEqual(baseKinds(fix([fixes, answer])), [], 'the planner reads the current runs');
    assert.deepEqual(baseKinds(fix([fixes, answer]), 'recorded'), ['test'], 'what ran on the base stays');
  });
});

describe('the check a kill cut short before the current attempt (R7 of resumable runs)', () => {
  type WorktreeCheck = Parameters<typeof cutShortBefore>[0]['checks'][number];
  const review = (fix: FixState, attempt: number, checks: readonly WorktreeCheck[] = []): Parameters<typeof cutShortBefore>[0] => ({ phases: { 'baseline-checks': { status: 'running', attempt } } as never, checks, fix });
  const start = (kind: CheckKind, attempt: number, runsBefore: number) => ({ phase: 'baseline-checks' as const, attempt, kind, command: `npm run ${kind}`, runsBefore });
  /** A worktree check of `phase` at `attempt`, drifted by an edit of `src/a.ts` or clean. */
  const worktreeCheck = (attempt: number, moment: WorktreeCheck['moment'], drifted: boolean, phase: CheckPhase = 'baseline-checks'): WorktreeCheck => ({
    phase, attempt, moment, drifted, head: null, strays: [], files: drifted ? [{ path: 'src/a.ts', outcome: 'modified', expected: null }] : [],
  });
  // test@1 is cut with no run after its start; test@2 starts and passes.
  const cutThenPassed = ((): FixState => {
    const fix = emptyFixState();
    return { ...fix, checks: { ...fix.checks, starts: { ...fix.checks.starts, 'baseline-checks': [start('test', 1, 0), start('test', 2, 0)] }, runs: { ...fix.checks.runs, 'baseline-checks': [run('baseline-checks', 'test', 'passed', 2, 0)] } } };
  })();

  it('finds a start no run came after, a cut run, or one killed at its timeout, in an earlier attempt, the last of them', () => {
    const fix = emptyFixState();
    const cutStart = { ...fix, checks: { ...fix.checks, starts: { ...fix.checks.starts, 'baseline-checks': [start('build', 1, 0), start('lint', 1, 1)] }, runs: { ...fix.checks.runs, 'baseline-checks': [run('baseline-checks', 'build', 'passed', 1, 0)] } } };
    assert.deepEqual(cutShortBefore(review(cutStart, 2), 'baseline-checks'), { kind: 'lint', attempt: 1 });
    const timedOut = { ...fix, checks: { ...fix.checks, starts: { ...fix.checks.starts, 'baseline-checks': [start('test', 1, 0)] }, runs: { ...fix.checks.runs, 'baseline-checks': [run('baseline-checks', 'test', 'timeout', 1, 0)] } } };
    assert.deepEqual(cutShortBefore(review(timedOut, 2), 'baseline-checks'), { kind: 'test', attempt: 1 });
    assert.equal(cutShortBefore(review(timedOut, 1), 'baseline-checks'), null, 'the step that ran a check of the current attempt writes it back itself');
    assert.equal(cutShortBefore(review(withRuns(fix, { 'baseline-checks': [run('baseline-checks', 'test', 'failed', 1, 0)] }), 2), 'baseline-checks'), null, 'a failure that exited is no kill');
  });

  it('never finds a run that a kill ended with no start before it, which an engine from before check.started recorded with its writes as a revision', () => {
    const fix = emptyFixState();
    const killed = { ...run('baseline-checks', 'test', 'failed', 1, 0), exitCode: 137 };
    for (const legacy of [run('baseline-checks', 'test', 'timeout', 1, 0), killed]) {
      assert.equal(cutShortBefore(review(withRuns(fix, { 'baseline-checks': [legacy] }), 2), 'baseline-checks'), null, legacy.outcome);
      // A start of the kind in the attempt that came after the run is no start of it.
      const startedAfter = { ...fix, checks: { ...fix.checks, starts: { ...fix.checks.starts, 'baseline-checks': [start('test', 1, 1)] }, runs: { ...fix.checks.runs, 'baseline-checks': [legacy, run('baseline-checks', 'test', 'passed', 1, 0)] } } };
      assert.equal(cutShortBefore(review(startedAfter, 2), 'baseline-checks'), null, `${legacy.outcome}, started after`);
    }
  });

  it('holds the cut checks in ledger order, a start before the run recorded after it at the same count of runs', () => {
    // lint@1 is cut at its start; then test@2 starts and the engine kills it at its timeout, the phase's first run.
    const fix = emptyFixState();
    const timedOut = run('baseline-checks', 'test', 'timeout', 2, 0);
    const cut = { ...fix, checks: { ...fix.checks, starts: { ...fix.checks.starts, 'baseline-checks': [start('lint', 1, 0), start('test', 2, 0)] }, runs: { ...fix.checks.runs, 'baseline-checks': [timedOut] } } };
    assert.deepEqual(cutShortChecks(cut, 'baseline-checks'), [start('lint', 1, 0), timedOut]);
  });

  it('retires a cut check once a later attempt found the tree clean, so a drift after it is a person\'s edit that blocks', () => {
    const cleanAtTwo = [worktreeCheck(1, 'start', false), worktreeCheck(2, 'start', false), worktreeCheck(3, 'start', true)];
    assert.equal(cutShortBefore(review(cutThenPassed, 3, cleanAtTwo), 'baseline-checks'), null);
  });

  it('keeps a cut check while no attempt after it and before the current one found the tree clean', () => {
    assert.deepEqual(cutShortBefore(review(cutThenPassed, 3, [worktreeCheck(1, 'start', false)]), 'baseline-checks'), { kind: 'test', attempt: 1 }, 'a clean check before the cut explains nothing');
    assert.deepEqual(cutShortBefore(review(cutThenPassed, 3, [worktreeCheck(2, 'start', true)]), 'baseline-checks'), { kind: 'test', attempt: 1 }, 'a drift at the next attempt that blocked');
    assert.deepEqual(cutShortBefore(review(cutThenPassed, 3, [worktreeCheck(2, 'start', false, 'checks')]), 'baseline-checks'), { kind: 'test', attempt: 1 }, 'another phase\'s clean check');
    assert.deepEqual(cutShortBefore(review(cutThenPassed, 2, [worktreeCheck(2, 'start', false)]), 'baseline-checks'), { kind: 'test', attempt: 1 }, 'the current attempt\'s own check');
  });

  it('retires a cut check once its write back finished, and keeps one a stop cut before the tree was checked again', () => {
    const restoration: RestorationState = { phase: 'baseline-checks', attempt: 2, check: { kind: 'test', attempt: 1 }, files: [], checksBefore: 1 };
    const fix = { ...cutThenPassed, restorations: [restoration] };
    assert.equal(cutShortBefore(review(fix, 3, [worktreeCheck(2, 'start', true), worktreeCheck(2, 'restored', false)]), 'baseline-checks'), null);
    assert.deepEqual(cutShortBefore(review(fix, 3, [worktreeCheck(2, 'start', true)]), 'baseline-checks'), { kind: 'test', attempt: 1 });
  });
});

describe('the second cut of a kind in one attempt (R4 of resumable runs)', () => {
  it('is a cut that replaces a cut of its own attempt, and nothing else', () => {
    const cutAt = (attempt: number) => ({ run: { attempt }, why: 'cut' as const });
    assert.equal(secondCut(cutAt(2), 2, 'cut'), true);
    assert.equal(secondCut(cutAt(1), 2, 'cut'), false, 'a cut of an earlier attempt runs again');
    assert.equal(secondCut(cutAt(2), 2, 'failed'), false, 'only a cut is a second cut');
    assert.equal(secondCut({ run: { attempt: 2 }, why: 'timeout' }, 2, 'cut'), false, 'a cut after a timeout is the first cut');
    assert.equal(secondCut({ run: { attempt: 2 }, why: 'cut-attempt' }, 2, 'cut'), false);
    assert.equal(secondCut(null, 2, 'cut'), false, 'a first run replaces nothing');
  });
});

describe('the last write back of an attempt (R7 of resumable runs)', () => {
  const restoration = (phase: TreeCheckPhase, attempt: number, checksBefore: number): RestorationState => ({ phase, attempt, check: { kind: 'test', attempt: attempt - 1 }, files: [], checksBefore });

  it('reads the checks before the attempt\'s last write back, leaving out another attempt\'s and another phase\'s', () => {
    const fix = { ...emptyFixState(), restorations: [restoration('baseline-checks', 2, 1), restoration('baseline-checks', 2, 3), restoration('baseline-checks', 3, 5), restoration('checks', 2, 7)] };
    assert.equal(lastRestorationAt(fix, 'baseline-checks', 2), 3);
  });

  it('holds -1 for an attempt with no write back, and for a read-only run', () => {
    assert.equal(lastRestorationAt({ ...emptyFixState(), restorations: [restoration('baseline-checks', 2, 1)] }, 'baseline-checks', 1), -1);
    assert.equal(lastRestorationAt(null, 'survey', 1), -1);
  });
});

// R2, R9, TD8 and TD9 of the documentation step.
describe('the items of the documentation step', () => {
  const answerOf = (key: string, drift: readonly { readonly file: string; readonly what: string }[]): FixRecordedV4 => ({ phase: 'fixes', key, workerId: worker, findings: [], drift: [...drift], tests: [], suite: { result: 'not-run', command: '', failures: '' }, violations: [], comparisons: [] });
  const batch = (key: string): PlannedBatch => ({ key, cluster: key.split('-')[0]!, findingIds: [`RIPPLE-${key.split('-')[1]!}`] });
  /** A fix state with batches c1-1 and c2-1 in launch order, each answered with its `drift` lines, the second round's c3-1 too when given. */
  const fixWith = (first: readonly { readonly file: string; readonly what: string }[], second: readonly { readonly file: string; readonly what: string }[], third: readonly { readonly file: string; readonly what: string }[] | null = null): FixState => ({
    ...emptyFixState(),
    plan: { routes: [], clusters: [], batches: [batch('c1-1'), batch('c2-1')] },
    secondRound: third === null ? null : { blocked: [], clusters: [], batches: [batch('c3-1')] },
    answers: { ...emptyFixState().answers, fixes: { 'c2-1': answerOf('c2-1', second), 'c1-1': answerOf('c1-1', first), ...(third === null ? {} : { 'c3-1': answerOf('c3-1', third) }) } },
  });
  /** A resolver that reads `./` away and refuses a path that leaves the tree, as `planPathOf` does over a worktree that holds every path. */
  const resolve = (file: string): string | null => (file.startsWith('../') || file.startsWith('/') ? null : file.replace(/^\.\//, ''));

  it('groups the lines by the path they resolve to, keeps the path the first line wrote, and numbers the items in the order of their first lines, the search last', () => {
    const fix = fixWith([{ file: './docs/testing.md', what: 'the echo removes the bytes' }, { file: 'CHANGES.md', what: 'always translated' }], [{ file: 'docs/testing.md', what: 'test_shout prints HI' }]);
    assert.deepEqual(documentationItemsOf(fix, resolve), [
      { id: 'doc-1', file: './docs/testing.md', path: 'docs/testing.md', drift: [{ key: 'c1-1', file: './docs/testing.md', what: 'the echo removes the bytes' }, { key: 'c2-1', file: 'docs/testing.md', what: 'test_shout prints HI' }] },
      { id: 'doc-2', file: 'CHANGES.md', path: 'CHANGES.md', drift: [{ key: 'c1-1', file: 'CHANGES.md', what: 'always translated' }] },
      { id: 'search', file: null, path: null, drift: [] },
    ]);
  });

  it('reads the batches in launch order, the first round before the second, whatever order the answers were recorded in', () => {
    const fix = fixWith([{ file: 'b.md', what: 'b' }], [{ file: 'a.md', what: 'a' }], [{ file: 'c.md', what: 'c' }]);
    assert.deepEqual(documentationItemsOf(fix, resolve).map((item) => item.file), ['b.md', 'a.md', 'c.md', null]);
  });

  it('groups the lines whose path the resolver refuses by the path folded, as an unlocated candidate\'s, apart from every resolved path', () => {
    const fix = fixWith([{ file: '../Outside.md', what: 'one' }, { file: '..\\outside.md', what: 'two' }], [{ file: 'outside.md', what: 'three' }]);
    const items = documentationItemsOf(fix, (file) => (file.includes('..') ? null : resolve(file)));
    assert.deepEqual(items.map((item) => [item.id, item.file, item.path, item.drift.map((line) => line.what)]), [
      ['doc-1', '../Outside.md', null, ['one', 'two']],
      ['doc-2', 'outside.md', 'outside.md', ['three']],
      ['search', null, null, []],
    ]);
  });

  it('keeps two equal lines of one answer as two lines, and gives a run whose fixes reported none the search alone', () => {
    const line = { file: 'a.md', what: 'stale' };
    assert.deepEqual(documentationItemsOf(fixWith([line, line], []), resolve)[0]?.drift, [{ key: 'c1-1', ...line }, { key: 'c1-1', ...line }]);
    assert.deepEqual(documentationItemsOf(fixWith([], []), resolve), [{ id: 'search', file: null, path: null, drift: [] }]);
    assert.deepEqual(documentationItemsOf(emptyFixState(), resolve), [{ id: 'search', file: null, path: null, drift: [] }], 'no plan of the fixes, no line');
  });

  it('gives the repair the paths the fixes and the documentation step revised, and the step the fixes\' and its documents\'', () => {
    const fixes = revision('fixes', { kind: 'fix', key: 'c1-1', workerId: worker });
    const step = { ...revision('documentation', { kind: 'fix', key: 'documentation', workerId: worker }), files: [{ path: 'docs/testing.md', status: 'modified' as const, before: null, beforeSymlink: false, symlink: false, after: null }] };
    const answer = { ...revision('answer', { kind: 'fix', key: 'pass-1', workerId: worker }), files: [{ path: 'README.md', status: 'modified' as const, before: null, beforeSymlink: false, symlink: false, after: null }] };
    const fix: FixState = { ...fixOf([fixes, step, answer]), documentation: { items: [{ id: 'doc-1', file: 'CHANGES.md', path: 'CHANGES.md', drift: [{ key: 'c1-1', file: 'CHANGES.md', what: 'x' }] }, { id: 'doc-2', file: '../x.md', path: null, drift: [{ key: 'c1-1', file: '../x.md', what: 'y' }] }, { id: 'search', file: null, path: null, drift: [] }] } };
    assert.deepEqual(fixesRevisedPaths(fix), ['src/a.ts']);
    assert.deepEqual(fixPassRevisedPaths(fix), ['docs/testing.md', 'src/a.ts']);
    const review = { fix, answerPasses: [], ranking: null, candidates: {} };
    assert.deepEqual(ownedFiles(review, 'repair', 'repair'), ['docs/testing.md', 'src/a.ts'], 'not the answer pass\'s README.md');
    assert.deepEqual(ownedFiles(review, 'documentation', 'documentation'), ['CHANGES.md', 'src/a.ts'], 'a refused path gives no file; its own revision is no file of the fixes');
  });
});

describe('whether the documentation step can be planned', () => {
  const fixes = revision('fixes', { kind: 'fix', key: 'c1-1', workerId: worker });
  /** A fix state with `revisions` whose units in `stopped` the run budget or two failures left not attempted. */
  const settled = (revisions: readonly TreeRevised[], stopped: Partial<FixState['notAttempted']>): FixState => ({ ...fixOf(revisions), notAttempted: { ...emptyFixState().notAttempted, ...stopped } });

  it('is ready once the fixes revised the tree and the run budget stopped none of their batches', () => {
    assert.deepEqual(documentationReadiness(fixOf([fixes])), { kind: 'ready' });
    assert.deepEqual(documentationReadiness(settled([fixes], { fixes: { 'c2-1': { cause: 'failures', reason: '2 attempts did not complete' } } })), { kind: 'ready' }, 'a batch that failed twice is no budget stop');
    assert.deepEqual(documentationReadiness(settled([fixes], { repair: { repair: { cause: 'budget', reason: 'spent' } } })), { kind: 'ready' }, 'a stop of another phase is not the fixes\'');
  });

  it('waits for the batches of the fixes the run budget stopped, with their keys, before it reads the revisions', () => {
    assert.deepEqual(documentationReadiness(settled([], { fixes: { 'c1-1': { cause: 'budget', reason: 'spent' }, 'c2-1': { cause: 'budget', reason: 'spent' } } })), { kind: 'budget', keys: ['c1-1', 'c2-1'] });
  });

  it('has nothing to do when only another phase revised the tree, or nothing did', () => {
    assert.deepEqual(documentationReadiness(emptyFixState()), { kind: 'no-fixes-revision' });
    assert.deepEqual(documentationReadiness(fixOf([revision('repair', { kind: 'fix', key: 'repair', workerId: worker })])), { kind: 'no-fixes-revision' });
  });
});
