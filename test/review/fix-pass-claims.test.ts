import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { caseInsensitiveFileSystem, readClaims } from '../../src/review/claims.ts';
import { commitRun } from '../../src/review/commit.ts';
import { fixerAnswer } from '../helpers/fake-runtime.ts';
import { fixedA, fixedB, reviewScript } from '../helpers/fix-pass-fixture.ts';
import { until } from '../helpers/launcher.ts';
import { git } from '../helpers/repository.ts';
import { reportText, ReviewSandbox, sandboxConcurrency } from '../helpers/review-sandbox.ts';

describe('claims (commit series integrity)', { timeout: 900_000, concurrency: sandboxConcurrency }, () => {
  const shared = 'test/shared.test.ts';
  const sharedV1 = 'import { parse } from \'../src/a.ts\';\nif (parse(null) !== 0) throw new Error(\'null\');\n';
  const sharedV2 = `${sharedV1}if (parse('x') !== 1) throw new Error('x');\n`;
  /** Wait until the round's claims directory holds a marker, which the claim command wrote. */
  const claimMade = (box: ReviewSandbox, round: 1 | 2 = 1): Promise<void> => until(() => box.checkpoint.foldRuns().length === 1 && box.markers(round).length > 0, 'a claim marker', 120_000);
  const answeredOnLedger = (box: ReviewSandbox, key: string): Promise<void> => until(() => box.checkpoint.foldRuns().some((run) => run.review?.fix?.answers.fixes[key] !== undefined), `${key}'s answer on the ledger`, 120_000);
  const outcomeOnLedger = (box: ReviewSandbox, key: string): Promise<void> => until(() => box.checkpoint.foldRuns().some((run) => (run.review?.units.fixes[key]?.failures.length ?? 0) > 0 || run.review?.fix?.answers.fixes[key] !== undefined), `${key}'s outcome on the ledger`, 120_000);
  const revised = (state: RunState): [string, string, string[], string[]][] => state.review!.fix!.revisions.filter((revision) => revision.phase === 'fixes').map((revision) => [revision.source.kind, revision.source.kind === 'check' ? '' : revision.source.key, revision.change.findings, revision.files.map((file) => file.path)]);

  it('refuses a sibling the file a running cluster claimed, which then gets a second round owning it, each revision holding only its own fixer\'s edits (R1, R4)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    const c1Claimed = join(box.directory, 'c1-claimed');
    const c1MayAnswer = join(box.directory, 'c1-may-answer');
    box.script({
      ...reviewScript,
      'fixer:fixes:c1-1': { edits: [{ claims: [shared], expectClaim: 'claimed', writes: { 'src/a.ts': fixedA, [shared]: sharedV1 }, snapshot: 0 }], waitFor: c1MayAnswer, output: fixerAnswer([{ files: ['src/a.ts', shared], subject: 'fix(a): Return 0 for a null text' }]) },
      // c2's fix needs the shared test too; its claim comes once c1's is made, and is refused before any edit.
      'fixer:fixes:c2-1': { edits: [{ waitFor: c1Claimed, claims: [shared], expectClaim: 'refused' }], output: fixerAnswer([{ status: 'blocked', files: [], requiredFiles: [shared], note: 'the fix needs the shared test, which c1 claimed' }]) },
      'fixer:fixes:c3-1': { edits: [{ claims: ['docs/c3.md'], expectClaim: 'claimed', writes: { 'src/b.ts': fixedB, [shared]: sharedV2, 'docs/c3.md': 'notes\n' }, snapshot: 0 }], output: fixerAnswer([{ files: ['docs/c3.md', 'src/b.ts', shared], subject: 'fix(b): Import parse' }]) },
    });
    const pending = box.fix('claude');
    await claimMade(box);
    writeFileSync(c1Claimed, '');
    await answeredOnLedger(box, 'c2-1');
    writeFileSync(c1MayAnswer, '');
    const text = reportText(await pending);
    const state = box.run();
    const fix = state.review!.fix!;
    assert.deepEqual(fix.answers.fixes['c2-1']!.findings.map((finding) => [finding.status, finding.requiredFiles]), [['blocked', [shared]]]);
    // The report names who held each path: c1 by its claim in the first round, c3 by the plan in the second.
    assert.match(text, /^\| test\/shared\.test\.ts \| created \| c1-1, c3-1 \| c1 \(claimed\), c3 \|$/m);
    assert.match(text, /^\| docs\/c3\.md \| created \| c3-1 \| c3 \(claimed\) \|$/m);
    // c1's claim reached the ledger with c2-1's answer, the first settle after it, under c1's own key; c3's in the second round.
    assert.deepEqual(fix.claims.map((claim) => [claim.path, claim.cluster, claim.key, claim.round, claim.claimedAt === null]), [[shared, 'c1', 'c1-1', 1, false], ['docs/c3.md', 'c3', 'c3-1', 2, false]]);
    const events = box.events(state.id);
    const claimedAt = events.findIndex(([kind, payload]) => kind === 'files.claimed' && payload.key === 'c1-1');
    assert.ok(claimedAt >= 0 && claimedAt < events.findIndex(([kind, payload]) => kind === 'fix.recorded' && payload.key === 'c2-1'), 'appended before the settling unit\'s answer');
    assert.deepEqual(fix.secondRound, {
      blocked: [{ id: 'SCAN-2', requiredFiles: [shared] }],
      clusters: [{ id: 'c3', findingIds: ['SCAN-2'], files: ['src/b.ts', shared] }],
      batches: [{ key: 'c3-1', cluster: 'c3', findingIds: ['SCAN-2'] }],
    });
    assert.deepEqual(revised(state), [
      ['fix', 'c1-1', ['SCAN-1'], ['src/a.ts', shared]],
      ['fix', 'c3-1', ['SCAN-2'], ['docs/c3.md', 'src/b.ts', shared]],
    ]);
    assert.deepEqual(fix.answers.fixes['c3-1']!.violations, [], 'the second round owns the file the first round claimed');
    assert.match(box.promptOf(state, 'fixer fixes:c3-1'), /no other worker edits:\n- src\/b\.ts\n- test\/shared\.test\.ts\n/);
    assert.match(box.promptOf(state, 'fixer fixes:c3-1'), /^ {4}first round: blocked, needing test\/shared\.test\.ts \(which c1 had claimed\): the fix needs the shared test, which c1 claimed$/m);
    assert.match(box.promptOf(state, 'fixer fixes:c2-1'), /^ {4}node '.*cli\.ts' claim --path '<path>' --unit c2-1 --in '.*round-1'$/m);
    // Each round claimed in its own directory.
    assert.equal(box.markers(1).length, 1);
    assert.equal(box.markers(2).length, 1);
    assert.ok(box.logs.includes('worker fixer fixes:c1-1: claimed 1 file: test/shared.test.ts'), box.logs.join('\n'));
    assert.ok(state.review!.checks.every((check) => !check.drifted));
  });

  it('commits the edits of a finding blocked by a claim refused after its first edit under the fixer\'s message, which says the change is partial (R11)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    const c1Claimed = join(box.directory, 'c1-claimed');
    const c1MayAnswer = join(box.directory, 'c1-may-answer');
    const partial = 'fix(b): Import parse, without the shared test c1 holds';
    box.script({
      ...reviewScript,
      // c1 answers only once c2 has, so c1 holds the test when c2 claims it and the settles come in one order.
      'fixer:fixes:c1-1': { edits: [{ claims: [shared], expectClaim: 'claimed', writes: { 'src/a.ts': fixedA, [shared]: sharedV1 }, snapshot: 0 }], waitFor: c1MayAnswer, output: fixerAnswer([{ files: ['src/a.ts', shared], subject: 'fix(a): Return 0 for a null text' }]) },
      // c2 edits its own file, then finds the test it also needs claimed, and reports the finding blocked with the edit it made.
      'fixer:fixes:c2-1': { edits: [{ writes: { 'src/b.ts': fixedB } }, { waitFor: c1Claimed, claims: [shared], expectClaim: 'refused' }], output: fixerAnswer([{ status: 'blocked', files: ['src/b.ts'], requiredFiles: [shared], subject: partial, body: 'Partial: the test of the import waits for test/shared.test.ts, which c1 claimed.' }]) },
      'fixer:fixes:c3-1': { edits: [{ writes: { [shared]: sharedV2 }, snapshot: 0 }], output: fixerAnswer([{ status: 'applied', files: [shared], subject: 'test(b): Cover the import of parse' }]) },
    });
    const pending = box.fix('claude');
    await claimMade(box);
    writeFileSync(c1Claimed, '');
    await answeredOnLedger(box, 'c2-1');
    writeFileSync(c1MayAnswer, '');
    reportText(await pending);
    const state = box.run();
    assert.deepEqual(state.review!.fix!.answers.fixes['c2-1']!.findings.map((finding) => [finding.status, finding.files, finding.message?.subject ?? null]), [['blocked', ['src/b.ts'], partial]]);
    assert.deepEqual(revised(state).map(([, key, findings, paths]) => [key, findings, paths]), [
      ['c2-1', ['SCAN-2'], ['src/b.ts']],
      ['c1-1', ['SCAN-1'], ['src/a.ts', shared]],
      ['c3-1', ['SCAN-2'], [shared]],
    ]);
    // The commit command commits the partial change under the fixer's message, and the second round's completion after it.
    commitRun({ checkpoint: box.checkpoint, worktree: box.repo });
    assert.deepEqual(git(box.repo, 'log', '--format=%s', '-3').split('\n').reverse(), [partial, 'fix(a): Return 0 for a null text', 'test(b): Cover the import of parse']);
  });

  it('records an edit of a file a still-running sibling claimed as a violation, the sibling\'s claim reaching the ledger with that answer (R3, R6)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    const c2Claimed = join(box.directory, 'c2-claimed');
    const c2MayAnswer = join(box.directory, 'c2-may-answer');
    box.script({
      ...reviewScript,
      'fixer:fixes:c2-1': { edits: [{ claims: [shared], expectClaim: 'claimed', writes: { 'src/b.ts': fixedB, [shared]: sharedV1 } }], waitFor: c2MayAnswer, output: fixerAnswer([{ files: ['src/b.ts', shared], subject: 'fix(b): Import parse' }]) },
      // c1 edits the shared test without claiming it, once c2 has.
      'fixer:fixes:c1-1': { edits: [{ waitFor: c2Claimed, writes: { 'src/a.ts': fixedA, [shared]: sharedV2 } }], output: fixerAnswer([{ files: ['src/a.ts', shared], subject: 'fix(a): Return 0 for a null text' }]) },
    });
    const pending = box.fix('claude');
    await claimMade(box);
    writeFileSync(c2Claimed, '');
    await answeredOnLedger(box, 'c1-1');
    writeFileSync(c2MayAnswer, '');
    const text = reportText(await pending);
    const state = box.run();
    const fix = state.review!.fix!;
    assert.deepEqual(fix.answers.fixes['c1-1']!.violations, [shared]);
    assert.match(text, /^- Ownership violation: test\/shared\.test\.ts, claimed by c2, was edited by c1-1, which reported it; the edit is kept and revised \(PD4\)\.$/m);
    const events = box.events(state.id);
    const claimedAt = events.findIndex(([kind, payload]) => kind === 'files.claimed' && payload.key === 'c2-1');
    assert.ok(claimedAt >= 0 && claimedAt < events.findIndex(([kind, payload]) => kind === 'fix.recorded' && payload.key === 'c1-1'), 'the running sibling\'s claim is on the ledger before the answer that violates it');
    assert.deepEqual(fix.claims.map((claim) => [claim.path, claim.key]), [[shared, 'c2-1']], 'no late claim of a file a sibling holds');
    assert.ok(state.review!.checks.every((check) => !check.drifted));
  });

  it('leaves a sibling\'s edit of a file the sibling claimed out of a failed attempt\'s revisions (R5)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    const c1MayDie = join(box.directory, 'c1-may-die');
    const c2MayAnswer = join(box.directory, 'c2-may-answer');
    box.script({
      ...reviewScript,
      'fixer:fixes:c1-1': [
        { edits: [{ writes: { 'src/a.ts': fixedA }, snapshot: 0 }], waitFor: c1MayDie, exit: 3 },
        { output: fixerAnswer([{ status: 'already-applied', files: ['src/a.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
      ],
      'fixer:fixes:c2-1': { edits: [{ claims: [shared], expectClaim: 'claimed', writes: { 'src/b.ts': fixedB, [shared]: sharedV1 } }], waitFor: c2MayAnswer, output: fixerAnswer([{ files: ['src/b.ts', shared], subject: 'fix(b): Import parse' }]) },
    });
    const pending = box.fix('claude');
    await until(() => existsSync(join(box.repo, ...shared.split('/'))), 'c2-1\'s edit of the shared test', 120_000);
    writeFileSync(c1MayDie, '');
    await outcomeOnLedger(box, 'c1-1');
    writeFileSync(c2MayAnswer, '');
    reportText(await pending);
    const state = box.run();
    assert.deepEqual(revised(state), [
      ['attempt', 'c1-1', ['SCAN-1'], ['src/a.ts']],
      ['fix', 'c2-1', ['SCAN-2'], ['src/b.ts', shared]],
    ]);
    const events = box.events(state.id);
    assert.ok(events.findIndex(([kind, payload]) => kind === 'files.claimed' && payload.key === 'c2-1') < events.findIndex(([kind]) => kind === 'attempt.failed'), 'c2\'s claim is recorded with c1\'s failure, before it');
  });

  it('fails an answer that leaves out a claimed file it changed, as one that leaves out an owned file, recording the claim with the failure', async (t) => {
    const box = ReviewSandbox.forTest(t);
    box.script({
      ...reviewScript,
      'fixer:fixes:c1-1': [
        { edits: [{ claims: ['docs/a.md'], expectClaim: 'claimed', writes: { 'src/a.ts': fixedA, 'docs/a.md': 'a\n' } }], output: fixerAnswer([{ files: ['src/a.ts'] }]) },
        { edits: [{ claims: ['docs/a.md'], expectClaim: 'claimed' }], output: fixerAnswer([{ status: 'already-applied', files: ['docs/a.md', 'src/a.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
      ],
    });
    reportText(await box.fix('claude'));
    const state = box.run();
    const failed = box.events(state.id).filter(([kind, payload]) => kind === 'attempt.failed' && payload.key === 'c1-1');
    assert.equal(failed.length, 1);
    assert.match(String(failed[0]![1].reason), /^structural check: The answer names no finding for the owned or claimed file docs\/a\.md, whose bytes changed/);
    assert.deepEqual(state.review!.fix!.claims.map((claim) => [claim.path, claim.key]), [['docs/a.md', 'c1-1']], 'claimed once, with the failure, and the retry held it');
  });

  it('stops the run when its claims directory is removed while two fixers run, keeps their edits, and retries them on a directory seeded again (R12)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    const c1MayAnswer = join(box.directory, 'c1-may-answer');
    const c2MayAnswer = join(box.directory, 'c2-may-answer');
    box.script({
      ...reviewScript,
      'fixer:fixes:c1-1': [
        { edits: [{ claims: ['docs/c1.md'], expectClaim: 'claimed', writes: { 'src/a.ts': fixedA, 'docs/c1.md': 'c1\n' }, snapshot: 0 }], waitFor: c1MayAnswer, output: fixerAnswer([{ files: ['docs/c1.md', 'src/a.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
        { edits: [{ claims: ['docs/c1.md'], expectClaim: 'claimed' }], output: fixerAnswer([{ status: 'already-applied', files: ['docs/c1.md', 'src/a.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
      ],
      'fixer:fixes:c2-1': [
        { edits: [{ writes: { 'src/b.ts': fixedB }, snapshot: 0 }], waitFor: c2MayAnswer, output: fixerAnswer([{ files: ['src/b.ts'], subject: 'fix(b): Import parse' }]) },
        { output: fixerAnswer([{ status: 'already-applied', files: ['src/b.ts'], subject: 'fix(b): Import parse' }]) },
      ],
    });
    const pending = box.fix('claude');
    await until(() => box.checkpoint.foldRuns().length === 1 && box.markers().length === 1 && existsSync(join(box.repo, 'src', 'b.ts')) && readFileSync(join(box.repo, 'src', 'b.ts'), 'utf8') === fixedB && box.checkpoint.foldRuns()[0]!.review?.fix?.plan !== null, 'both fixers\' edits in the tree', 120_000);
    const directory = box.claimsDirectory();
    rmSync(directory, { recursive: true });
    // c1 settles first: its claim of docs/c1.md was lost with the directory, so a sibling settling first would read c1's edit of it as its own, which R12 accepts; this order keeps each attribution to assert.
    writeFileSync(c1MayAnswer, '');
    await until(() => (box.checkpoint.foldRuns()[0]?.review?.units.fixes['c1-1']?.failures.length ?? 0) > 0, 'c1-1\'s failure on the ledger', 120_000);
    writeFileSync(c2MayAnswer, '');
    const blocked = await pending;
    assert.ok(blocked.kind === 'blocked' && blocked.blocker.code === 'claims-lost' && blocked.blocker.phase === 'fixes', JSON.stringify(blocked));
    assert.equal(blocked.kind === 'blocked' ? blocked.blocker.detail : '', `the claims directory ${directory} was removed while the run was editing`);
    assert.match(blocked.kind === 'blocked' ? blocked.blocker.action : '', /^run the command again, which seeds the claims directory from the ledger/);
    assert.ok(box.logs.includes(`phase fixes: the claims directory ${directory} is gone; no more launches, the running units will be recorded as failed attempts`), box.logs.join('\n'));
    const state = box.run();
    const events = box.events(state.id);
    // Whatever they answered, both were recorded as failed for their environment, with their edits, and neither as answered.
    assert.deepEqual(events.filter(([kind]) => kind === 'attempt.failed').map(([, payload]) => [payload.key, payload.fault, payload.reason]).sort(), [['c1-1', 'environment', 'the claims directory was removed while the unit ran'], ['c2-1', 'environment', 'the claims directory was removed while the unit ran']]);
    assert.equal(events.filter(([kind]) => kind === 'fix.recorded').length, 0);
    assert.deepEqual(revised(state).map(([kind, key, findings]) => [kind, key, findings]).sort(), [['attempt', 'c1-1', ['SCAN-1']], ['attempt', 'c2-1', ['SCAN-2']]]);
    assert.equal(state.review!.phases.fixes.status, 'blocked');
    // The next run seeds the directory, gives both batches fresh attempts that are told what their predecessors left, and completes.
    reportText(await box.fix('claude'));
    const after = box.run();
    assert.ok(existsSync(directory), 'prepared again');
    for (const key of ['c1-1', 'c2-1']) {
      const prompts = Object.values(after.workers).filter((worker) => worker.launch.label === `fixer fixes:${key}`).map((worker) => box.checkpoint.evidence.read(worker.launch.prompt).toString('utf8'));
      assert.equal(prompts.length, 2, key);
      assert.match(prompts[1]!, /The tree may already hold part of this work/, key);
      assert.match(prompts[1]!, /An earlier attempt left edits for SCAN-/, key);
    }
    assert.deepEqual(after.review!.fix!.claims.map((claim) => [claim.path, claim.key]), [['docs/c1.md', 'c1-1']], 'the retry\'s claim, made on the new directory');
    assert.equal(after.review!.phases.fixes.status, 'completed');
  });

  it('records a fixer as failed when its claims directory is replaced by a file, the loss and the settle read from one reading (R12)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    const c1MayAnswer = join(box.directory, 'c1-may-answer');
    const c2MayAnswer = join(box.directory, 'c2-may-answer');
    box.script({
      ...reviewScript,
      'fixer:fixes:c1-1': { edits: [{ claims: ['docs/c1.md'], expectClaim: 'claimed', writes: { 'src/a.ts': fixedA, 'docs/c1.md': 'c1\n' }, snapshot: 0 }], waitFor: c1MayAnswer, output: fixerAnswer([{ files: ['docs/c1.md', 'src/a.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
      'fixer:fixes:c2-1': { edits: [{ writes: { 'src/b.ts': fixedB }, snapshot: 0 }], waitFor: c2MayAnswer, output: fixerAnswer([{ files: ['src/b.ts'], subject: 'fix(b): Import parse' }]) },
    });
    const pending = box.fix('claude');
    await until(() => box.checkpoint.foldRuns().length === 1 && box.markers().length === 1 && existsSync(join(box.repo, 'src', 'b.ts')) && readFileSync(join(box.repo, 'src', 'b.ts'), 'utf8') === fixedB && box.checkpoint.foldRuns()[0]!.review?.fix?.plan !== null, 'both fixers\' edits in the tree', 120_000);
    const directory = box.claimsDirectory();
    // The path still exists, as a file, so only a reading of the directory itself sees it gone.
    rmSync(directory, { recursive: true });
    writeFileSync(directory, '');
    writeFileSync(c1MayAnswer, '');
    await until(() => (box.checkpoint.foldRuns()[0]?.review?.units.fixes['c1-1']?.failures.length ?? 0) > 0 || box.checkpoint.foldRuns()[0]?.review?.fix?.answers.fixes['c1-1'] !== undefined, 'c1-1\'s outcome on the ledger', 120_000);
    writeFileSync(c2MayAnswer, '');
    const blocked = await pending;
    assert.ok(blocked.kind === 'blocked' && blocked.blocker.code === 'claims-lost', JSON.stringify(blocked));
    const events = box.events(box.run().id);
    assert.deepEqual(events.filter(([kind]) => kind === 'attempt.failed').map(([, payload]) => [payload.key, payload.fault]).sort(), [['c1-1', 'environment'], ['c2-1', 'environment']]);
    assert.equal(events.filter(([kind]) => kind === 'fix.recorded').length, 0, 'no answer recorded as completed while its markers were dropped');
  });

  it('stops the run when its claims directory is emptied in place while two fixers run, as the claim command judges it lost (R12)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    const c1MayAnswer = join(box.directory, 'c1-may-answer');
    const c2MayAnswer = join(box.directory, 'c2-may-answer');
    box.script({
      ...reviewScript,
      'fixer:fixes:c1-1': { edits: [{ claims: ['docs/c1.md'], expectClaim: 'claimed', writes: { 'src/a.ts': fixedA, 'docs/c1.md': 'c1\n' }, snapshot: 0 }], waitFor: c1MayAnswer, output: fixerAnswer([{ files: ['docs/c1.md', 'src/a.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
      'fixer:fixes:c2-1': { edits: [{ writes: { 'src/b.ts': fixedB }, snapshot: 0 }], waitFor: c2MayAnswer, output: fixerAnswer([{ files: ['src/b.ts'], subject: 'fix(b): Import parse' }]) },
    });
    const pending = box.fix('claude');
    await until(() => box.checkpoint.foldRuns().length === 1 && box.markers().length === 1 && existsSync(join(box.repo, 'src', 'b.ts')) && readFileSync(join(box.repo, 'src', 'b.ts'), 'utf8') === fixedB && box.checkpoint.foldRuns()[0]!.review?.fix?.plan !== null, 'both fixers\' edits in the tree', 120_000);
    const directory = box.claimsDirectory();
    // A temporary file cleaner takes the files and leaves the directory: held.json and c1's marker are gone.
    for (const name of readdirSync(directory)) rmSync(join(directory, name));
    writeFileSync(c1MayAnswer, '');
    await until(() => (box.checkpoint.foldRuns()[0]?.review?.units.fixes['c1-1']?.failures.length ?? 0) > 0 || box.checkpoint.foldRuns()[0]?.review?.fix?.answers.fixes['c1-1'] !== undefined, 'c1-1\'s outcome on the ledger', 120_000);
    writeFileSync(c2MayAnswer, '');
    const blocked = await pending;
    assert.ok(blocked.kind === 'blocked' && blocked.blocker.code === 'claims-lost', JSON.stringify(blocked));
    const events = box.events(box.run().id);
    assert.deepEqual(events.filter(([kind]) => kind === 'attempt.failed').map(([, payload]) => [payload.key, payload.fault]).sort(), [['c1-1', 'environment'], ['c2-1', 'environment']]);
    assert.equal(events.filter(([kind]) => kind === 'fix.recorded').length, 0, 'no answer recorded as completed while its markers were dropped');
    assert.deepEqual(readdirSync(directory), [], 'held.json is not written again behind the loss');
  });

  it('lets a later cluster claim a file a settled cluster claimed, with no second round, at concurrency 1 as at any (PD3)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    box.script({
      ...reviewScript,
      'fixer:fixes:c1-1': { edits: [{ claims: [shared], expectClaim: 'claimed', writes: { 'src/a.ts': fixedA, [shared]: sharedV1 }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts', shared], subject: 'fix(a): Return 0 for a null text' }]) },
      'fixer:fixes:c2-1': { edits: [{ claims: [shared], expectClaim: 'claimed', writes: { 'src/b.ts': fixedB, [shared]: sharedV2 }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/b.ts', shared], subject: 'fix(b): Import parse' }]) },
    });
    reportText(await box.fix('claude', { flags: { concurrency: 1 } }));
    const state = box.run();
    const fix = state.review!.fix!;
    assert.deepEqual(fix.claims.map((claim) => [claim.path, claim.cluster]), [[shared, 'c1'], [shared, 'c2']]);
    assert.deepEqual(fix.secondRound, { blocked: [], clusters: [], batches: [] });
    assert.deepEqual(revised(state), [
      ['fix', 'c1-1', ['SCAN-1'], ['src/a.ts', shared]],
      ['fix', 'c2-1', ['SCAN-2'], ['src/b.ts', shared]],
    ]);
    // The second claim made the next generation of the path's marker, the first holder's kept.
    assert.equal(box.markers().length, 2);
    assert.ok(state.review!.checks.every((check) => !check.drifted));
  });

  it('prepares the claims directory again at a settle, with no launch after it: the late claim it recorded is a marker, and its settled cluster holds nothing (R1, TD2)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    const c1Settled = join(box.directory, 'c1-settled');
    box.script({
      ...reviewScript,
      // c1 claims the shared test, and writes docs/x.md without claiming it, which its answer claims late.
      'fixer:fixes:c1-1': { edits: [{ claims: [shared], expectClaim: 'claimed', writes: { 'src/a.ts': fixedA, [shared]: sharedV1, 'docs/x.md': 'x\n' }, snapshot: 0 }], output: fixerAnswer([{ files: ['docs/x.md', 'src/a.ts', shared], subject: 'fix(a): Return 0 for a null text' }]) },
      // c2, launched with c1 and still running, claims the shared test once c1 has settled; no batch is left to launch in between.
      'fixer:fixes:c2-1': { edits: [{ waitFor: c1Settled, claims: [shared], expectClaim: 'claimed', writes: { 'src/b.ts': fixedB, [shared]: sharedV2 }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/b.ts', shared], subject: 'fix(b): Import parse' }]) },
    });
    const pending = box.fix('claude');
    await answeredOnLedger(box, 'c1-1');
    const live = readClaims(box.claimsDirectory(), caseInsensitiveFileSystem(box.repo));
    assert.deepEqual(live.map((claim) => (claim.whole ? [claim.path, claim.cluster, claim.claimedAt === null] : null)).sort(), [['docs/x.md', 'c1', true], [shared, 'c1', false]], 'the late claim is seeded at the settle that recorded it');
    assert.deepEqual(JSON.parse(readFileSync(join(box.claimsDirectory(), 'held.json'), 'utf8')).settled, ['c1'], 'the settled cluster is listed at once');
    writeFileSync(c1Settled, '');
    reportText(await pending);
    const state = box.run();
    const fix = state.review!.fix!;
    assert.deepEqual(fix.claims.map((claim) => [claim.path, claim.cluster, claim.claimedAt === null]), [[shared, 'c1', false], ['docs/x.md', 'c1', true], [shared, 'c2', false]]);
    assert.deepEqual(fix.lostClaims, []);
    assert.deepEqual(fix.secondRound, { blocked: [], clusters: [], batches: [] });
    assert.deepEqual(fix.answers.fixes['c2-1']!.violations, []);
    const events = box.events(state.id);
    assert.equal(events.filter(([kind, payload]) => kind === 'worker.launched' && String(payload.label).startsWith('fixer ')).length, 2, 'no launch prepared the directory after c1 settled');
  });
});
