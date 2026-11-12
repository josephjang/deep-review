import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Checkpoint, evidenceDirectoryName } from '../../src/checkpoint/checkpoint.ts';
import { InvalidHistoryError } from '../../src/checkpoint/errors.ts';
import { Ledger, ledgerFileName, type EventRow } from '../../src/checkpoint/ledger.ts';
import type { ScopeFile } from '../../src/checkpoint/events.ts';
import { newLinesOf } from '../../src/github/pull-request.ts';
import { answerFileName, decisionsFileName, factsFileName, newPathOfPatchPart, patchFiles, promptFileName, readRecordedRun, replayDecider, reviewFileName, type DeciderReplayOptions, type DeciderReplayOutcome } from '../../src/replay/decider.ts';
import { ReplayRefusedError } from '../../src/replay/errors.ts';
import { replayCheckpointDirectoryName } from '../../src/replay/run.ts';
import { diffNameStatus, diffPatch } from '../../src/scope/git.ts';
import { deciderAnswer, type Script } from '../helpers/fake-runtime.ts';
import { reviewScript } from '../helpers/fix-pass-fixture.ts';
import { baseEnvironment, fakeClaude } from '../helpers/launcher.ts';
import { commitAll, git, remove, repositoryWith, temporaryDirectory, write } from '../helpers/repository.ts';
import { pullRequestGh, pullRequestSource } from '../helpers/replay-pull-request.ts';
import { reportText, ReviewSandbox } from '../helpers/review-sandbox.ts';

/** The choice the verifier of SWEEP-1 leaves to the author. */
const sweepChoice = 'Either inline other() into its one caller, or keep it as a function of its own.';

/**
 * The recorded review: reviewScript's, ranked SCAN-1, SCAN-2 and SWEEP-1,
 * whose verifier names a choice for the author, decided by the recorded
 * decider as two fixes and a finding left as outside the change.
 */
const recordedScript: Script = {
  ...reviewScript,
  'verifier:sweep-verification:g1': { output: { verdicts: [{ index: 0, verdict: 'PLAUSIBLE', evidence: 'other() has one caller', basis: 'traced', runs: [], unconfirmed: { kind: 'choice', text: 'whether other() stays a function is a choice of shape' }, authorChoice: sweepChoice }] } },
};

describe('patchFiles', () => {
  it('finds the part of the patch of each file by its path, quoted by git or holding " b/", and places a finding on its line', (t) => {
    const repo = repositoryWith(temporaryDirectory(t, 'deep-review-patch-files-'), { 'plain.ts': 'one\n', 'old.ts': 'kept\nkept\nkept\nkept\n' });
    const base = git(repo, 'rev-parse', 'HEAD');
    write(repo, 'plain.ts', 'one\ntwo\n');
    write(repo, 'café.ts', 'x\n');
    write(repo, 'a b/a b/c.ts', 'y\n');
    remove(repo, 'old.ts');
    write(repo, 'new.ts', 'kept\nkept\nkept\nkept\nmore\n');
    const head = commitAll(repo, 'change');
    const statuses: Record<string, ScopeFile['status']> = { A: 'added', M: 'modified', D: 'deleted' };
    const files = diffNameStatus(repo, base, head, []).map(({ code, path }) => ({ path, status: statuses[code]! }));
    const patch = diffPatch(repo, base, head, []).toString('utf8');
    assert.match(patch, /^diff --git "a\/caf\\303\\251\.ts" "b\/caf\\303\\251\.ts"$/m, 'git quotes the path of café.ts');
    assert.match(patch, /^rename to new\.ts$/m, 'git writes the move of old.ts as a rename');

    const listed = new Map(patchFiles(files, patch).map((file) => [file.path, file.patch]));

    assert.deepEqual([...listed.keys()].sort(), ['a b/a b/c.ts', 'café.ts', 'new.ts', 'old.ts', 'plain.ts']);
    assert.equal(newLinesOf(listed.get('café.ts')!)?.get(1), 'added', 'a finding on café.ts:1 is on the diff');
    assert.ok(listed.get('café.ts')!.includes('+x\n'));
    assert.ok(listed.get('a b/a b/c.ts')!.includes('+y\n'), 'the part of the path holding " b/" is its own');
    assert.equal(newLinesOf(listed.get('plain.ts')!)?.get(2), 'added');
    assert.equal(newLinesOf(listed.get('new.ts')!)?.get(5), 'added', 'a renamed file is read from its rename line');
    assert.equal(listed.get('old.ts'), null, 'the old side of a rename has no part of its own');
  });

  it('reads the new path of a part from the header as git writes it', () => {
    assert.equal(newPathOfPatchPart('diff --git a/x b/x\nindex 1..2\n'), 'x');
    assert.equal(newPathOfPatchPart('diff --git a/x b/y b/x b/y\n'), 'x b/y');
    assert.equal(newPathOfPatchPart('diff --git "a/tab\\there" "b/tab\\there"\n'), 'tab\there');
    assert.equal(newPathOfPatchPart('diff --git "a/q\\"\\\\" "b/q\\"\\\\"\n'), 'q"\\');
    assert.equal(newPathOfPatchPart('diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\n'), 'café.ts');
    assert.equal(newPathOfPatchPart('diff --git a/old "b/caf\\303\\251.ts"\nsimilarity index 90%\nrename from old\nrename to "caf\\303\\251.ts"\n'), 'café.ts');
    assert.equal(newPathOfPatchPart('diff --git a/x b/y\n--- a/x\n+++ b/y\n'), null, 'an unquoted header of two paths names no path plainly');
    assert.equal(newPathOfPatchPart('diff --git "a/x" "b/\\q"\n'), null, 'an escape git never writes is no path');
  });
});

describe('replayDecider', { timeout: 600_000 }, () => {
  let box: ReviewSandbox;
  let runId: string;
  let directories = 0;

  before(async () => {
    box = new ReviewSandbox();
    box.script(recordedScript);
    reportText(await box.review('claude', { scope: pullRequestSource(box, pullRequestGh(box)) }));
    runId = box.run().id;
  });

  after(() => {
    box.close();
  });

  /** A fresh directory under the sandbox, outside its repository. */
  const newDirectory = (name: string): string => join(box.directory, `${name}-${String((directories += 1))}`);

  /** The recorded run's ledger rows, in order. */
  const recordedRows = (): EventRow[] => box.checkpoint.ledger.events(runId);

  /**
   * A checkpoint holding the recorded run as `rows` gives it, written row by
   * row as a ledger of another engine would hold it, beside a copy of the
   * recorded blobs.
   */
  function checkpointOf(rows: readonly EventRow[]): string {
    const root = newDirectory('checkpoint');
    const ledger = Ledger.open(root);
    try {
      ledger.write((tx) => {
        tx.createRun({ id: runId, createdAt: rows[0]!.recordedAt });
        for (const { runId: id, kind, version, payload, recordedAt, engine } of rows) tx.insertEvent({ runId: id, kind, version, payload, recordedAt, engine });
      });
    } finally {
      ledger.close();
    }
    cpSync(join(box.checkpoint.root, evidenceDirectoryName), join(root, evidenceDirectoryName), { recursive: true });
    return root;
  }

  /** Replay the recorded run's decider through the fake Claude, with the options given over the usual ones. */
  const replay = (change: Partial<DeciderReplayOptions> & Pick<DeciderReplayOptions, 'output'>): Promise<DeciderReplayOutcome> =>
    replayDecider({
      checkpoint: box.checkpoint.root,
      run: runId,
      tree: box.repo,
      runtime: 'claude',
      executable: process.execPath,
      executableArgs: [fakeClaude],
      rolesRoot: box.rolesRoot,
      engine: '0.0.0-test',
      log: () => {},
      environment: { ...baseEnvironment, FAKE_SCRIPT: box.scriptFile },
      scratchRoot: box.scratchRoot,
      ...change,
    });

  const read = (output: string, name: string): string => readFileSync(join(output, name), 'utf8');

  it('reads the run up to its decision, never the decisions this engine refuses, and prints the task without launching', async () => {
    // The decisions as the first gate's ledgers hold them, in a shape the fold of this engine refuses.
    const rows = recordedRows().map((row) => (row.kind === 'decisions.recorded' ? { ...row, payload: JSON.stringify({ ...JSON.parse(row.payload), decisions: [{ id: 'SCAN-1', decision: 'fix', settled: null }] }) } : row));
    const root = checkpointOf(rows);
    const ledgerBefore = readFileSync(join(root, ledgerFileName));
    const output = newDirectory('print');

    const outcome = await replay({ checkpoint: root, run: runId.slice(0, 8), output, printTask: true });

    assert.deepEqual(outcome, { runId, attempts: [], decisions: null, review: null });
    const prompt = read(output, promptFileName(1));
    assert.match(prompt, /^Role: decider\nUnit: decision\nPhase: decision$/m);
    assert.match(prompt, /numbered \[0\] to \[2\]/);
    assert.ok(prompt.includes(`choice left to the author by SWEEP-1's verifier: ${sweepChoice}`), prompt);
    assert.ok(!prompt.includes('### What failed in the earlier answer'));
    assert.ok(!existsSync(join(output, replayCheckpointDirectoryName)), 'nothing was launched');
    assert.deepEqual(readFileSync(join(root, ledgerFileName)), ledgerBefore, 'the recorded ledger is only read');
    const copy = Checkpoint.open(root, { engine: '0.0.0-test' });
    try {
      assert.throws(() => copy.fold(runId), InvalidHistoryError, 'this engine refuses the run folded whole');
    } finally {
      copy.close();
    }
  });

  it('launches a second decider told what the check refused the first for, and keeps both', async () => {
    box.script({
      decider: [
        // A fix of SWEEP-1 that settles no choice, though its verifier named one: the check refuses it.
        { output: deciderAnswer([{}, {}, { decision: 'fix' }]) },
        { output: deciderAnswer([{}, {}, { decision: 'leave', reason: 'settled', settledFor: ['SWEEP-1'] }]) },
      ],
    });
    const output = newDirectory('refused');

    const outcome = await replay({ output });

    assert.deepEqual(outcome.attempts.map((attempt) => attempt.outcome), ['refused', 'accepted']);
    const refusal = outcome.attempts[0]!.reason!;
    assert.match(refusal, /\[2\]/, 'the refusal names the decision it concerns');
    assert.ok(!read(output, promptFileName(1)).includes('### What failed in the earlier answer'));
    const second = read(output, promptFileName(2));
    assert.ok(second.includes('### What failed in the earlier answer'), second);
    assert.ok(second.includes(`- ${refusal}`), `the second task names what the refusal said: ${refusal}`);
    assert.equal((JSON.parse(read(output, answerFileName(1))) as { decisions: { decision: string }[] }).decisions[2]!.decision, 'fix');

    assert.deepEqual(JSON.parse(read(output, decisionsFileName)), outcome.decisions);
    const sweep = outcome.decisions!.find((decision) => decision.id === 'SWEEP-1')!;
    assert.equal(sweep.decision, 'leave');
    assert.deepEqual(sweep.settled.map((settled) => [settled.for, settled.by]), [[['SWEEP-1'], 'shape']]);
    const facts = JSON.parse(read(output, factsFileName)) as Record<string, unknown>;
    assert.equal(facts.accepted, true);
    assert.deepEqual((facts.attempts as { outcome: string; reason: string | null; costUsd: number | null }[]).map((attempt) => [attempt.outcome, attempt.reason]), [['refused', refusal], ['accepted', null]]);
    assert.deepEqual(facts.choices, [{
      finding: 3,
      id: 'SWEEP-1',
      decision: 'leave',
      leave: 'settled',
      departure: false,
      verifiers: [{ candidate: 'SWEEP-1', choice: sweepChoice }],
      settled: sweep.settled,
      unanswered: [],
    }]);
  });

  it('renders the review as publish --dry-run prints it, from the accepted decisions and no writer', async () => {
    box.script({ decider: { output: deciderAnswer([{ decision: 'ask', edits: false }, {}, { decision: 'leave', reason: 'outside-change-not-regression' }]) } });
    const output = newDirectory('rendered');

    const outcome = await replay({ output });

    assert.deepEqual(outcome.attempts.map((attempt) => attempt.outcome), ['accepted']);
    assert.equal(outcome.review, join(output, reviewFileName), 'the outcome names the review it wrote');
    const review = read(output, reviewFileName);
    assert.ok(review.startsWith(`Dry run: run ${runId} would post one review to https://github.com/acme/widgets/pull/42`), review);
    const body = review.slice(review.indexOf('--- The body of the review'), review.indexOf('--- The end of the body ---'));
    assert.match(body, /### What needs a person\n\n- \*\*\[Question on finding 1\]\(.*\)\.\*\* Fake question for \[0\]\?/, 'what needs a person asks the question');
    assert.ok(body.includes(`Its verifier left this choice to the author: ${sweepChoice} deep-review did not settle it.`), 'the verifier\'s choice of the finding left as is is shown');
    assert.ok(body.includes('deep-review recorded no explanation by its writer for this run'), 'the review is in deep-review\'s own words');
    assert.match(review, /^--- The comment of finding 2 \(SCAN-2\) on src\/b\.ts:1, /m);
    const facts = JSON.parse(read(output, factsFileName)) as { needsAPerson: unknown; fixes: unknown; choices: { id: string; decision: string; settled: unknown[]; unanswered: unknown[] }[] };
    assert.deepEqual(facts.needsAPerson, { questions: [{ finding: 1, id: 'SCAN-1', question: 'fake question for [0]?' }], departures: [] });
    assert.deepEqual(facts.fixes, [{ finding: 2, id: 'SCAN-2', approach: 'fake approach for [1]', departure: false }]);
    assert.deepEqual(facts.choices.map((choice) => [choice.id, choice.decision, choice.settled, choice.unanswered]), [['SWEEP-1', 'leave', [], [{ candidate: 'SWEEP-1', choice: sweepChoice }]]]);
  });

  it('writes and names no review for a run that reviewed no pull request', async () => {
    const local = new ReviewSandbox();
    try {
      local.script(reviewScript);
      reportText(await local.review('claude'));
      const localRun = local.run().id;
      local.script({ decider: { output: deciderAnswer([{}, {}, {}]) } });
      const lines: string[] = [];
      const output = newDirectory('no-pull-request');

      const outcome = await replay({
        checkpoint: local.checkpoint.root,
        run: localRun,
        tree: local.repo,
        rolesRoot: local.rolesRoot,
        environment: { ...baseEnvironment, FAKE_SCRIPT: local.scriptFile },
        scratchRoot: local.scratchRoot,
        output,
        log: (line) => lines.push(line),
      });

      assert.deepEqual(outcome.attempts.map((attempt) => attempt.outcome), ['accepted']);
      assert.notEqual(outcome.decisions, null);
      assert.ok(lines.includes(`run ${localRun} reviewed no pull request, so there is no review to render`), lines.join('\n'));
      assert.equal(outcome.review, null, 'the outcome names no review');
      assert.ok(!existsSync(join(output, reviewFileName)), 'no review was written');
    } finally {
      local.close();
    }
  });

  it('launches the decider with the recorded decider\'s settings on its runtime, and with the roles\' policy on another', async () => {
    const original = recordedRows().map((row) => ({ row, payload: JSON.parse(row.payload) as { label?: string; model?: string; runtime?: string } }));
    const decider = original.find(({ row, payload }) => row.kind === 'worker.launched' && payload.label?.startsWith('decider decision:') === true);
    assert.ok(decider !== undefined, 'the recorded run launched a decider');
    const policyModel = decider.payload.model!;
    const withLaunch = (change: Record<string, unknown>): EventRow[] => original.map(({ row, payload }) => (row === decider.row ? { ...row, payload: JSON.stringify({ ...payload, ...change }) } : row));
    const launchedDecider = (output: string): { model: string; effort: string; timeoutMs: number; budgetUsd: number | null } => {
      const replayed = Checkpoint.open(join(output, replayCheckpointDirectoryName), { engine: '0.0.0-test' });
      try {
        const [run] = replayed.ledger.listRuns();
        return Object.values(replayed.fold(run!.id).workers)[0]!.launch;
      } finally {
        replayed.close();
      }
    };
    box.script({ decider: { output: deciderAnswer([{}, {}, { decision: 'leave', reason: 'settled', settledFor: ['SWEEP-1'] }]) } });

    const recordedOutput = newDirectory('recorded-settings');
    await replay({ checkpoint: checkpointOf(withLaunch({ model: 'claude-recorded-model', effort: 'low', timeoutMs: 123_456, budgetUsd: 1.5 })), output: recordedOutput });

    const launched = launchedDecider(recordedOutput);
    assert.deepEqual([launched.model, launched.effort, launched.timeoutMs, launched.budgetUsd], ['claude-recorded-model', 'low', 123_456, 1.5]);
    const recordedFacts = JSON.parse(read(recordedOutput, factsFileName)) as { model: string; effort: string; settingsFrom: string };
    assert.deepEqual([recordedFacts.model, recordedFacts.effort, recordedFacts.settingsFrom], ['claude-recorded-model', 'low', 'recorded']);

    const otherOutput = newDirectory('policy-settings');
    await replay({ checkpoint: checkpointOf(withLaunch({ runtime: 'codex', model: 'codex-recorded-model' })), output: otherOutput });

    assert.equal(launchedDecider(otherOutput).model, policyModel, 'a decider recorded on another runtime gives the roles\' policy');
    assert.equal((JSON.parse(read(otherOutput, factsFileName)) as { settingsFrom: string }).settingsFrom, 'policy');
  });

  it('reads a snapshot of a ledger still open for writing, with the events its write-ahead log holds', () => {
    const rows = recordedRows();
    const root = checkpointOf(rows.slice(0, -1));
    const writer = Ledger.open(root);
    try {
      const { runId: id, kind, version, payload, recordedAt, engine } = rows.at(-1)!;
      writer.write((tx) => {
        tx.insertEvent({ runId: id, kind, version, payload, recordedAt, engine });
      });
      assert.ok(existsSync(join(root, `${ledgerFileName}-wal`)), 'the last event is in the write-ahead log of the open ledger');

      const recorded = readRecordedRun(root, runId);

      assert.deepEqual(recorded.events.map((event) => event.kind), rows.map((row) => row.kind));
    } finally {
      writer.close();
    }
  });

  it('refuses a run that never reached the decision phase', async () => {
    const rows = recordedRows();
    const decision = rows.findIndex((row) => row.kind === 'phase.started' && (JSON.parse(row.payload) as { phase: string }).phase === 'decision');
    const root = checkpointOf(rows.slice(0, decision));

    await assert.rejects(replay({ checkpoint: root, output: newDirectory('pending'), printTask: true }), (error: unknown) => error instanceof ReplayRefusedError && /never reached the decision phase: the phase is pending/.test(error.message));
  });

  it('refuses an output directory inside the tree, named directly or through a link, before anything is written', async () => {
    const link = newDirectory('tree-link');
    symlinkSync(box.repo, link, 'junction');
    for (const output of [join(box.repo, 'replay-out'), join(link, 'replay-out')]) {
      await assert.rejects(replay({ output, printTask: true }), (error: unknown) => error instanceof ReplayRefusedError && /^The output directory .* is inside the tree /.test(error.message), output);
      assert.ok(!existsSync(output), `nothing was written at ${output}`);
    }
  });
});
