import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { codexWindowsSandboxesV4, type ReviewConfiguration } from '../../src/checkpoint/events.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { renderReport } from '../../src/review/report.ts';
import { askDecision, configurationV3, configured, decidedOf, decisions, fixRun, History, ranked, reference, reported, scope, statistics, triaged, worker } from '../helpers/review-history.ts';
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

  it('names the Codex Windows sandbox a Codex run on Windows pinned, after the runtime, and nothing for a run that pins none (R7 of the Codex sandbox)', () => {
    const state = reported().fold();
    const pinning = (codex: ReviewConfiguration['codex']): RunState => ({ ...state, review: { ...state.review!, configuration: { ...state.review!.configuration, runtime: 'codex', codex } } });
    const expected = { unelevated: 'unelevated', elevated: 'elevated', none: 'none (workers that edit ran in no sandbox, workers that read under unelevated)' };
    assert.deepEqual(Object.keys(expected).sort(), [...codexWindowsSandboxesV4].sort(), 'every value the ledger can record is rendered');
    for (const windowsSandbox of codexWindowsSandboxesV4) {
      const words = expected[windowsSandbox];
      const report = renderReport(pinning({ windowsSandbox }), { engine: '0.0.0+dev', statistics });
      assert.match(report, new RegExp(`^Runtime: codex [^\n]*\nCodex Windows sandbox: ${RegExp.escape(words)}\nModels: `, 'm'), windowsSandbox);
    }
    assert.doesNotMatch(renderReport(pinning(null), { engine: '0.0.0+dev', statistics }), /Windows sandbox/, 'a Codex run off Windows');
    assert.doesNotMatch(renderReport(state, { engine: '0.0.0+dev', statistics }), /Windows sandbox/, 'a Claude Code run');
  });

  it('names the unelevated sandbox for a Codex run configured before the setting existed only when its worktree is on Windows (R3, R7 of the Codex sandbox)', () => {
    const codexAt = (worktree: string): string => renderReport(new History().add('run.created', { worktree }).add('scope.captured', scope).add('review.configured', { ...configurationV3, runtime: 'codex', runBudgetUsd: null }, 3).fold(), { engine: '0.0.0+dev', statistics });
    assert.doesNotMatch(codexAt('/home/me/repo'), /Windows sandbox/, 'a run off Windows names no Windows sandbox');
    for (const worktree of ['C:\\repo', '\\\\server\\share\\repo']) assert.match(codexAt(worktree), /^Runtime: codex [^\n]*\nCodex Windows sandbox: unelevated\nModels: /m, worktree);
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

describe('the Decisions section (R8 of the decision step)', () => {
  const render = (state: RunState): string => renderReport(state, { engine: '0.0.0+dev', statistics });
  const departing = { ...decisions[0], departure: { rule: 'parse trusts its callers', source: 'src/a.ts:1', reason: 'the comment came with a caller that is gone' } };

  it('follows the header and comes before Angles, counting the decisions and the fixes that depart from a rule', () => {
    const report = render(decidedOf(reported(), [departing, askDecision('SWEEP-1', false)]).fold());
    const order = ['\nFindings: ', '\n## Decisions\n', '\n## Angles\n'].map((marker) => report.indexOf(marker));
    assert.ok(order.every((position) => position > 0) && order[0]! < order[1]! && order[1]! < order[2]!, JSON.stringify(order));
    assert.match(report, /^Before any fix, the decision step decided each finding: 1 to fix, 0 to leave, 1 to ask the author; 1 fix departs from a rule the repository states\. A fixer applies a finding to fix, and the default of a question that edits, when the run fixes; no fixer sees a finding left\.$/m);
  });

  it('lists each question as a checklist item, with its default, the option recommended, every option\'s cost and rule, where the decider looked and why', () => {
    const report = render(decidedOf(reported(), [departing, askDecision('SWEEP-1', false)]).fold());
    assert.match(report, /^### Questions for the author\n\nNone of these held the run up: each has a default, and an answer is needed only to go another way\. This run does not fix: no fixer ran, and the tree is unchanged\. Each option's rule is the line a convention source of the repository would state for it, so the next review settles the question alone\.\n\n- \[ \] 2\\\. SWEEP-1: Should parse accept an empty input\?\n  - Default: keep accepting it \(no edit\)\n  - Recommended: accept it and return an empty result\n  - Option 1: keep accepting it\. Costs: callers that pass one now see the change\. Rule: parse rejects an empty input\n  - Option 2: accept it and return an empty result\. Costs: an empty input passes silently\. Rule: parse accepts an empty input\n  - Looked in: the change's commit message; README\.md; test\/a\.test\.ts\n  - Grounds: nothing in the repository states which behavior is meant$/m);
  });

  it('says no question\'s default was applied, neither in a read-only run, which ran no fixer, nor in a fix run, whose Fixes says whether a fixer edited it', () => {
    const readOnly = render(decidedOf(reported(), [decisions[0], askDecision('SWEEP-1', true)]).fold());
    assert.match(readOnly, /^None of these held the run up: [^\n]*This run does not fix: no fixer ran, and the tree is unchanged\./m);
    assert.match(readOnly, /^ {2}- Default: reject it with an error$/m);
    const fixing = render(decidedOf(fixRun(), [decisions[0], askDecision('SWEEP-1', false)]).fold());
    assert.match(fixing, /^None of these held the run up: [^\n]*A fixer edits a default that edits the code into the tree, and Fixes says whether it did; a default that keeps the code changes nothing\./m);
    assert.doesNotMatch(fixing, /no fixer ran/);
    for (const report of [readOnly, fixing]) assert.doesNotMatch(report, /applied as written|^ {2}- Applied: |ask the author, applying /m);
  });

  it('lists each finding to fix with its approach, the options rejected and the rule it departs from, and each finding left with its reason', () => {
    const fixed = render(decidedOf(reported(), [departing, { ...decisions[1], leave: { reason: 'superseded', supersededBy: 'RIPPLE-1' } }]).fold());
    assert.match(fixed, /^### To fix\n\n- 1\\\. RIPPLE-1: guard the null once, before parse reads it\. Grounds: parse reads the null on an empty input, at lines 4 and 7\n  - Rejected: catch the throw in each caller: leaves the null in parse\n  - Departs from: parse trusts its callers \(src\/a\.ts:1\): the comment came with a caller that is gone$/m);
    assert.match(fixed, /^### Left\n\n- 2\\\. SWEEP-1, superseded by RIPPLE-1: the helper would edit only lines the change does not touch$/m);
    assert.doesNotMatch(fixed, /### Questions for the author/, 'no question, no heading');
    const stopped = { ...departing, fix: { ...decisions[0]!.fix, approach: 'guard the null once.' } };
    assert.match(render(decidedOf(reported(), [stopped, decisions[1]]).fold()), /^- 1\\\. RIPPLE-1: guard the null once\. Grounds: /m, 'an approach with its own stop gets no second one');
    assert.match(render(decidedOf(reported()).fold()), /^- 2\\\. SWEEP-1, outside the change, and not a regression: /m);
  });

  it('closes each finding\'s block with its decision', () => {
    const report = render(decidedOf(reported(), [departing, askDecision('SWEEP-1', true)]).fold());
    assert.match(report, /^### 1\. \[major\] CONFIRMED  RIPPLE-1[^\n]*\n[\s\S]*?Also at: SWEEP-2 src\/a\.ts:7\nDecision: fix, departing from a rule: parse reads the null on an empty input, at lines 4 and 7$/m);
    assert.match(report, /^Decision: ask the author, defaulting to reject it with an error; see Decisions: nothing in the repository states which behavior is meant$/m);
    assert.match(render(decidedOf(reported()).fold()), /^Decision: left, outside the change, and not a regression: the helper would edit only lines the change does not touch$/m);
  });

  it('ends an option and its cost with one stop, whether or not the decider wrote one', () => {
    const asked = askDecision('SWEEP-1', false) as { ask: { options: { option: string; cost: string }[] } };
    const stopped = { ...asked, ask: { ...asked.ask, options: asked.ask.options.map((option) => ({ ...option, option: `${option.option}.`, cost: `${option.cost}?` })) } };
    const report = render(decidedOf(reported(), [decisions[0], stopped]).fold());
    assert.match(report, /^ {2}- Option 1: keep accepting it\. Costs: callers that pass one now see the change\? Rule: /m);
    assert.doesNotMatch(report, /\.\. |\?\. /);
  });

  it('takes a stop before a closing bracket or quote as the end, and turns a trailing colon, comma or semicolon into the stop', () => {
    const asked = askDecision('SWEEP-1', false) as { ask: { options: { option: string; cost: string }[] } };
    const texts = [['Keep it (see README.)', 'uses "x."'], ['as follows:', 'one more,']] as const;
    const marked = { ...asked, ask: { ...asked.ask, options: asked.ask.options.map((option, position) => ({ ...option, option: texts[position]![0], cost: texts[position]![1] })) } };
    const report = render(decidedOf(reported(), [decisions[0], marked]).fold());
    assert.match(report, /^ {2}- Option 1: Keep it \(see README\.\) Costs: uses "x\." Rule: /m);
    assert.match(report, /^ {2}- Option 2: as follows\. Costs: one more\. Rule: /m);
  });

  it('keeps a decider\'s text on its own line whatever it holds, so it cannot open a heading or a list item', () => {
    const hostile = { ...askDecision('SWEEP-1', false), grounds: 'first line\n## Not a heading\n- not an item' };
    const report = render(decidedOf(reported(), [decisions[0], hostile]).fold());
    assert.doesNotMatch(report, /^## Not a heading$/m);
    assert.match(report, /Grounds: first line ## Not a heading - not an item$/m);
  });

  it('is absent from a run configured before the decision step, and from one that ranked nothing', () => {
    assert.doesNotMatch(render(reported().fold()), /Decisions|^Decision: /m);
    const nothing = decidedOf(reported()).fold();
    assert.doesNotMatch(render({ ...nothing, review: { ...nothing.review!, ranking: [], decisions: null } }), /## Decisions/);
  });
});
