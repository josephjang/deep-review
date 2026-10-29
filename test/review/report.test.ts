import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { codexWindowsSandboxesV4, type ReviewConfiguration } from '../../src/checkpoint/events.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { renderReport, type ReportInput } from '../../src/review/report.ts';
import { renderStats } from '../../src/review/stats-report.ts';
import { answer, askDecision, configurationV3, decidedFixRun, passToReport, configured, continuedToReport, decidedOf, decisions, fixRun, History, ranked, readOnlyReported, reference, reported, scope, statistics, triaged, worker, reportInput } from '../helpers/review-history.ts';
import { finderAngles } from '../../src/review/vocabulary.ts';

const snapshotPath = resolve(import.meta.dirname, '../fixtures/reports/synthetic.md');

describe('renderReport', () => {
  it('renders the synthetic run exactly as the committed snapshot, which a person read once in review', () => {
    const rendered = renderReport(reported().fold(), reportInput);
    const snapshot = readFileSync(snapshotPath, 'utf8');
    assert.equal(rendered, snapshot, `the report changed; if on purpose, write the new text to ${snapshotPath}`);
  });

  it('exercises every section and mark in the snapshot', () => {
    const report = renderReport(reported().fold(), reportInput);
    for (const heading of ['# The uncommitted change on 22222222', '## What needs you', '## Before you merge', '## What deep-review would fix', '## Findings', '## What the review covered', '## Refuted at verification', '## About this run']) assert.ok(report.includes(`\n${heading}\n`) || report.startsWith(`${heading}\n`), heading);
    assert.match(report, /^### 1\. null dereference\n\nLeft as is\. Major, CONFIRMED\.\n\n- Where: src\/a\.ts:4 \(RIPPLE-1; merged into it: SWEEP-2 at src\/a\.ts:7\)$/m);
    assert.match(report, /^### 2\. extract the helper\n\nLeft as is\. Minor, PLAUSIBLE, which no verifier examined\.\n\n- Where: C:\\elsewhere\\b\.ts:9 \(unlocated: C:\\elsewhere\\b\.ts:9; unverified\) \(SWEEP-1\)$/m);
    assert.match(report, /^- Evidence: none; the verifier of this group failed twice$/m);
    // The pass that did not run and the findings no verifier examined are gaps of the brief, in plain words (R10 of the report for the person); the notes keep why, the group and its phase, as the brief does not.
    const brief = report.slice(0, report.indexOf('\n## Findings\n'));
    assert.ok(brief.includes('The footguns review pass did not run, and a later pass looked for what it would have found. No verifier examined finding 2 and a candidate merged into finding 1; it counts as plausible.'), brief);
    const covered = report.slice(report.indexOf('\n## What the review covered\n'));
    assert.match(covered, /^- The footguns review pass \(FOOTGUNS\) did not run: 2 attempts did not complete: [^\n]*\. A later pass looked for what it would have found\.$/m);
    assert.match(covered, /^- Group g1 of sweep-verification was not verified \(2 attempts did not complete: failed; failed again\): its candidates are SWEEP-1, SWEEP-2\.$/m);
    assert.doesNotMatch(brief, /g1|sweep-verification/, 'the brief names neither the group nor its phase');
    assert.match(report, /- Worktree checks: 9, none found a difference/);
    assert.match(report, /- Run budget: 30\.00 USD, checked before every launch; spent 4\.50 USD\./);
    assert.match(report, /- Unlocated candidates.*SWEEP-1 \(C:\\elsewhere\\b\.ts:9\)/);
    assert.match(report, /^- Workers with no reported cost: 1\. .* the costs above leave such workers out, so the run cost more than the totals show\. The budget check counted each such worker at its per-worker cap, except a worker lost with its engine, which it could not price and left out\.$/m);
    assert.match(report, /Findings: 2 \(1 CONFIRMED, 1 PLAUSIBLE\); 0 refuted at verification/);
    assert.ok(report.endsWith('\n') && !report.endsWith('\n\n'));
  });

  it('says why a run has no account of the change in one sentence, in the brief alone', () => {
    const state = reported().fold();
    const expected = { unrecorded: 'deep-review recorded no account of this change, because an engine before this change reviewed it.', none: 'deep-review gave no account of this change.' };
    for (const kind of ['unrecorded', 'none'] as const) {
      const report = renderReport({ ...state, review: { ...state.review!, change: { kind } } }, reportInput);
      assert.equal(report.split('\n')[2], expected[kind], kind);
      assert.ok(!report.includes('\n## The change, in full\n'), 'the account is told once (R1 of the report for the person)');
    }
  });

  it('names the Codex Windows sandbox a Codex run on Windows pinned, after the runtime, and nothing for a run that pins none (R7 of the Codex sandbox)', () => {
    const state = reported().fold();
    const pinning = (codex: ReviewConfiguration['codex']): RunState => ({ ...state, review: { ...state.review!, configuration: { ...state.review!.configuration, runtime: 'codex', codex } } });
    const expected = { unelevated: 'unelevated', elevated: 'elevated', none: 'none (workers that edit ran in no sandbox, workers that read under unelevated)' };
    assert.deepEqual(Object.keys(expected).sort(), [...codexWindowsSandboxesV4].sort(), 'every value the ledger can record is rendered');
    for (const windowsSandbox of codexWindowsSandboxesV4) {
      const words = expected[windowsSandbox];
      const report = renderReport(pinning({ windowsSandbox }), reportInput);
      assert.match(report, new RegExp(`^Runtime: codex [^\n]*\nCodex Windows sandbox: ${RegExp.escape(words)}\nModels: `, 'm'), windowsSandbox);
    }
    assert.doesNotMatch(renderReport(pinning(null), reportInput), /Windows sandbox/, 'a Codex run off Windows');
    assert.doesNotMatch(renderReport(state, reportInput), /Windows sandbox/, 'a Claude Code run');
  });

  it('names the unelevated sandbox for a Codex run configured before the setting existed only when its worktree is on Windows (R3, R7 of the Codex sandbox)', () => {
    const codexAt = (worktree: string): string => renderReport(new History().add('run.created', { worktree }).add('scope.captured', scope).add('review.configured', { ...configurationV3, runtime: 'codex', runBudgetUsd: null }, 3).fold(), reportInput);
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
    const report = renderReport(history.fold(), { ...reportInput, engine: '0.0.1+abc', statistics: noCost });
    assert.match(report, /^Engine: 0\.0\.1\+abc \(run created by 0\.0\.0\)$/m);
    assert.match(report, /## Findings\n\nNo finding survived verification\.\n/);
    assert.match(report, /## Refuted at verification\n\n- SCAN-1 \(SCAN\)  src\/a\.ts:3  SCAN-1 summary\n  Evidence: line 3 is a comment\n/);
    assert.match(report, /- The run budget did not apply: runtime claude reports no cost in USD/);
    assert.match(renderStats(history.fold(), noCost).join('\n'), /^\| Total \| 9 \| 22\.5 \| - \| 900 \| 180 \| 90 \|$/m);
    assert.doesNotMatch(report, /no reported cost/, 'a runtime that reports no cost has no unreported count to name');
    assert.match(report, /Findings: 0 \(0 CONFIRMED, 0 PLAUSIBLE\); 1 refuted at verification/);
  });

  it('names the run budget in force at the end, not the one the run was configured with', () => {
    const raised = ranked().add('limits.changed', { concurrency: 4, runBudgetUsd: 75.5 }).fold();
    assert.equal(raised.review!.configuration.runBudgetUsd, 30);
    const report = renderReport(raised, reportInput);
    assert.match(report, /^- Run budget: 75\.50 USD, checked before every launch; spent 4\.50 USD\.$/m);
    assert.doesNotMatch(report, /30\.00 USD/);
  });

  it('names what the budget check counted beside the reported spend when the two differ, as status does (R15 of resumable runs)', () => {
    const state = ranked().fold();
    const line = (budgetCheck: ReportInput['budgetCheck']): string | undefined => renderReport(state, { ...reportInput, budgetCheck }).split('\n').find((entry) => entry.startsWith('- Run budget: '));
    assert.equal(line({ usd: 4.5, charged: 0, lost: 0 }), '- Run budget: 30.00 USD, checked before every launch; spent 4.50 USD.', 'the check counted the reported spend alone');
    assert.equal(line({ usd: 12.5, charged: 1, lost: 0 }), '- Run budget: 30.00 USD, checked before every launch; spent 4.50 USD; the budget check counted 12.50 USD, counting 1 worker that reported no cost at its per-worker cap.');
    assert.equal(line({ usd: 20.5, charged: 2, lost: 1 }), '- Run budget: 30.00 USD, checked before every launch; spent 4.50 USD; the budget check counted 20.50 USD, counting 2 workers that reported no cost at their per-worker caps; 1 worker lost with an earlier engine is not counted.');
    assert.equal(line(null), '- Run budget: 30.00 USD, checked before every launch; spent 4.50 USD.', 'no check to name');
  });

  it('says a runtime that reports cost ran without a run budget, rather than that it reports no cost', () => {
    const state = ranked().fold();
    const unbudgeted = { ...state, review: { ...state.review!, limits: { ...state.review!.limits, runBudgetUsd: null } } };
    const report = renderReport(unbudgeted, { ...reportInput, statistics: { ...statistics, total: { ...statistics.total, costUnreported: 0 }, budgetApplied: false } });
    assert.match(report, /^- No run budget was set, so only the per-worker budgets and timeouts bounded this run; spent 4\.50 USD\.$/m);
    assert.doesNotMatch(report, /reports no cost in USD/);
    assert.doesNotMatch(report, /no reported cost/, 'no line for zero unreported workers');
    const withUnreported = renderReport(unbudgeted, { ...reportInput, statistics: { ...statistics, budgetApplied: false } });
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
    const report = renderReport(drifted, reportInput);
    assert.match(report, /- Worktree checks: 10, 1 found a difference in report \(attempt 1: src\/a\.ts modified\); each blocked the run/);
    assert.ok(report.includes(' 1 file too large to freeze, which no worker was given: big.bin.'), 'a gap of the brief (R10 of the brief of a run)');
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
          'SCAN-1': { ...review.candidates['SCAN-1']!, summary: 'refuted <stdin>\n# Heading', verdict: { verdict: 'REFUTED' as const, evidence: 'line 3 *x*\n\n## is a comment' }, duplicateOf: null },
        },
        anglesNotRun: { FOOTGUNS: 'timeout\n## Limitation heading' },
        unverifiedGroups: { ...review.unverifiedGroups, 'sweep-verification': { g1: 'failed\n# Group heading' } },
      },
    };
    const report = renderReport(hostile, reportInput);
    const headings = report.split('\n').filter((line) => line.startsWith('#'));
    assert.deepEqual(headings.filter((line) => line.startsWith('## ') || line.startsWith('# ')), ['# The uncommitted change on 22222222', '## What needs you', '## Before you merge', '## What deep-review would fix', '## Findings', '## What the review covered', '## Refuted at verification', '## About this run']);
    assert.equal(headings.filter((line) => line.startsWith('### ')).length, 2, 'one heading per finding, and nothing else at that level');
    assert.match(report, /^### 1\. ## Injected section second line$/m);
    assert.match(report, /^- Reason: because - a list item$/m);
    assert.match(report, /\(unlocated: C:\\x\.ts ## Heading from a path:9; unverified\) \(SWEEP-1\)$/m);
    assert.match(report, /^- SCAN-1 \(SCAN\) {2}src\/a\.ts:3 {2}refuted \\<stdin> # Heading\n {2}Evidence: line 3 \\\*x\\\* ## is a comment$/m, 'a refuted summary and its evidence are escaped as worker text (R11)');
    assert.match(report, /^- The footguns review pass \(FOOTGUNS\) did not run: timeout ## Limitation heading\. /m);
    assert.match(report, /^- Group g1 of sweep-verification was not verified \(failed # Group heading\): /m);
    assert.deepEqual(report.split('\n').filter((line) => line.includes('a list item')), ['- Reason: because - a list item'], 'no list item opened by a reason');
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
    const report = renderReport(withUnlocated({ 'SWEEP-3': ['src/gone.ts', 42], 'SWEEP-4': ['src/a.ts', 999], 'SWEEP-5': ['./SRC/A.ts', 998] }), reportInput);
    assert.match(report, /^- Unlocated candidates on a path the repository does not hold, or on a line past the end of an unchanged file: SWEEP-1 \(C:\\elsewhere\\b\.ts:9\)\.$/m);
    assert.match(report, /^- Unlocated candidates on a file the change deletes, which has no after state for a line to point into: SWEEP-3 \(src\/gone\.ts:42\)\.$/m);
    assert.match(report, /^- Unlocated candidates on a line past the end of the changed file: SWEEP-4 \(src\/a\.ts:999\), SWEEP-5 \(\.\/SRC\/A\.ts:998\)\.$/m, 'a whole path spelled with ./ or in another case names the changed file');
    assert.doesNotMatch(report, /ends with a changed path/, 'no candidate whose whole path names a changed file, or no scope path, is called ambiguous');
    assert.doesNotMatch(report, /did not match the reviewed change/, 'no candidate is described by a reason that is not its own');
  });

  it('never pins a candidate whose path only ends with a changed path to that changed path, since the ledger cannot tell it from an unchanged file', () => {
    // test/src/a.ts may be an unchanged file too short for line 3, rather than src/a.ts; /repo/src/gone.ts and a bare a.ts may be either.
    const report = renderReport(withUnlocated({ 'SWEEP-3': ['test/src/a.ts', 3], 'SWEEP-4': ['/repo/src/gone.ts', 42], 'SWEEP-5': ['a.ts', 5] }), reportInput);
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
    const report = renderReport(withOutside(), reportInput);
    assert.match(report, /^- Where: src\/caller\.ts:12 \(outside the change; unverified\) \(SWEEP-1\)$/m);
    assert.match(report, /^- Candidates on files outside the reviewed change: SWEEP-1 \(src\/caller\.ts:12\)\. Each points at an unchanged file of the repository, its line checked against the file as the worktree held it; no worktree check covers such a file\.$/m);
    assert.doesNotMatch(report, /Unlocated candidates/, 'a candidate on an unchanged file is located');
    assert.doesNotMatch(report, /C:\\repo/, 'the finder\'s spelling is not printed for a located candidate');
  });

  it('lists no candidate outside the change when none is, and leaves out a duplicate', () => {
    assert.doesNotMatch(renderReport(reported().fold(), reportInput), /outside the reviewed change|outside the change/);
    const state = withOutside();
    const review = state.review!;
    const duplicate = { ...state, review: { ...review, candidates: { ...review.candidates, 'SWEEP-1': { ...review.candidates['SWEEP-1']!, duplicateOf: 'RIPPLE-1' } } } };
    assert.doesNotMatch(renderReport(duplicate, reportInput), /Candidates on files outside the reviewed change/);
  });

  describe('the brief at the top, and the evidence after it (R12, R15 of the brief of a run)', () => {
    const answerable = (): RunState => decidedOf(reported(), [{ ...decisions[0], departure: { rule: 'parse trusts its callers', source: 'docs/rules.md', reason: 'a caller passes null' } }, askDecision('SWEEP-1', false)]).fold();

    it('starts with the brief, which ends at Findings, then one block per finding and the evidence (R1, R8 of the report for the person)', () => {
      const report = renderReport(answerable(), reportInput);
      assert.ok(report.startsWith('# The uncommitted change on 22222222\n\ndeep-review recorded no account of this change'), report.slice(0, 200));
      const parts = ['## What needs you\n', '## Before you merge\n', '## What deep-review would fix\n', '## Findings\n', '## What the review covered\n', '## Refuted at verification\n', '## About this run\n'].map((marker) => report.indexOf(`\n${marker}`));
      assert.ok(parts.every((position, index) => position > 0 && (index === 0 || parts[index - 1]! < position)), JSON.stringify(parts));
      assert.doesNotMatch(report, /^## (Decisions|Fixes|Changed files|Notes of the run|The run|Statistics|Angles)$/m);
    });

    it('puts an anchor before each finding, and each link of the brief points at one', () => {
      const report = renderReport(answerable(), reportInput);
      const anchors = [...report.matchAll(/^<a id="([^"]+)"><\/a>$/gm)].map((match) => match[1]);
      assert.deepEqual(anchors, ['finding-1', 'finding-2'], 'by the number of each finding (R6 of the report for the person)');
      for (const [number, id] of [[1, 'RIPPLE-1'], [2, 'SWEEP-1']] as const) assert.match(report, new RegExp(`^<a id="finding-${String(number)}"></a>\\n\\n### ${String(number)}\\. [^\\n]+\\n\\n[^\\n]+\\n\\n- Where: [^\\n]+\\(${id}`, 'm'), id);
      const links = [...report.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1]!);
      assert.ok(links.length >= 1, 'the table of the fixes links to its findings');
      for (const link of links) assert.ok(anchors.includes(link), link);
    });

    it('names no local path the engine writes before the facts of the run, and names each there (a path under ~ is in survey-report.test.ts)', () => {
      const state = fixRun().fold();
      const input = { ...reportInput, engineEntry: '/opt/engine/main.mjs', store: '/w/.git/deep-review-checkpoint/artifacts', fix: { patches: [reference('1'), reference('2'), reference('3')], continueCommand: null } };
      const report = renderReport({ ...state, review: { ...state.review!, configuration: { ...state.review!.configuration, executable: '/usr/local/bin/claude' } } }, input);
      const facts = report.indexOf('\n## About this run\n');
      assert.ok(facts > 0);
      const before = report.slice(0, facts);
      for (const local of ['/w/', '/opt/engine', '/usr/local/bin', '/home/me', '/evidence/']) assert.ok(!before.includes(local), `${local} before the facts of the run`);
      assert.match(before, /artifacts\/1{64}/, 'a patch by its name in the store');
      const after = report.slice(facts);
      assert.match(after, /^Repository: \/w$/m);
      assert.match(after, /^Runtime: claude [^\n]* at \/usr\/local\/bin\/claude$/m);
      assert.match(after, /^Evidence store: \/w\/\.git\/deep-review-checkpoint\/artifacts; a name such as `artifacts\/<hash>` in this report is the file `<hash>` in it\.$/m);
    });

    it('ends with the facts of the run, which name the command that continues a fix pass the run budget stopped', () => {
      const state = fixRun().fold();
      const fix = state.review!.fix!;
      const stopped = { ...state, review: { ...state.review!, fix: { ...fix, notAttempted: { ...fix.notAttempted, fixes: { 'c1-9': { cause: 'budget' as const, reason: 'spent' } } } } } } as RunState;
      const report = renderReport(stopped, { ...reportInput, fix: { patches: [reference('1'), reference('2'), reference('3')], continueCommand: 'node "/opt/e/main.mjs" review --fix --budget-usd 31' } });
      assert.match(report, /\n## About this run\n[\s\S]*\n\nThe run budget stopped the fix pass: 1 batch did not start\. `node "\/opt\/e\/main\.mjs" review --fix --budget-usd 31` continues it and reviews nothing again\.\n$/);
      assert.doesNotMatch(report.slice(0, report.indexOf('\n## Findings\n')), /batch|node /, 'the brief names no batch and no local path (R10 of the report for the person)');
    });

    it('names the documentation step in the facts of the run when the run budget stopped it, alone or with the batches and the repair (R8 of the documentation step)', () => {
      const state = fixRun().fold();
      const fix = state.review!.fix!;
      const spent = { cause: 'budget' as const, reason: 'spent' };
      const line = (notAttempted: Partial<typeof fix.notAttempted>): string | undefined => {
        const stopped = { ...state, review: { ...state.review!, fix: { ...fix, notAttempted: { ...fix.notAttempted, ...notAttempted } } } } as RunState;
        const report = renderReport(stopped, { ...reportInput, fix: { patches: [reference('1'), reference('2'), reference('3')], continueCommand: 'deep-review review --fix --budget-usd 31' } });
        return /^The run budget stopped the fix pass: (.*) did not start\./m.exec(report)?.[1];
      };
      assert.equal(line({ documentation: { documentation: spent } }), 'the documentation step');
      assert.equal(line({ fixes: { 'c1-9': spent }, documentation: { documentation: spent } }), '1 batch and the documentation step');
      assert.equal(line({ fixes: { 'c1-8': spent, 'c1-9': spent }, documentation: { documentation: spent }, repair: { repair: spent } }), '2 batches, the documentation step and the repair');
    });
  });

  it('refuses a run without a review', () => {
    const state = configured().fold();
    assert.throws(() => renderReport({ ...state, review: null }, reportInput), /Run run-1 has no review to report on/);
  });
});

describe('the block of each finding (R6 of the report for the person; R8 of the decision step)', () => {
  const render = (state: RunState): string => renderReport(state, reportInput);
  const departing = { ...decisions[0], departure: { rule: 'parse trusts its callers', source: 'src/a.ts:1', reason: 'the comment came with a caller that is gone' } };
  /** A finding's block, from its anchor to the next anchor or part. */
  const block = (report: string, number: number): string => {
    const start = report.indexOf(`<a id="finding-${String(number)}"></a>`);
    const next = report.indexOf('\n\n<a id=', start + 1);
    return report.slice(start, next === -1 ? report.indexOf('\n\n## ', start) : next);
  };

  it('gives a fix its decision, its plan, the options it rejected, the rule it goes against and the commands that review it', () => {
    const fixed = block(render(decidedOf(reported(), [departing, { ...decisions[1], leave: { reason: 'superseded', supersededBy: 'RIPPLE-1' } }]).fold()), 1);
    assert.ok(fixed.includes([
      'To fix against a written rule when the fix pass runs. Major, CONFIRMED.',
      '',
      '- Where: src/a.ts:4 (RIPPLE-1; merged into it: SWEEP-2 at src/a.ts:7)',
      '- Reason: same root cause at lines 4 and 7',
      '- Evidence: line 4 dereferences null',
      '- Decision: fix: parse reads the null on an empty input, at lines 4 and 7',
      '- Plan: guard the null once, before parse reads it.',
      '- Rejected: catch the throw in each caller: leaves the null in parse',
      '- Against a written rule: parse trusts its callers (src/a.ts:1): the comment came with a caller that is gone',
      '- To review: `deep-review answer --run run-1 --finding 1 --accept` keeps the fix and changes the rule, `deep-review answer --run run-1 --finding 1 --reject` follows the rule',
    ].join('\n')), fixed);
  });

  it('gives a finding left its reason, and the finding that supersedes it by its number', () => {
    const report = render(decidedOf(reported(), [departing, { ...decisions[1], leave: { reason: 'superseded', supersededBy: 'RIPPLE-1' } }]).fold());
    assert.match(block(report, 2), /^- Decision: left, superseded by finding 1: the helper would edit only lines the change does not touch$/m);
    assert.match(block(render(decidedOf(reported()).fold()), 2), /^- Decision: left, outside the change, and not a regression: the helper would edit only lines the change does not touch$/m);
  });

  it('gives a question why it asks, each option with its marks, cost and rule, where deep-review looked, and the command that answers', () => {
    const asked = block(render(decidedOf(reported(), [departing, askDecision('SWEEP-1', false)]).fold()), 2);
    assert.ok(asked.includes([
      '- Decision: ask you; why it asks: nothing in the repository states which behavior is meant',
      '- Question: Should parse accept an empty input?',
      '- Option 1, the default, in place now: keep accepting it. Cost: callers that pass one now see the change. Rule: parse rejects an empty input.',
      '- Option 2, deep-review\'s choice: accept it and return an empty result. Cost: an empty input passes silently. Rule: parse accepts an empty input.',
      '- Where deep-review looked: the change\'s commit message; README.md; test/a.test.ts',
      '- To answer: `deep-review answer --run run-1 --finding 2 --option <n>`, with the number of the option',
    ].join('\n')), asked);
    assert.match(asked, /^A question for you\. Minor, PLAUSIBLE, which no verifier examined\.$/m);
    const readOnly = block(render(decidedOf(reported(), [decisions[0], askDecision('SWEEP-1', true)]).fold()), 2);
    assert.match(readOnly, /^- Option 1, the default, which the tree does not hold: reject it with an error\./m, 'a default that edits is not in place in a run that only reviewed');
  });

  it('gives an answered question its answer, when, and what applied it, the tree or nothing yet', () => {
    const asked = decidedOf(reported(), [decisions[0], askDecision('SWEEP-1', false)]);
    const recorded = (option: number): { report: string; at: string } => {
      const history = asked.clone().add('answer.recorded', { id: 'SWEEP-1', answer: { kind: 'option', option }, note: null });
      return { report: render(history.fold()), at: history.events.at(-1)!.recordedAt };
    };
    const held = recorded(0);
    assert.match(block(held.report, 2), new RegExp(`^- Answer: option 1 on ${held.at}; the option the tree held$`, 'm'));
    assert.ok(held.report.includes('It follows your answers to finding 2'), 'the status line says so (R14 of the report for the person)');
    assert.doesNotMatch(held.report, /Finding 2 asks you a question/, 'an answered question leaves what needs you');
    const owed = recorded(1);
    assert.match(block(owed.report, 2), new RegExp(`^- Answer: option 2 on ${owed.at}; not yet applied$`, 'm'));
    assert.match(owed.report, /^Answers: 1 recorded, 0 applied$/m, 'the header counts the answers');
    assert.doesNotMatch(owed.report, /^Answered: the last pass/m, 'no pass yet');
  });

  it('gives a reviewed departure its answer and what applied it, and a note given with it', () => {
    const readOnly = decidedOf(reported(), [departing, decisions[1]]);
    const rejected = readOnly.clone().add('answer.recorded', { id: 'RIPPLE-1', answer: { kind: 'reject' }, note: 'the caller is still there' });
    const at = rejected.events.at(-1)!.recordedAt;
    assert.match(block(render(rejected.fold()), 1), new RegExp(`^- Answer: rejected on ${at}; not yet applied\\. Note: the caller is still there$`, 'm'));
  });

  it('says an unanswered default that edits is in place in a fix run only once its fixer applied it', () => {
    const asked = (status: string): string => block(render(decidedFixRun([askDecision('RIPPLE-1', true), askDecision('SWEEP-1', false)], status).fold()), 1);
    assert.match(asked('applied'), /^- Option 1, the default, in place now: reject it with an error\./m);
    for (const status of ['deferred', 'blocked']) assert.match(asked(status), /^- Option 1, the default, which the tree does not hold: reject it with an error\./m, status);
  });

  it('keeps a decider\'s text on its own line whatever it holds, so it cannot open a heading or a list item', () => {
    const hostile = { ...askDecision('SWEEP-1', false), grounds: 'first line\n## Not a heading\n- not an item' };
    const report = render(decidedOf(reported(), [decisions[0], hostile]).fold());
    assert.doesNotMatch(report, /^## Not a heading$/m);
    assert.match(report, /^- Decision: ask you; why it asks: first line ## Not a heading - not an item$/m);
    const lines = { ...askDecision('SWEEP-1', false), ask: { ...(askDecision('SWEEP-1', false) as { ask: Record<string, unknown> }).ask, options: [{ option: 'a\n## b', cost: 'd', rule: 'e', edits: false }, { option: 'f', cost: 'g', rule: 'h', edits: true }] } };
    assert.match(render(decidedOf(reported(), [decisions[0], lines]).fold()), /^ {3}- Option 1, the default, in place now: a ## b\. Cost: d\. Rule: e\.$/m, 'an option cannot open a line of its own');
  });

  it('adds the number of another finding after its id in a worker\'s text, and escapes what a preview would hide (R6, R11 of the report for the person)', () => {
    const state = decidedOf(reported(), [{ ...decisions[0], grounds: 'as SWEEP-1 says, <stdin> is read twice' }, decisions[1]]).fold();
    assert.match(block(render(state), 1), /^- Decision: fix: as SWEEP-1 \(finding 2\) says, \\<stdin> is read twice$/m);
  });

  it('has no decision in a run configured before the decision step', () => {
    assert.doesNotMatch(render(reported().fold()), /^- Decision: /m);
  });

  // R9 and PD5 of the skill surface corrections: no `deep-review` executable is installed, so the report says once what a person at a terminal types, with the path of the engine that wrote it.
  it('says once, in the facts of the run, how a person at a terminal runs the answer command, with the path of the engine that wrote the report, and keeps the short name on each line', () => {
    const terminal = 'At a terminal, type a command of this report from the repository with the engine that wrote the report in place of `deep-review`: `node "/opt/deep review/engine/main.mjs" answer --finding <number> --option <n>`, with `--accept` or `--reject` in place of `--option <n>` for a departure. Through the deep-review skill, ask the agent to answer the finding with the option you choose.';
    const asked = render(decidedOf(reported(), [departing, askDecision('SWEEP-1', false)]).fold());
    assert.equal(asked.split(terminal).length - 1, 1, 'said once');
    assert.ok(asked.indexOf(terminal) > asked.indexOf('\n## About this run\n'), 'in the facts of the run, the one part that names a local path (R15 of the brief of a run)');
    // Each question and departure keeps the short name a reader cites.
    assert.match(asked, /To take it: `deep-review answer --run run-1 --finding 2 --option 2`\./m);
    assert.match(asked, /To keep the fix and change the rule: `deep-review answer --run run-1 --finding 1 --accept`\. To follow the rule: `deep-review answer --run run-1 --finding 1 --reject`\.$/m);
    assert.match(asked, /^- To review: `deep-review answer --run run-1 --finding 1 --accept` keeps the fix and changes the rule, `deep-review answer --run run-1 --finding 1 --reject` follows the rule$/m);
    assert.ok(render(decidedOf(reported(), [departing, decisions[1]]).fold()).includes(terminal), 'a departure alone');
    assert.ok(!render(decidedOf(reported()).fold()).includes('At a terminal'), 'no question and no departure');
    // The path is the one the report's writer was given, as a Windows install spells it too.
    const windows = renderReport(decidedOf(reported(), [departing, decisions[1]]).fold(), { ...reportInput, engineEntry: 'C:\\Users\\me\\.claude\\plugins\\deep-review\\engine\\main.mjs' });
    assert.ok(windows.includes('`node "C:\\Users\\me\\.claude\\plugins\\deep-review\\engine\\main.mjs" answer --finding <number> --option <n>`'), windows);
    // A path with a backtick cannot close the code span early, and is single-quoted, since bash would run it as a command substitution inside double quotes.
    const ticked = renderReport(decidedOf(reported(), [departing, decisions[1]]).fold(), { ...reportInput, engineEntry: '/opt/a`b/main.mjs' });
    assert.ok(ticked.includes('``node \'/opt/a`b/main.mjs\' answer --finding <number> --option <n>``'), ticked);
    // A `$` or a `"` would be expanded or end double quotes, so such a path is single-quoted too.
    const dollar = renderReport(decidedOf(reported(), [departing, decisions[1]]).fold(), { ...reportInput, engineEntry: '/home/me/$work/main.mjs' });
    assert.ok(dollar.includes('`node \'/home/me/$work/main.mjs\' answer --finding <number> --option <n>`'), dollar);
    const quoted = renderReport(decidedOf(reported(), [departing, decisions[1]]).fold(), { ...reportInput, engineEntry: '/opt/a"b/main.mjs' });
    assert.ok(quoted.includes('`node \'/opt/a"b/main.mjs\' answer --finding <number> --option <n>`'), quoted);
  });

  // FOOTGUNS-1 of the gate: the command a person pastes reaches the shell with the engine's path intact, whatever it holds.
  it('names the engine\'s path in a form bash hands on as written, when it holds a space, $, a backtick or a "', (t) => {
    if (spawnSync('bash', ['-c', 'printf %s ok'], { windowsHide: true }).status !== 0) return t.skip('no bash here');
    for (const engineEntry of ['/opt/deep review/engine/main.mjs', '/home/me/$work/main.mjs', '/opt/a`b`/main.mjs', '/opt/a"b/main.mjs', "/opt/it's/main.mjs"]) {
      const report = renderReport(decidedOf(reported(), [departing, decisions[1]]).fold(), { ...reportInput, engineEntry });
      const path = /`+ ?node (.+?) answer --finding <number> --option <n> ?`+/.exec(report)?.[1];
      assert.ok(path !== undefined, report);
      const result = spawnSync('bash', ['-c', `printf %s ${path}`], { encoding: 'utf8', windowsHide: true });
      assert.equal(result.stdout, engineEntry, `${engineEntry}: ${result.stderr}`);
    }
  });

});

describe('a report after an answer pass (R10 of answers)', () => {
  /** The decided fix run, its departure rejected and SWEEP-1 answered with option 2, through a pass that applied the first and deferred the second, to its second report. */
  const passed = (): History => passToReport(decidedFixRun().add('answer.recorded', answer('RIPPLE-1', 'reject')).add('answer.recorded', answer('SWEEP-1', 1)).add('answer.pass', { ids: ['RIPPLE-1', 'SWEEP-1'] }), 1, [['RIPPLE-1', 'applied'], ['SWEEP-1', 'deferred']], 2);
  const render = (state: RunState): string => renderReport(state, { ...reportInput, fix: { patches: [reference('1'), reference('2')], continueCommand: null } });

  it('says in the header how many answers the run holds, when the last pass ran and where the report before it is', () => {
    const history = passed();
    const pass = history.review().answerPasses[0]!;
    const report = render(history.fold());
    assert.match(report, /^Answers: 2 recorded, 1 applied$/m);
    assert.ok(report.includes(`\nAnswered: the last pass on ${pass.at}, after the report artifacts/${'9'.repeat(64)}\n`), report);
  });

  it('marks each answer applied by the pass or still owed, and gives each finding the pass worked its outcome and patch', () => {
    const report = render(passed().fold());
    const at = passed().review().answerPasses[0]!.at;
    assert.match(report, new RegExp(`^- Answer: rejected on [^;]+; applied by the answer pass of ${at}$`, 'm'));
    assert.match(report, /^- Answer: option 2 on [^;]+; not yet applied$/m, 'the pass deferred it, so it is still owed');
    assert.match(report, new RegExp(`^- Fix: applied; RIPPLE-1 answered\\n- Commit message: fix: Answer RIPPLE-1\\n- Patch: 1, 2\\n- Answer pass: pass-1, opened on ${at}$`, 'm'));
    assert.match(report, /^- Fix: deferred; SWEEP-1 answered\n- Patch: none\n- Answer pass: pass-1, opened on [^\n]+$/m, 'a held finding the pass worked has the pass\'s outcome');
  });

  it('says a rejection the tree held through the applied one holds the fix that follows the rule, and an acceptance owed after it', () => {
    const accepted = passed().add('answer.recorded', answer('RIPPLE-1', 'accept'));
    assert.match(render(accepted.fold()), /^- Answer: accepted on [^;]+; not yet applied$/m);
    const rejectedAgain = accepted.clone().add('answer.recorded', answer('RIPPLE-1', 'reject'));
    assert.match(render(rejectedAgain.fold()), new RegExp(`^- Answer: rejected on ${rejectedAgain.events.at(-1)!.recordedAt}; the rule-following fix the tree held$`, 'm'));
  });

  it('gives each check the run after your answers, and says the checks did not run after a pass that changed nothing', () => {
    const report = render(passed().fold());
    assert.match(report, /^- After your answers: passed, [\d.]+ s$/m);
    const quiet = passToReport(decidedFixRun().add('answer.recorded', answer('SWEEP-1', 1)).add('answer.pass', { ids: ['SWEEP-1'] }), 1, [['SWEEP-1', 'deferred']], 1);
    const quietReport = renderReport(quiet.fold(), { ...reportInput, fix: { patches: [reference('1')], continueCommand: null } });
    assert.match(quietReport, /^- After your answers: not run, since no answer pass changed a file\.$/m);
    assert.doesNotMatch(render(decidedFixRun().fold()), /After your answers/, 'a run with no pass has no such line');
  });

  it('says which patches are committed once deep-review commit built a series before the pass', () => {
    const history = new History();
    const first = { commits: [{ sha: 'a'.repeat(40), revision: 'change', subject: 'the change' }, { sha: 'b'.repeat(40), revision: 0, subject: 'fix: Guard the null' }], from: '2'.repeat(40), to: 'b'.repeat(40) };
    for (const event of passed().events) {
      history.add(event.kind, event.payload, event.version);
      if (event.kind === 'phase.finished' && (event.payload as { phase: string; attempt: number }).phase === 'report' && (event.payload as { attempt: number }).attempt === 1) history.add('commits.created', first);
    }
    const report = render(history.fold());
    assert.match(report, /^Fix pass: [^\n]*; 2 patches; patch 1 is committed; patch 2, an answer pass's, is in the working tree, uncommitted$/m);
    assert.match(report, /^1\. fix: Guard the null \(finding 1, c1-1\), src\/a\.ts modified, committed as bbbbbbbb: /m);
    assert.match(report, /^2\. [^\n]*\(finding 1, pass-1, an answer pass after the commits\)/m);
  });
});

// R7 of fix pass continuation.
describe('the report of a run continued into the fix pass', () => {
  const fix = { patches: [reference('1')], continueCommand: null };

  it('says in its header when the run was continued and where its read-only report is, after the models', () => {
    const state = continuedToReport().fold();
    const report = renderReport(state, { ...reportInput, fix });
    const at = state.review!.continuedFrom!.at;
    assert.match(report, new RegExp(`^Models: strong opus, fast sonnet\\nContinued: into the fix pass on ${at.replaceAll('.', '\\.')}, after the read-only report artifacts/e{64}\\nFindings: `, 'm'));
    assert.match(report, /^## Patches$/m, 'a full fix run\'s report');
  });

  it('has no such line for a run never continued, read-only or fixing', () => {
    assert.doesNotMatch(renderReport(readOnlyReported().fold(), reportInput), /^Continued:/m);
    assert.doesNotMatch(renderReport(fixRun().fold(), { ...reportInput, fix }), /^Continued:/m);
  });

  it('names the read-only report by its name in the store, whatever the input gives of the fix pass (R15 of the brief of a run)', () => {
    assert.match(renderReport(continuedToReport().fold(), reportInput), /^Continued: into the fix pass on [^,]+, after the read-only report artifacts\/e{64}$/m);
  });
});
