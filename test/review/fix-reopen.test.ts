import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import type { NewEvent } from '../../src/checkpoint/checkpoint.ts';
import { budgetStoppedUnits } from '../../src/checkpoint/fix-state.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { commitRun } from '../../src/review/commit.ts';
import { ReviewRefusedError } from '../../src/review/errors.ts';
import { fixerAnswer, type Script } from '../helpers/fake-runtime.ts';
import { fixedA, found, noLeads } from '../helpers/fix-pass-fixture.ts';
import { baseEnvironment, fakeClaude, type Finished, node } from '../helpers/launcher.ts';
import { commitAll, git, write } from '../helpers/repository.ts';
import { afterFind, appending, reportText, ReviewSandbox, sandboxConcurrency, scopeSource } from '../helpers/review-sandbox.ts';

const cli = resolve(import.meta.dirname, '../../src/cli.ts');

/** src/a.ts once the second batch's fixer passed a text to parse as well. */
const secondA = fixedA.replace('return parse(null);', 'return parse(\'\');');

/**
 * Two findings in src/a.ts, one batch each at a batch size of 1: the first
 * batch's fixer spends 5 USD, past a run budget of 1 USD, so the second
 * batch is not attempted for the budget; the second batch's fixer answers
 * when a reopened run launches it.
 */
const budgetScript: Script = {
  triage: { output: { candidates: [found('src/a.ts', 2, 'text is dereferenced when null'), found('src/a.ts', 6, 'other() passes null on')], leads: noLeads } },
  'fixer:fixes:c1-1': { costUsd: 5, edits: [{ writes: { 'src/a.ts': fixedA }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
  'fixer:fixes:c1-2': { edits: [{ writes: { 'src/a.ts': secondA }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Pass a text to parse' }]) },
};

/** A sandbox whose fix run the run budget stopped before its second batch, and that run. */
async function stoppedRun(t: TestContext): Promise<{ box: ReviewSandbox; stopped: RunState }> {
  const box = ReviewSandbox.forTest(t, budgetScript);
  box.editPolicy((policy) => ({ ...policy, fixes: { batchSize: 1 } }));
  reportText(await box.fix('claude', { flags: { budgetUsd: 1 } }));
  const stopped = box.run();
  assert.deepEqual(budgetStoppedUnits(stopped.review!.fix!), [{ phase: 'fixes', key: 'c1-2' }]);
  return { box, stopped };
}

/** The labels of the workers `after` launched that `before` had not. */
const launchedSince = (before: RunState, after: RunState): string[] => Object.values(after.workers).filter((worker) => !Object.hasOwn(before.workers, worker.launch.workerId)).map((worker) => worker.launch.label ?? '');

/** The kinds of each append the review made, in order, through a checkpoint that records them. */
const recording = (box: ReviewSandbox): { checkpoint: ReturnType<typeof appending>; appends: string[][] } => {
  const appends: string[][] = [];
  return { checkpoint: appending(box.checkpoint, (events: readonly NewEvent[]) => appends.push(events.map((event) => event.kind))), appends };
};

const refusedAtBudget = (runId: string) => (error: unknown): boolean =>
  error instanceof ReviewRefusedError && new RegExp(`^run ${runId} stopped its fix pass at the run budget: spent (\\d+\\.\\d\\d) USD of the 1\\.00 USD run budget[^;]*; run the command again with --budget-usd above \\1 to continue it, or with --fresh to review the change again in a new run$`).test(error.message);

describe('a fix pass the run budget stopped', { timeout: 900_000, concurrency: sandboxConcurrency }, () => {
  it('is reopened by the same command with a higher budget, in one append with the limits, which launches only the batch the budget left and writes a new report (R11 of resumable runs)', async (t) => {
    const { box, stopped } = await stoppedRun(t);
    const { checkpoint, appends } = recording(box);
    const text = reportText(await box.fix('claude', { flags: { budgetUsd: 100 }, checkpoint }));
    assert.deepEqual(appends[0], ['fix.reopened', 'limits.changed'], 'the reopen and its limits are one append (TD8)');
    assert.equal(box.checkpoint.foldRuns().length, 1, 'no run is created');
    const state = box.checkpoint.fold(stopped.id);
    assert.deepEqual(launchedSince(stopped, state), ['fixer fixes:c1-2'], 'no read-only worker and no settled unit launches');
    assert.deepEqual(Object.keys(state.review!.fix!.answers.fixes).sort(), ['c1-1', 'c1-2']);
    assert.deepEqual(budgetStoppedUnits(state.review!.fix!), []);
    assert.deepEqual(state.review!.fix!.reopenings.map((reopening) => reopening.units), [[{ phase: 'fixes', key: 'c1-2' }]]);
    assert.equal(state.review!.limits.runBudgetUsd, 100);
    assert.notDeepEqual(state.review!.report, stopped.review!.report, 'a new report');
    assert.equal(readFileSync(join(box.repo, 'src', 'a.ts'), 'utf8'), secondA);
    assert.ok(box.logs.some((line) => line.startsWith(`run ${stopped.id}: reopened its fix pass, which the run budget stopped, for batch c1-2; `)), box.logs.join('\n'));
    assert.match(text, /^Fix pass: 2 applied, 0 already applied, 0 deferred, 0 blocked, 0 not attempted,/m);
  });

  it('refuses the same command with a budget not above the spend, or the pinned one, naming --budget-usd and --fresh, and appends nothing (R12 of resumable runs)', async (t) => {
    const { box, stopped } = await stoppedRun(t);
    const sequence = box.checkpoint.ledger.lastSequence(stopped.id);
    await assert.rejects(box.fix('claude', { flags: { budgetUsd: 1 } }), refusedAtBudget(stopped.id));
    await assert.rejects(box.fix('claude'), refusedAtBudget(stopped.id), 'with no --budget-usd, the pinned budget is in force');
    assert.equal(box.checkpoint.ledger.lastSequence(stopped.id), sequence);
    assert.equal(box.checkpoint.foldRuns().length, 1, 'no run is created');
  });

  for (const [name, move, moved] of [
    ['a file the run expects changed', (box: ReviewSandbox): void => write(box.repo, 'src/a.ts', 'edited by hand\n'), /src\/a\.ts \(modified\)/],
    ['HEAD moved', (box: ReviewSandbox): void => {
      write(box.repo, 'notes.md', 'a note\n');
      git(box.repo, 'add', 'notes.md');
      git(box.repo, 'commit', '-q', '-m', 'docs: Add a note');
    }, /HEAD \(/],
  ] as const) {
    it(`is not reopened when ${name}: the log names the run and what moved, and a new run is created (R12 of resumable runs)`, async (t) => {
      const { box, stopped } = await stoppedRun(t);
      const sequence = box.checkpoint.ledger.lastSequence(stopped.id);
      move(box);
      await box.fix('claude', { flags: { budgetUsd: 100 } });
      const line = box.logs.find((entry) => entry.startsWith(`run ${stopped.id}: its fix pass, which the run budget stopped, is not reopened: the tree is not where the run left it: `));
      assert.ok(line !== undefined, box.logs.join('\n'));
      assert.match(line, moved);
      assert.match(line, /; restore them to reopen it$/);
      assert.equal(box.checkpoint.ledger.lastSequence(stopped.id), sequence, 'the stopped run is left as it was');
      assert.equal(box.checkpoint.foldRuns().length, 2, 'a new run');
    });
  }

  it('is not reopened with --fresh, nor by a command that names another scope, which each create a new run', async (t) => {
    const { box, stopped } = await stoppedRun(t);
    const sequence = box.checkpoint.ledger.lastSequence(stopped.id);
    await box.fix('claude', { flags: { budgetUsd: 100 }, fresh: true });
    assert.equal(box.checkpoint.foldRuns().length, 2);
    // Another scope names no such run, whatever the budget: the fresh run is complete by now, so this is a third run.
    await box.fix('claude', { flags: { budgetUsd: 100 }, scope: scopeSource(() => ({ ref: 'HEAD', paths: [] })) });
    assert.equal(box.checkpoint.foldRuns().length, 3);
    assert.equal(box.checkpoint.ledger.lastSequence(stopped.id), sequence);
    assert.ok(!box.logs.some((line) => line.includes('reopened its fix pass')), box.logs.join('\n'));
  });

  it('completes in the reopen\'s append a series of commits a stop cut short after the branch moved, and reopens on the head it made (R9, R11 of resumable runs)', async (t) => {
    const { box, stopped } = await stoppedRun(t);
    assert.throws(() => commitRun({ checkpoint: box.checkpoint, worktree: box.repo, beforeMove: () => {
      throw new Error('stopped');
    } }), /stopped/);
    const open = box.checkpoint.fold(stopped.id).review!.fix!.openSeries!;
    git(box.repo, 'update-ref', 'refs/heads/main', open.to, open.from);
    const { checkpoint, appends } = recording(box);
    reportText(await box.fix('claude', { flags: { budgetUsd: 100 }, checkpoint }));
    assert.deepEqual(appends[0], ['commits.created', 'fix.reopened', 'limits.changed']);
    const state = box.checkpoint.fold(stopped.id);
    assert.deepEqual(state.review!.fix!.commits, [open]);
    assert.deepEqual(launchedSince(stopped, state), ['fixer fixes:c1-2']);
    // The reopened batch's revision is committed as a later series, from the head the first one made.
    const later = commitRun({ checkpoint: box.checkpoint, worktree: box.repo });
    assert.equal(git(box.repo, 'rev-parse', `${later.commits[0]!.sha}^`), open.to);
  });

  it('is resumed, not reopened again nor joined by a new run, when another engine reopened it between the find and the lock', async (t) => {
    const { box, stopped } = await stoppedRun(t);
    const { checkpoint, acted } = afterFind(box.checkpoint, (target) => {
      target.append(stopped.id, stopped.lastSequence, [
        { kind: 'fix.reopened', version: 1, payload: { units: [{ phase: 'fixes', key: 'c1-2' }] } },
        { kind: 'limits.changed', version: 1, payload: { ...stopped.review!.limits, runBudgetUsd: 100 } },
      ]);
    });
    reportText(await box.fix('claude', { flags: { budgetUsd: 100 }, checkpoint }));
    assert.ok(acted(), 'the other engine reopened the run after the find');
    assert.equal(box.checkpoint.foldRuns().length, 1, 'no second run');
    assert.ok(box.logs.includes(`run ${stopped.id}: resuming`), box.logs.join('\n'));
    const state = box.checkpoint.fold(stopped.id);
    assert.equal(state.review!.fix!.reopenings.length, 1, 'this engine reopened nothing more');
    assert.deepEqual(launchedSince(stopped, state), ['fixer fixes:c1-2']);
  });

  it('is held at its pinned budget again by a resume with no --budget-usd, which leaves the batch not attempted and completes (R11 of resumable runs)', async (t) => {
    const { box, stopped } = await stoppedRun(t);
    // An engine stopped right after the reopen's append: the run is active with the batch to launch.
    box.checkpoint.append(stopped.id, stopped.lastSequence, [
      { kind: 'fix.reopened', version: 1, payload: { units: [{ phase: 'fixes', key: 'c1-2' }] } },
      { kind: 'limits.changed', version: 1, payload: { ...stopped.review!.limits, runBudgetUsd: 100 } },
    ]);
    reportText(await box.fix('claude'));
    const state = box.checkpoint.fold(stopped.id);
    assert.equal(state.review!.limits.runBudgetUsd, 1);
    assert.deepEqual(budgetStoppedUnits(state.review!.fix!), [{ phase: 'fixes', key: 'c1-2' }]);
    assert.deepEqual(launchedSince(stopped, state), []);
  });
});

describe('the deep-review command reopening a fix pass the run budget stopped (TD9 of resumable runs)', { timeout: 900_000, concurrency: sandboxConcurrency }, () => {
  const environment = (box: ReviewSandbox): NodeJS.ProcessEnv => {
    mkdirSync(box.scratchRoot, { recursive: true });
    return { ...baseEnvironment, FAKE_SCRIPT: box.scriptFile, FAKE_CHECKS: box.checksFile, HOME: box.home, USERPROFILE: box.home, TEMP: box.scratchRoot, TMP: box.scratchRoot, TMPDIR: box.scratchRoot };
  };
  const run = (box: ReviewSandbox, ...args: string[]): Promise<Finished> => node([cli, ...args], { cwd: box.repo, env: environment(box) });
  const review = (box: ReviewSandbox, ...args: string[]): Promise<Finished> => run(box, 'review', '--runtime', 'claude', '--executable', process.execPath, '--executable-arg', fakeClaude, '--roles', box.rolesRoot, '--fix', ...args);
  const sandbox = (t: TestContext): ReviewSandbox => {
    const box = ReviewSandbox.forTest(t, budgetScript);
    box.editPolicy((policy) => ({ ...policy, fixes: { batchSize: 1 } }));
    return box;
  };

  it('reopens a --last-commit run once its fixes left the tree with uncommitted changes, which --last-commit alone refuses', async (t) => {
    const box = sandbox(t);
    const first = await review(box, '--last-commit', '--budget-usd', '1');
    assert.equal(first.status, 0, first.stderr);
    const stopped = box.run();
    assert.notEqual(git(box.repo, 'status', '--porcelain'), '', 'the fixes changed the tree');
    const second = await review(box, '--last-commit', '--budget-usd', '100');
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, new RegExp(`run ${stopped.id}: reopened its fix pass, which the run budget stopped, for batch c1-2; `));
    assert.equal(box.checkpoint.foldRuns().length, 1);
  });

  it('reopens a --worktree run once commit left the tree clean, which --worktree alone refuses', async (t) => {
    const box = sandbox(t);
    // The change under review is uncommitted, as --worktree reviews it.
    git(box.repo, 'reset', '-q', '--soft', 'HEAD~1');
    const first = await review(box, '--worktree', '--budget-usd', '1');
    assert.equal(first.status, 0, first.stderr);
    const stopped = box.run();
    const committed = await run(box, 'commit', '--change-message', 'the change under review');
    assert.equal(committed.status, 0, committed.stderr);
    assert.equal(git(box.repo, 'status', '--porcelain'), '', 'commit left the tree clean');
    const second = await review(box, '--worktree', '--budget-usd', '100');
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, new RegExp(`run ${stopped.id}: reopened its fix pass, which the run budget stopped, for batch c1-2; `));
    assert.equal(box.checkpoint.foldRuns().length, 1);
    // Without a run to reopen, --worktree on a clean tree still refuses.
    commitAll(box.repo, 'chore: Keep the reopened batch\'s edit');
    const refused = await review(box, '--worktree', '--budget-usd', '100');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--worktree reviews uncommitted changes, and this tree has none/);
  });
});
