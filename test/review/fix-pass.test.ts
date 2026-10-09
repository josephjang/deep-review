import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import type { ReviewOutcome } from '../../src/review/controller.ts';
import { policyFileName } from '../../src/review/policy.ts';
import { describeRun } from '../../src/review/status.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { deciderAnswer, fixerAnswer, type Script } from '../helpers/fake-runtime.ts';
import { until } from '../helpers/launcher.ts';
import { git, write } from '../helpers/repository.ts';
import { ReviewSandbox } from '../helpers/review-sandbox.ts';

/** A candidate as a finder returns it. */
const found = (file: string, line: number, summary: string): Record<string, unknown> => ({ file, line, summary, detail: `${summary}: the failure a user would see` });

/** The nine leads with nothing in them. */
const noLeads = ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'].map((angle) => ({ angle, lead: null }));

/**
 * A review whose triage finds one defect in src/a.ts and one in src/b.ts,
 * both PLAUSIBLE from SCAN, which the decider decides to fix, and whose
 * sweep adds a PLAUSIBLE DESIGN finding in src/a.ts, which it leaves as
 * outside the change, so no fixer sees it. Ranked SCAN-1, SCAN-2,
 * SWEEP-1, the plan is c1 owning src/a.ts with SCAN-1 and c2 owning
 * src/b.ts with SCAN-2, one batch each, c1-1 and c2-1.
 */
const reviewScript: Script = {
  triage: { output: { candidates: [found('src/a.ts', 2, 'text is dereferenced when null'), found('src/b.ts', 1, 'b calls parse without importing it')], leads: noLeads } },
  sweep: { output: { candidates: [{ ...found('src/a.ts', 5, 'other() would read better inlined'), angle: 'DESIGN' }] } },
  decider: { output: deciderAnswer([{}, {}, { decision: 'leave' }]) },
};

/** The fixed bytes each fixer writes. */
const fixedA = 'export function parse(text: string | null) {\n  return text?.length ?? 0;\n}\n\nexport function other() {\n  return parse(null);\n}\n';
const fixedB = 'import { parse } from \'./a.ts\';\n\nexport const b = parse("x");\n';
const testA = 'import { parse } from \'../src/a.ts\';\nif (parse(null) !== 0) throw new Error(\'null\');\n';

describe('the fix pass', { timeout: 900_000 }, () => {
  let box: ReviewSandbox;
  beforeEach(() => {
    box = new ReviewSandbox();
  });
  afterEach(() => {
    box.close();
  });

  const report = (outcome: ReviewOutcome): string => {
    assert.equal(outcome.kind, 'report', JSON.stringify(outcome));
    return outcome.kind === 'report' ? readFileSync(outcome.reportPath, 'utf8') : '';
  };
  const promptOf = (state: RunState, label: string): string => box.promptOf(state, label);
  /** Set the sandbox policy's fixer batch size, which the next run created pins. */
  const setPolicyBatchSize = (batchSize: number): void => {
    const policyFile = join(box.rolesRoot, policyFileName);
    writeFileSync(policyFile, JSON.stringify({ ...JSON.parse(readFileSync(policyFile, 'utf8')), fixes: { batchSize } }, null, 2));
  };

  it('fixes the fixer-routed findings, one cluster per file, runs the checks before and after, and records each finding\'s edits as a revision', async () => {
    // Each fixer answers only once both are running, so that they ran at once is not left to how fast each one started.
    const bothRunning = join(box.directory, 'both-fixers-running');
    box.script({
      ...reviewScript,
      'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA, 'test/a.test.ts': testA }, snapshot: 0 }], waitFor: bothRunning, output: fixerAnswer([{ files: ['src/a.ts', 'test/a.test.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
      'fixer:fixes:c2-1': { edits: [{ writes: { 'src/b.ts': fixedB }, snapshot: 0 }], waitFor: bothRunning, output: fixerAnswer([{ files: ['src/b.ts'], subject: 'fix(b): Import parse' }]) },
    });
    const pending = box.fix('claude');
    const running = (label: string): boolean => box.checkpoint.foldRuns().some((run) => Object.values(run.workers).some((worker) => worker.launch.label === label && worker.status === 'running'));
    try {
      await until(() => running('fixer fixes:c1-1') && running('fixer fixes:c2-1'), 'both fixers running', 120_000);
    } finally {
      writeFileSync(bothRunning, '');
    }
    const text = report(await pending);
    const state = box.run();
    const review = state.review!;
    assert.equal(review.configuration.fix, true);
    assert.deepEqual(Object.fromEntries(Object.entries(review.phases).map(([phase, value]) => [phase, value.status])), {
      survey: 'completed', triage: 'completed', finders: 'completed', deduplication: 'completed', verification: 'completed', sweep: 'completed', 'sweep-deduplication': 'completed', 'sweep-verification': 'completed', 'merge-rank': 'completed',
      decision: 'completed', 'baseline-checks': 'completed', fixes: 'completed', checks: 'completed', repair: 'completed', 'repair-checks': 'completed', report: 'completed',
    });
    const fix = review.fix!;
    // Routing by decision and clustering (R6 of the decision step; R3).
    assert.deepEqual(fix.plan, {
      routes: [{ id: 'SCAN-1', route: 'fixer' }, { id: 'SCAN-2', route: 'fixer' }, { id: 'SWEEP-1', route: 'held' }],
      clusters: [{ id: 'c1', findingIds: ['SCAN-1'], files: ['src/a.ts'] }, { id: 'c2', findingIds: ['SCAN-2'], files: ['src/b.ts'] }],
      batches: [{ key: 'c1-1', cluster: 'c1', findingIds: ['SCAN-1'] }, { key: 'c2-1', cluster: 'c2', findingIds: ['SCAN-2'] }],
    });
    // The checks ran before the fixes and after them, in order, and the repair had nothing to do (R9, R10).
    assert.deepEqual(box.checkRuns(), ['build', 'typecheck', 'lint', 'test', 'build', 'typecheck', 'lint', 'test']);
    assert.deepEqual(fix.checks.runs['baseline-checks'].map((run) => [run.kind, run.outcome]), [['build', 'passed'], ['typecheck', 'passed'], ['lint', 'passed'], ['test', 'passed']]);
    assert.deepEqual(fix.checks.runs.checks.map((run) => run.outcome), ['passed', 'passed', 'passed', 'passed']);
    assert.deepEqual(fix.checks.runs['repair-checks'], []);
    // Each fixer ran with edit access in its own scratch, and its answer and edits are recorded (R4, R5, R6).
    const fixers = Object.values(state.workers).filter((worker) => worker.launch.label?.startsWith('fixer '));
    assert.deepEqual(fixers.map((worker) => [worker.launch.label, worker.launch.access]).sort(), [['fixer fixes:c1-1', 'edit'], ['fixer fixes:c2-1', 'edit']]);
    assert.ok(fixers.every((worker) => worker.launch.scratch !== null && !worker.launch.scratch.startsWith(box.repo)));
    assert.deepEqual(Object.keys(fix.answers.fixes).sort(), ['c1-1', 'c2-1']);
    assert.deepEqual(fix.answers.fixes['c1-1']!.findings.map((finding) => [finding.id, finding.status, finding.files]), [['SCAN-1', 'applied', ['src/a.ts', 'test/a.test.ts']]]);
    assert.deepEqual(fix.revisions.map((revision) => [revision.phase, revision.source.kind, revision.change.findings, revision.change.message.subject, revision.files.map((file) => `${file.path} ${file.status}`)]).sort(), [
      ['fixes', 'fix', ['SCAN-1'], 'fix(a): Return 0 for a null text', ['src/a.ts modified', 'test/a.test.ts created']],
      ['fixes', 'fix', ['SCAN-2'], 'fix(b): Import parse', ['src/b.ts modified']],
    ]);
    // The design finding the decision left never reached a fixer (R6 of the decision step), and each fixer was told its finding's decision (R7).
    const c1 = promptOf(state, 'fixer fixes:c1-1');
    assert.match(c1, /^Cluster c1, batch c1-1: 1 finding, numbered \[0\] to \[0\]/m);
    assert.doesNotMatch(c1, /Findings of this cluster that earlier batches worked/, 'a cluster\'s first batch has none before it');
    assert.match(c1, /^\[0\] SCAN-1 \[minor\] PLAUSIBLE \(SCAN\) at src\/a\.ts:2$/m);
    assert.doesNotMatch(c1, /SWEEP-1/);
    assert.match(c1, /^ {4}decided: fix\. fake grounds for \[0\]\n {8}approach: fake approach for \[0\]\n {8}rejected: fake alternative for \[0\] \(fake reason it was rejected\)$/m);
    assert.match(c1, /Never defer a finding over a choice its decision made: defer only by the criteria of your role prompt/);
    assert.match(c1, /- src\/b\.ts \(c2\)/, 'the other cluster\'s files are named as not to be edited');
    assert.match(c1, /^ {4}node ".*cli\.ts" snapshot --finding <index> --into ".*snapshots"$/m);
    assert.doesNotMatch(c1, /may already hold part of this work/);
    // The tree holds the fixes, nothing is committed, and no check found the tree drifted.
    assert.equal(readFileSync(join(box.repo, 'src', 'a.ts'), 'utf8'), fixedA);
    assert.equal(readFileSync(join(box.repo, 'test', 'a.test.ts'), 'utf8'), testA);
    assert.equal(git(box.repo, 'log', '--format=%s', '-1'), 'the change under review', 'the run commits nothing');
    assert.ok(review.checks.every((check) => !check.drifted), JSON.stringify(review.checks.filter((check) => check.drifted)));
    // One patch per revision (R13), and the report says what the fix pass did.
    assert.equal(review.report!.patches.length, 2);
    assert.match(text, /^Fix pass: 2 applied, 0 already applied, 0 deferred, 0 blocked, 0 not attempted, 1 left by decision, 0 asked, kept as is; 2 patches; the edits are in the working tree, uncommitted$/m);
    assert.match(text, /^### 1\. SCAN-1 applied\n\nNote: fake applied \[0\]\nCommit message: fix\(a\): Return 0 for a null text\nCluster: c1, batch c1-1 \(src\/a\.ts\); patch \d$/m);
    assert.match(text, /^### 3\. SWEEP-1 left by decision\n\nNo fixer saw it: the decision step left it, outside the change, and not a regression\. See Decisions\.$/m);
    assert.match(text, /^## Decisions\n\nBefore any fix, the decision step decided each finding: 2 to fix, 1 to leave, 0 to ask the author\./m);
    // The flags named every check, so each row's source is --check, where a check the survey chose names its file.
    assert.match(text, /^\| build \| ".*fake-check\.mjs" build \| --check \| passed, [\d.]+ s \| passed, [\d.]+ s \|$/m);
    assert.match(text, /^## Conventions\n\nThe survey found no file that states conventions/m);
    assert.match(text, /^\| test\/a\.test\.ts \| created \| c1-1 \|$/m);
    for (const patch of review.report!.patches) assert.ok(text.includes(box.checkpoint.evidence.pathOf(patch)), 'the report names each patch by its path');
    assert.match(text, /^- After the repair: not run, since no check failed after the fixes\.$/m);
    // The two clusters' fixers ran at once: both launched before either finished.
    const events = box.events(state.id);
    const launched = (cluster: string): number => events.findIndex(([kind, payload]) => kind === 'worker.launched' && payload.label === `fixer fixes:${cluster}`);
    const firstFinish = events.findIndex(([kind, payload]) => kind === 'worker.finished' && fixers.some((worker) => worker.launch.workerId === payload.workerId));
    assert.ok(launched('c1-1') < firstFinish && launched('c2-1') < firstFinish, 'both fixers were in flight together');
  });

  /** A script whose triage finds three defects in src/a.ts, so one cluster holds three findings in rank order. */
  const threeInOneFile: Script = {
    triage: { output: { candidates: [found('src/a.ts', 1, 'first'), found('src/a.ts', 2, 'second'), found('src/a.ts', 3, 'third')], leads: noLeads } },
  };

  it('gives each finding its own revision from the snapshot taken after it, folds a finding with none into the next, and writes a series git am applies', async () => {
    const v1 = 'export function parse(text: string | null) {\n  return text?.length ?? 0;\n}\n';
    const v3 = `${v1}\nexport function other() {\n  return parse(null);\n}\n`;
    box.script({
      ...threeInOneFile,
      'fixer:fixes:c1-1': {
        edits: [
          { writes: { 'src/a.ts': v1 }, snapshot: 0 },
          { writes: { 'src/a.ts': `${v1}// second\n` } },
          { writes: { 'src/a.ts': v3, 'test/a.test.ts': testA } },
        ],
        output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix: First' }, { files: ['src/a.ts'], subject: 'fix: Second' }, { files: ['src/a.ts', 'test/a.test.ts'], subject: 'fix: Third' }]),
      },
    });
    report(await box.fix('claude'));
    const state = box.run();
    const revisions = state.review!.fix!.revisions;
    assert.deepEqual(revisions.map((revision) => [revision.change.findings, revision.change.message.subject, revision.files.map((file) => file.path)]), [
      [['SCAN-1'], 'fix: First', ['src/a.ts']],
      // The second finding took no snapshot, so its edits fold into the third's revision, which names both.
      [['SCAN-2', 'SCAN-3'], 'Apply SCAN-2, SCAN-3', ['src/a.ts', 'test/a.test.ts']],
    ]);
    assert.match(revisions[1]!.change.message.body, /^fix: Second\n\nWhy finding 1 changed\.\n\nfix: Third\n\nWhy finding 2 changed\.$/);
    // The series applies in order to a checkout at the scope's head and reconstructs the tree the fixer left.
    const clone = join(box.directory, 'clone');
    // A checkout that writes the bytes as committed, whatever the machine's own core.autocrlf says.
    git(box.directory, 'clone', '-q', '-c', 'core.autocrlf=false', box.repo, clone);
    git(clone, 'config', 'user.name', 'Test');
    git(clone, 'config', 'user.email', 'test@example.invalid');
    const patches = state.review!.report!.patches.map((reference, index) => {
      const file = join(box.directory, `${String(index + 1).padStart(4, '0')}.patch`);
      writeFileSync(file, box.checkpoint.evidence.read(reference));
      return file;
    });
    git(clone, 'am', '--keep-cr', '-q', ...patches);
    for (const path of ['src/a.ts', 'test/a.test.ts']) assert.equal(readFileSync(join(clone, ...path.split('/')), 'utf8'), readFileSync(join(box.repo, ...path.split('/')), 'utf8'), path);
    assert.deepEqual(git(clone, 'log', '--format=%s', '-2').split('\n'), ['Apply SCAN-2, SCAN-3', 'fix: First']);
  });

  it('fixes a cluster in batches of the policy\'s size, one after another, each told what the batches before it did', async () => {
    setPolicyBatchSize(1);
    // Two findings in src/a.ts make one cluster; batches of one run it as c1-1, then c1-2.
    box.script({
      triage: { output: { candidates: [found('src/a.ts', 2, 'text is dereferenced when null'), found('src/a.ts', 6, 'other() passes null on')], leads: noLeads } },
      'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
      'fixer:fixes:c1-2': { output: fixerAnswer([{ status: 'already-applied', files: ['src/a.ts'], note: 'the guard c1-1 added covers it' }]) },
    });
    report(await box.fix('claude'));
    const state = box.run();
    const fix = state.review!.fix!;
    assert.deepEqual(fix.plan!.clusters.map((cluster) => [cluster.id, cluster.findingIds]), [['c1', ['SCAN-1', 'SCAN-2']]]);
    assert.deepEqual(fix.plan!.batches.map((batch) => [batch.key, batch.findingIds]), [['c1-1', ['SCAN-1']], ['c1-2', ['SCAN-2']]]);
    // c1-2 launched only once c1-1's answer was on the ledger.
    const events = box.events(state.id);
    const answeredAt = events.findIndex(([kind, payload]) => kind === 'fix.recorded' && payload.key === 'c1-1');
    const launchedAt = events.findIndex(([kind, payload]) => kind === 'worker.launched' && payload.label === 'fixer fixes:c1-2');
    assert.ok(answeredAt >= 0 && launchedAt > answeredAt, `c1-1 answered at ${String(answeredAt)}, c1-2 launched at ${String(launchedAt)}`);
    const second = promptOf(state, 'fixer fixes:c1-2');
    assert.match(second, /^Cluster c1, batch c1-2: 1 finding, numbered \[0\] to \[0\]/m);
    assert.match(second, /^- c1-1 SCAN-1 applied: fake applied \[0\]$/m);
    assert.match(second, /Files you own while this batch runs, which no other worker edits:\n- src\/a\.ts\n/);
    assert.doesNotMatch(second, /may already hold part of this work/, 'the first batch\'s revision is no warning to the second');
    assert.deepEqual(Object.entries(fix.answers.fixes).map(([key, answer]) => [key, answer.findings.map((finding) => finding.status)]), [['c1-1', ['applied']], ['c1-2', ['already-applied']]]);
    assert.deepEqual(fix.revisions.filter((revision) => revision.phase === 'fixes').map((revision) => [revision.source.kind === 'fix' ? revision.source.key : null, revision.change.findings]), [['c1-1', ['SCAN-1']]]);
    assert.ok(describeRun(state, claudeAdapter, (reference) => reference.sha256).lines.includes('Fix pass: c1-1 answered, c1-2 answered; 0 no fixer sees, as decided'));
  });

  it('stops launching fixers once the run budget is reached, reports what it did not attempt, and completes instead of blocking (R19)', async () => {
    setPolicyBatchSize(1);
    box.script({
      triage: { output: { candidates: [found('src/a.ts', 2, 'text is dereferenced when null'), found('src/a.ts', 6, 'other() passes null on')], leads: noLeads } },
      // The first batch alone spends past the budget, so its cluster's second batch is never launched.
      'fixer:fixes:c1-1': { costUsd: 5, edits: [{ writes: { 'src/a.ts': fixedA }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
    });
    const text = report(await box.fix('claude', { flags: { budgetUsd: 1 } }));
    const state = box.run();
    const fix = state.review!.fix!;
    assert.deepEqual(Object.keys(fix.answers.fixes), ['c1-1']);
    assert.equal(fix.notAttempted.fixes['c1-2']?.cause, 'budget');
    assert.match(fix.notAttempted.fixes['c1-2']?.reason ?? '', /^spent 5\.\d\d USD of the 1\.00 USD run budget/);
    assert.equal(Object.values(state.workers).some((worker) => worker.launch.label === 'fixer fixes:c1-2'), false, 'no worker for the batch past the budget');
    assert.equal(state.review!.phases.fixes.status, 'degraded');
    assert.equal(state.review!.blocker, null);
    assert.ok(box.logs.some((line) => /^phase fixes: c1-2 not attempted \(budget\): spent/.test(line)), box.logs.join('\n'));
    // The report says what the budget left undone; the checks still ran on the fixed tree.
    assert.match(text, /^### 2\. SCAN-2 not attempted\n\nNot attempted: the run budget was reached first: spent 5\.\d\d USD of the 1\.00 USD run budget/m);
    assert.match(text, /^Fix pass: 1 applied, 0 already applied, 0 deferred, 0 blocked, 1 not attempted, 0 left by decision, 0 asked, kept as is;/m);
    assert.equal(fix.checks.runs.checks.length > 0, true);
  });

  it('gives a finding blocked on another cluster\'s file a second round that owns both, once the first round settled, and reports what it was first blocked on (R21)', async () => {
    const guardedB = `${fixedB}// keeps the guard\n`;
    box.script({
      ...reviewScript,
      // As on the gate: SCAN-1's fix needs src/b.ts, which c2 owns for its one finding.
      'fixer:fixes:c1-1': { output: fixerAnswer([{ status: 'blocked', files: [], requiredFiles: ['src/b.ts'], note: 'the fix needs src/b.ts, which c2 owns' }]) },
      'fixer:fixes:c2-1': { edits: [{ writes: { 'src/b.ts': fixedB }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/b.ts'], subject: 'fix(b): Import parse' }]) },
      'fixer:fixes:c3-1': { edits: [{ writes: { 'src/a.ts': fixedA, 'src/b.ts': guardedB }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts', 'src/b.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
    });
    const text = report(await box.fix('claude'));
    const state = box.run();
    const fix = state.review!.fix!;
    assert.deepEqual(fix.secondRound, {
      blocked: [{ id: 'SCAN-1', requiredFiles: ['src/b.ts'] }],
      clusters: [{ id: 'c3', findingIds: ['SCAN-1'], files: ['src/a.ts', 'src/b.ts'] }],
      batches: [{ key: 'c3-1', cluster: 'c3', findingIds: ['SCAN-1'] }],
    });
    // The round was planned once both first-round batches had answered, and its batch launched after.
    const events = box.events(state.id);
    const at = (predicate: (event: [string, Record<string, unknown>]) => boolean): number => events.findIndex(predicate);
    const replannedAt = at(([kind]) => kind === 'fixes.replanned');
    assert.ok(at(([kind, payload]) => kind === 'fix.recorded' && payload.key === 'c1-1') < replannedAt && at(([kind, payload]) => kind === 'fix.recorded' && payload.key === 'c2-1') < replannedAt);
    assert.ok(replannedAt < at(([kind, payload]) => kind === 'worker.launched' && payload.label === 'fixer fixes:c3-1'));
    const prompt = promptOf(state, 'fixer fixes:c3-1');
    assert.match(prompt, /^Cluster c3, batch c3-1, in the second round: 1 finding/m);
    assert.match(prompt, /^ {4}first round: blocked, needing src\/b\.ts: the fix needs src\/b\.ts, which c2 owns$/m);
    assert.match(prompt, /Files you own while this batch runs, which no other worker edits:\n- src\/a\.ts\n- src\/b\.ts\n/);
    assert.match(prompt, /^- c2-1 SCAN-2 applied: fake applied \[0\]$/m);
    // The edit to src/b.ts, c2's in the first round, is no violation in the second.
    assert.deepEqual(fix.answers.fixes['c3-1']!.violations, []);
    assert.deepEqual(fix.revisions.filter((revision) => revision.phase === 'fixes').map((revision) => [revision.source.kind === 'fix' ? revision.source.key : null, revision.change.findings, revision.files.map((file) => file.path)]), [
      ['c2-1', ['SCAN-2'], ['src/b.ts']],
      ['c3-1', ['SCAN-1'], ['src/a.ts', 'src/b.ts']],
    ]);
    assert.match(text, /^### 1\. SCAN-1 applied\n\nNote: fake applied \[0\]\nCommit message: fix\(a\): Return 0 for a null text\nCluster: c3, batch c3-1 \(src\/a\.ts, src\/b\.ts\); patch \d\nFirst blocked on: src\/b\.ts, which the second round gave it$/m);
    assert.ok(state.review!.checks.every((check) => !check.drifted));
    assert.ok(box.logs.includes('phase fixes: second round for SCAN-1, in 1 cluster and 1 batch'), box.logs.join('\n'));
  });

  it('sees a CRLF checkout rewritten to LF as no change: no revision for the check, no drift, and a fix\'s patch of its own lines only (R22)', async () => {
    // Check the reviewed tree out again with core.autocrlf, as Git for Windows does: every text file CRLF in the worktree, LF in the index.
    git(box.repo, 'config', 'core.autocrlf', 'true');
    git(box.repo, 'rm', '--cached', '-r', '-q', '.');
    git(box.repo, 'reset', '--hard', '-q');
    assert.ok(readFileSync(join(box.repo, 'src', 'a.ts'), 'utf8').includes('\r\n'));
    const lfA = readFileSync(join(box.repo, 'src', 'a.ts'), 'utf8').replaceAll('\r\n', '\n');
    const lfB = readFileSync(join(box.repo, 'src', 'b.ts'), 'utf8').replaceAll('\r\n', '\n');
    // The build reformats both changed files to LF, as zod's postbuild did; the fixer then edits one line of src/a.ts.
    box.checks({ build: [{ write: { 'src/a.ts': lfA, 'src/b.ts': lfB } }, 'pass'] });
    box.script({
      ...reviewScript,
      'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
      'fixer:fixes:c2-1': { output: fixerAnswer([{ status: 'deferred', files: [] }]) },
    });
    report(await box.fix('claude'));
    const state = box.run();
    const fix = state.review!.fix!;
    assert.deepEqual(fix.revisions.map((revision) => [revision.source.kind, revision.files.map((file) => file.path)]), [['fix', ['src/a.ts']]], 'the build\'s rewrite is no revision');
    assert.ok(state.review!.checks.every((check) => !check.drifted), 'nor drift');
    const patch = box.checkpoint.evidence.read(state.review!.report!.patches[0]!).toString('utf8');
    assert.deepEqual(patch.split('\n').filter((line) => /^[-+][^-+]/.test(line)), ['-  return text!.length;', '+  return text?.length ?? 0;'], patch);
  });

  it('revises an unowned file a fixer edits and reports, without drift', async () => {
    box.script({
      ...reviewScript,
      // The change deletes src/gone.ts; c1 brings it back, a file no cluster owns.
      'fixer:fixes:c1-1': { edits: [{ writes: { 'src/gone.ts': 'export const gone = 2;\n' } }], output: fixerAnswer([{ files: ['src/gone.ts'] }]) },
    });
    report(await box.fix('claude'));
    const state = box.run();
    assert.deepEqual(state.review!.fix!.revisions.map((revision) => revision.files.map((file) => `${file.path} ${file.status}`)), [['src/gone.ts created']]);
    assert.ok(state.review!.checks.every((check) => !check.drifted));
    assert.deepEqual(state.review!.fix!.answers.fixes['c1-1']!.violations, []);
  });

  it('records a reported edit to a file another cluster owns as a violation, revises it, and completes', async () => {
    box.script({
      ...reviewScript,
      'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA, 'src/b.ts': fixedB } }], output: fixerAnswer([{ files: ['src/a.ts', 'src/b.ts'] }]) },
      'fixer:fixes:c2-1': { output: fixerAnswer([{ status: 'already-applied', files: [] }]) },
    });
    report(await box.fix('claude', { flags: { concurrency: 1 } }));
    const state = box.run();
    assert.deepEqual(state.review!.fix!.answers.fixes['c1-1']!.violations, ['src/b.ts']);
    assert.deepEqual(state.review!.fix!.revisions[0]!.files.map((file) => file.path), ['src/a.ts', 'src/b.ts']);
    assert.ok(state.review!.checks.every((check) => !check.drifted));
  });

  it('blocks the fixes phase\'s end check on an unreported edit to a settled sibling\'s file, naming it and its expected bytes, and completes once it is restored', async () => {
    const marker = join(box.directory, 'c1-may-answer');
    box.script({
      ...reviewScript,
      'fixer:fixes:c1-1': { waitFor: marker, output: fixerAnswer([{ files: [] , status: 'deferred' }]) },
      'fixer:fixes:c2-1': { edits: [{ writes: { 'src/b.ts': fixedB } }], output: fixerAnswer([{ files: ['src/b.ts'] }]) },
    });
    const pending = box.fix('claude');
    await until(() => box.checkpoint.foldRuns().some((run) => run.review?.fix?.answers.fixes['c2-1'] !== undefined), 'c2-1\'s answer on the ledger', 120_000);
    // c1 reaches into the settled c2's file and says nothing of it.
    write(box.repo, 'src/b.ts', 'export const b = "clobbered";\n');
    writeFileSync(marker, '');
    const blocked = await pending;
    assert.ok(blocked.kind === 'blocked' && blocked.blocker.code === 'drift' && blocked.blocker.phase === 'fixes', JSON.stringify(blocked));
    const named = /src\/b\.ts \(modified; expected at (.+)\)$/.exec(blocked.kind === 'blocked' ? blocked.blocker.detail : '');
    assert.ok(named !== null, JSON.stringify(blocked));
    assert.equal(readFileSync(named[1]!, 'utf8'), fixedB, 'the bytes c2 left, not the scope\'s');
    const end = box.run().review!.checks.at(-1)!;
    assert.equal(end.moment, 'end');
    // Restored from the path the blocker named, the run completes.
    writeFileSync(join(box.repo, 'src', 'b.ts'), readFileSync(named[1]!));
    report(await box.fix('claude'));
    assert.equal(box.run().review!.phases.fixes.status, 'completed');
  });

  it('lists a file no answer names as a stray, and does not block on it', async () => {
    box.script({
      ...reviewScript,
      'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA, 'notes.txt': 'scratch left in the tree\n' } }], output: fixerAnswer([{ files: ['src/a.ts'] }]) },
    });
    report(await box.fix('claude'));
    const state = box.run();
    assert.ok(state.review!.checks.some((check) => check.phase === 'fixes' && check.moment === 'end' && check.strays.includes('notes.txt')), JSON.stringify(state.review!.checks));
    assert.ok(state.review!.checks.every((check) => !check.drifted));
    assert.equal(existsSync(join(box.repo, 'notes.txt')), true, 'the engine removes nothing from the tree');
  });

  it('gives a check that failed before any edit and still fails to the repair worker with both outputs, for the failures that are new (R24)', async () => {
    box.checks({ lint: 'fail' });
    box.script({
      ...reviewScript,
      'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA } }], output: fixerAnswer([{ files: ['src/a.ts'] }]) },
      'fixer:repair:repair': { output: fixerAnswer([{ status: 'deferred', files: [], note: 'every failure was there before the fixes' }]) },
    });
    const text = report(await box.fix('claude'));
    const state = box.run();
    const fix = state.review!.fix!;
    assert.equal(fix.checks.runs['baseline-checks'].find((run) => run.kind === 'lint')?.outcome, 'failed');
    assert.equal(fix.checks.runs.checks.find((run) => run.kind === 'lint')?.outcome, 'failed');
    assert.deepEqual(fix.answers.repair.repair!.findings.map((finding) => [finding.id, finding.status]), [['lint', 'deferred']]);
    const repair = promptOf(state, 'fixer repair:repair');
    assert.match(repair, /^\[0\] lint: .*\n {4}exited with code 1\n[\s\S]*?\n {4}It failed before any fixer edited the tree too: fix only the failures its output then does not show/m);
    // Each fixer was told what failed before it edited anything.
    assert.match(promptOf(state, 'fixer fixes:c1-1'), /^These failed before any fixer edited the tree; their output then is at the paths given\. [^\n]*\n- lint: \S/m);
    assert.deepEqual(fix.checks.runs['repair-checks'].map((run) => run.kind), ['build', 'typecheck', 'lint', 'test'], 'the checks ran once more after the repair');
    assert.match(text, /^- lint check deferred: every failure was there before the fixes; no patch$/m);
  });

  it('never sends the repair a check that failed before any edit and passes after', async () => {
    box.checks({ lint: ['fail', 'pass'] });
    box.script({ ...reviewScript, 'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA } }], output: fixerAnswer([{ files: ['src/a.ts'] }]) } });
    report(await box.fix('claude'));
    assert.ok(!Object.values(box.run().workers).some((worker) => worker.launch.label === 'fixer repair:repair'));
  });

  it('sends a check the fixers broke to one repair worker, which owns their files, and runs the checks once more', async () => {
    box.checks({ test: { failIfContains: { 'src/a.ts': 'BROKEN' } } });
    box.script({
      ...reviewScript,
      'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': `${fixedA}// BROKEN\n` } }], output: fixerAnswer([{ files: ['src/a.ts'] }]) },
      'fixer:repair:repair': { edits: [{ writes: { 'src/a.ts': fixedA }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Drop the line that broke the test' }]) },
    });
    report(await box.fix('claude'));
    const state = box.run();
    const fix = state.review!.fix!;
    assert.equal(fix.checks.runs.checks.find((run) => run.kind === 'test')?.outcome, 'failed');
    assert.deepEqual(fix.answers.repair.repair!.findings.map((finding) => [finding.id, finding.status]), [['test', 'applied']]);
    assert.deepEqual(fix.checks.runs['repair-checks'].map((run) => [run.kind, run.outcome]), [['build', 'passed'], ['typecheck', 'passed'], ['lint', 'passed'], ['test', 'passed']]);
    assert.deepEqual(fix.revisions.map((revision) => [revision.phase, revision.change.findings]), [['fixes', ['SCAN-1']], ['repair', ['test']]]);
    const repair = promptOf(state, 'fixer repair:repair');
    assert.match(repair, /^Repair: 1 check, numbered \[0\] to \[0\], fails after the fixers' edits\./m);
    assert.match(repair, /^ {4}It passed before any fixer edited the tree\.$/m);
    assert.match(repair, /^\[0\] test: .*fake-check\.mjs" test\n {4}exited with code 1\n {4}stdout, its last \d+ bytes \(the whole is at .+\):\n```text\ntest: src\/a\.ts is broken\n```/m);
    assert.match(repair, /Files you own: every file the fixers changed\.\n- src\/a\.ts\n/);
    assert.match(repair, /^- c1-1 SCAN-1 applied: fake applied \[0\]$/m);
  });

  it('leaves a check the repair did not fix failing in the report, and completes', async () => {
    box.checks({ test: { failIfContains: { 'src/a.ts': 'BROKEN' } } });
    box.script({
      ...reviewScript,
      'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': `${fixedA}// BROKEN\n` } }], output: fixerAnswer([{ files: ['src/a.ts'] }]) },
      'fixer:repair:repair': { output: fixerAnswer([{ status: 'deferred', files: [] }]) },
    });
    report(await box.fix('claude'));
    const fix = box.run().review!.fix!;
    assert.equal(fix.checks.runs['repair-checks'].find((run) => run.kind === 'test')?.outcome, 'failed');
    assert.equal(box.run().review!.phases['repair-checks'].status, 'completed');
  });

  it('blocks with drift naming HEAD when a commit lands during the fixes, whatever the files say', async () => {
    const marker = join(box.directory, 'c1-may-answer');
    box.script({ ...reviewScript, 'fixer:fixes:c1-1': { waitFor: marker, output: fixerAnswer([{ status: 'deferred', files: [] }]) } });
    const pending = box.fix('claude');
    await until(() => box.checkpoint.foldRuns().some((run) => Object.values(run.workers).some((worker) => worker.launch.label === 'fixer fixes:c1-1' && worker.status === 'running')), 'the c1 fixer on the ledger', 120_000);
    const head = git(box.repo, 'rev-parse', 'HEAD');
    git(box.repo, 'commit', '-q', '--allow-empty', '-m', 'a commit during the run');
    const moved = git(box.repo, 'rev-parse', 'HEAD');
    writeFileSync(marker, '');
    const blocked = await pending;
    assert.ok(blocked.kind === 'blocked' && blocked.blocker.code === 'drift', JSON.stringify(blocked));
    assert.ok(blocked.kind === 'blocked' && blocked.blocker.detail.includes(`HEAD is ${moved}, the run expects ${head}`), JSON.stringify(blocked));
    assert.match(blocked.kind === 'blocked' ? blocked.blocker.action : '', /reset a moved HEAD to the recorded head/);
  });

  it('marks a cluster whose fixer fails twice not attempted, records the edits it left, degrades the phase and completes', async () => {
    box.script({
      ...reviewScript,
      'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': `${fixedA}// half done\n` } }], exit: 3 },
    });
    report(await box.fix('claude'));
    const state = box.run();
    const fix = state.review!.fix!;
    assert.equal(fix.notAttempted.fixes['c1-1']?.cause, 'failures');
    assert.match(fix.notAttempted.fixes['c1-1']?.reason ?? '', /^2 attempts did not complete/);
    assert.equal(state.review!.phases.fixes.status, 'degraded');
    // The first attempt's edits were recorded with its failure; the second left the same bytes, so it recorded nothing (R20).
    const workers = Object.values(state.workers).filter((worker) => worker.launch.label === 'fixer fixes:c1-1');
    assert.equal(workers.length, 2);
    const partial = fix.revisions.filter((revision) => revision.source.kind === 'attempt');
    assert.deepEqual(partial.map((revision) => [revision.source.kind === 'attempt' ? revision.source.workerId : null, revision.change.findings, revision.files.map((file) => file.path)]), [[workers[0]!.launch.workerId, [], ['src/a.ts']]]);
    assert.match(partial[0]!.change.message.subject, /^chore: keep the partial edits of batch c1-1$/);
    const events = box.events(state.id);
    assert.equal(events.findIndex(([kind, payload]) => kind === 'tree.revised' && (payload.source as { kind: string }).kind === 'attempt'), events.findIndex(([kind]) => kind === 'attempt.failed') + 1, 'recorded right after the failure, in its append');
    assert.ok(state.review!.checks.every((check) => !check.drifted), 'the edits the failed fixers left are expected, not drift');
    // The retry was told the tree may hold its predecessor's work.
    const prompts = workers.map((worker) => box.checkpoint.evidence.read(worker.launch.prompt).toString('utf8'));
    assert.doesNotMatch(prompts[0]!, /may already hold part of this work/);
    assert.match(prompts[1]!, /The tree may already hold part of this work/);
    assert.doesNotMatch(prompts[1]!, /An earlier attempt left edits for/, 'the first attempt snapshotted no finding');
  });

  it('fails an answer that leaves out a changed owned file, and tells the retry the tree may hold earlier work', async () => {
    box.script({
      ...reviewScript,
      'fixer:fixes:c1-1': [
        { edits: [{ writes: { 'src/a.ts': fixedA } }], output: fixerAnswer([{ files: [] }]) },
        { output: fixerAnswer([{ status: 'already-applied', files: ['src/a.ts'] }]) },
      ],
    });
    report(await box.fix('claude'));
    const state = box.run();
    const failed = box.events(state.id).filter(([kind, payload]) => kind === 'attempt.failed' && payload.key === 'c1-1');
    assert.equal(failed.length, 1);
    assert.match(String(failed[0]![1].reason), /^structural check: The answer names no finding for the owned file src\/a\.ts, whose bytes changed/);
    assert.deepEqual(state.review!.fix!.answers.fixes['c1-1']!.findings.map((finding) => [finding.status, finding.files]), [['already-applied', ['src/a.ts']]]);
    // The refused attempt's edit is recorded as its own, naming no finding since it snapshotted none, and the retry, which verified it, revised nothing (R20).
    assert.deepEqual(state.review!.fix!.revisions.map((revision) => [revision.source.kind, revision.change.findings, revision.files.map((file) => file.path)]), [['attempt', [], ['src/a.ts']]]);
  });

  it('leaves out of a failed attempt\'s revisions a file another cluster is editing and a stray listed before it ran', async () => {
    // The baseline build leaves an untracked file the run does not expect, which the fixes phase's start check lists as a stray.
    box.checks({ build: [{ write: { 'notes.txt': 'build notes\n' } }, 'pass'] });
    const c1MayDie = join(box.directory, 'c1-may-die');
    const c2MayAnswer = join(box.directory, 'c2-may-answer');
    box.script({
      ...reviewScript,
      // c1-1 snapshots its finding, waits until c2-1's edit of src/b.ts is in the tree, then dies; the engine reads what it left with that edit and the stray in place.
      'fixer:fixes:c1-1': [
        { edits: [{ writes: { 'src/a.ts': fixedA }, snapshot: 0 }], waitFor: c1MayDie, exit: 3 },
        { output: fixerAnswer([{ status: 'already-applied', files: ['src/a.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
      ],
      'fixer:fixes:c2-1': { edits: [{ writes: { 'src/b.ts': fixedB } }], waitFor: c2MayAnswer, output: fixerAnswer([{ files: ['src/b.ts'] }]) },
    });
    const pending = box.fix('claude');
    await until(() => existsSync(join(box.repo, 'src', 'b.ts')) && readFileSync(join(box.repo, 'src', 'b.ts'), 'utf8') === fixedB, 'c2-1\'s edit in the tree', 120_000);
    writeFileSync(c1MayDie, '');
    await until(() => box.checkpoint.foldRuns().some((run) => (run.review?.units.fixes['c1-1']?.failures.length ?? 0) > 0), 'c1-1\'s failed attempt on the ledger', 120_000);
    writeFileSync(c2MayAnswer, '');
    report(await pending);
    const fix = box.run().review!.fix!;
    assert.deepEqual(fix.revisions.filter((revision) => revision.phase === 'fixes').map((revision) => [revision.source.kind, revision.change.findings, revision.files.map((file) => file.path)]), [
      ['attempt', ['SCAN-1'], ['src/a.ts']],
      ['fix', ['SCAN-2'], ['src/b.ts']],
    ]);
    assert.ok(box.run().review!.checks.some((check) => check.strays.includes('notes.txt')), 'the notes are a stray, in no revision');
  });

  it('leaves out of a failed attempt\'s revisions a file git ignores that its snapshot listed, since the snapshot asks git nothing (R23)', async () => {
    writeFileSync(join(box.repo, '.git', 'info', 'exclude'), '*.log\n');
    box.script({
      ...reviewScript,
      // The log is new since the launch, so the snapshot's walk, which cannot ask git, lists it beside the fix.
      'fixer:fixes:c1-1': [
        { edits: [{ writes: { 'src/a.ts': fixedA, 'debug.log': 'trace\n' }, snapshot: 0 }], exit: 3 },
        { output: fixerAnswer([{ status: 'already-applied', files: ['src/a.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
      ],
    });
    report(await box.fix('claude'));
    const listings = readdirSync(box.scratchRoot, { recursive: true, encoding: 'utf8' }).filter((path) => basename(path) === '0.json');
    assert.ok(listings.some((path) => Object.hasOwn((JSON.parse(readFileSync(join(box.scratchRoot, path), 'utf8')) as { paths: Record<string, unknown> }).paths, 'debug.log')), `a listing names the log: ${listings.join(', ')}`);
    const fix = box.run().review!.fix!;
    assert.deepEqual(fix.revisions.filter((revision) => revision.phase === 'fixes').map((revision) => [revision.source.kind, revision.change.findings, revision.files.map((file) => file.path)]), [['attempt', ['SCAN-1'], ['src/a.ts']]]);
  });

  it('records each finding an unfinished attempt snapshotted as its own revision, and commits it with the message the retry gives on verifying it', async () => {
    const second = `${fixedA}// the second finding\n`;
    box.script({
      triage: { output: { candidates: [found('src/a.ts', 2, 'text is dereferenced when null'), found('src/a.ts', 6, 'other() passes null on')], leads: noLeads } },
      'fixer:fixes:c1-1': [
        // The first attempt snapshots both findings, writes a test after its last snapshot, and dies.
        { edits: [{ writes: { 'src/a.ts': fixedA }, snapshot: 0 }, { writes: { 'src/a.ts': second }, snapshot: 1 }, { writes: { 'test/a.test.ts': testA } }], exit: 3 },
        { output: fixerAnswer([{ status: 'already-applied', files: ['src/a.ts'], subject: 'fix(a): Return 0 for a null text' }, { status: 'already-applied', files: ['src/a.ts', 'test/a.test.ts'], subject: 'fix(a): Stop other() passing null' }]) },
      ],
    });
    report(await box.fix('claude'));
    const state = box.run();
    const fix = state.review!.fix!;
    const [first, retry] = Object.values(state.workers).filter((worker) => worker.launch.label === 'fixer fixes:c1-1');
    assert.ok(first !== undefined && retry !== undefined);
    assert.deepEqual(fix.revisions.map((revision) => [revision.source.kind === 'attempt' ? revision.source.workerId : revision.source.kind, revision.change.findings, revision.files.map((file) => `${file.path} ${file.status}`)]), [
      [first.launch.workerId, ['SCAN-1'], ['src/a.ts modified']],
      [first.launch.workerId, ['SCAN-2'], ['src/a.ts modified']],
      // The test came after the last snapshot: git reported it, and no finding accounts for it.
      [first.launch.workerId, [], ['test/a.test.ts created']],
    ]);
    // The log names each revision by the finding it serves, and the last by what it is: no finding's (R27 of the fix pass).
    assert.deepEqual(box.logs.filter((line) => line.startsWith('worker fixer fixes:c1-1: revised')), [
      'worker fixer fixes:c1-1: revised 1 file for SCAN-1',
      'worker fixer fixes:c1-1: revised 1 file for SCAN-2',
      'worker fixer fixes:c1-1: revised 1 file after its last snapshot',
    ]);
    const prompt = box.checkpoint.evidence.read(retry.launch.prompt).toString('utf8');
    assert.match(prompt, /An earlier attempt left edits for SCAN-1, SCAN-2, recorded as that attempt's work/);
    assert.deepEqual(fix.answers.fixes['c1-1']!.findings.map((finding) => [finding.status, finding.message?.subject ?? null]), [['already-applied', 'fix(a): Return 0 for a null text'], ['already-applied', 'fix(a): Stop other() passing null']]);
    // The patches carry the retry's messages for the findings it verified, and the engine's for the rest.
    const patches = state.review!.report!.patches.map((patch) => box.checkpoint.evidence.read(patch).toString('utf8'));
    assert.deepEqual(patches.map((patch) => /^Subject: \[PATCH \d+\/\d+\] (.*)$/m.exec(patch)?.[1]), ['fix(a): Return 0 for a null text', 'fix(a): Stop other() passing null', 'chore: keep the partial edits of batch c1-1']);
    assert.ok(state.review!.checks.every((check) => !check.drifted));
  });

  it('records a check that rewrites a file the run expects as a revision attributed to the check, not drift', async () => {
    box.checks({ lint: [{ write: { 'src/a.ts': 'export const formatted = true;\n' } }, 'pass'] });
    box.script({ ...reviewScript, 'fixer:fixes:c1-1': { output: fixerAnswer([{ status: 'already-applied', files: [] }]) } });
    report(await box.fix('claude'));
    const state = box.run();
    const revision = state.review!.fix!.revisions.find((candidate) => candidate.source.kind === 'check');
    assert.deepEqual(revision === undefined ? null : [revision.phase, revision.source, revision.files.map((file) => file.path), revision.change.message.subject], ['baseline-checks', { kind: 'check', check: 'lint' }, ['src/a.ts'], 'chore: apply the lint check\'s rewrite']);
    assert.ok(box.logs.includes('check lint (baseline-checks): rewrote 1 file the run expects; recorded as its revision'), box.logs.join('\n'));
    assert.ok(state.review!.checks.every((check) => !check.drifted));
  });

  it('skips the three later checks when build fails, and runs all three when build passes', async () => {
    box.checks({ build: ['fail', 'pass'] });
    box.script({ ...reviewScript, 'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA } }], output: fixerAnswer([{ files: ['src/a.ts'] }]) } });
    report(await box.fix('claude'));
    const fix = box.run().review!.fix!;
    assert.deepEqual(fix.checks.runs['baseline-checks'].map((run) => [run.kind, run.outcome, run.error]), [['build', 'failed', null], ['typecheck', 'skipped', 'build failed'], ['lint', 'skipped', 'build failed'], ['test', 'skipped', 'build failed']]);
    assert.deepEqual(fix.checks.runs.checks.map((run) => run.outcome), ['passed', 'passed', 'passed', 'passed']);
    assert.deepEqual(box.checkRuns(), ['build', 'build', 'typecheck', 'lint', 'test']);
  });

  it('runs a fix pass on the fake Codex to its report, with no budget', async () => {
    box.script({ ...reviewScript, 'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'] }]) } });
    report(await box.fix('codex'));
    const state = box.run();
    assert.equal(state.review!.configuration.runBudgetUsd, null);
    assert.equal(state.review!.fix!.revisions.length, 1);
    assert.equal(state.review!.report!.patches.length, 1);
  });

  it('runs the checks the surveyor chose from package.json, a hinted one and stated ones, with a --no-check over the survey, and pins them on the run (R4, R5, R11 of the repository survey)', async () => {
    const script = (kind: string, basis: 'stated' | 'hint'): Record<string, unknown> => ({ kind, command: `npm run ${kind}`, basis, source: { path: 'package.json', quote: `"${kind}": "node ..."` }, missingTool: null, reason: null });
    box.script({
      ...reviewScript,
      surveyor: { output: { conventions: [], userRules: [], checks: [script('build', 'hint'), script('lint', 'stated'), script('test', 'stated')], note: '' } },
      'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA } }], output: fixerAnswer([{ files: ['src/a.ts'] }]) },
    });
    report(await box.review('claude', { fix: { commands: {}, dropped: ['typecheck'] } }));
    const state = box.run();
    const planned = state.review!.fix!.checks.planned!;
    assert.equal(planned.manager, null, 'a version 2 plan names no package manager');
    assert.deepEqual(planned.checks.map((check) => [check.kind, check.command, check.origin, check.source?.basis ?? null]), [['build', 'npm run build', 'survey', 'hint'], ['typecheck', null, 'flag', null], ['lint', 'npm run lint', 'survey', 'stated'], ['test', 'npm run test', 'survey', 'stated']]);
    assert.deepEqual(box.checkRuns(), ['build', 'lint', 'test', 'build', 'lint', 'test'], 'npm ran each script, and the dropped kind never ran');
    // The surveyor was told the kinds to choose, the flag that settled typecheck, the shell a check runs in, and the manifest rules' hints as guesses.
    const prompt = box.promptOf(state, 'surveyor survey:survey');
    assert.match(prompt, /^Kinds to choose: build, lint, test$/m);
    assert.match(prompt, /^- typecheck: dropped by --no-check$/m);
    assert.match(prompt, process.platform === 'win32' ? /as `cmd\.exe \/d \/s \/c "<command>"`[\s\S]*`where\.exe <tool>`/ : /as `\/bin\/sh -c "<command>"`[\s\S]*`command -v <tool>`/);
    assert.match(prompt, /^- build: `npm run build` \(the package\.json script `build` through npm, which package-lock\.json names\)$/m);
    assert.doesNotMatch(prompt, /^- typecheck: (none|`)/m, 'no hint for a kind a flag settled');
    assert.ok(box.logs.includes(`run ${state.id}: check build: npm run build (survey, hint in package.json)`), box.logs.join('\n'));
    assert.ok(box.logs.includes(`run ${state.id}: check typecheck: not available (flag: dropped by --no-check)`), box.logs.join('\n'));
  });

  it('hints, and no longer refuses, a repository whose lock files name two package managers, and plans no check the surveyor did not choose (R11 of the repository survey)', async () => {
    write(box.repo, 'yarn.lock', '# yarn\n');
    git(box.repo, 'add', 'yarn.lock');
    git(box.repo, 'commit', '-q', '--amend', '--no-edit');
    box.script(reviewScript);
    report(await box.review('claude', { fix: { commands: {}, dropped: [] } }));
    const state = box.run();
    assert.match(box.promptOf(state, 'surveyor survey:survey'), /^- test: none \(the package\.json script `test`, but the lock files name more than one package manager \(yarn\.lock, package-lock\.json\)/m);
    // The fake surveyor chose no command, so no hinted command ran: a hint is a guess, never a plan.
    assert.deepEqual(state.review!.fix!.checks.planned!.checks.map((check) => [check.kind, check.command, check.origin]), [['build', null, 'none'], ['typecheck', null, 'none'], ['lint', null, 'none'], ['test', null, 'none']]);
    assert.deepEqual(box.checkRuns(), []);
  });

  it('writes a series that leaves the user\'s own uncommitted change out, so it applies at HEAD in worktree mode', async () => {
    write(box.repo, 'src/c.ts', 'export const c = 1;\n');
    box.script({ ...reviewScript, 'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA } }], output: fixerAnswer([{ files: ['src/a.ts'] }]) } });
    report(await box.fix('claude'));
    const state = box.run();
    assert.equal(state.scope!.mode, 'worktree');
    const clone = join(box.directory, 'clone');
    git(box.directory, 'clone', '-q', '-c', 'core.autocrlf=false', box.repo, clone);
    git(clone, 'config', 'user.name', 'Test');
    git(clone, 'config', 'user.email', 'test@example.invalid');
    const patches = state.review!.report!.patches.map((reference, index) => {
      const file = join(box.directory, `${String(index + 1)}.patch`);
      writeFileSync(file, box.checkpoint.evidence.read(reference));
      return file;
    });
    git(clone, 'am', '--keep-cr', '-q', ...patches);
    assert.equal(readFileSync(join(clone, 'src', 'a.ts'), 'utf8'), fixedA);
    assert.equal(existsSync(join(clone, 'src', 'c.ts')), false, 'the user\'s uncommitted change is in no patch');
  });

  it('owns a file outside the change as HEAD holds it: a fixer that leaves it alone passes, and one that edits it is a modification', async () => {
    // RIPPLE finds a caller of parse() in src/caller.ts, a file the change does not touch.
    write(box.repo, 'src/caller.ts', 'import { parse } from \'./a.ts\';\nexport const n = parse(null);\n');
    git(box.repo, 'add', 'src/caller.ts');
    git(box.repo, 'commit', '-q', '-m', 'add a caller');
    write(box.repo, 'src/a.ts', fixedA);
    git(box.repo, 'commit', '-q', '-am', 'the change under review');
    box.script({
      triage: { output: { candidates: [found('src/caller.ts', 2, 'passes null to parse')], leads: noLeads } },
      'fixer:fixes:c1-1': [{ output: fixerAnswer([{ status: 'deferred', files: [] }]) }],
    });
    report(await box.fix('claude'));
    const untouched = box.run();
    assert.deepEqual(untouched.review!.fix!.plan!.clusters, [{ id: 'c1', findingIds: ['SCAN-1'], files: ['src/caller.ts'] }]);
    assert.deepEqual(box.events(untouched.id).filter(([kind]) => kind === 'attempt.failed'), [], 'an untouched owned file outside the change is no unreported edit');
    assert.equal(untouched.review!.fix!.revisions.length, 0);
    // Edited, the same file is a modification of what HEAD held, and its patch applies there.
    box.checkpoint.append(untouched.id, untouched.lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'next case' } }]);
    box.script({
      triage: { output: { candidates: [found('src/caller.ts', 2, 'passes null to parse')], leads: noLeads } },
      'fixer:fixes:c1-1': { edits: [{ writes: { 'src/caller.ts': 'import { parse } from \'./a.ts\';\nexport const n = parse(\'\');\n' } }], output: fixerAnswer([{ files: ['src/caller.ts'] }]) },
    });
    report(await box.fix('claude'));
    const edited = box.checkpoint.foldRuns().at(-1)!;
    assert.deepEqual(edited.review!.fix!.revisions.map((revision) => revision.files.map((file) => `${file.path} ${file.status}`)), [['src/caller.ts modified']]);
    const patch = box.checkpoint.evidence.read(edited.review!.report!.patches[0]!).toString('utf8');
    assert.doesNotMatch(patch, /new file mode/);
    assert.match(patch, /^-export const n = parse\(null\);$/m);
  });

  it('keeps what a run pinned when it resumes: the fix pass, its checks and its batch size, whatever the flags and the policy say now', async () => {
    setPolicyBatchSize(2);
    box.script({ triage: { exit: 2 } });
    assert.equal((await box.fix('claude')).kind, 'blocked');
    assert.deepEqual(box.run().review!.configuration!.fixes, { batchSize: 2 }, 'the run pinned the policy\'s batch size');
    setPolicyBatchSize(4);
    box.script(reviewScript);
    report(await box.review('claude', { fix: { commands: { test: 'echo other' }, dropped: [] } }));
    assert.ok(box.logs.some((line) => /keeps the checks it pinned; --check and --no-check are ignored$/.test(line)), box.logs.join('\n'));
    assert.ok(box.run().review!.fix!.checks.planned!.checks.every((check) => check.origin === 'flag' && check.command !== 'echo other'));
    assert.deepEqual(box.run().review!.configuration!.fixes, { batchSize: 2 }, 'the resumed run kept the size it started with');
  });

  it('logs --fix and its check flags as ignored on a run pinned without the fix pass, and keeps it read-only', async () => {
    box.script({ triage: { exit: 2 } });
    assert.equal((await box.review('claude')).kind, 'blocked');
    box.script(reviewScript);
    report(await box.fix('claude'));
    assert.equal(box.run().review!.fix, null, 'the read-only run stays read-only');
    assert.ok(box.logs.some((line) => /is pinned without the fix pass; --fix, --check and --no-check are ignored$/.test(line)), box.logs.join('\n'));
  });

  it('logs the absence of --fix on a run pinned with it, and continues the fix pass', async () => {
    box.script({ triage: { exit: 2 } });
    assert.equal((await box.fix('claude')).kind, 'blocked');
    box.script(reviewScript);
    report(await box.review('claude'));
    assert.notEqual(box.run().review!.fix, null);
    assert.ok(box.logs.some((line) => /is pinned to the fix pass and continues it; the absence of --fix is ignored$/.test(line)), box.logs.join('\n'));
  });
});
