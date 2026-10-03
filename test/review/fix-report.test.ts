import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { fixLimitations } from '../../src/review/fix-report.ts';
import { renderReport } from '../../src/review/report.ts';
import { describeRun } from '../../src/review/status.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { checkRun, fixPlan, fixRun, fixStatistics, mergeRanked, reference, reported, statistics, withFixPass, worker } from '../helpers/review-history.ts';

const snapshotPath = resolve(import.meta.dirname, '../fixtures/reports/fix.md');
const evidencePath = (blob: { sha256: string; bytes: number }): string => `/evidence/${blob.sha256.slice(0, 8)}`;

const patches = ['/evidence/patch-1', '/evidence/patch-2', '/evidence/patch-3'];

describe('the report of a fix run', () => {
  const render = (state: RunState = fixRun().fold()): string => renderReport(state, { engine: '0.0.0+dev', statistics: fixStatistics, fix: { evidencePath, patches } });

  it('renders exactly as the committed snapshot, which a person read once in review', () => {
    assert.equal(render(), readFileSync(snapshotPath, 'utf8'), `the report changed; if on purpose, write the new text to ${snapshotPath}`);
  });

  it('says in its header that the run fixed, how each finding ended, and that the edits are uncommitted', () => {
    assert.match(render(), /^Fix pass: 1 applied, 0 already applied, 0 deferred, 0 blocked, 0 not attempted, 1 held for the author; 3 patches; the edits are in the working tree, uncommitted$/m);
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
    assert.match(report, /^\| src\/a\.ts \| modified \| lint check, c1-1, repair \|$/m);
    assert.match(report, /^\| test\/a\.test\.ts \| created \| c1-1 \|$/m);
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

  it('names an ownership violation with the cluster that reported it and the one that owns the file', () => {
    const review = fixRun().review();
    const fix = review.fix!;
    const withViolation = { ...review, fix: { ...fix, plan: { ...fix.plan!, clusters: [...fix.plan!.clusters, { id: 'c2', findingIds: ['SWEEP-1'], files: ['src/b.ts'] }] }, answers: { ...fix.answers, fixes: { 'c1-1': { ...fix.answers.fixes['c1-1']!, violations: ['src/b.ts'] } } } } };
    assert.ok(fixLimitations(withViolation).includes('- Ownership violation: src/b.ts, owned by c2, was edited by c1-1, which reported it; the edit is kept and revised (PD4).'));
  });

  it('renders a run without the fix pass with none of these sections', () => {
    const report = renderReport(reported().fold(), { engine: '0.0.0+dev', statistics });
    for (const heading of ['## Fixes', '## Checks', '## Changed files']) assert.ok(!report.includes(heading), heading);
    assert.doesNotMatch(report, /^Fix pass:/m);
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
    assert.equal(json.commits, null);
  });

  it('names a batch with a worker running as running, and one with none yet as pending', () => {
    const history = withFixPass(mergeRanked()).start('baseline-checks').add('check.ran', checkRun('baseline-checks', 'build')).finish('baseline-checks').start('fixes').add('fixes.planned', fixPlan);
    assert.ok(describeRun(history.fold(), claudeAdapter, evidencePath).lines.includes('Fix pass: c1-1 pending; 1 held for the author'));
    history.add('worker.launched', { ...(history.events.find((event) => event.kind === 'worker.launched')?.payload as object), workerId: worker(70), label: 'fixer fixes:c1-1' });
    assert.ok(describeRun(history.fold(), claudeAdapter, evidencePath).lines.includes('Fix pass: c1-1 running; 1 held for the author'));
  });
});
