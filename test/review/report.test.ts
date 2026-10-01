import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { renderReport } from '../../src/review/report.ts';
import { configured, ranked, reference, reported, statistics, triaged, worker } from '../helpers/review-history.ts';
import { finderAngles } from '../../src/review/vocabulary.ts';

const snapshotPath = resolve(import.meta.dirname, '../fixtures/reports/synthetic.md');

describe('renderReport', () => {
  it('renders the synthetic run exactly as the committed snapshot, which a person read once in review', () => {
    const rendered = renderReport(reported().fold(), { engine: '0.0.0+dev', statistics });
    const snapshot = readFileSync(snapshotPath, 'utf8');
    assert.equal(rendered, snapshot, `the report changed; if on purpose, write the new text to ${snapshotPath}`);
  });

  it('exercises every section and mark in the snapshot', () => {
    const report = renderReport(reported().fold(), { engine: '0.0.0+dev', statistics });
    for (const heading of ['# Deep review report', '## Angles', '## Findings', '## Refuted at verification', '## Statistics', '## Limitations']) assert.ok(report.includes(`${heading}\n`), heading);
    assert.match(report, /^\| FOOTGUNS \| not run \(2 attempts did not complete: .*\) \| none \|$/m);
    assert.match(report, /^\| RIPPLE \| run \| the callers of parse\(\) \|$/m);
    assert.match(report, /^\| SCAN \| run \(as the triage\) \| - \|$/m);
    assert.match(report, /^### 1\. \[major\] CONFIRMED  RIPPLE-1 \(also SWEEP-2\)  src\/a\.ts:4$/m);
    assert.match(report, /^### 2\. \[minor\] PLAUSIBLE  SWEEP-1  C:\\elsewhere\\b\.ts:9 \(unlocated: C:\\elsewhere\\b\.ts:9; unverified\)$/m);
    assert.match(report, /Evidence: none; the verifier of this group failed twice/);
    assert.match(report, /Also at: SWEEP-2 src\/a\.ts:7/);
    assert.match(report, /- Angle FOOTGUNS did not run/);
    assert.match(report, /- Group g1 of sweep-verification was not verified: .* Its candidates \(SWEEP-1, SWEEP-2\) carry PLAUSIBLE with the unverified mark\./);
    assert.match(report, /- Worktree checks: 9, none found a difference/);
    assert.match(report, /- Run budget: 30\.00 USD, checked before every launch; spent 4\.50 USD\./);
    assert.match(report, /- Unlocated candidates.*SWEEP-1 \(C:\\elsewhere\\b\.ts:9\)/);
    assert.match(report, /^\| Total \| 9 \| 22\.5 \| 4\.50 \(1 worker unreported\) \| 900 \| 180 \| 90 \|$/m);
    assert.match(report, /^\| triage \| 1 \| 2\.5 \| 0\.50 \| 100 \| 20 \| 10 \|$/m, 'a row with every cost reported carries no mark');
    assert.match(report, /^- Workers with no reported cost: 1\. .* the costs above leave such workers out, so the run cost more than the totals show\. The budget check counted each such worker at its per-worker cap, except a worker lost with its engine, which it could not price and left out\.$/m);
    assert.match(report, /Findings: 2 \(1 CONFIRMED, 1 PLAUSIBLE\); 0 refuted at verification/);
    assert.ok(report.endsWith('\n') && !report.endsWith('\n\n'));
  });

  it('says when no finding survived, lists the refuted, and names a run created by another engine', () => {
    const history = triaged().start('finders');
    for (const angle of finderAngles) history.add('candidates.recorded', { phase: 'finders', key: angle, workerId: worker(10 + finderAngles.indexOf(angle)), candidates: [], leads: null });
    history.finish('finders').start('deduplication').finish('deduplication').start('verification')
      .add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['SCAN-1'] }] })
      .add('verdicts.recorded', { phase: 'verification', groupId: 'g1', workerId: worker(21), verdicts: [{ id: 'SCAN-1', verdict: 'REFUTED', evidence: 'line 3 is a comment' }] })
      .finish('verification').start('sweep').add('candidates.recorded', { phase: 'sweep', key: 'sweep', workerId: worker(30), candidates: [], leads: null }).finish('sweep')
      .start('sweep-deduplication').finish('sweep-deduplication').start('sweep-verification').add('verification.planned', { phase: 'sweep-verification', groups: [] }).finish('sweep-verification')
      .start('merge-rank').finish('merge-rank').start('report');
    // What statisticsOf gives through a runtime that reports no cost in USD: no cost, and no unreported count.
    const noCost = { phases: statistics.phases.map((row) => ({ ...row, costUsd: null, costUnreported: null })), total: { ...statistics.total, costUsd: null, costUnreported: null }, budgetApplied: false };
    const report = renderReport(history.fold(), { engine: '0.0.1+abc', statistics: noCost });
    assert.match(report, /^Engine: 0\.0\.1\+abc \(run created by 0\.0\.0\)$/m);
    assert.match(report, /## Findings\n\nNo finding survived verification\.\n/);
    assert.match(report, /## Refuted at verification\n\n- SCAN-1 \(SCAN\)  src\/a\.ts:3  SCAN-1 summary\n  Evidence: line 3 is a comment\n/);
    assert.match(report, /- The run budget did not apply: runtime claude reports no cost in USD/);
    assert.match(report, /^\| Total \| 9 \| 22\.5 \| - \| 900 \| 180 \| 90 \|$/m);
    assert.doesNotMatch(report, /no reported cost/, 'a runtime that reports no cost has no unreported count to name');
    assert.match(report, /Findings: 0 \(0 CONFIRMED, 0 PLAUSIBLE\); 1 refuted at verification/);
  });

  it('names the run budget in force at the end, not the one the run was configured with', () => {
    const raised = ranked().add('limits.changed', { concurrency: 4, runBudgetUsd: 75.5 }).fold();
    assert.equal(raised.review!.configuration.runBudgetUsd, 30);
    const report = renderReport(raised, { engine: '0.0.0', statistics });
    assert.match(report, /^- Run budget: 75\.50 USD, checked before every launch; spent 4\.50 USD\.$/m);
    assert.doesNotMatch(report, /30\.00 USD/);
  });

  it('says a runtime that reports cost ran without a run budget, rather than that it reports no cost', () => {
    const state = ranked().fold();
    const unbudgeted = { ...state, review: { ...state.review!, limits: { ...state.review!.limits, runBudgetUsd: null } } };
    const report = renderReport(unbudgeted, { engine: '0.0.0', statistics: { ...statistics, total: { ...statistics.total, costUnreported: 0 }, budgetApplied: false } });
    assert.match(report, /^- No run budget was set, so only the per-worker budgets and timeouts bounded this run; spent 4\.50 USD\.$/m);
    assert.doesNotMatch(report, /reports no cost in USD/);
    assert.doesNotMatch(report, /no reported cost/, 'no line for zero unreported workers');
    const withUnreported = renderReport(unbudgeted, { engine: '0.0.0', statistics: { ...statistics, budgetApplied: false } });
    assert.match(withUnreported, /^- Workers with no reported cost: 1\. .* so the run cost more than the totals show\.$/m, 'no budget check ran, so the line says nothing of one');
  });

  it('reports a drift check and an oversized file among the limitations', () => {
    const history = ranked();
    const state = history.fold();
    const drifted = {
      ...state,
      review: { ...state.review!, checks: [...state.review!.checks, { phase: 'report' as const, attempt: 1, moment: 'start' as const, drifted: true, head: null, files: [{ path: 'src/a.ts', outcome: 'modified' as const }], strays: [] }] },
      scope: { ...state.scope!, files: [...state.scope!.files, { path: 'big.bin', status: 'added' as const, symlink: false, before: null, after: { oversized: { sha256: 'f'.repeat(64), size: 9_000_000 } } }] },
    };
    const report = renderReport(drifted, { engine: '0.0.0', statistics });
    assert.match(report, /- Worktree checks: 10, 1 found a difference in report \(attempt 1: src\/a\.ts modified\); each blocked the run/);
    assert.match(report, /- Files too large to freeze, which no worker could be given a frozen state of: big\.bin\./);
  });

  it('keeps text from workers inside the line it belongs to, so it cannot add a heading, a list item or a paragraph', () => {
    const state = reported().fold();
    const review = state.review!;
    const hostile = {
      ...state,
      review: {
        ...review,
        ranking: review.ranking!.map((finding, index) => (index === 0 ? { ...finding, summary: '## Injected section\nsecond line', reason: 'because\n- a list item' } : finding)),
        candidates: {
          ...review.candidates,
          'SWEEP-1': { ...review.candidates['SWEEP-1']!, rawFile: 'C:\\x.ts\n## Heading from a path' },
          'SCAN-1': { ...review.candidates['SCAN-1']!, summary: 'refuted\n# Heading', verdict: { verdict: 'REFUTED' as const, evidence: 'line 3\n\n## is a comment' }, duplicateOf: null },
        },
        anglesNotRun: { FOOTGUNS: 'timeout\n## Limitation heading' },
        unverifiedGroups: { ...review.unverifiedGroups, 'sweep-verification': { g1: 'failed\n# Group heading' } },
      },
    };
    const report = renderReport(hostile, { engine: '0.0.0+dev', statistics });
    const headings = report.split('\n').filter((line) => line.startsWith('#'));
    assert.deepEqual(headings.filter((line) => line.startsWith('## ') || line.startsWith('# ')), ['# Deep review report', '## Angles', '## Findings', '## Refuted at verification', '## Statistics', '## Limitations']);
    assert.equal(headings.filter((line) => line.startsWith('### ')).length, 2, 'one heading per finding, and nothing else at that level');
    assert.match(report, /^\\## Injected section second line$/m);
    assert.match(report, /^Reason: because - a list item$/m);
    assert.match(report, /\(unlocated: C:\\x\.ts ## Heading from a path:9; unverified\)$/m);
    assert.match(report, /^- SCAN-1 \(SCAN\) {2}src\/a\.ts:3 {2}refuted # Heading\n {2}Evidence: line 3 ## is a comment$/m);
    assert.match(report, /^- Angle FOOTGUNS did not run: timeout ## Limitation heading\. /m);
    assert.match(report, /^- Group g1 of sweep-verification was not verified: failed # Group heading\. /m);
    assert.ok(!report.split('\n').some((line) => /^[-*+] /.test(line) && line.includes('a list item')), 'no list item opened by a reason');
  });

  /** The reported run with extra unlocated candidates, each on `file:line`, and a deleted `src/gone.ts` in its scope. */
  const withUnlocated = (extra: Readonly<Record<string, readonly [string, number]>>): RunState => {
    const state = reported().fold();
    const review = state.review!;
    const added = Object.fromEntries(Object.entries(extra).map(([id, [rawFile, rawLine]]) => [id, { ...review.candidates['SWEEP-1']!, id, rawFile, rawLine }]));
    return {
      ...state,
      scope: { ...state.scope!, files: [...state.scope!.files, { path: 'src/gone.ts', status: 'deleted' as const, symlink: false, before: { blob: reference('f') }, after: null }] },
      review: { ...review, candidates: { ...review.candidates, ...added } },
    };
  };

  it('says why each unlocated candidate is unlocated: a path the repository does not hold, a file the change deletes, or a line past the end', () => {
    const report = renderReport(withUnlocated({ 'SWEEP-3': ['src/gone.ts', 42], 'SWEEP-4': ['src/a.ts', 999], 'SWEEP-5': ['./SRC/A.ts', 998] }), { engine: '0.0.0', statistics });
    assert.match(report, /^- Unlocated candidates on a path the repository does not hold, or on a line past the end of an unchanged file: SWEEP-1 \(C:\\elsewhere\\b\.ts:9\)\.$/m);
    assert.match(report, /^- Unlocated candidates on a file the change deletes, which has no after state for a line to point into: SWEEP-3 \(src\/gone\.ts:42\)\.$/m);
    assert.match(report, /^- Unlocated candidates on a line past the end of the changed file: SWEEP-4 \(src\/a\.ts:999\), SWEEP-5 \(\.\/SRC\/A\.ts:998\)\.$/m, 'a whole path spelled with ./ or in another case names the changed file');
    assert.doesNotMatch(report, /ends with a changed path/, 'no candidate whose whole path names a changed file, or no scope path, is called ambiguous');
    assert.doesNotMatch(report, /did not match the reviewed change/, 'no candidate is described by a reason that is not its own');
  });

  it('never pins a candidate whose path only ends with a changed path to that changed path, since the ledger cannot tell it from an unchanged file', () => {
    // test/src/a.ts may be an unchanged file too short for line 3, rather than src/a.ts; /repo/src/gone.ts and a bare a.ts may be either.
    const report = renderReport(withUnlocated({ 'SWEEP-3': ['test/src/a.ts', 3], 'SWEEP-4': ['/repo/src/gone.ts', 42], 'SWEEP-5': ['a.ts', 5] }), { engine: '0.0.0', statistics });
    assert.match(
      report,
      /^- Unlocated candidates on a path that ends with a changed path, naming either that changed file or an unchanged path of the repository, neither with such a line: SWEEP-3 \(test\/src\/a\.ts:3\), SWEEP-4 \(\/repo\/src\/gone\.ts:42\), SWEEP-5 \(a\.ts:5\)\.$/m,
    );
    assert.doesNotMatch(report, /past the end of the changed file/, 'test/src/a.ts:3 and a.ts:5 are not reported as lines of src/a.ts');
    assert.doesNotMatch(report, /on a file the change deletes/, '/repo/src/gone.ts is not reported as the deleted src/gone.ts');
    assert.match(report, /^- Unlocated candidates on a path the repository does not hold, or on a line past the end of an unchanged file: SWEEP-1 \(C:\\elsewhere\\b\.ts:9\)\.$/m);
  });

  /** The reported run with SWEEP-1 located on an unchanged file outside the change, as normalizeLocations records one. */
  const withOutside = (): RunState => {
    const state = reported().fold();
    const review = state.review!;
    const outside = { ...review.candidates['SWEEP-1']!, file: 'src/caller.ts', line: 12, located: true, inScope: false, rawFile: 'C:\\repo\\src\\caller.ts', rawLine: 12 };
    return { ...state, review: { ...review, candidates: { ...review.candidates, 'SWEEP-1': outside } } };
  };

  it('prints a candidate outside the change at its canonical path with a mark, and lists it apart from the unlocated ones', () => {
    const report = renderReport(withOutside(), { engine: '0.0.0', statistics });
    assert.match(report, /^### 2\. \[minor\] PLAUSIBLE  SWEEP-1  src\/caller\.ts:12 \(outside the change; unverified\)$/m);
    assert.match(report, /^- Candidates on files outside the reviewed change: SWEEP-1 \(src\/caller\.ts:12\)\. Each points at an unchanged file of the repository, its line checked against the file as the worktree held it; no worktree check covers such a file\.$/m);
    assert.doesNotMatch(report, /Unlocated candidates/, 'a candidate on an unchanged file is located');
    assert.doesNotMatch(report, /C:\\repo/, 'the finder\'s spelling is not printed for a located candidate');
  });

  it('lists no candidate outside the change when none is, and leaves out a duplicate', () => {
    assert.doesNotMatch(renderReport(reported().fold(), { engine: '0.0.0', statistics }), /outside the reviewed change|outside the change/);
    const state = withOutside();
    const review = state.review!;
    const duplicate = { ...state, review: { ...review, candidates: { ...review.candidates, 'SWEEP-1': { ...review.candidates['SWEEP-1']!, duplicateOf: 'RIPPLE-1' } } } };
    assert.doesNotMatch(renderReport(duplicate, { engine: '0.0.0', statistics }), /Candidates on files outside the reviewed change/);
  });

  it('refuses a run without a review', () => {
    const state = configured().fold();
    assert.throws(() => renderReport({ ...state, review: null }, { engine: 'e', statistics }), /Run run-1 has no review to report on/);
  });
});
