import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { fixLimitations, stopLimitations } from '../../src/review/fix-report.ts';
import { cutWorkerLines, renderReport } from '../../src/review/report.ts';
import { describeRun } from '../../src/review/status.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { answer, askDecision, checkRun, decidedFixRun, decidedOf, decisions, fixPlan, fixRun, fixStatistics, mergeRanked, passToReport, reference, reported, statistics, withFixPass, worker, reportInput } from '../helpers/review-history.ts';

const snapshotPath = resolve(import.meta.dirname, '../fixtures/reports/fix.md');
const evidencePath = (blob: { sha256: string; bytes: number }): string => `/evidence/${blob.sha256.slice(0, 8)}`;

const patches = ['/evidence/patch-1', '/evidence/patch-2', '/evidence/patch-3'];

describe('the report of a fix run', () => {
  const render = (state: RunState = fixRun().fold()): string => renderReport(state, { ...reportInput, statistics: fixStatistics, fix: { evidencePath, patches, continueCommand: null } });

  it('renders exactly as the committed snapshot, which a person read once in review', () => {
    assert.equal(render(), readFileSync(snapshotPath, 'utf8'), `the report changed; if on purpose, write the new text to ${snapshotPath}`);
  });

  it('says in its header that the run fixed, how each finding ended, and that the edits are uncommitted', () => {
    assert.match(render(), /^Fix pass: 1 applied, 0 already applied, 0 deferred, 0 blocked, 0 not attempted, 1 held for the author; 3 patches; the edits are in the working tree, uncommitted$/m);
  });

  it('says once deep-review commit committed every patch, lowercase in its header and capitalized where the Fixes section starts a sentence (R8 of answers)', () => {
    const revisions = ['chore: apply the lint check\'s rewrite', 'fix: Guard the null in parse', 'style: Format the guard'].map((subject, revision) => ({ sha: String(revision + 3).repeat(40), revision, subject }));
    const commits = [{ sha: 'a'.repeat(40), revision: 'change' as const, subject: 'the change' }, ...revisions];
    const written = fixRun().add('report.written', { report: reference('9', 4096), statistics, patches: [reference('1'), reference('2'), reference('3')] }, 4).finish('report');
    const report = render(written.add('commits.created', { commits, from: '2'.repeat(40), to: '5'.repeat(40) }).fold());
    assert.match(report, /^Fix pass: [^\n]*; 3 patches; patches 1 to 3 are committed$/m);
    assert.match(report, /in rank order\. Patches 1 to 3 are committed; a patch number/);
  });

  it('places Fixes, Checks and Changed files after Findings and before Refuted at verification', () => {
    const report = render();
    const order = ['## Findings', '## Fixes', '## Checks', '## Changed files', '## Refuted at verification', '## Statistics', '## Limitations'].map((heading) => report.indexOf(`\n${heading}\n`));
    assert.ok(order.every((position) => position > 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });

  it('gives every ranked finding its fate, the fixer\'s note and correction, its cluster and patch, and a held finding\'s reason', () => {
    const report = render();
    assert.match(report, /^### 1\. RIPPLE-1 applied\n\nNote: guarded the null before its use\nCommit message: fix: Guard the null in parse\nCluster: c1, batch c1-1 \(src\/a\.ts\); patch 2\nCorrection: src\/a\.ts parse: parse is at line 4 -> it moved to line 6 \(git blame\)$/m);
    assert.match(report, /^### 2\. SWEEP-1 held for the author\n\nA PLAUSIBLE finding from a design angle: held for the author, and no fixer saw it\.$/m);
    assert.match(report, /^### Repair\n\n- lint check applied: formatted the guard; patch 3$/m);
    assert.match(report, /Documentation the fixers say their edits made stale, which nothing in this run updated:\n\n- README\.md: parse no longer throws on null \(c1-1\)/);
    assert.match(report, /Tests the fixers say they added or tightened:\n\n- test\/a\.test\.ts: parse\(null\) returns 0 \(c1-1\)/);
  });

  it('shows each check in each phase that ran it, a kind not available with its reason, the output of one that failed, and one failing before the fix pass', () => {
    const report = render();
    assert.match(report, /^\| Check \| Command \| Before the fixes \| After the fixes \| After the repair \|$/m);
    assert.match(report, /^\| typecheck \| not available \(none: nothing names it\) \| - \| - \| - \|$/m);
    assert.match(report, /^\| lint \| npm run lint \| passed, 4\.0 s \| failed, 4\.0 s; output \/evidence\/cccccccc, \/evidence\/dddddddd \| passed, 4\.0 s \|$/m);
    assert.match(report, /^\| test \| npm run test \| failed, 4\.0 s; output \S+, \S+ \| failed, 4\.0 s; output \S+, \S+ \(failing before the fix pass\) \| failed, 4\.0 s; output \S+, \S+ \(failing before the fix pass\) \|$/m);
  });

  it('lists every changed path once with its final status and who changed it, then the patch series in order', () => {
    const report = render();
    assert.match(report, /^\| Path \| Status \| Changed by \| Held by \|$/m);
    assert.match(report, /^\| src\/a\.ts \| modified \| lint check, c1-1, repair \| c1 \|$/m);
    assert.match(report, /^\| test\/a\.test\.ts \| created \| c1-1 \| nobody \|$/m, 'a file no cluster owned, edited before claims existed');
    assert.match(report, /applies in order to a tree at the scope with `git am --keep-cr`:\n\n1\. chore: apply the lint check's rewrite \(lint check\): \/evidence\/patch-1\n2\. fix: Guard the null in parse \(c1-1\): \/evidence\/patch-2\n3\. style: Format the guard \(repair\): \/evidence\/patch-3$/m);
  });

  it('adds the strays, the checks not available, and the fixers\' validation and suite lines to Limitations', () => {
    const report = render();
    assert.match(report, /^- Files no answer names, left in the tree and in no patch: notes\.txt\.$/m);
    assert.match(report, /^- Checks not available: typecheck \(nothing names it\)\.$/m);
    assert.match(report, /^- Validation of RIPPLE-1 \(c1-1\), old-code, test\/a\.test\.ts: failed on the old code for the null, passed on the fix$/m);
    assert.match(report, /^- Fixer c1-1 ran its own suite: pass \(npm test\)\.$/m);
    assert.match(report, /^- The repair ran its own suite: pass \(npm test\)\.$/m);
    assert.match(report, /^- Worktree checks: \d+, none found a difference from what the run expected\.$/m);
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
    assert.match(render({ ...fixRun().fold(), review: { ...review, fix: claimed } }), /^\| test\/a\.test\.ts \| created \| c1-1 \| c1 \(claimed\) \|$/m);
    const late = { ...fix, claims: [{ ...claimed.claims[0]!, claimedAt: null }] };
    assert.match(render({ ...fixRun().fold(), review: { ...review, fix: late } }), /^\| test\/a\.test\.ts \| created \| c1-1 \| c1 \(claimed late\) \|$/m);
  });

  it('names a path\'s owner by the plan as its holder over a later claim of it, as the fold judges who holds it', () => {
    const review = fixRun().review();
    const fix = review.fix!;
    const plan = { ...fix.plan!, clusters: [...fix.plan!.clusters, { id: 'c2', findingIds: [], files: [] }] };
    const claimed = { ...fix, plan, claims: [{ path: 'src/a.ts', cluster: 'c2', key: 'c2-1', round: 1 as const, claimedAt: '2026-10-09T01:00:00.000Z' }] };
    assert.match(render({ ...fixRun().fold(), review: { ...review, fix: claimed } }), /^\| src\/a\.ts \| modified \| lint check, c1-1, repair \| c1 \|$/m);
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
    const noCommand = { ...fix, checks: { ...fix.checks, planned: { ...fix.checks.planned!, checks: fix.checks.planned!.checks.map((check) => ({ ...check, command: null, origin: 'setting' as const, layer: 'flag' as const, reason: 'dropped by --no-check' })) }, runs: { 'baseline-checks': [], checks: [], 'repair-checks': [], 'answer-checks': [] } } };
    const report = render({ ...state, review: { ...state.review!, fix: noCommand } });
    assert.ok(fix.revisions.length > 0, 'the fixes changed files');
    assert.doesNotMatch(report, /no fix changed a file/);
    assert.doesNotMatch(report, /no check failed after the fixes/);
    assert.match(report, /^- No check ran in any phase, since no kind has a command\.$/m);
    // A run with commands whose fixes changed nothing still says so.
    const unchanged = { ...fix, revisions: [], checks: { ...fix.checks, runs: { ...fix.checks.runs, checks: [], 'repair-checks': [] } } };
    assert.match(render({ ...state, review: { ...state.review!, fix: unchanged } }), /^- After the fixes: not run, since no fix changed a file\.$/m);
  });

  it('marks a column whose runs checked a tree a later fix changed, never for an answer pass, and says what came after (TD3 of resumable runs)', () => {
    const state = fixRun().fold();
    const fix = state.review!.fix!;
    const later = (phase: string): RunState => ({ ...state, review: { ...state.review!, fix: { ...fix, revisions: [...fix.revisions, { ...fix.revisions[1]!, phase } as never] } } });
    const header = (report: string): string => report.split('\n').find((line) => line.startsWith('| Check |'))!;
    assert.doesNotMatch(header(render()), /an earlier tree/);
    const refixed = render(later('fixes'));
    assert.match(header(refixed), /\| After the fixes \(an earlier tree\) \| After the repair \(an earlier tree\) \|$/);
    assert.match(refixed, /^- After the fixes: its runs checked an earlier tree, which a later revision of the fixes changed\.$/m);
    assert.doesNotMatch(header(render(later('answer'))), /an earlier tree/, 'the column after answers shows the tree an answer pass left');
    assert.match(header(render(later('repair'))), /\| After the fixes \| After the repair \(an earlier tree\) \|$/);
  });

  it('says why the checks after the repair did not run: no failure to repair, a repair not attempted, or one that changed nothing (TD11 of resumable runs)', () => {
    const state = fixRun().fold();
    const fix = state.review!.fix!;
    const without = (change: Partial<typeof fix>): string => render({ ...state, review: { ...state.review!, fix: { ...fix, checks: { ...fix.checks, runs: { ...fix.checks.runs, 'repair-checks': [] } }, ...change } } });
    assert.match(without({}), /^- After the repair: not run, since the repair changed no file\.$/m);
    assert.match(without({ notAttempted: { ...fix.notAttempted, repair: { repair: { cause: 'budget', reason: 'spent' } } } }), /^- After the repair: not run, since the repair was not attempted\.$/m);
    assert.match(without({ checks: { ...fix.checks, runs: { ...fix.checks.runs, checks: fix.checks.runs.checks.map((run) => ({ ...run, outcome: 'passed' as const })), 'repair-checks': [] } } }), /^- After the repair: not run, since no check failed after the fixes\.$/m);
    // An answer pass's later revision makes the runs after the fixes old, but they are still the ones the repair read.
    const answerRevision = { ...fix.revisions.at(-1)!, phase: 'answer' as const };
    assert.match(without({ revisions: [...fix.revisions, answerRevision] }), /^- After the repair: not run, since the repair changed no file\.$/m);
    assert.match(without({ revisions: [...fix.revisions, answerRevision], notAttempted: { ...fix.notAttempted, repair: { repair: { cause: 'budget', reason: 'spent' } } } }), /^- After the repair: not run, since the repair was not attempted\.$/m);
  });

  it('renders a run without the fix pass with none of these sections', () => {
    const report = renderReport(reported().fold(), reportInput);
    for (const heading of ['## Fixes', '## Checks', '## Changed files']) assert.ok(!report.includes(heading), heading);
    assert.doesNotMatch(report, /^Fix pass:/m);
  });
});

describe('the report of a fix run with the decision step (R8 of the decision step)', () => {
  const render = (state: RunState): string => renderReport(state, { ...reportInput, statistics: fixStatistics, fix: { evidencePath, patches, continueCommand: null } });

  it('says of a finding no fixer saw that the decision left it, with the reason, and counts it so in the header', () => {
    const report = render(decidedOf(fixRun()).fold());
    assert.match(report, /^### 2\. SWEEP-1 left by decision\n\nNo fixer saw it: the decision step left it, outside the change, and not a regression\. See Decisions\.$/m);
    assert.match(report, /^Fix pass: 1 applied, 0 already applied, 0 deferred, 0 blocked, 0 not attempted, 1 left by decision, 0 asked, kept as is; 3 patches; the edits are in the working tree, uncommitted$/m);
    assert.doesNotMatch(report, /held for the author/);
  });

  it('says of an ask whose default keeps the code that no fixer saw it and the author is asked', () => {
    const report = render(decidedOf(fixRun(), [decisions[0], askDecision('SWEEP-1', false)]).fold());
    assert.match(report, /^### 2\. SWEEP-1 asked, kept as is\n\nNo fixer saw it: the decision step asks the author, and its default keeps the code as it is\. See Decisions\.$/m);
    assert.match(report, /0 left by decision, 1 asked, kept as is;/);
  });

  const superseded = { ...decisions[1], leave: { reason: 'superseded', supersededBy: 'RIPPLE-1' } };

  it('names the superseding finding of a finding left as superseded, and what its fixer reported', () => {
    assert.match(render(decidedOf(fixRun(), [decisions[0], superseded]).fold()), /^No fixer saw it: the decision step left it, superseded by RIPPLE-1, whose fixer reported it applied\. See Decisions\.$/m);
  });

  it('says a superseded finding may still stand when its superseder\'s fixer deferred, or no fixer answered for it', () => {
    const state = decidedOf(fixRun(), [decisions[0], superseded]).fold();
    const fix = state.review!.fix!;
    const answer = fix.answers.fixes['c1-1']!;
    const withAnswers = (fixes: typeof fix.answers.fixes): RunState => ({ ...state, review: { ...state.review!, fix: { ...fix, answers: { ...fix.answers, fixes } } } });
    const deferred = render(withAnswers({ 'c1-1': { ...answer, findings: answer.findings.map((finding) => ({ ...finding, status: 'deferred' as const })) } }));
    assert.match(deferred, /^### 2\. SWEEP-1 left by decision\n\nNo fixer saw it: the decision step left it, superseded by RIPPLE-1, whose fixer reported it deferred\. Its removal depended on RIPPLE-1's fix, so this finding may still stand\. See Decisions\.$/m);
    // The header still counts it as left by decision; the line above is what keeps the report from saying it was handled.
    assert.match(deferred, /^Fix pass: 0 applied, 0 already applied, 1 deferred, 0 blocked, 0 not attempted, 1 left by decision, 0 asked, kept as is;/m);
    assert.match(render(withAnswers({})), /^No fixer saw it: the decision step left it, superseded by RIPPLE-1, whose fix was not attempted\. Its removal depended on RIPPLE-1's fix, so this finding may still stand\. See Decisions\.$/m);
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
      run({ kind: 'lint', attempt: 2, outcome: 'passed', exitCode: 0, replaces: { attempt: 1, outcome: 'failed' } }, 3.1),
      run({ kind: 'typecheck', attempt: 2, outcome: 'cut', exitCode: 143 }, 1),
      run({ kind: 'typecheck', attempt: 2, outcome: 'passed', exitCode: 0, replaces: { attempt: 2, outcome: 'cut' } }, 3.1),
      run({ kind: 'test', attempt: 2, outcome: 'cut', exitCode: null, signal: null }, 1),
      run({ kind: 'test', attempt: 2, outcome: 'passed', exitCode: 0, replaces: { attempt: 2, outcome: 'cut' } }, 5.2),
      run({ kind: 'build', attempt: 2, outcome: 'timeout', termination: 'killed', exitCode: null, signal: 'SIGKILL' }, 1200),
      run({ kind: 'build', attempt: 2, outcome: 'passed', exitCode: 0, replaces: { attempt: 2, outcome: 'timeout' } }, 312),
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

  it('names a series of commits a stop left open, and each one the next command dropped', () => {
    const series = { commits: [{ sha: 'b'.repeat(40), revision: 0, subject: 's' }], from: 'a'.repeat(40), to: 'b'.repeat(40) };
    assert.deepEqual(lines({ openSeries: series }), [`A stop cut \`deep-review commit\` short: its series from ${'a'.repeat(40)} to ${'b'.repeat(40)} is not recorded yet, and the next command completes it or drops it by where HEAD is.`]);
    assert.deepEqual(lines({ droppedSeries: [series] }), [`Dropped: the series of commits from ${'a'.repeat(40)} to ${'b'.repeat(40)} that a stop cut short before the branch moved; a later \`deep-review commit\` builds it again.`]);
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
    const report = renderReport({ ...state, workers }, { ...reportInput, statistics: fixStatistics, fix: { evidencePath, patches, continueCommand: null } });
    assert.ok(report.includes(`\n- Cut: the worker of ${label} ended with exit code 143, a kill mark, and ran again.\n`), report);
    assert.ok(describeRun({ ...state, workers }, claudeAdapter, evidencePath).lines.includes(`Stop: Cut: the worker of ${label} ended with exit code 143, a kill mark, and ran again.`));
  });
});
