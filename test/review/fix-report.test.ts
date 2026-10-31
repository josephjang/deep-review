import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { FixRecorded } from '../../src/checkpoint/events.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { fixBlockLines, fixLimitations, stopLimitations } from '../../src/review/fix-report.ts';
import { cutWorkerLines, limitBlockLines, lostWorkerLines, renderReport } from '../../src/review/report.ts';
import { renderStats } from '../../src/review/stats-report.ts';
import { describeRun } from '../../src/review/status.ts';
import { documentationUnitKey, repairUnitKey } from '../../src/review/vocabulary.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { checkedRun, onBranch, rewordedOnBase, type ChecksOfRun } from '../helpers/base-checks-history.ts';
import { answer, askDecision, checkRun, decidedFixRun, decidedOf, decisions, documentationAnswer, documentationItems, documentedFixRun, endCheck, fixPlan, fixRun, fixStatistics, mergeRanked, passToReport, reference, reported, statistics, withFixPass, worker, reportInput, type History } from '../helpers/review-history.ts';

const snapshotPath = resolve(import.meta.dirname, '../fixtures/reports/fix.md');
const evidencePath = (blob: { sha256: string; bytes: number }): string => `/evidence/${blob.sha256.slice(0, 8)}`;

const patches = [reference('1'), reference('2'), reference('3')];

describe('the report of a fix run', () => {
  const render = (state: RunState = fixRun().fold()): string => renderReport(state, { ...reportInput, statistics: fixStatistics, fix: { patches, continueCommand: null } });

  it('renders exactly as the committed snapshot, which a person read once in review', () => {
    assert.equal(render(), readFileSync(snapshotPath, 'utf8'), `the report changed; if on purpose, write the new text to ${snapshotPath}`);
  });

  it('says in its header that the run fixed, how each finding ended, and that the edits are uncommitted', () => {
    assert.match(render(), /^Fix pass: 1 applied, 0 already applied, 0 deferred, 0 blocked, 0 not attempted, 1 held for the author; 3 patches; the edits are in the working tree, uncommitted$/m);
  });

  it('says once deep-review commit committed every patch, in its header and by the commit of each patch (R8 of answers)', () => {
    const revisions = ['chore: apply the lint check\'s rewrite', 'fix: Guard the null in parse', 'style: Format the guard'].map((subject, revision) => ({ sha: String(revision + 3).repeat(40), revision, subject }));
    const commits = [{ sha: 'a'.repeat(40), revision: 'change' as const, subject: 'the change' }, ...revisions];
    const written = fixRun().add('report.written', { report: reference('9', 4096), statistics, patches: [reference('1'), reference('2'), reference('3')] }, 4).finish('report');
    const report = render(written.add('commits.created', { commits, from: '2'.repeat(40), to: '5'.repeat(40) }).fold());
    assert.match(report, /^Fix pass: [^\n]*; 3 patches; patches 1 to 3 are committed$/m);
    assert.match(report, /^2\. fix: Guard the null in parse \(finding 1, c1-1\), src\/a\.ts modified, test\/a\.test\.ts created, committed as 44444444: artifacts\/2{64}$/m);
  });

  it('places Documentation updates, Checks and Patches after Findings and before What the review covered (R8 of the report for the person)', () => {
    const report = render();
    const order = ['## Findings', '## Documentation updates', '## Checks', '## Patches', '## What the review covered', '## Refuted at verification', '## About this run'].map((heading) => report.indexOf(`\n${heading}\n`));
    assert.ok(order.every((position) => position > 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });

  it('gives every ranked finding in its block its fate, the fixer\'s note and correction, its patch and validations, and a held finding\'s reason, and leaves its cluster to the statistics', () => {
    const report = render();
    assert.match(renderStats(fixRun().fold(), fixStatistics).join('\n'), /^- 1\. RIPPLE-1: cluster c1, batch c1-1 \(src\/a\.ts\)$/m);
    assert.match(report, /^- Fix: applied; guarded the null before its use\n- Commit message: fix: Guard the null in parse\n- Patch: 2\n- Correction: src\/a\.ts parse: parse is at line 4 -> it moved to line 6 \(git blame\)\n- Validation, as its fixer reports it: old-code, test\/a\.test\.ts: failed on the old code for the null, passed on the fix$/m);
    assert.match(report, /^- Fix: held for the author; a run configured before the decision step held a PLAUSIBLE finding of a design angle, and no fixer saw it\.$/m);
    assert.match(report, /^- Its fix: applied, formatted the guard; patch 3$/m);
    assert.match(report, /Tests the fixers say they added or tightened:\n\n- test\/a\.test\.ts: parse\(null\) returns 0 \(c1-1\)/);
  });

  it('gives a finding two fixers worked the validation of each, oldest first and by its fixer, as the block lists both patches (R6 of the report for the person)', () => {
    const review = passToReport(decidedFixRun().add('answer.recorded', answer('RIPPLE-1', 'reject')).add('answer.pass', { ids: ['RIPPLE-1'] }), 1, [['RIPPLE-1', 'applied']], 2).review();
    const fix = review.fix!;
    const validated = <Recorded extends FixRecorded>(recorded: Recorded, evidence: string): Recorded => ({ ...recorded, findings: recorded.findings.map((finding) => ({ ...finding, validation: [{ method: 'old-code' as const, source: 'test/a.test.ts', evidence, runs: [] }] })) });
    const twice = { ...fix, answers: { ...fix.answers, fixes: { 'c1-1': validated(fix.answers.fixes['c1-1']!, 'failed on <stdin> before the guard') }, answer: { 'pass-1': validated(fix.answers.answer['pass-1']!, 'failed before the answer') } } };
    const lines = fixBlockLines(review, twice, 'RIPPLE-1', { numbers: new Map([['RIPPLE-1', 1]]), own: 1 });
    assert.ok(lines.includes('Patch: 1, 2'), lines.join('\n'));
    assert.deepEqual(lines.filter((line) => line.startsWith('Validation')), [
      'Validation, as fixer c1-1 reports it: old-code, test/a.test.ts: failed on \\<stdin> before the guard',
      'Validation, as the fixer of the answer pass pass-1 reports it: old-code, test/a.test.ts: failed before the answer',
    ]);
  });

  it('gives each check a block with its anchor, each phase that ran it, a kind not available with its reason, the output of one that failed, and one failing before the fix pass', () => {
    const report = render();
    assert.match(report, /^<a id="check-typecheck"><\/a>\n\n### typecheck\n\n- Command: not available \(none: nothing names it\)$/m);
    // The frozen output is named by its name in the store, which names no local path (R15 of the brief of a run).
    assert.match(report, /^### lint\n\n- Command: `npm run lint`\n- As submitted: passed, 4\.0 s\n- After the fixes: failed, 4\.0 s; output artifacts\/c{64}, artifacts\/d{64}\n- After the fixes for the checks: passed, 4\.0 s$/m);
    assert.match(report, /^- After the fixes: failed, 4\.0 s; output \S+, \S+ \(failing before the fix pass\)$/m);
    assert.match(report, /^\| \[lint\]\(#check-lint\) \| /m, 'the table of the brief links to the block');
  });

  it('gives under a check\'s fix each validation the repair reports, quoted as a worker\'s text, since its findings have no block of their own', () => {
    const state = fixRun().fold();
    const fix = state.review!.fix!;
    const repaired = fix.answers.repair[repairUnitKey]!;
    const validation = [{ method: 'existing' as const, source: 'npm run lint', evidence: 'passed after RIPPLE-1 read <stdin>', runs: [] }];
    const findings = repaired.findings.map((finding) => (finding.id === 'lint' ? { ...finding, validation } : finding));
    const report = render({ ...state, review: { ...state.review!, fix: { ...fix, answers: { ...fix.answers, repair: { [repairUnitKey]: { ...repaired, findings } } } } } });
    assert.match(report, /^- Its fix: applied, formatted the guard; patch 3\n- Validation, as its fixer reports it: existing, npm run lint: passed after RIPPLE-1 \(finding 1\) read \\<stdin>$/m);
    assert.match(report, /^- Its fix: deferred, every failure was there before the fixes; no patch\n\n/m, 'a fix with no validation has no line of it');
  });

  it('escapes a worker\'s text in Checks and Patches, so a preview shows what a terminal shows, and numbers the findings it names (R11 of the report for the person)', () => {
    const state = fixRun().fold();
    const fix = state.review!.fix!;
    const revisions = fix.revisions.map((revision, index) => (index === 1 ? { ...revision, change: { ...revision.change, message: { subject: 'fix: Read RIPPLE-1\'s config from <stdin>', body: 'Why.' } } } : revision));
    const repaired = fix.answers.repair[repairUnitKey]!;
    const findings = repaired.findings.map((finding) => (finding.id === 'lint' ? { ...finding, note: 'kept a * b and __init__' } : finding));
    const fixes = { ...fix.answers.fixes['c1-1']!, tests: [{ file: 'test/a.test.ts', covers: 'parse(<stdin>)' }] };
    const report = render({ ...state, review: { ...state.review!, fix: { ...fix, revisions, answers: { ...fix.answers, fixes: { 'c1-1': fixes }, repair: { [repairUnitKey]: { ...repaired, findings } } } } } });
    assert.match(report, /^2\. fix: Read RIPPLE-1 \(finding 1\)'s config from \\<stdin> \(finding 1, c1-1\), /m);
    assert.match(report, /^- Its fix: applied, kept a \\\* b and \\_\\_init\\_\\_; patch 3$/m);
    assert.match(report, /^- test\/a\.test\.ts: parse\(\\<stdin>\) \(c1-1\)$/m);
  });

  it('lists the patch series in order, each with who made it and the files it changes, and leaves who held each path to the statistics', () => {
    const report = render();
    const stats = renderStats(fixRun().fold(), fixStatistics).join('\n');
    assert.match(stats, /^\| src\/a\.ts \| c1 \|$/m);
    assert.match(stats, /^\| test\/a\.test\.ts \| nobody \|$/m, 'a file no cluster owned, edited before claims existed');
    assert.match(report, /applies in order to a tree at the scope with `git am --keep-cr`:\n\n1\. chore: apply the lint check's rewrite \(the lint check\), src\/a\.ts modified: artifacts\/1{64}\n2\. fix: Guard the null in parse \(finding 1, c1-1\), src\/a\.ts modified, test\/a\.test\.ts created: artifacts\/2{64}\n3\. style: Format the guard \(repair\), src\/a\.ts modified: artifacts\/3{64}$/m);
  });

  it('adds the strays and the fixers\' validation and suite lines to the notes of the run, and names a check not available as a gap of the brief', () => {
    const report = render();
    assert.match(report, /^- Files no answer names, left in the tree and in no patch: notes\.txt\.$/m);
    assert.ok(report.includes(' No typecheck check ran: nothing names it. '), 'a gap under the table of the checks (R4 of the report for the person)');
    assert.doesNotMatch(report, /Checks not available/);
    assert.match(report, /^- Fixer c1-1 ran its own suite: pass \(npm test\)\.$/m);
    assert.match(report, /^- The repair ran its own suite: pass \(npm test\)\.$/m);
    assert.match(report, /^- Worktree checks: \d+, none found a difference from what the run expected\.$/m);
  });

  it('says which drifts a later write back of their attempt resolved and which blocked the run (R7 of resumable runs)', () => {
    const state = fixRun().fold();
    const review = state.review!;
    const [first, second, ...rest] = review.checks;
    const drifted = (check: typeof first) => ({ ...check!, phase: 'baseline-checks' as const, attempt: 1, drifted: true, files: [{ path: 'src/a.ts', outcome: 'modified' as const }] });
    const checks = [drifted(first), drifted(second), ...rest];
    // A write back after the first check of its attempt resolves that check alone; the second came after it.
    const fate = (checksBefore: number[]): string => {
      const restorations = checksBefore.map((before) => ({ phase: 'baseline-checks' as const, attempt: 1, check: { kind: 'test' as const, attempt: 1 }, files: [], checksBefore: before }));
      return render({ ...state, review: { ...review, checks, fix: { ...review.fix!, restorations } } }).split('\n').find((line) => line.startsWith('- Worktree checks: '))!;
    };
    assert.match(fate([]), /; each blocked the run until the tree was restored\.$/);
    assert.match(fate([1]), /; 1 was written back after a check a kill cut short, and each other blocked the run until the tree was restored\.$/);
    assert.match(fate([1, 2]), /; each was written back after a check a kill cut short\.$/, 'the attempt\'s last write back resolves every check before it');
  });

  it('adds every editing phase\'s suite line to Limitations in phase order, naming an answer pass\'s fixer as such (R10 of answers)', () => {
    const history = passToReport(decidedFixRun().add('answer.recorded', answer('SWEEP-1', 1)).add('answer.pass', { ids: ['SWEEP-1'] }), 1, [['SWEEP-1', 'deferred']], 1);
    const suites = fixLimitations(history.review()).filter((line) => line.includes(' ran its own suite: '));
    assert.deepEqual(suites, ['- Fixer c1-1 ran its own suite: pass (npm test).', '- The fixer of the answer pass pass-1 ran its own suite: pass (npm test).']);
  });

  it('names as strays only what the run left:not a file there before it, nor a leftover a later revision took (PD9 of commit series integrity)', () => {
    const review = fixRun().review();
    const [first, ...rest] = review.checks;
    const checks = [{ ...first!, strays: ['before.txt'] }, ...rest.map((check) => ({ ...check, strays: [...check.strays, 'before.txt', 'src/a.ts', 'dist/a.js'] }))];
    const strays = fixLimitations({ ...review, checks }).filter((line) => line.startsWith('- Files no answer names'));
    // src/a.ts is in a revision, as dist/ is once the tail check revision rewrites it; dist/a.js here is in none.
    assert.deepEqual(strays, ['- Files no answer names, left in the tree and in no patch: dist/a.js, notes.txt.']);
  });

  it('names as strays what the last check still found, not a leftover a check found mid-run that a fixer then restored', () => {
    const review = fixRun().review();
    // From the fixes phase's end check the checks find the rebuilt dist/x.js; the report's start check, the last, no longer does.
    const from = review.checks.findIndex((check) => check.phase === 'fixes' && check.moment === 'end');
    const checks = review.checks.map((check, index) => (index >= from && index < review.checks.length - 1 ? { ...check, strays: [...check.strays, 'dist/x.js'] } : check));
    assert.ok(from > 0 && checks.at(-1)!.strays.includes('notes.txt'), 'notes.txt stays in the tree to the end');
    const strays = fixLimitations({ ...review, checks }).filter((line) => line.startsWith('- Files no answer names'));
    assert.deepEqual(strays, ['- Files no answer names, left in the tree and in no patch: notes.txt.']);
  });

  it('names who held each changed path by claim, late claim or plan, round by round (R3 of commit series integrity)', () => {
    const review = fixRun().review();
    const fix = review.fix!;
    const claimed = { ...fix, claims: [{ path: 'test/a.test.ts', cluster: 'c1', key: 'c1-1', round: 1 as const, claimedAt: '2026-10-09T01:00:00.000Z' }] };
    const stats = (state: RunState): string => renderStats(state, fixStatistics).join('\n');
    assert.match(stats({ ...fixRun().fold(), review: { ...review, fix: claimed } }), /^\| test\/a\.test\.ts \| c1 \(claimed\) \|$/m);
    const late = { ...fix, claims: [{ ...claimed.claims[0]!, claimedAt: null }] };
    assert.match(stats({ ...fixRun().fold(), review: { ...review, fix: late } }), /^\| test\/a\.test\.ts \| c1 \(claimed late\) \|$/m);
  });

  it('names a path\'s owner by the plan as its holder over a later claim of it, as the fold judges who holds it', () => {
    const review = fixRun().review();
    const fix = review.fix!;
    const plan = { ...fix.plan!, clusters: [...fix.plan!.clusters, { id: 'c2', findingIds: [], files: [] }] };
    const claimed = { ...fix, plan, claims: [{ path: 'src/a.ts', cluster: 'c2', key: 'c2-1', round: 1 as const, claimedAt: '2026-10-09T01:00:00.000Z' }] };
    assert.match(renderStats({ ...fixRun().fold(), review: { ...review, fix: claimed } }, fixStatistics).join('\n'), /^\| src\/a\.ts \| c1 \|$/m);
  });

  it('names a later check\'s rewrite of a file an unfinished attempt\'s revision holds, as for a fixer\'s answer, since a stop can leave a fixer\'s edits there (R10 of resumable runs)', () => {
    const review = fixRun().review();
    const fix = review.fix!;
    const answered = fix.revisions.find((revision) => revision.source.kind === 'fix')!;
    const check = fix.revisions.find((revision) => revision.source.kind === 'check')!;
    const file = answered.files[0]!;
    const attempt = { ...answered, source: { kind: 'attempt' as const, key: 'c1-1', workerId: worker(60) }, change: { ...answered.change, findings: ['SCAN-1'] } };
    const partial = { ...attempt, change: { ...attempt.change, findings: [] } };
    const lines = fixLimitations({ ...review, fix: { ...fix, revisions: [attempt, partial, { ...check, files: [file] }] } }).filter((line) => line.startsWith('- Rewritten by a later check'));
    const by = `by the ${check.source.kind === 'check' ? check.source.check : ''} check in ${check.phase}; a generated file the fixer kept, or a fix the check reformatted.`;
    assert.deepEqual(lines, [`- Rewritten by a later check: ${file.path}, in c1-1's revision of SCAN-1, ${by}`, `- Rewritten by a later check: ${file.path}, in c1-1's revision of partial edits, ${by}`]);
  });

  it('names a late claim and a lost claim in Limitations, with who holds a lost claim\'s path (R6, F9 of commit series integrity)', () => {
    const review = fixRun().review();
    const fix = { ...review.fix!, claims: [{ path: 'docs/late.md', cluster: 'c1', key: 'c1-1', round: 1 as const, claimedAt: null }], lostClaims: [{ path: 'src/a.ts', claimedAt: null, reason: 'owned' as const, holder: 'c1', unit: 'c2-1', cluster: 'c2' }, { path: 'docs/x.md', claimedAt: '2026-10-09T01:00:00.000Z', reason: 'unplanned' as const, holder: null, unit: 'c9-1', cluster: 'c9' }] };
    const lines = fixLimitations({ ...review, fix });
    assert.ok(lines.includes('- Claimed late: docs/late.md by c1-1, edited before it was claimed (R6 of commit series integrity).'), lines.join('\n'));
    assert.ok(lines.includes('- Claim lost: src/a.ts by c2-1 to c1; the claim is not on the ledger, and the file\'s edits fall under the ownership rule.'), lines.join('\n'));
    assert.ok(lines.includes('- Claim lost: docs/x.md by c9-1 which no batch of the round has; the claim is not on the ledger, and the file\'s edits fall under the ownership rule.'), lines.join('\n'));
  });

  it('names an ownership violation of a claimed file with the cluster that claimed it', () => {
    const review = fixRun().review();
    const fix = review.fix!;
    const plan = { ...fix.plan!, clusters: [...fix.plan!.clusters, { id: 'c2', findingIds: ['SWEEP-1'], files: ['src/b.ts'] }], batches: [...fix.plan!.batches, { key: 'c2-1', cluster: 'c2', findingIds: ['SWEEP-1'] }] };
    const withViolation = { ...review, fix: { ...fix, plan, claims: [{ path: 'docs/shared.md', cluster: 'c2', key: 'c2-1', round: 1 as const, claimedAt: '2026-10-09T01:00:00.000Z' }], answers: { ...fix.answers, fixes: { 'c1-1': { ...fix.answers.fixes['c1-1']!, violations: ['docs/shared.md'] } } }, violationHolders: { 'c1-1': { 'docs/shared.md': { cluster: 'c2', by: 'claim' as const } } } } };
    assert.ok(fixLimitations(withViolation).includes('- Ownership violation: docs/shared.md, claimed by c2, was edited by c1-1, which reported it; the edit is kept and revised (PD4).'));
  });

  it('names the cluster a violation was judged against, not one that claimed the file after its holder settled (R6 of commit series integrity)', () => {
    const review = fixRun().review();
    const fix = review.fix!;
    const plan = { ...fix.plan!, clusters: [...fix.plan!.clusters, { id: 'c2', findingIds: [], files: [] }, { id: 'c3', findingIds: [], files: [] }] };
    // c2 held docs/shared.md when c1-1 answered; c3 claimed it once c2 had settled.
    const claims = [{ path: 'docs/shared.md', cluster: 'c2', key: 'c2-1', round: 1 as const, claimedAt: '2026-10-09T01:00:00.000Z' }, { path: 'docs/shared.md', cluster: 'c3', key: 'c3-1', round: 1 as const, claimedAt: '2026-10-09T02:00:00.000Z' }];
    const withViolation = { ...review, fix: { ...fix, plan, claims, answers: { ...fix.answers, fixes: { 'c1-1': { ...fix.answers.fixes['c1-1']!, violations: ['docs/shared.md'] } } }, violationHolders: { 'c1-1': { 'docs/shared.md': { cluster: 'c2', by: 'claim' as const } } } } };
    const lines = fixLimitations(withViolation);
    assert.ok(lines.includes('- Ownership violation: docs/shared.md, claimed by c2, was edited by c1-1, which reported it; the edit is kept and revised (PD4).'), lines.join('\n'));
  });

  it('names an ownership violation with the cluster that reported it and the one that owns the file', () => {
    const review = fixRun().review();
    const fix = review.fix!;
    const withViolation = { ...review, fix: { ...fix, plan: { ...fix.plan!, clusters: [...fix.plan!.clusters, { id: 'c2', findingIds: ['SWEEP-1'], files: ['src/b.ts'] }] }, answers: { ...fix.answers, fixes: { 'c1-1': { ...fix.answers.fixes['c1-1']!, violations: ['src/b.ts'] } } }, violationHolders: { 'c1-1': { 'src/b.ts': { cluster: 'c2', by: 'plan' as const } } } } };
    assert.ok(fixLimitations(withViolation).includes('- Ownership violation: src/b.ts, owned by c2, was edited by c1-1, which reported it; the edit is kept and revised (PD4).'));
  });

  it('says a checks phase did not run because no check has a command, not because no fix changed a file, when every kind is dropped (the survey\'s gate, 2026-10-04)', () => {
    // A fix run whose revisions changed files but whose every kind had no command, as an operator without the project's tools runs one.
    const state = fixRun().fold();
    const fix = state.review!.fix!;
    const noCommand = { ...fix, checks: { ...fix.checks, planned: { ...fix.checks.planned!, checks: fix.checks.planned!.checks.map((check) => ({ ...check, command: null, origin: 'setting' as const, layer: 'flag' as const, reason: 'dropped by --no-check' })) }, runs: { 'baseline-checks': [], checks: [], 'base-checks': [], 'repair-checks': [], 'answer-checks': [] } } };
    const report = render({ ...state, review: { ...state.review!, fix: noCommand } });
    assert.ok(fix.revisions.length > 0, 'the fixes changed files');
    assert.doesNotMatch(report, /no fix changed a file/);
    assert.doesNotMatch(report, /no check failed after the fixes/);
    assert.match(report, /^- No check ran in any phase, since no kind has a command\.$/m);
    // A run with commands whose fixes changed nothing still says so.
    const unchanged = { ...fix, revisions: [], checks: { ...fix.checks, runs: { ...fix.checks.runs, checks: [], 'repair-checks': [] } } };
    assert.match(render({ ...state, review: { ...state.review!, fix: unchanged } }), /^- After the fixes: not run, since no fix changed a file\.$/m);
  });

  it('marks the runs of a phase that checked a tree a later fix changed, never for an answer pass, and says what came after (TD3 of resumable runs)', () => {
    const state = fixRun().fold();
    const fix = state.review!.fix!;
    const later = (phase: string): RunState => ({ ...state, review: { ...state.review!, fix: { ...fix, revisions: [...fix.revisions, { ...fix.revisions[1]!, phase } as never] } } });
    const checks = (report: string): string => report.slice(report.indexOf('\n## Checks\n'), report.indexOf('\n## Patches\n'));
    assert.doesNotMatch(checks(render()), /an earlier tree/);
    const refixed = render(later('fixes'));
    assert.match(checks(refixed), /^- After the fixes, on an earlier tree: /m);
    assert.match(checks(refixed), /^- After the fixes for the checks, on an earlier tree: /m);
    assert.match(refixed, /^- After the fixes: its runs checked an earlier tree, which a later revision of the fixes changed\.$/m);
    assert.doesNotMatch(checks(render(later('answer'))), /an earlier tree/, 'the runs after answers show the tree an answer pass left');
    const repaired = checks(render(later('repair')));
    assert.match(repaired, /^- After the fixes: /m);
    assert.doesNotMatch(repaired, /^- After the fixes, on an earlier tree/m);
    assert.match(repaired, /^- After the fixes for the checks, on an earlier tree: /m);
    // A revision of the documentation step after the checks, as a reopening that gives its unit back makes, is named as its own (R10 of the documentation step).
    const documented = render(later('documentation'));
    assert.match(checks(documented), /^- After the fixes, on an earlier tree: /m);
    assert.match(documented, /^- After the fixes: its runs checked an earlier tree, which a later revision of the documentation step changed\.$/m);
    assert.match(render(later('repair')), /^- After the fixes for the checks: its runs checked an earlier tree, which a later revision of the fixes for the checks changed\.$/m);
  });

  it('says why the checks after the repair did not run: no failure to repair, a repair not attempted, or one that changed nothing (TD11 of resumable runs)', () => {
    const state = fixRun().fold();
    const fix = state.review!.fix!;
    const without = (change: Partial<typeof fix>): string => render({ ...state, review: { ...state.review!, fix: { ...fix, checks: { ...fix.checks, runs: { ...fix.checks.runs, 'repair-checks': [] } }, ...change } } });
    assert.match(without({}), /^- After the fixes for the checks: not run, since the fixes for the checks changed no file\.$/m);
    assert.match(without({ notAttempted: { ...fix.notAttempted, repair: { repair: { cause: 'budget', reason: 'spent' } } } }), /^- After the fixes for the checks: not run, since the fixes for the checks were not attempted: [^\n]*spent\.$/m);
    assert.match(without({ checks: { ...fix.checks, runs: { ...fix.checks.runs, checks: fix.checks.runs.checks.map((run) => ({ ...run, outcome: 'passed' as const })), 'repair-checks': [] } } }), /^- After the fixes for the checks: not run, since no check failed after the fixes\.$/m);
    // An answer pass's later revision makes the runs after the fixes old, but they are still the ones the repair read.
    const answerRevision = { ...fix.revisions.at(-1)!, phase: 'answer' as const };
    assert.match(without({ revisions: [...fix.revisions, answerRevision] }), /^- After the fixes for the checks: not run, since the fixes for the checks changed no file\.$/m);
    assert.match(without({ revisions: [...fix.revisions, answerRevision], notAttempted: { ...fix.notAttempted, repair: { repair: { cause: 'budget', reason: 'spent' } } } }), /^- After the fixes for the checks: not run, since the fixes for the checks were not attempted: [^\n]*spent\.$/m);
  });

  it('says the repair was not attempted, and why, when an unfinished attempt\'s revision ran the checks after it', () => {
    const state = fixRun().fold();
    const fix = state.review!.fix!;
    // The repair failed twice, the first attempt having left edits: its revision runs the checks after the repair, and no answer of the repair is on record.
    const attempt = { ...fix.revisions.at(-1)!, source: { kind: 'attempt' as const, key: repairUnitKey, workerId: '00000000-0000-4000-8000-000000000001' } };
    const failed = { ...fix, revisions: [...fix.revisions.slice(0, -1), attempt], answers: { ...fix.answers, repair: {} }, notAttempted: { ...fix.notAttempted, repair: { [repairUnitKey]: { cause: 'failures' as const, reason: 'its worker failed twice' } } } };
    const report = render({ ...state, review: { ...state.review!, fix: failed } });
    assert.ok(failed.checks.runs['repair-checks'].length > 0, 'the checks after the repair ran');
    assert.match(report, /^- The fixes for the checks were not attempted: its worker failed twice\.$/m);
    assert.doesNotMatch(report, /^- After the fixes for the checks: not run/m);
    assert.doesNotMatch(render(), /were not attempted/, 'a repair that answered says nothing of the kind');
  });

  it('renders a run without the fix pass with none of these sections', () => {
    const report = renderReport(reported().fold(), reportInput);
    for (const heading of ['## Documentation updates', '## Checks', '## Patches']) assert.ok(!report.includes(heading), heading);
    assert.doesNotMatch(report, /^Fix pass:/m);
  });
});

describe('the report of a fix run with the decision step (R8 of the decision step)', () => {
  const render = (state: RunState): string => renderReport(state, { ...reportInput, statistics: fixStatistics, fix: { patches, continueCommand: null } });

  it('says of a finding no fixer saw that the decision left it, with the reason, and counts it so in the header', () => {
    const report = render(decidedOf(fixRun()).fold());
    assert.match(report, /^### 2\. extract the helper\n\nLeft as is\. Minor, PLAUSIBLE, which no verifier examined\.\n/m);
    assert.match(report, /^- Decision: left, outside the change, and not a regression: [^\n]+\n\n## Documentation updates$/m, 'a finding no fixer saw has no fix line');
    assert.match(report, /^Fix pass: 1 applied, 0 already applied, 0 deferred, 0 blocked, 0 not attempted, 1 left by decision, 0 asked, kept as is; 3 patches; the edits are in the working tree, uncommitted$/m);
    assert.doesNotMatch(report, /held for the author/);
  });

  it('says of an ask whose default keeps the code that no fixer saw it and the author is asked', () => {
    const report = render(decidedOf(fixRun(), [decisions[0], askDecision('SWEEP-1', false)]).fold());
    assert.match(report, /^### 2\. extract the helper\n\nA question for you\. /m);
    assert.match(report, /0 left by decision, 1 asked, kept as is;/);
  });

  const superseded = { ...decisions[1], leave: { reason: 'superseded', supersededBy: 'RIPPLE-1' } };

  it('names the superseding finding of a finding left as superseded, and what its fixer reported', () => {
    assert.match(render(decidedOf(fixRun(), [decisions[0], superseded]).fold()), /^- Fix: none of its own; its removal was finding 1's fix, whose fixer reported it applied\.$/m);
  });

  it('says a superseded finding may still stand when its superseder\'s fixer deferred, or no fixer answered for it', () => {
    const state = decidedOf(fixRun(), [decisions[0], superseded]).fold();
    const fix = state.review!.fix!;
    const answer = fix.answers.fixes['c1-1']!;
    const withAnswers = (fixes: typeof fix.answers.fixes): RunState => ({ ...state, review: { ...state.review!, fix: { ...fix, answers: { ...fix.answers, fixes } } } });
    const deferred = render(withAnswers({ 'c1-1': { ...answer, findings: answer.findings.map((finding) => ({ ...finding, status: 'deferred' as const })) } }));
    assert.match(deferred, /^- Fix: none of its own; its removal was finding 1's fix, whose fixer reported it deferred\. This finding may still stand\.$/m);
    // The header still counts it as left by decision; the line above is what keeps the report from saying it was handled.
    assert.match(deferred, /^Fix pass: 0 applied, 0 already applied, 1 deferred, 0 blocked, 0 not attempted, 1 left by decision, 0 asked, kept as is;/m);
    assert.match(render(withAnswers({})), /^- Fix: none of its own; its removal was finding 1's fix, whose fixer did not attempt it\. This finding may still stand\.$/m);
  });
});

describe('status of a fix run with the decision step', () => {
  it('counts the decisions, and words the findings no fixer sees as decided, not as held', () => {
    const history = decidedOf(fixRun()).add('report.written', { report: reference('e', 2048), statistics: fixStatistics, patches: [reference('1'), reference('2'), reference('3')] }, 2).finish('report');
    const described = describeRun(history.fold(), claudeAdapter, evidencePath);
    assert.ok(described.lines.includes('Decisions: 1 to fix, 1 to leave, 0 to ask the author'), described.lines.join('\n'));
    assert.ok(described.lines.includes('Fix pass: c1-1 answered; 1 no fixer sees, as decided'), described.lines.join('\n'));
    assert.deepEqual((described.json as { decisions: unknown }).decisions, { fix: 1, leave: 1, ask: 0 });
  });
});

describe('status of a fix run', () => {
  it('names each batch\'s state, the clusters, the findings held, each check\'s outcome per phase, and the patches', () => {
    const history = fixRun().add('report.written', { report: reference('e', 2048), statistics: fixStatistics, patches: [reference('1'), reference('2'), reference('3')] }, 2).finish('report');
    const described = describeRun(history.fold(), claudeAdapter, evidencePath);
    assert.ok(described.lines.includes('Fix pass: c1-1 answered; 1 held for the author'), described.lines.join('\n'));
    assert.ok(described.lines.includes('Check lint: baseline-checks passed, checks failed, repair-checks passed'), described.lines.join('\n'));
    assert.ok(described.lines.includes('Check typecheck: not available'));
    assert.ok(described.lines.includes('Patch 1: /evidence/11111111'));
    const json = JSON.parse(JSON.stringify(described.json)) as { fix: { clusters: { id: string; findings: string[]; files: string[] }[]; batches: { key: string; cluster: string; state: string; findings: string[] }[]; held: string[] }; patches: string[]; commits: unknown };
    assert.deepEqual(json.fix.clusters, [{ id: 'c1', findings: ['RIPPLE-1'], files: ['src/a.ts'] }]);
    assert.deepEqual(json.fix.batches, [{ key: 'c1-1', cluster: 'c1', state: 'answered', findings: ['RIPPLE-1'] }]);
    assert.deepEqual(json.fix.held, ['SWEEP-1']);
    assert.deepEqual(json.patches, ['/evidence/11111111', '/evidence/22222222', '/evidence/33333333']);
    assert.deepEqual(json.commits, []);
    assert.ok(!described.lines.some((line) => line.includes('answer-checks')), 'a run with no answer pass names no answer-pass check');
  });

  it('counts the claims made, by how many clusters, the late ones and the lost ones, and carries them in the JSON (R3 of commit series integrity)', () => {
    const history = withFixPass(mergeRanked()).start('baseline-checks').add('check.ran', checkRun('baseline-checks', 'build')).finish('baseline-checks').start('fixes').add('fixes.planned', fixPlan);
    assert.ok(describeRun(history.fold(), claudeAdapter, evidencePath).lines.includes('Claims: 0 by 0 clusters, 0 late, 0 lost'));
    history
      .add('files.claimed', { phase: 'fixes', key: 'c1-1', cluster: 'c1', files: [{ path: 'docs/a.md', claimedAt: '2026-10-09T01:00:00.000Z' }, { path: 'docs/b.md', claimedAt: null }] })
      .add('claims.lost', { phase: 'fixes', unit: 'c9-1', cluster: 'c9', files: [{ path: 'docs/x.md', claimedAt: null, reason: 'unplanned', holder: null }] });
    const described = describeRun(history.fold(), claudeAdapter, evidencePath);
    assert.ok(described.lines.includes('Claims: 2 by 1 cluster, 1 late, 1 lost'), described.lines.join('\n'));
    const json = JSON.parse(JSON.stringify(described.json)) as { fix: { claims: { path: string }[]; lostClaims: { path: string }[] } };
    assert.deepEqual(json.fix.claims.map((claim) => claim.path), ['docs/a.md', 'docs/b.md']);
    assert.deepEqual(json.fix.lostClaims.map((claim) => claim.path), ['docs/x.md']);
    assert.ok(!describeRun(withFixPass(mergeRanked()).fold(), claudeAdapter, evidencePath).lines.some((line) => line.startsWith('Claims:')), 'nothing to count before the plan');
  });

  it('names a batch with a worker running as running, and one with none yet as pending', () => {
    const history = withFixPass(mergeRanked()).start('baseline-checks').add('check.ran', checkRun('baseline-checks', 'build')).finish('baseline-checks').start('fixes').add('fixes.planned', fixPlan);
    assert.ok(describeRun(history.fold(), claudeAdapter, evidencePath).lines.includes('Fix pass: c1-1 pending; 1 held for the author'));
    history.add('worker.launched', { ...(history.events.find((event) => event.kind === 'worker.launched')?.payload as object), workerId: worker(70), label: 'fixer fixes:c1-1' });
    assert.ok(describeRun(history.fold(), claudeAdapter, evidencePath).lines.includes('Fix pass: c1-1 running; 1 held for the author'));
  });
});

describe('the record of a stop (R15 of resumable runs)', () => {
  const state = fixRun().fold();
  const review = state.review!;
  const fix = review.fix!;
  const first = fix.checks.runs.checks[0]!;
  /** A run of a check in `checks`, as `first` with the fields given and the time it took. */
  const run = (fields: Partial<typeof first>, seconds: number): typeof first => ({ ...first, ...fields, startedAt: '2026-10-19T00:00:00.000Z', endedAt: new Date(Date.parse('2026-10-19T00:00:00.000Z') + seconds * 1000).toISOString() });
  const lines = (change: Partial<typeof fix>): string[] => stopLimitations({ ...review, fix: { ...fix, ...change } }, evidencePath);

  it('says nothing for a run no stop touched', () => {
    assert.deepEqual(stopLimitations(review, evidencePath), []);
  });

  it('names each check that ran again with both runs, by why it ran again, and each start with no end on record', () => {
    const runs = [
      run({ kind: 'lint', attempt: 1, outcome: 'failed', exitCode: 1 }, 4.4),
      run({ kind: 'lint', attempt: 2, outcome: 'passed', exitCode: 0, replaces: { attempt: 1, outcome: 'failed' }, replacedAt: 0 }, 3.1),
      run({ kind: 'typecheck', attempt: 2, outcome: 'cut', exitCode: 143 }, 1),
      run({ kind: 'typecheck', attempt: 2, outcome: 'passed', exitCode: 0, replaces: { attempt: 2, outcome: 'cut' }, replacedAt: 2 }, 3.1),
      run({ kind: 'test', attempt: 2, outcome: 'cut', exitCode: null, signal: null }, 1),
      run({ kind: 'test', attempt: 2, outcome: 'passed', exitCode: 0, replaces: { attempt: 2, outcome: 'cut' }, replacedAt: 4 }, 5.2),
      run({ kind: 'build', attempt: 2, outcome: 'timeout', termination: 'killed', exitCode: null, signal: 'SIGKILL' }, 1200),
      run({ kind: 'build', attempt: 2, outcome: 'passed', exitCode: 0, replaces: { attempt: 2, outcome: 'timeout' }, replacedAt: 6 }, 312),
    ];
    const starts = [{ phase: 'checks' as const, attempt: 1, kind: 'test' as const, command: 'npm test', runsBefore: 1 }];
    assert.deepEqual(lines({ checks: { ...fix.checks, runs: { ...fix.checks.runs, checks: runs }, starts: { ...fix.checks.starts, checks: starts } } }), [
      'Ran again after a stop: lint in checks, failed in 4.4 s at attempt 1, passed in 3.1 s at attempt 2.',
      'Cut: typecheck in checks ended with exit code 143, a kill mark, and ran again: passed in 3.1 s.',
      'Cut: test in checks ended with no result from its guard, and ran again: passed in 5.2 s.',
      'Ran again after a timeout: build in checks timed out after 1200.0 s at its first run, and passed in 312.0 s at its second.',
      'Cut by a stop: test in checks at attempt 1, with no end on record.',
    ]);
  });

  it('names a build on the base that ran again in the new worktree of its attempt with no stop, and one skipped in a cut attempt as after a stop (TD16 of the facts before a merge)', () => {
    const onBase = (fields: Partial<typeof first>, seconds: number): typeof first => run({ phase: 'base-checks', kind: 'build', ...fields }, seconds);
    const base = (runs: (typeof first)[], finished: number): string[] => stopLimitations({ ...review, phases: { ...review.phases, 'base-checks': { status: 'running', attempt: 2 } }, fix: { ...fix, checks: { ...fix.checks, runs: { ...fix.checks.runs, 'base-checks': runs }, finished: { ...fix.checks.finished, 'base-checks': finished } } } }, evidencePath);
    // A plain reopening started attempt 2 after attempt 1 finished, so no stop came between them.
    const passed = [onBase({ attempt: 1, outcome: 'passed', exitCode: 0 }, 4), onBase({ attempt: 2, outcome: 'passed', exitCode: 0, replaces: { attempt: 1, outcome: 'passed' }, replacedAt: 0 }, 3.5)];
    assert.deepEqual(base(passed, 1), ['Built again on the base: build in base-checks passed in 4.0 s at attempt 1, and passed in 3.5 s at attempt 2, since each attempt makes its own worktree of the base.']);
    const skipped = [onBase({ attempt: 1, outcome: 'skipped', exitCode: null, error: 'no worktree of the base could be made: fatal: x', skipReason: 'no-worktree' }, 0), onBase({ attempt: 2, outcome: 'passed', exitCode: 0, replaces: { attempt: 1, outcome: 'skipped' }, replacedAt: 0 }, 3.5)];
    assert.deepEqual(base(skipped, 1), ['Built again on the base: build in base-checks was skipped at attempt 1, which had no worktree of the base, and passed in 3.5 s at attempt 2, since each attempt makes its own worktree of the base.']);
    // A stop cut attempt 1 before its `phase.finished`, so the skipped build runs again for the stop.
    assert.deepEqual(base(skipped, 0), ['Ran again after a stop: build in base-checks, skipped in 0.0 s at attempt 1, passed in 3.5 s at attempt 2.']);
  });

  it('names each file written back, and where the bytes it overwrote are, or that there were none', () => {
    const blob = reference('7');
    const restorations = [{ phase: 'checks' as const, attempt: 2, check: { kind: 'test' as const, attempt: 1 }, checksBefore: 0, files: [{ path: 'src/a.ts', before: { blob }, beforeSymlink: false, expected: null, expectedSymlink: false }, { path: 'src/new.ts', before: null, beforeSymlink: false, expected: null, expectedSymlink: false }] }];
    assert.deepEqual(lines({ restorations }), [`Written back after a cut test check in checks: src/a.ts; the bytes before are at ${evidencePath(blob)}.`, 'Written back after a cut test check in checks: src/new.ts; it did not exist before.']);
  });

  it('names a file the write back left because its bytes in the tree or its expected bytes were too large to keep', () => {
    const oversized = { oversized: { sha256: 'f'.repeat(64), size: 9 * 1024 * 1024 } };
    const restorations = [{ phase: 'checks' as const, attempt: 1, check: { kind: 'test' as const, attempt: 1 }, checksBefore: 0, files: [{ path: 'src/a.ts', before: oversized, beforeSymlink: false, expected: { blob: reference('a') }, expectedSymlink: false }, { path: 'src/b.ts', before: { blob: reference('7') }, beforeSymlink: false, expected: oversized, expectedSymlink: false }] }];
    assert.deepEqual(lines({ restorations }), ['Not written back after a cut test check in checks: src/a.ts; its bytes in the tree were too large to keep.', 'Not written back after a cut test check in checks: src/b.ts; its expected bytes were too large to keep.']);
  });

  it('names a write back made again at a later attempt by the check it followed: a timeout, or a start a stop cut after it', () => {
    const blob = reference('7');
    const restoration = (at: number) => ({ phase: 'checks' as const, attempt: at, check: { kind: 'test' as const, attempt: 1 }, checksBefore: 0, files: [{ path: 'src/a.ts', before: { blob }, beforeSymlink: false, expected: null, expectedSymlink: false }] });
    const start = (runsBefore: number) => ({ phase: 'checks' as const, attempt: 1, kind: 'test' as const, command: 'npm test', runsBefore });
    const timedOut = run({ kind: 'test', attempt: 1, outcome: 'timeout', termination: 'killed', exitCode: null, signal: 'SIGKILL' }, 1200);
    const written = (after: string): string => `Written back ${after} in checks: src/a.ts; the bytes before are at ${evidencePath(blob)}.`;
    // A stop cut the timeout's own write back before the tree was checked again, so the next attempt wrote it back again.
    const checks = { ...fix.checks, runs: { ...fix.checks.runs, checks: [timedOut] }, starts: { ...fix.checks.starts, checks: [start(0)] } };
    assert.deepEqual(lines({ checks, restorations: [restoration(1), restoration(2)] }), [written('after test timed out'), written('after test timed out')]);
    // The timeout's second run started, and a stop cut it before its write back at the next attempt.
    const cutAgain = { ...checks, starts: { ...checks.starts, checks: [start(0), start(1)] } };
    assert.deepEqual(lines({ checks: cutAgain, restorations: [restoration(1), restoration(2)] }), ['Cut by a stop: test in checks at attempt 1, with no end on record.', written('after test timed out'), written('after a cut test check')]);
  });

  it('names a series of commits a stop left open, and each one dropped, without blaming a stop for a refused move', () => {
    const series = { commits: [{ sha: 'b'.repeat(40), revision: 0, subject: 's' }], from: 'a'.repeat(40), to: 'b'.repeat(40) };
    assert.deepEqual(lines({ openSeries: series }), [`A stop cut \`deep-review commit\` short: its series from ${'a'.repeat(40)} to ${'b'.repeat(40)} is not recorded yet, and the next command completes it or drops it by where HEAD is.`]);
    // `deep-review commit` drops its own series when git refused to move the branch, with no stop involved, so the line names both causes.
    assert.deepEqual(lines({ droppedSeries: [series] }), [`Dropped: the series of commits from ${'a'.repeat(40)} to ${'b'.repeat(40)}, which the branch never moved to, after a stop or a refused move; a later \`deep-review commit\` builds it again.`]);
  });

  it('names each worker a kill from outside ended, and whether its unit ran again, in the report and in status', () => {
    const [launched] = Object.values(state.workers).filter((candidate) => candidate.status === 'finished');
    if (launched?.status !== 'finished') throw new Error('the fix run has a finished worker');
    const cut = { ...launched, finish: { ...launched.finish, exitCode: 143, signal: null, termination: 'exited' as const } };
    const rerun = { ...launched, launchedAt: '2999-01-01T00:00:00.000Z', launch: { ...launched.launch, workerId: worker(98) } };
    const label = launched.launch.label;
    assert.deepEqual(cutWorkerLines({ [launched.launch.workerId]: cut }), [`Cut: the worker of ${label} ended with exit code 143, a kill mark, and did not run again.`]);
    const workers = { [launched.launch.workerId]: cut, [worker(98)]: rerun };
    assert.deepEqual(cutWorkerLines(workers), [`Cut: the worker of ${label} ended with exit code 143, a kill mark, and ran again.`]);
    // Each renderer adds its own prefix to the bare sentence: a bullet in the report, `Stop: ` in status.
    const report = renderReport({ ...state, workers }, { ...reportInput, statistics: fixStatistics, fix: { patches, continueCommand: null } });
    assert.ok(report.includes(`\n- Cut: the worker of ${label} ended with exit code 143, a kill mark, and ran again.\n`), report);
    assert.ok(describeRun({ ...state, workers }, claudeAdapter, evidencePath).lines.includes(`Stop: Cut: the worker of ${label} ended with exit code 143, a kill mark, and ran again.`));
  });

  it('names each worker a stop of the engine lost, whether its unit ran again, and whether its edits are in a revision, in the report and in status (R15 of resumable runs)', () => {
    const [launched] = Object.values(state.workers).filter((candidate) => candidate.status === 'finished');
    if (launched?.status !== 'finished') throw new Error('the fix run has a finished worker');
    const label = launched.launch.label;
    const fix = state.review!.fix!;
    const withoutLost = (workers: RunState['workers']): RunState['workers'] => Object.fromEntries(Object.entries(workers).filter(([, candidate]) => candidate.status !== 'lost'));
    assert.deepEqual(lostWorkerLines(withoutLost(state.workers), fix.revisions), [], 'a run that lost no worker names none');
    const lost = { status: 'lost' as const, launch: launched.launch, launchedAt: launched.launchedAt, reason: 'the engine exited while the worker ran' };
    const rerun = { ...launched, launchedAt: '2999-01-01T00:00:00.000Z', launch: { ...launched.launch, workerId: worker(98) } };
    assert.deepEqual(lostWorkerLines({ [launched.launch.workerId]: lost }, fix.revisions), [`Lost with the engine: the worker of ${label}, and did not run again.`]);
    const workers = { [launched.launch.workerId]: lost, [worker(98)]: rerun };
    assert.deepEqual(lostWorkerLines(workers, fix.revisions), [`Lost with the engine: the worker of ${label}, and ran again.`], 'no revision of its attempt: it left no edit');
    // A worker with no label is named by its id, and no later worker with no label counts as its rerun.
    const unlabeled = { ...lost, launch: { ...lost.launch, label: null } };
    const laterUnlabeled = { ...rerun, launch: { ...rerun.launch, label: null } };
    assert.deepEqual(lostWorkerLines({ [launched.launch.workerId]: unlabeled, [worker(98)]: laterUnlabeled }, fix.revisions), [`Lost with the engine: the worker of ${launched.launch.workerId}, and did not run again.`]);
    // The revision of the lost attempt names the worker; a revision of another worker of the same unit does not count.
    const answered = fix.revisions.find((revision) => revision.source.kind === 'fix')!;
    const ofAttempt = (workerId: string) => ({ ...answered, source: { kind: 'attempt' as const, key: 'c1-1', workerId }, change: { ...answered.change, findings: [] } });
    assert.deepEqual(lostWorkerLines(workers, [...fix.revisions, ofAttempt(worker(97))]), [`Lost with the engine: the worker of ${label}, and ran again.`]);
    const revisions = [...fix.revisions, ofAttempt(launched.launch.workerId)];
    const sentence = `Lost with the engine: the worker of ${label}, and ran again; its edits are in a revision of its unfinished attempt.`;
    assert.deepEqual(lostWorkerLines(workers, revisions), [sentence]);
    const kept = { ...state, workers, review: { ...state.review!, fix: { ...fix, revisions } } };
    const report = renderReport(kept, { ...reportInput, statistics: fixStatistics, fix: { patches, continueCommand: null } });
    assert.ok(report.includes(`\n- ${sentence}\n`), report);
    assert.ok(describeRun(kept, claudeAdapter, evidencePath).lines.includes(`Stop: ${sentence}`));
  });

  it('names each block for the provider\'s usage limit the run resumed after, in the report and in status (R14, R15 of resumable runs)', () => {
    assert.deepEqual(limitBlockLines(state.review!), [], 'a run no limit blocked names none');
    const detail = 'the fixer worker for fixes:c1-1 stopped at the provider\'s usage limit: resets 12:10pm\n(Asia/Seoul)';
    const limitBlocks = [{ phase: 'fixes' as const, attempt: 1, detail }, { phase: 'fixes' as const, attempt: 2, detail: 'resets 6pm' }];
    const blocked = { ...state, review: { ...state.review!, limitBlocks } };
    const sentences = ['Usage limit: fixes blocked at attempt 1, and the run resumed after it: the fixer worker for fixes:c1-1 stopped at the provider\'s usage limit: resets 12:10pm (Asia/Seoul).', 'Usage limit: fixes blocked at attempt 2, and the run resumed after it: resets 6pm.'];
    assert.deepEqual(limitBlockLines(blocked.review), sentences, 'one per block, in order, its detail on one line');
    const report = renderReport(blocked, { ...reportInput, statistics: fixStatistics, fix: { patches, continueCommand: null } });
    assert.ok(report.includes(`\n- ${sentences[0]!}\n- ${sentences[1]!}\n`), report);
    const lines = describeRun(blocked, claudeAdapter, evidencePath).lines;
    assert.deepEqual(lines.filter((line) => line.startsWith('Stop: Usage limit: ')), sentences.map((sentence) => `Stop: ${sentence}`));
  });
});

// R10 and R11 of the documentation step.
describe('the Documentation section of the report', () => {
  const line = (file: string, what: string): { file: string; what: string } => ({ file, what });
  /** The section Documentation of a run's report, up to the section after it. */
  const section = (state: RunState): string => {
    const report = renderReport(state, { ...reportInput, statistics: fixStatistics, fix: { patches: state.review!.fix!.revisions.map((_, index) => reference(String(index + 1))), continueCommand: null } });
    const start = report.indexOf('\n## Documentation updates\n');
    assert.ok(start > 0, 'the report has the section');
    return report.slice(start + 1, report.indexOf('\n## Checks\n'));
  };
  /** The step's answer: doc-1 applied with its revision, doc-2 deferred, the search already applied, and the step's own drift. */
  const answeredStep = (history: History): History => {
    history.start('documentation');
    history.add('documentation.planned', { items: documentationItems(history) }).worker(55, 'documentation documentation:documentation');
    const findings = [
      { id: 'doc-1', status: 'applied', file: 'docs/a.md', line: null, note: 'said parse returns 0 for a null', message: { subject: 'docs(a): Say parse returns 0', body: 'Why.' }, files: ['docs/a.md'], corrections: [], validation: [{ method: 'static', source: 'docs/a.md', evidence: 'parse in src/a.ts returns 0 for a null' }], requiredFiles: [] },
      { id: 'doc-2', status: 'deferred', file: '../outside.md', line: null, note: 'the path is outside the repository', message: null, files: [], corrections: [], validation: [], requiredFiles: [] },
      { id: 'search', status: 'already-applied', file: '.', line: null, note: 'no other document states the behavior', message: null, files: [], corrections: [], validation: [], requiredFiles: [] },
    ];
    return history.add('fix.recorded', documentationAnswer(worker(55), [], { findings, drift: [line('CHANGES.md', 'the bytes are always translated')] }), 3)
      .add('tree.revised', { phase: 'documentation', source: { kind: 'fix', key: 'documentation', workerId: worker(55) }, change: { findings: ['doc-1'], message: { subject: 'docs(a): Say parse returns 0', body: 'Why.' } }, files: [{ path: 'docs/a.md', status: 'modified', before: { blob: reference('a') }, beforeSymlink: false, symlink: false, after: { blob: reference('b') } }] }, 3)
      .add('worktree.checked', endCheck('documentation'), 7).finish('documentation');
  };

  it('gives each item its outcome, its document, its note, its commit, files and patch, the lines it took and its validation, then what the step found at its end', () => {
    const text = section(documentedFixRun([line('./docs/a.md', 'parse throws on a null'), line('../outside.md', 'parse throws')], answeredStep).fold());
    assert.equal(text, [
      '## Documentation updates',
      '',
      'The documentation step answered for 2 documents the fixers named, and for its own search.',
      '',
      '### 1. doc-1 applied',
      '',
      'Document: `./docs/a.md`, the repository path `docs/a.md`',
      'Note: said parse returns 0 for a null',
      'Commit message: docs(a): Say parse returns 0',
      'Files: docs/a.md; patch 2',
      'Validation: static, docs/a.md: parse in src/a.ts returns 0 for a null',
      'Lines it took:',
      '- parse throws on a null (c1-1)',
      '',
      '### 2. doc-2 deferred',
      '',
      'Document: `../outside.md`, which the engine refused as a path of the repository',
      'Note: the path is outside the repository',
      'Lines it took:',
      '- parse throws (c1-1)',
      '',
      '### 3. search already applied',
      '',
      'Note: no other document states the behavior',
      '',
      'Documents the documentation step found out of date at its end, which it did not bring in line:',
      '',
      '- CHANGES.md: the bytes are always translated',
      '',
    ].join('\n'));
  });

  it('escapes the step\'s note, commit subject and validation, so a preview shows what a terminal shows (R11 of the report for the person)', () => {
    const state = documentedFixRun([line('./docs/a.md', 'parse throws on a null'), line('../outside.md', 'parse throws')], answeredStep).fold();
    const fix = state.review!.fix!;
    const step = fix.answers.documentation[documentationUnitKey]!;
    const findings = step.findings.map((finding) => (finding.id === 'doc-1' ? { ...finding, note: 'said <stdin> is read', message: { subject: 'docs(a): Say *all* is read', body: 'Why.' }, validation: [{ method: 'static' as const, source: 'docs/a.md', evidence: 'reads __all__', runs: [] }] } : finding));
    const text = section({ ...state, review: { ...state.review!, fix: { ...fix, answers: { ...fix.answers, documentation: { [documentationUnitKey]: { ...step, findings } } } } } });
    assert.match(text, /^Note: said \\<stdin> is read\nCommit message: docs\(a\): Say \\\*all\\\* is read$/m);
    assert.match(text, /^Validation: static, docs\/a\.md: reads \\_\\_all\\_\\_$/m);
  });

  it('gives the step\'s validation once, under Documentation, and credits none of its drift or tests to the fixers', () => {
    // The fixers name no document, so only the step's search answers, with its validation, its own drift and a test.
    const searched = (history: History): History => {
      history.start('documentation');
      history.add('documentation.planned', { items: documentationItems(history) }).worker(55, 'documentation documentation:documentation');
      const message = { subject: 'docs(a): Say parse returns 0', body: 'Why.' };
      const findings = [{ id: 'search', status: 'applied', file: 'docs/a.md', line: null, note: 'said parse returns 0 for a null', message, files: ['docs/a.md'], corrections: [], validation: [{ method: 'static', source: 'docs/a.md', evidence: 'parse in src/a.ts returns 0 for a null' }], requiredFiles: [] }];
      return history.add('fix.recorded', documentationAnswer(worker(55), [], { findings, drift: [line('CHANGES.md', 'the bytes are always translated')], tests: [{ file: 'test/doc.test.ts', covers: 'the example in docs/a.md' }] }), 3)
        .add('tree.revised', { phase: 'documentation', source: { kind: 'fix', key: 'documentation', workerId: worker(55) }, change: { findings: ['search'], message }, files: [{ path: 'docs/a.md', status: 'modified', before: { blob: reference('a') }, beforeSymlink: false, symlink: false, after: { blob: reference('b') } }] }, 3)
        .add('worktree.checked', endCheck('documentation'), 7).finish('documentation');
    };
    const state = documentedFixRun([], searched).fold();
    const report = renderReport(state, { ...reportInput, statistics: fixStatistics, fix: { patches: state.review!.fix!.revisions.map((_, index) => reference(String(index + 1))), continueCommand: null } });
    assert.equal(report.split('parse in src/a.ts returns 0 for a null').length - 1, 1, 'the validation line appears once');
    assert.match(section(state), /^Validation: static, docs\/a\.md: parse in src\/a\.ts returns 0 for a null$/m);
    assert.match(section(state), /^- CHANGES\.md: the bytes are always translated$/m);
    assert.doesNotMatch(report, /Validation of search/);
    assert.match(report, /^- The documentation step ran its own suite: not-run\.$/m);
    const patchesPart = report.slice(report.indexOf('\n## Patches\n'), report.indexOf('\n## What the review covered\n'));
    assert.doesNotMatch(patchesPart, /test\/doc\.test\.ts/, 'the step\'s tests are not a fixer\'s');
  });

  it('says why the step did not run, and gives an item not attempted its reason', () => {
    const failed = documentedFixRun([line('docs/a.md', 'parse throws on a null')], (history) => history.start('documentation').add('documentation.planned', { items: documentationItems(history) }).add('unit.unattempted', { phase: 'documentation', key: 'documentation', cause: 'failures', reason: '2 attempts did not complete' }, 2).add('worktree.checked', endCheck('documentation'), 7).finish('documentation', 'degraded')).fold();
    const text = section(failed);
    assert.match(text, /^The documentation step did not run: its worker failed twice\.$/m);
    assert.match(text, /^### 1\. doc-1 not attempted\n\nDocument: `docs\/a\.md`, the repository path `docs\/a\.md`\nNot attempted: 2 attempts did not complete\nLines it took:\n- parse throws on a null \(c1-1\)$/m);
    assert.match(section(documentedFixRun().fold()), /^The documentation step answered for 0 documents the fixers named, and for its own search\.$/m);
  });

  it('lists the lines no item took, with who reported each', () => {
    const report = renderReport(fixRun().fold(), { ...reportInput, statistics: fixStatistics, fix: { patches: [reference('1'), reference('2'), reference('3')], continueCommand: null } });
    assert.match(report, /\n## Documentation updates\n\nThe documentation step did not run: an engine before the documentation step configured this run\.\n\nDocumentation the workers of this run say their edits made stale, which no step of this run took:\n\n- README\.md: parse no longer throws on null \(c1-1\)\n\n## Checks\n/);
  });

  it('names the repair and an answer pass for a line after the step, and has no section for a run before the step with no line', () => {
    // The fold of these lines is tested with the brief's list; here only how the report names who reported each.
    const state = passToReport(documentedFixRun().add('answer.recorded', answer('SWEEP-1', 1)).add('answer.pass', { ids: ['SWEEP-1'] }), 1, [['SWEEP-1', 'deferred']], 1).fold();
    const fix = state.review!.fix!;
    const repair = { phase: 'repair' as const, key: 'repair', workerId: worker(60), findings: [], drift: [line('README.md', 'parse throws')], tests: [], suite: { result: 'not-run' as const, command: '', failures: '' }, violations: [], comparisons: [] };
    const passed = { ...fix.answers.answer['pass-1']!, drift: [line('docs/a.md', 'the example prints 4')] };
    const late = { ...state, review: { ...state.review!, fix: { ...fix, answers: { ...fix.answers, repair: { repair }, answer: { 'pass-1': passed } } } } } as RunState;
    assert.match(section(late), /\nDocumentation the repair or an answer pass says its edits made stale, after the documentation step:\n\n- README\.md: parse throws \(the repair\)\n- docs\/a\.md: the example prints 4 \(answer pass 1\)\n/);
    const report = renderReport(decidedFixRun().fold(), { ...reportInput, statistics: fixStatistics, fix: { patches: [reference('1')], continueCommand: null } });
    assert.doesNotMatch(report, /\n## Documentation updates\n/, 'an older run whose fixers named nothing');
  });

  it('names no fixer in the heading of the lines no step took when only the repair reported one', () => {
    const state = decidedFixRun().fold();
    const fix = state.review!.fix!;
    const repair = { phase: 'repair' as const, key: 'repair', workerId: worker(60), findings: [], drift: [line('docs/api.md', 'the check name changed')], tests: [], suite: { result: 'not-run' as const, command: '', failures: '' }, violations: [], comparisons: [] };
    const repaired = { ...state, review: { ...state.review!, fix: { ...fix, answers: { ...fix.answers, repair: { repair } } } } } as RunState;
    const text = section(repaired);
    assert.match(text, /\nDocumentation the workers of this run say their edits made stale, which no step of this run took:\n\n- docs\/api\.md: the check name changed \(the repair\)\n/);
    assert.doesNotMatch(text, /the fixers say/);
  });
});

describe('the runs on the base in the Checks section (R8 of the facts before a merge)', () => {
  const render = (state: RunState): string => renderReport(state, { ...reportInput, statistics: fixStatistics, fix: { patches, continueCommand: null } });
  /** The Checks section of the report of a run whose checks end as `checks` says, its scope a branch's. */
  const checksOf = (checks: ChecksOfRun): string => {
    const report = render(onBranch(checkedRun(checks)));
    return report.slice(report.indexOf('\n## Checks\n'), report.indexOf('\n## Patches\n'));
  };
  const output = 'output artifacts\\/c{64}, artifacts\\/d{64}';
  const same = { kind: 'lint', reading: 'same', words: 'the same two lint errors as on the base' };
  const failing = { before: { lint: 'failed' }, after: { lint: 'failed' } } as const;
  const gitError = 'fatal: could not create work tree dir \'/home/me/.cache/x\': Permission denied';

  it('gives each check its run on the base, with a model\'s comparison and its words and no mark of a failure before the fix pass', () => {
    const text = checksOf({ ...failing, base: [['build', 'passed'], ['lint', 'failed']], comparisons: [same] });
    assert.match(text, /^### build\n\n- Command: `npm run build`\n- Source: [^\n]+\n- As submitted: passed, 4\.0 s\n- After the fixes: passed, 4\.0 s\n- On the base: passed, 4\.0 s$/m);
    assert.match(text, new RegExp(`^- After the fixes: failed, 4\\.0 s; ${output} \\(failing before the fix pass\\)\\n- On the base: failed, 4\\.0 s; ${output}; a model's comparison: the change has no failure that the base does not have \\(the same two lint errors as on the base\\)$`, 'm'));
    assert.match(text, /^### test\n\n- Command: `npm run test`\n- Source: [^\n]+\n- As submitted: passed, 4\.0 s\n- After the fixes: passed, 4\.0 s\n\n/m, 'no run on the base for a kind not taken there');
    assert.match(text, /^- On the base: the base of the change is the merge base with origin\/main \(2247b35e\)\.$/m);
  });

  it('says what a model read of the comparison, or that it gave none', () => {
    assert.match(checksOf({ ...failing, base: [['build', 'passed'], ['lint', 'failed']], comparisons: [{ ...same, reading: 'adds', words: 'two errors the base does not have' }] }), /; a model's comparison: the change has a failure that the base does not have \(two errors the base does not have\)$/m);
    assert.match(checksOf({ ...failing, base: [['build', 'passed'], ['lint', 'timeout']], comparisons: [{ ...same, reading: 'unknown', words: 'the base lacks the tool' }] }), /^- On the base: timeout, 4\.0 s; [^\n]*; a model's comparison: the outputs cannot be compared \(the base lacks the tool\)$/m);
    assert.match(checksOf({ ...failing, base: [['build', 'passed'], ['lint', 'failed']], comparisons: [] }), /^- On the base: failed, 4\.0 s; [^\n]*; the worker that compared the failures gave no comparison$/m);
  });

  it('says why a kind did not run on the base, with the error in the facts of the run alone', () => {
    const report = render(onBranch(checkedRun({ ...failing, base: [['lint', 'skipped', 'no-worktree', gitError]] })));
    assert.match(report, /^- On the base: skipped: no worktree of the base could be made$/m);
    assert.match(report, /^- On the base: lint did not run there, since no worktree of the base could be made; the facts of the run give the error\.$/m);
    assert.match(report, /^Worktree of the base: could not be made: fatal: could not create work tree dir '\/home\/me\/\.cache\/x': Permission denied$/m);
    const refused = render(onBranch(checkedRun({ ...failing, base: [['lint', 'skipped', 'no-worktree', 'The worktree of the base (/w/tmp) is inside the reviewed tree (/w).']] })));
    assert.match(refused, /^Worktree of the base: could not be made: The worktree of the base \(\/w\/tmp\) is inside the reviewed tree \(\/w\)\.$/m);
    assert.doesNotMatch(refused, /git could not|error of git/, 'a refusal of the engine is not blamed on git');
    assert.ok(report.indexOf('/home/me/.cache/x') > report.indexOf('\n## About this run\n'), 'the path is in the facts of the run alone');
    assert.equal(report.split('/home/me/.cache/x').length, 2, 'once');
    assert.match(checksOf({ ...failing, base: [['build', 'failed'], ['lint', 'skipped', 'build-failed']] }), /^- On the base: lint did not run there, since the build did not pass on the base\.$/m);
    const timedOut = checksOf({ ...failing, base: [['build', 'timeout'], ['lint', 'skipped', 'build-failed']] });
    assert.match(timedOut, /^- On the base: timeout, 4\.0 s; [^\n]*$/m);
    assert.match(timedOut, /^- On the base: skipped: the build did not pass on the base$/m, 'words true of a build that timed out on the base');
    assert.match(checksOf({ ...failing, base: [] }), /^- On the base: lint did not run there\.$/m);
  });

  it('says why a kind did not run on the base by its skipReason, whatever words its error recorded (TD17 of the facts before a merge)', () => {
    const report = render(rewordedOnBase(onBranch(checkedRun({ ...failing, base: [['lint', 'skipped', 'no-worktree', 'fatal: x']] })), 'the base could not be checked out: fatal: x'));
    assert.match(report, /^- On the base: skipped: no worktree of the base could be made$/m);
    assert.match(report, /^- On the base: lint did not run there, since no worktree of the base could be made; the facts of the run give the error\.$/m);
    assert.match(report, /^Worktree of the base: could not be made: the base could not be checked out: fatal: x$/m, 'the error it recorded, whole');
    const unbuilt = render(rewordedOnBase(onBranch(checkedRun({ ...failing, base: [['build', 'failed'], ['lint', 'skipped', 'build-failed']] })), 'no worktree of the base could be made: fatal: x'));
    assert.doesNotMatch(unbuilt, /^Worktree of the base:/m, 'a run skipped after a failed build had a worktree, whatever its error says');
  });

  it('says why no check ran on the base, and nothing of the base in a run configured before the checks on the base (R10)', () => {
    assert.match(checksOf({ after: { lint: 'failed' } }), /^- On the base: not run, since no check failed before and after the fixes\.$/m);
    assert.doesNotMatch(checksOf({ ...failing, compared: false }), /On the base/);
    assert.doesNotMatch(checksOf({}).replace('- On the base: not run, since no check failed before and after the fixes.', ''), /On the base/);
  });
});
