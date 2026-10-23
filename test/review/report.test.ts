import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { codexWindowsSandboxesV4, type ChangeReading, type ReviewConfiguration } from '../../src/checkpoint/events.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { conditionWords } from '../../src/review/prompts.ts';
import { renderReport, type ReportInput } from '../../src/review/report.ts';
import { answer, askDecision, changeReading, configurationV3, decidedFixRun, passToReport, configured, continuedToReport, decidedOf, decisions, fixRun, History, ranked, readOnlyReported, reference, reported, scope, statistics, triaged, worker, reportInput } from '../helpers/review-history.ts';
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
    for (const heading of ['# The uncommitted change on 22222222', '## The change', '## What the review did not cover', '## Where to look', '## What deep-review changed', '## The change, in full', '## Findings', '## Angles', '## Refuted at verification', '## Statistics', '## Notes of the run', '## The run']) assert.ok(report.includes(`\n${heading}\n`) || report.startsWith(`${heading}\n`), heading);
    assert.match(report, /^\| FOOTGUNS \| not run \(2 attempts did not complete: .*\) \| none \|$/m);
    assert.match(report, /^\| RIPPLE \| run \| the callers of parse\(\) \|$/m);
    assert.match(report, /^\| SCAN \| run \(as the triage\) \| - \|$/m);
    assert.match(report, /^### 1\. \[major\] CONFIRMED  RIPPLE-1 \(also SWEEP-2\)  src\/a\.ts:4$/m);
    assert.match(report, /^### 2\. \[minor\] PLAUSIBLE  SWEEP-1  C:\\elsewhere\\b\.ts:9 \(unlocated: C:\\elsewhere\\b\.ts:9; unverified\)$/m);
    assert.match(report, /Evidence: none; the verifier of this group failed twice/);
    assert.match(report, /Also at: SWEEP-2 src\/a\.ts:7/);
    // The angle that did not run and the group no verifier examined are gaps of the brief (R10 of the brief of a run); only the group keeps a note, which names it and its phase, as the brief does not (R12).
    assert.match(report, /^- The FOOTGUNS angle did not run \(2 attempts did not complete: [^\n]*\)\. A later pass looked for what it would have found\.$/m);
    assert.match(report, /^- No verifier examined SWEEP-1, SWEEP-2 \(2 attempts did not complete: failed; failed again\); each counts as PLAUSIBLE\.$/m);
    assert.doesNotMatch(report, /^- Angle FOOTGUNS did not run/m);
    const notes = report.slice(report.indexOf('\n## Notes of the run\n'));
    assert.match(notes, /^- Group g1 of sweep-verification was not verified \(2 attempts did not complete: failed; failed again\): its candidates \(SWEEP-1, SWEEP-2\) are a gap of the brief\.$/m);
    assert.doesNotMatch(report.slice(0, report.indexOf('\n---\n')), /g1|sweep-verification/, 'the brief names neither the group nor its phase');
    assert.match(report, /- Worktree checks: 9, none found a difference/);
    assert.match(report, /- Run budget: 30\.00 USD, checked before every launch; spent 4\.50 USD\./);
    assert.match(report, /- Unlocated candidates.*SWEEP-1 \(C:\\elsewhere\\b\.ts:9\)/);
    assert.match(report, /^\| Total \| 9 \| 22\.5 \| 4\.50 \(1 worker unreported\) \| 900 \| 180 \| 90 \|$/m);
    assert.match(report, /^\| triage \| 1 \| 2\.5 \| 0\.50 \| 100 \| 20 \| 10 \|$/m, 'a row with every cost reported carries no mark');
    assert.match(report, /^- Workers with no reported cost: 1\. .* the costs above leave such workers out, so the run cost more than the totals show\. The budget check counted each such worker at its per-worker cap, except a worker lost with its engine, which it could not price and left out\.$/m);
    assert.match(report, /Findings: 2 \(1 CONFIRMED, 1 PLAUSIBLE\); 0 refuted at verification/);
    assert.ok(report.endsWith('\n') && !report.endsWith('\n\n'));
  });

  it('says why a run has no account of the change in one sentence, the same in the brief and in the evidence', () => {
    const state = reported().fold();
    const expected = { unrecorded: 'The triage of this run did not record the core of the change, because an engine before this change reviewed it.', none: 'The triage of this run gave no account of the change.' };
    for (const kind of ['unrecorded', 'none'] as const) {
      const report = renderReport({ ...state, review: { ...state.review!, change: { kind } } }, reportInput);
      const after = (heading: string): string => report.slice(report.indexOf(`\n${heading}\n\n`) + heading.length + 3).split('\n')[0]!;
      assert.equal(after('## The change'), expected[kind], kind);
      assert.equal(after('## The change, in full'), expected[kind], kind);
    }
  });

  it('words each judgment of the triage in the change in full as the scope block words it, after its own label', () => {
    const state = reported().fold();
    const reading = { ...changeReading, wideEffect: { holds: true, what: null, files: [] } } as unknown as ChangeReading;
    const report = renderReport({ ...state, review: { ...state.review!, change: { kind: 'given', reading } } }, reportInput);
    const evidence = report.slice(report.indexOf('\n## The change, in full\n'));
    assert.match(evidence, /^- Public interface: yes, parse\(\) can now return null\. \(in src\/a\.ts\)$/m);
    assert.match(evidence, /^- Wide effect: yes$/m);
    for (const [label, condition] of [['Public interface', reading.publicInterface], ['Wide effect', reading.wideEffect]] as const) assert.match(evidence, new RegExp(`^- ${label}: ${RegExp.escape(conditionWords(condition))}$`, 'm'), label);
    const without = renderReport({ ...state, review: { ...state.review!, change: { kind: 'given', reading: changeReading as unknown as ChangeReading } } }, reportInput);
    assert.match(without, /^- Wide effect: no$/m);
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
    assert.match(report, /^\| Total \| 9 \| 22\.5 \| - \| 900 \| 180 \| 90 \|$/m);
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
    assert.match(report, /^- 1 file too large to freeze, which no worker was given: big\.bin\.$/m, 'a gap of the brief (R10 of the brief of a run)');
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
    const report = renderReport(hostile, reportInput);
    const headings = report.split('\n').filter((line) => line.startsWith('#'));
    assert.deepEqual(headings.filter((line) => line.startsWith('## ') || line.startsWith('# ')), ['# The uncommitted change on 22222222', '## The change', '## What the review did not cover', '## Where to look', '## What deep-review changed', '## The change, in full', '## Findings', '## Angles', '## Refuted at verification', '## Statistics', '## Notes of the run', '## The run']);
    assert.equal(headings.filter((line) => line.startsWith('### ')).length, 2, 'one heading per finding, and nothing else at that level');
    assert.match(report, /^\\## Injected section second line$/m);
    assert.match(report, /^Reason: because - a list item$/m);
    assert.match(report, /\(unlocated: C:\\x\.ts ## Heading from a path:9; unverified\)$/m);
    assert.match(report, /^- SCAN-1 \(SCAN\) {2}src\/a\.ts:3 {2}refuted # Heading\n {2}Evidence: line 3 ## is a comment$/m);
    assert.match(report, /^- The FOOTGUNS angle did not run \(timeout ## Limitation heading\)\. /m);
    assert.match(report, /^- No verifier examined SWEEP-1, SWEEP-2 \(failed # Group heading\); /m);
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
    assert.match(report, /^### 2\. \[minor\] PLAUSIBLE  SWEEP-1  src\/caller\.ts:12 \(outside the change; unverified\)$/m);
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

    it('starts with the brief, then a rule and one sentence, then the evidence', () => {
      const report = renderReport(answerable(), reportInput);
      assert.ok(report.startsWith('# The uncommitted change on 22222222\n\n2 things need you: 1 question and 1 fix that goes against a written rule.'), report.slice(0, 200));
      const parts = ['## The change\n', '## Questions for you (1)\n', '## Fixes that go against a written rule (1)\n', '## What the review did not cover\n', '## Where to look\n', '## What deep-review changed\n', '---\n\nThe evidence for each statement above follows.\n', '## The change, in full\n'].map((marker) => report.indexOf(`\n${marker}`));
      assert.ok(parts.every((position, index) => position > 0 && (index === 0 || parts[index - 1]! < position)), JSON.stringify(parts));
    });

    it('puts an anchor before each finding, and each link of the brief points at one', () => {
      const report = renderReport(answerable(), reportInput);
      const anchors = [...report.matchAll(/^<a id="([^"]+)"><\/a>$/gm)].map((match) => match[1]);
      assert.deepEqual(anchors, ['finding-ripple-1', 'finding-sweep-1']);
      for (const id of ['RIPPLE-1', 'SWEEP-1']) assert.match(report, new RegExp(`^<a id="finding-${id.toLowerCase()}"></a>\\n\\n### \\d\\. \\[[a-z]+\\] [A-Z]+  ${id} `, 'm'), id);
      const links = [...report.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1]!);
      assert.ok(links.length >= 3, 'the question, the departure and where to look link to their findings');
      for (const link of links) assert.ok(anchors.includes(link) || link === 'the-change-in-full', link);
    });

    it('names no local path the engine writes before the facts of the run, and names each there (a path under ~ is in survey-report.test.ts)', () => {
      const state = fixRun().fold();
      const input = { ...reportInput, engineEntry: '/opt/engine/main.mjs', store: '/w/.git/deep-review-checkpoint/artifacts', fix: { patches: [reference('1'), reference('2'), reference('3')], continueCommand: null } };
      const report = renderReport({ ...state, review: { ...state.review!, configuration: { ...state.review!.configuration, executable: '/usr/local/bin/claude' } } }, input);
      const facts = report.indexOf('\n## The run\n');
      assert.ok(facts > 0);
      const before = report.slice(0, facts);
      for (const local of ['/w/', '/opt/engine', '/usr/local/bin', '/home/me', '/evidence/']) assert.ok(!before.includes(local), `${local} before the facts of the run`);
      assert.match(before, /artifacts\/1{64}/, 'a patch by its name in the store');
      const after = report.slice(facts);
      assert.match(after, /^Repository: \/w$/m);
      assert.match(after, /^Runtime: claude [^\n]* at \/usr\/local\/bin\/claude$/m);
      assert.match(after, /^Evidence store: \/w\/\.git\/deep-review-checkpoint\/artifacts; a name such as artifacts\/<hash> in this report is the file <hash> in it\.$/m);
    });

    it('ends with the facts of the run, which name the command that continues a fix pass the run budget stopped', () => {
      const state = fixRun().fold();
      const fix = state.review!.fix!;
      const stopped = { ...state, review: { ...state.review!, fix: { ...fix, notAttempted: { ...fix.notAttempted, fixes: { 'c1-9': { cause: 'budget' as const, reason: 'spent' } } } } } } as RunState;
      const report = renderReport(stopped, { ...reportInput, fix: { patches: [reference('1'), reference('2'), reference('3')], continueCommand: 'node "/opt/e/main.mjs" review --fix --budget-usd 31' } });
      assert.match(report, /\n## The run\n[\s\S]*\n\nThe run budget stopped the fix pass: 1 batch did not start\. `node "\/opt\/e\/main\.mjs" review --fix --budget-usd 31` continues it and reviews nothing again\.\n$/);
      assert.match(report, /^- The run budget stopped the fixes before [^\n]+ (was|were) attempted\. The facts of the run at the end of the report give the command that continues them\.$/m);
      assert.doesNotMatch(report.slice(0, report.indexOf('\n---\n')), /batch/, 'the brief names no batch (R12 of the brief of a run)');
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

describe('the Decisions section (R8 of the decision step)', () => {
  const render = (state: RunState): string => renderReport(state, reportInput);
  const departing = { ...decisions[0], departure: { rule: 'parse trusts its callers', source: 'src/a.ts:1', reason: 'the comment came with a caller that is gone' } };

  it('follows the change in full and comes before Findings and Angles, counting the decisions and the fixes that depart from a rule (R12 of the brief of a run)', () => {
    const report = render(decidedOf(reported(), [departing, askDecision('SWEEP-1', false)]).fold());
    const order = ['\n---\n', '\n## The change, in full\n', '\n## Decisions\n', '\n## Findings\n', '\n## Angles\n', '\n## The run\n'].map((marker) => report.indexOf(marker));
    assert.ok(order.every((position) => position > 0) && order.every((position, index) => index === 0 || order[index - 1]! < position), JSON.stringify(order));
    assert.match(report, /^Before any fix, the decision step decided each finding: 1 to fix, 0 to leave, 1 to ask the author; 1 fix departs from a rule the repository states\. A fixer applies a finding to fix, and the default of a question that edits, when the run fixes; no fixer sees a finding left\.$/m);
  });

  it('gives each question in the brief, with the option in place now, deep-review\'s choice, every option\'s cost and rule, where the decider looked and why, and says in Decisions how it stands (R8 of the brief of a run)', () => {
    const report = render(decidedOf(reported(), [departing, askDecision('SWEEP-1', false)]).fold());
    assert.ok(report.includes([
      '### 1. Should parse accept an empty input? ([SWEEP-1](#finding-sweep-1))',
      '',
      'In place now: option 1, because it is the easiest to take back. deep-review\'s choice: option 2.',
      '',
      '| Option | What it does | What it costs |',
      '|---|---|---|',
      '| 1, in place now | keep accepting it | callers that pass one now see the change |',
      '| 2, deep-review\'s choice | accept it and return an empty result | an empty input passes silently |',
      '',
      'To take deep-review\'s choice: `deep-review answer --finding SWEEP-1 --option 2`. For another option, give its number.',
      '',
      '<details><summary>The rule that each option makes, where deep-review looked, and why it asks</summary>',
      '',
      '- Option 1 makes this rule: parse rejects an empty input',
      '- Option 2 makes this rule: parse accepts an empty input',
      '- Where deep-review looked: the change\'s commit message; README.md; test/a.test.ts',
      '- Why it asks: nothing in the repository states which behavior is meant',
      '',
      '</details>',
    ].join('\n')), report);
    assert.match(report, /^### Asked\n\nNone of these held the run up: each has a default, and an answer is needed only to go another way\. This run does not fix: no fixer ran, and the tree is unchanged\. The brief at the top of this report gives each question with its options\.\n\n- 2\\\. SWEEP-1: not answered; the default in place is keep accepting it \(no edit\)$/m);
    assert.doesNotMatch(report, /next review settles the question alone/, 'nothing yet carries an answer to the next review (PD3 of answers)');
  });

  it('says in one line when the option in place now is also deep-review\'s choice', () => {
    const asked = askDecision('SWEEP-1', false) as { ask: Record<string, unknown> };
    const same = { ...asked, ask: { ...asked.ask, recommended: 0 } };
    const report = render(decidedOf(reported(), [decisions[0], same]).fold());
    assert.match(report, /^In place now: option 1, which is also deep-review's choice, because it is the easiest to take back\.$/m);
    assert.match(report, /^\| 1, in place now, deep-review's choice \| /m);
    assert.match(report, /^To take deep-review's choice: `deep-review answer --finding SWEEP-1 --option 1`\./m);
  });

  it('says once what an answer does and that the next review may ask again, when there is a question or a departure, and never without (R10 of answers)', () => {
    const sentence = /^An answer given with `deep-review answer` is recorded on this run and applied to it: on a run that fixed, by an answer pass whose edits `deep-review commit` commits, on top of any commits it already made for the run; on a run that only reviewed, by `review --fix`, which continues it\. Nothing yet carries an answer to the next review, which may ask the same question again\.$/gm;
    assert.equal(render(decidedOf(reported(), [departing, askDecision('SWEEP-1', false)]).fold()).match(sentence)?.length, 1);
    assert.equal(render(decidedOf(reported(), [departing, decisions[1]]).fold()).match(sentence)?.length, 1, 'a departure alone');
    assert.equal(render(decidedOf(reported()).fold()).match(sentence), null, 'no question and no departure');
  });

  // R9 and PD5 of the skill surface corrections: no `deep-review` executable is installed, so the report says once what a person at a terminal types, with the path of the engine that wrote it.
  it('says once, in the facts of the run, how a person at a terminal runs the answer command, with the path of the engine that wrote the report, and keeps the short name on each line', () => {
    const terminal = 'At a terminal, type a command of this report from the repository with the engine that wrote the report in place of `deep-review`: `node "/opt/deep review/engine/main.mjs" answer --finding <id> --option <n>`, with `--accept` or `--reject` in place of `--option <n>` for a departure. Through the deep-review skill, ask the agent to answer the finding with the option you choose.';
    const asked = render(decidedOf(reported(), [departing, askDecision('SWEEP-1', false)]).fold());
    assert.equal(asked.split(terminal).length - 1, 1, 'said once');
    assert.ok(asked.indexOf(terminal) > asked.indexOf('\n## The run\n'), 'in the facts of the run, the one part that names a local path (R15 of the brief of a run)');
    // Each question and departure keeps the short name a reader cites.
    assert.match(asked, /^To take deep-review's choice: `deep-review answer --finding SWEEP-1 --option 2`\./m);
    assert.match(asked, /^To keep the fix and change the rule: `deep-review answer --finding RIPPLE-1 --accept`\. To follow the rule: `deep-review answer --finding RIPPLE-1 --reject`\.$/m);
    assert.match(asked, /^ {2}- Review with: `deep-review answer --finding RIPPLE-1 --accept` or `--reject`$/m);
    assert.ok(render(decidedOf(reported(), [departing, decisions[1]]).fold()).includes(terminal), 'a departure alone');
    assert.ok(!render(decidedOf(reported()).fold()).includes('At a terminal'), 'no question and no departure');
    // The path is the one the report's writer was given, as a Windows install spells it too.
    const windows = renderReport(decidedOf(reported(), [departing, decisions[1]]).fold(), { ...reportInput, engineEntry: 'C:\\Users\\me\\.claude\\plugins\\deep-review\\engine\\main.mjs' });
    assert.ok(windows.includes('`node "C:\\Users\\me\\.claude\\plugins\\deep-review\\engine\\main.mjs" answer --finding <id> --option <n>`'), windows);
    // A path with a backtick cannot close the code span early, and is single-quoted, since bash would run it as a command substitution inside double quotes.
    const ticked = renderReport(decidedOf(reported(), [departing, decisions[1]]).fold(), { ...reportInput, engineEntry: '/opt/a`b/main.mjs' });
    assert.ok(ticked.includes('``node \'/opt/a`b/main.mjs\' answer --finding <id> --option <n>``'), ticked);
    // A `$` or a `"` would be expanded or end double quotes, so such a path is single-quoted too.
    const dollar = renderReport(decidedOf(reported(), [departing, decisions[1]]).fold(), { ...reportInput, engineEntry: '/home/me/$work/main.mjs' });
    assert.ok(dollar.includes('`node \'/home/me/$work/main.mjs\' answer --finding <id> --option <n>`'), dollar);
    const quoted = renderReport(decidedOf(reported(), [departing, decisions[1]]).fold(), { ...reportInput, engineEntry: '/opt/a"b/main.mjs' });
    assert.ok(quoted.includes('`node \'/opt/a"b/main.mjs\' answer --finding <id> --option <n>`'), quoted);
  });

  // FOOTGUNS-1 of the gate: the command a person pastes reaches the shell with the engine's path intact, whatever it holds.
  it('names the engine\'s path in a form bash hands on as written, when it holds a space, $, a backtick or a "', (t) => {
    if (spawnSync('bash', ['-c', 'printf %s ok'], { windowsHide: true }).status !== 0) return t.skip('no bash here');
    for (const engineEntry of ['/opt/deep review/engine/main.mjs', '/home/me/$work/main.mjs', '/opt/a`b`/main.mjs', '/opt/a"b/main.mjs', "/opt/it's/main.mjs"]) {
      const report = renderReport(decidedOf(reported(), [departing, decisions[1]]).fold(), { ...reportInput, engineEntry });
      const path = /`+ ?node (.+?) answer --finding <id> --option <n> ?`+/.exec(report)?.[1];
      assert.ok(path !== undefined, report);
      const result = spawnSync('bash', ['-c', `printf %s ${path}`], { encoding: 'utf8', windowsHide: true });
      assert.equal(result.stdout, engineEntry, `${engineEntry}: ${result.stderr}`);
    }
  });

  it('ends an unreviewed departure with the command that reviews it, and a reviewed one with the answer and what applied it', () => {
    const readOnly = decidedOf(reported(), [departing, decisions[1]]);
    assert.match(render(readOnly.fold()), /^ {2}- Departs from: [^\n]*\n {2}- Review with: `deep-review answer --finding RIPPLE-1 --accept` or `--reject`$/m);
    const rejected = readOnly.clone().add('answer.recorded', { id: 'RIPPLE-1', answer: { kind: 'reject' }, note: 'the caller is still there' });
    const at = rejected.events.at(-1)!.recordedAt;
    assert.match(render(rejected.fold()), new RegExp(`^ {2}- Reviewed: rejected on ${at}; not yet applied\\. Note: the caller is still there$`, 'm'));
  });

  it('checks an answered question with the option chosen, when, and what applied it, the tree, a pass or nothing yet', () => {
    const asked = decidedOf(reported(), [decisions[0], askDecision('SWEEP-1', false)]);
    const recorded = (option: number): { report: string; at: string } => {
      const history = asked.clone().add('answer.recorded', { id: 'SWEEP-1', answer: { kind: 'option', option }, note: null });
      return { report: render(history.fold()), at: history.events.at(-1)!.recordedAt };
    };
    const held = recorded(0);
    assert.match(held.report, new RegExp(`^- 2\\\\\\. SWEEP-1: answered option 1 on ${held.at}; the option the tree held$`, 'm'));
    assert.match(held.report, new RegExp(`^Answered: option 1 on ${held.at}; the tree holds it\\. deep-review's choice was option 2\\.$`, 'm'), 'the brief says so in the question\'s block');
    assert.doesNotMatch(held.report, /In place now/, 'the answer stands in the default\'s place');
    assert.doesNotMatch(held.report, /To take deep-review's choice/, 'an answered question offers no command');
    const owed = recorded(1);
    assert.match(owed.report, new RegExp(`^- 2\\\\\\. SWEEP-1: answered option 2 on ${owed.at}; not yet applied$`, 'm'));
    assert.match(owed.report, new RegExp(`^Answered: option 2 on ${owed.at}; not yet applied\\. deep-review's choice was option 2\\.$`, 'm'));
    assert.match(owed.report, /^Answers: 1 recorded, 0 applied$/m, 'the header counts the answers');
    assert.doesNotMatch(owed.report, /^Answered: the last pass/m, 'no pass yet');
  });

  it('says no question\'s default was applied, neither in a read-only run, which ran no fixer, nor in a fix run, whose Fixes says whether a fixer edited it', () => {
    const readOnly = render(decidedOf(reported(), [decisions[0], askDecision('SWEEP-1', true)]).fold());
    assert.match(readOnly, /^None of these held the run up: [^\n]*This run does not fix: no fixer ran, and the tree is unchanged\./m);
    assert.match(readOnly, /^- 2\\\. SWEEP-1: not answered; the default is reject it with an error, which this run did not apply$/m, 'a default that edits is not in place in a run that only reviewed');
    assert.doesNotMatch(readOnly, /the default in place is/);
    const fixing = render(decidedOf(fixRun(), [decisions[0], askDecision('SWEEP-1', false)]).fold());
    assert.match(fixing, /^None of these held the run up: [^\n]*A fixer edits a default that edits the code into the tree, and Fixes says whether it did; a default that keeps the code changes nothing\./m);
    assert.doesNotMatch(fixing, /no fixer ran/);
    for (const report of [readOnly, fixing]) assert.doesNotMatch(report, /applied as written|^ {2}- Applied: |ask the author, applying /m);
  });

  it('says an unanswered default that edits is in place in a fix run only once its fixer applied it', () => {
    const asked = (status: string): string => render(decidedFixRun([askDecision('RIPPLE-1', true), askDecision('SWEEP-1', false)], status).fold());
    assert.match(asked('applied'), /^- 1\\\. RIPPLE-1: not answered; the default in place is reject it with an error$/m);
    for (const status of ['deferred', 'blocked']) assert.match(asked(status), /^- 1\\\. RIPPLE-1: not answered; the default is reject it with an error, which this run did not apply$/m, status);
    assert.match(asked('deferred'), /^- 2\\\. SWEEP-1: not answered; the default in place is keep accepting it \(no edit\)$/m, 'a default that keeps the code is in place');
  });

  it('lists each finding to fix with its approach, the options rejected and the rule it departs from, and each finding left with its reason', () => {
    const fixed = render(decidedOf(reported(), [departing, { ...decisions[1], leave: { reason: 'superseded', supersededBy: 'RIPPLE-1' } }]).fold());
    assert.match(fixed, /^### To fix\n\n- 1\\\. RIPPLE-1: guard the null once, before parse reads it\. Grounds: parse reads the null on an empty input, at lines 4 and 7\n  - Rejected: catch the throw in each caller: leaves the null in parse\n  - Departs from: parse trusts its callers \(src\/a\.ts:1\): the comment came with a caller that is gone$/m);
    assert.match(fixed, /^### Left\n\n- 2\\\. SWEEP-1, superseded by RIPPLE-1: the helper would edit only lines the change does not touch$/m);
    assert.doesNotMatch(fixed, /### Asked|## Questions for you/, 'no question, no heading');
    const stopped = { ...departing, fix: { ...decisions[0]!.fix, approach: 'guard the null once.' } };
    assert.match(render(decidedOf(reported(), [stopped, decisions[1]]).fold()), /^- 1\\\. RIPPLE-1: guard the null once\. Grounds: /m, 'an approach with its own stop gets no second one');
    assert.match(render(decidedOf(reported()).fold()), /^- 2\\\. SWEEP-1, outside the change, and not a regression: /m);
  });

  it('closes each finding\'s block with its decision', () => {
    const report = render(decidedOf(reported(), [departing, askDecision('SWEEP-1', true)]).fold());
    assert.match(report, /^### 1\. \[major\] CONFIRMED  RIPPLE-1[^\n]*\n[\s\S]*?Also at: SWEEP-2 src\/a\.ts:7\nDecision: fix, departing from a rule: parse reads the null on an empty input, at lines 4 and 7$/m);
    assert.match(report, /^Decision: ask the author, defaulting to reject it with an error; see Questions for you: nothing in the repository states which behavior is meant$/m);
    assert.match(render(decidedOf(reported()).fold()), /^Decision: left, outside the change, and not a regression: the helper would edit only lines the change does not touch$/m);
  });

  it('ends the reason of a departure with one stop, whether or not the decider wrote one, before its fate', () => {
    const stopped = { ...departing, departure: { ...departing.departure, reason: 'the comment came with a caller that is gone?' }, fix: { ...decisions[0]!.fix, approach: 'guard the null once.' } };
    const report = render(decidedOf(reported(), [stopped, decisions[1]]).fold());
    assert.match(report, /^Why deep-review went against it: the comment came with a caller that is gone\? This run only reviewed, so no fixer applied it; `review --fix` applies it\.$/m);
    assert.match(render(decidedOf(reported(), [departing, decisions[1]]).fold()), /^Why deep-review went against it: the comment came with a caller that is gone\. This run only reviewed/m, 'a text with no stop gets one');
    assert.doesNotMatch(report, /\.\. |\?\. /);
  });

  it('leaves the fixer\'s approach out of a departure\'s block and in Decisions, where the evidence keeps it (R9 of the brief of a run)', () => {
    const report = render(decidedOf(reported(), [{ ...departing, fix: { ...decisions[0]!.fix, approach: 'In parseInput (src/a.ts:4), guard the null once.' } }, decisions[1]]).fold());
    const [brief, evidence] = report.split('The evidence for each statement above follows.');
    assert.ok(brief !== undefined && evidence !== undefined);
    assert.doesNotMatch(brief, /parseInput/, 'the block says no internal name the reason does not');
    assert.doesNotMatch(brief, /^What the fix does:/m);
    assert.match(evidence, /^- 1\\\. RIPPLE-1: In parseInput \(src\/a\.ts:4\), guard the null once\./m);
  });

  it('takes a stop before a closing bracket or quote as the end, and turns a trailing colon, comma or semicolon into the stop', () => {
    const marked = (reason: string): string => render(decidedOf(reported(), [{ ...departing, departure: { ...departing.departure, reason } }, decisions[1]]).fold());
    assert.match(marked('see the caller (it is gone.)'), /^Why deep-review went against it: see the caller \(it is gone\.\) This run/m);
    assert.match(marked('guard it "here."'), /^Why deep-review went against it: guard it "here\." This run/m);
    assert.match(marked('as follows:'), /^Why deep-review went against it: as follows\. This run/m);
    assert.match(marked('one more,'), /^Why deep-review went against it: one more\. This run/m);
  });

  it('keeps a decider\'s text on its own line whatever it holds, so it cannot open a heading or a list item', () => {
    const hostile = { ...askDecision('SWEEP-1', false), grounds: 'first line\n## Not a heading\n- not an item' };
    const report = render(decidedOf(reported(), [decisions[0], hostile]).fold());
    assert.doesNotMatch(report, /^## Not a heading$/m);
    assert.match(report, /^- Why it asks: first line ## Not a heading - not an item$/m);
    const cells = { ...askDecision('SWEEP-1', false), ask: { ...(askDecision('SWEEP-1', false) as { ask: Record<string, unknown> }).ask, options: [{ option: 'a | b\nc', cost: 'd', rule: 'e', edits: false }, { option: 'f', cost: 'g', rule: 'h', edits: true }] } };
    assert.match(render(decidedOf(reported(), [decisions[0], cells]).fold()), /^\| 1, in place now \| a \\\| b c \| d \|$/m, 'an option cannot end its cell or its row');
  });

  it('is absent from a run configured before the decision step, and from one that ranked nothing', () => {
    assert.doesNotMatch(render(reported().fold()), /Decisions|^Decision: /m);
    const nothing = decidedOf(reported()).fold();
    assert.doesNotMatch(render({ ...nothing, review: { ...nothing.review!, ranking: [], decisions: null } }), /## Decisions/);
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
    assert.match(report, new RegExp(`^ {2}- Reviewed: rejected on [^;]+; applied by the answer pass of ${at}$`, 'm'));
    assert.match(report, /^- 2\\\. SWEEP-1: answered option 2 on [^;]+; not yet applied$/m, 'the pass deferred it, so it is still owed');
    assert.match(report, new RegExp(`^### 1\\. RIPPLE-1 applied\\n\\nNote: RIPPLE-1 answered\\nCommit message: fix: Answer RIPPLE-1\\nAnswer pass: pass-1, opened on ${at}; patch 2$`, 'm'));
    assert.match(report, /^### 2\. SWEEP-1 deferred\n\nNote: SWEEP-1 answered\nAnswer pass: pass-1, opened on [^;]+; no patch$/m, 'a held finding the pass worked has the pass\'s outcome');
    assert.match(report, /^What the fix pass, and the answer passes after it, did with each finding/m);
  });

  it('says a rejection the tree held through the applied one holds the fix that follows the rule, and an acceptance owed after it', () => {
    const accepted = passed().add('answer.recorded', answer('RIPPLE-1', 'accept'));
    assert.match(render(accepted.fold()), /^ {2}- Reviewed: accepted on [^;]+; not yet applied$/m);
    const rejectedAgain = accepted.clone().add('answer.recorded', answer('RIPPLE-1', 'reject'));
    assert.match(render(rejectedAgain.fold()), new RegExp(`^ {2}- Reviewed: rejected on ${rejectedAgain.events.at(-1)!.recordedAt}; the rule-following fix the tree held$`, 'm'));
  });

  it('gives the Checks table the answer pass\'s column, and says the checks did not run after a pass that changed nothing', () => {
    const report = render(passed().fold());
    assert.match(report, /^\| Check \| Command \| Source \| Before the fixes \| After the fixes \| After answers \|$/m);
    const quiet = passToReport(decidedFixRun().add('answer.recorded', answer('SWEEP-1', 1)).add('answer.pass', { ids: ['SWEEP-1'] }), 1, [['SWEEP-1', 'deferred']], 1);
    const quietReport = renderReport(quiet.fold(), { ...reportInput, fix: { patches: [reference('1')], continueCommand: null } });
    assert.match(quietReport, /^- After answers: not run, since no answer pass changed a file\.$/m);
    assert.doesNotMatch(render(decidedFixRun().fold()), /After answers/, 'a run with no pass has no such column or line');
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
    assert.match(report, /in rank order\. Patch 1 is committed; patch 2, an answer pass's, is in the working tree, uncommitted; a patch number/);
  });
});

// R7 of fix pass continuation.
describe('the report of a run continued into the fix pass', () => {
  const fix = { patches: [reference('1')], continueCommand: null };

  it('says in its header when the run was continued and where its read-only report is, after the roles digest', () => {
    const state = continuedToReport().fold();
    const report = renderReport(state, { ...reportInput, fix });
    const at = state.review!.continuedFrom!.at;
    assert.match(report, new RegExp(`^Roles digest: d{64}\\nContinued: into the fix pass on ${at.replaceAll('.', '\\.')}, after the read-only report artifacts/e{64}\\nFindings: `, 'm'));
    assert.match(report, /^## Fixes$/m, 'a full fix run\'s report');
  });

  it('has no such line for a run never continued, read-only or fixing', () => {
    assert.doesNotMatch(renderReport(readOnlyReported().fold(), reportInput), /^Continued:/m);
    assert.doesNotMatch(renderReport(fixRun().fold(), { ...reportInput, fix }), /^Continued:/m);
  });

  it('names the read-only report by its name in the store, whatever the input gives of the fix pass (R15 of the brief of a run)', () => {
    assert.match(renderReport(continuedToReport().fold(), reportInput), /^Continued: into the fix pass on [^,]+, after the read-only report artifacts\/e{64}$/m);
  });
});
