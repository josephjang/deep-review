import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import type { NewEvent } from '../../src/checkpoint/checkpoint.ts';
import { budgetStoppedUnits } from '../../src/checkpoint/fix-state.ts';
import type { Answer } from '../../src/checkpoint/events.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { sameDirectory } from '../../src/paths.ts';
import { answerRun, type AnswerOptions } from '../../src/review/answer.ts';
import { flagCheckSettings } from '../../src/review/checks/discover.ts';
import { commitRun } from '../../src/review/commit.ts';
import { gitContent } from '../../src/review/content.ts';
import { ReviewRefusedError } from '../../src/review/errors.ts';
import { stoppedUnitWords } from '../../src/review/report.ts';
import { budgetSpendOf } from '../../src/review/spend.ts';
import { describeRun, rolesPlaceholder } from '../../src/review/status.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { defaultRuntimes } from '../../src/runtime/runtimes.ts';
import { deciderAnswer, fixerAnswer, type Script } from '../helpers/fake-runtime.ts';
import { fixedA, found, noLeads } from '../helpers/fix-pass-fixture.ts';
import { baseEnvironment, fakeClaude, type Finished, node } from '../helpers/launcher.ts';
import { commitAll, git, write } from '../helpers/repository.ts';
import { afterFind, appending, cliEntry, loadedRunnerTimeoutMs, reportText, ReviewSandbox, sandboxConcurrency, scopeSource } from '../helpers/review-sandbox.ts';

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
  triage: { output: { candidates: [found('src/a.ts', 2, 'text is dereferenced when null'), found('src/a.ts', 6, 'other() passes null on')], leads: noLeads, change: null } },
  'fixer:fixes:c1-1': { costUsd: 5, edits: [{ writes: { 'src/a.ts': fixedA }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
  'fixer:fixes:c1-2': { edits: [{ writes: { 'src/a.ts': secondA }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Pass a text to parse' }]) },
};

/**
 * A sandbox whose fix run the run budget stopped, at a batch size of 1 and
 * a budget of 1 USD, and that run, which left `units` not attempted for the
 * budget, and whose end logged, reported and gave `status` the command
 * that continues it (R15 of resumable runs).
 */
async function stoppedRun(t: TestContext, script: Script = budgetScript, units: readonly { phase: 'fixes' | 'documentation' | 'repair'; key: string }[] = [{ phase: 'fixes', key: 'c1-2' }], prepare: (box: ReviewSandbox) => void = () => {}): Promise<{ box: ReviewSandbox; stopped: RunState; text: string }> {
  const box = ReviewSandbox.forTest(t, script);
  box.editPolicy((policy) => ({ ...policy, fixes: { batchSize: 1 } }));
  prepare(box);
  const text = reportText(await box.fix('claude', { flags: { budgetUsd: 1 } }));
  const stopped = box.run();
  assert.deepEqual(budgetStoppedUnits(stopped.review!.fix!), units);
  const spend = budgetSpendOf(stopped, claudeAdapter).usd!;
  // It names the run's worktree, since only a command over it reopens the run, wherever the command runs.
  assert.ok(sameDirectory(stopped.worktree, box.repo));
  const command = `node "${cliEntry}" review --repo "${stopped.worktree}" --runtime claude --last-commit --fix --budget-usd ${String(Math.floor(spend) + 1)} --roles "${box.rolesRoot}"`;
  assert.ok(box.logs.includes(`run ${stopped.id}: the run budget stopped its fix pass; ${command} continues it`), box.logs.join('\n'));
  const left = stoppedUnitWords(units);
  // The facts of the run name the command, and the brief says that they do (R10, R15 of the brief of a run).
  assert.ok(text.includes(`\nThe run budget stopped the fix pass: ${left} did not start. \`${command}\` continues it and reviews nothing again.\n`), text);
  assert.ok(text.indexOf(command) > text.indexOf('\n## The run\n'), 'only the facts of the run name the command, which holds local paths');
  assert.match(text, /^- The run budget stopped the fixes before [^\n]+ (was|were) attempted\. The facts of the run at the end of the report give the command that continues them\.$/m);
  // status names the same command, and in place of a roles directory it is not given, a placeholder it explains.
  const status = (ownRolesDigest: string): string[] => describeRun(stopped, claudeAdapter, (reference) => box.checkpoint.evidence.pathOf(reference), { engineEntry: cliEntry, ownRolesDigest: () => ownRolesDigest }).lines;
  const withoutRoles = command.replace(` --roles "${box.rolesRoot}"`, '');
  assert.ok(status(stopped.review!.configuration.rolesDigest).includes(`Continue: ${withoutRoles}, which continues the fix pass the run budget stopped and reviews nothing again`));
  assert.ok(status('0'.repeat(64)).includes(`Continue: ${withoutRoles} --roles "${rolesPlaceholder}", which continues the fix pass the run budget stopped and reviews nothing again, with the roles directory the run was reviewed with in place of ${rolesPlaceholder}`));
  return { box, stopped, text };
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
  // TD12 of the documentation step.
  it('plans the documentation step after the batches a reopening gives back, with the drift lines of the whole fix pass', async (t) => {
    const script: Script = {
      ...budgetScript,
      'fixer:fixes:c1-1': { costUsd: 5, edits: [{ writes: { 'src/a.ts': fixedA }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Return 0 for a null text' }], [{ file: 'docs/a.md', what: 'parse throws on a null text' }]) },
      'fixer:fixes:c1-2': { edits: [{ writes: { 'src/a.ts': secondA }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Pass a text to parse' }], [{ file: './docs/a.md', what: 'other passes null to parse' }]) },
    };
    const { box, stopped } = await stoppedRun(t, script);
    assert.deepEqual(stopped.review!.phases.documentation, { status: 'degraded', attempt: 1 }, 'the step waits for the batch the budget left');
    assert.equal(stopped.review!.fix!.documentation, null);
    reportText(await box.fix('claude', { flags: { budgetUsd: 100 } }));
    const state = box.checkpoint.fold(stopped.id);
    assert.deepEqual(launchedSince(stopped, state), ['fixer fixes:c1-2', 'documentation documentation:documentation']);
    assert.deepEqual(state.review!.fix!.documentation?.items.map((item) => [item.id, item.path, item.drift.map((line) => `${line.key}: ${line.what}`)]), [['doc-1', 'docs/a.md', ['c1-1: parse throws on a null text', 'c1-2: other passes null to parse']], ['search', null, []]]);
    assert.deepEqual(state.review!.phases.documentation, { status: 'completed', attempt: 2 });
  });

  it('reopens the documentation step alone when the run budget stopped it, and runs it with the plan it recorded (R8 of the documentation step)', async (t) => {
    // One batch of both findings spends past the budget, so the fixes finish and the step is planned, and the budget stops its worker.
    const script: Script = {
      ...budgetScript,
      'fixer:fixes:c1-1': { costUsd: 5, edits: [{ writes: { 'src/a.ts': secondA }, snapshot: 1 }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Return 0 for a null text' }, { status: 'already-applied' }], [{ file: 'docs/a.md', what: 'parse throws on a null text' }]) },
    };
    const { box, stopped } = await stoppedRun(t, script, [{ phase: 'documentation', key: 'documentation' }], (sandbox) => sandbox.editPolicy((policy) => ({ ...policy, fixes: { batchSize: 4 } })));
    assert.deepEqual(stopped.review!.fix!.documentation?.items.map((item) => item.id), ['doc-1', 'search']);
    const { checkpoint, appends } = recording(box);
    reportText(await box.fix('claude', { flags: { budgetUsd: 100 }, checkpoint }));
    assert.deepEqual(appends[0], ['fix.reopened', 'limits.changed']);
    const state = box.checkpoint.fold(stopped.id);
    assert.deepEqual(box.checkpoint.ledger.events(stopped.id).filter((event) => event.kind === 'fix.reopened').map((event) => event.version), [2], 'only version 2 lists the step');
    assert.deepEqual(launchedSince(stopped, state), ['documentation documentation:documentation'], 'no batch of the fixes launches again');
    assert.equal(box.checkpoint.ledger.events(stopped.id).filter((event) => event.kind === 'documentation.planned').length, 1, 'the plan stands');
    assert.deepEqual(state.review!.phases.documentation, { status: 'completed', attempt: 2 });
    assert.deepEqual(budgetStoppedUnits(state.review!.fix!), []);
  });

  it('is reopened by the same command with a higher budget, in one append with the limits, which launches only the batch the budget left and writes a new report (R11 of resumable runs)', async (t) => {
    const { box, stopped } = await stoppedRun(t);
    const { checkpoint, appends } = recording(box);
    const text = reportText(await box.fix('claude', { flags: { budgetUsd: 100 }, checkpoint }));
    assert.deepEqual(appends[0], ['fix.reopened', 'limits.changed'], 'the reopen and its limits are one append (TD8)');
    assert.equal(box.checkpoint.foldRuns().length, 1, 'no run is created');
    const state = box.checkpoint.fold(stopped.id);
    // The documentation step plans after the batch the reopening gives back (TD12 of the documentation step).
    assert.deepEqual(launchedSince(stopped, state), ['fixer fixes:c1-2', 'documentation documentation:documentation'], 'no read-only worker and no settled unit launches');
    assert.deepEqual(Object.keys(state.review!.fix!.answers.fixes).sort(), ['c1-1', 'c1-2']);
    assert.deepEqual(budgetStoppedUnits(state.review!.fix!), []);
    assert.deepEqual(state.review!.fix!.reopenings.map((reopening) => reopening.units), [[{ phase: 'fixes', key: 'c1-2' }]]);
    assert.equal(state.review!.limits.runBudgetUsd, 100);
    assert.notDeepEqual(state.review!.report, stopped.review!.report, 'a new report');
    assert.equal(readFileSync(join(box.repo, 'src', 'a.ts'), 'utf8'), secondA);
    assert.ok(box.logs.some((line) => line.startsWith(`run ${stopped.id}: reopened its fix pass, which the run budget stopped, for batch c1-2; `)), box.logs.join('\n'));
    assert.match(text, /^Fix pass: 2 applied, 0 already applied, 0 deferred, 0 blocked, 0 not attempted,/m);
    const reopening = state.review!.fix!.reopenings[0]!;
    assert.ok(text.includes(`\nReopened: the fix pass past the run budget on ${reopening.at}, after the report artifacts/${stopped.review!.report!.report.sha256}\n`), text);
    assert.doesNotMatch(text, /The run budget stopped the fix pass/, 'nothing is left for the budget');
    assert.ok(!describeRun(state, claudeAdapter, () => '', { engineEntry: cliEntry, ownRolesDigest: () => '' }).lines.some((line) => line.startsWith('Continue: ')));
  });

  it('names the --check and --no-check it is given as ignored, since it keeps the checks it pinned, as a resume names them', async (t) => {
    const { box, stopped } = await stoppedRun(t);
    const ignored = `run ${stopped.id} keeps the checks it pinned; --check and --no-check are ignored`;
    reportText(await box.fix('claude', { flags: { budgetUsd: 100 }, fix: flagCheckSettings({ test: 'echo other' }, ['lint']) }));
    assert.equal(box.checkpoint.fold(stopped.id).review!.fix!.reopenings.length, 1, 'the run was reopened');
    assert.ok(box.logs.includes(ignored), box.logs.join('\n'));
    assert.deepEqual(box.checkpoint.fold(stopped.id).review!.fix!.checks.planned, stopped.review!.fix!.checks.planned, 'the pinned checks are kept');
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
    assert.deepEqual(launchedSince(stopped, state), ['fixer fixes:c1-2', 'documentation documentation:documentation']);
    // The reopened batch's revision is committed as a later series, from the head the first one made.
    const later = commitRun({ checkpoint: box.checkpoint, worktree: box.repo });
    assert.equal(git(box.repo, 'rev-parse', `${later.commits[0]!.sha}^`), open.to);
  });

  it('names a staged path the series it completes does not hold, which the reopen\'s index reset unstaged, and leaves its bytes in the tree (R9 of resumable runs)', async (t) => {
    const { box, stopped } = await stoppedRun(t);
    assert.throws(() => commitRun({ checkpoint: box.checkpoint, worktree: box.repo, beforeMove: () => {
      throw new Error('stopped');
    } }), /stopped/);
    const open = box.checkpoint.fold(stopped.id).review!.fix!.openSeries!;
    git(box.repo, 'update-ref', 'refs/heads/main', open.to, open.from);
    // A person stages a file of their own before the command that reopens the run.
    write(box.repo, 'notes.txt', 'mine\n');
    git(box.repo, 'add', 'notes.txt');
    reportText(await box.fix('claude', { flags: { budgetUsd: 100 } }));
    const completed = box.logs.indexOf(`run ${stopped.id}: a commit a stop cut short had moved HEAD to ${open.to.slice(0, 12)}; the 1 commit it made is recorded now`);
    assert.ok(completed >= 0, box.logs.join('\n'));
    assert.equal(box.logs[completed + 1], `run ${stopped.id}: staged paths no commit holds were unstaged and are unchanged in the tree: notes.txt`);
    assert.equal(git(box.repo, 'diff', '--cached', '--name-only'), '', 'nothing stays staged');
    assert.equal(readFileSync(join(box.repo, 'notes.txt'), 'utf8'), 'mine\n');
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
    assert.deepEqual(launchedSince(stopped, state), ['fixer fixes:c1-2', 'documentation documentation:documentation']);
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

/** src/a.ts once a third batch's fixer marked it, after the second's. */
const thirdA = `${secondA}// checked by the third batch\n`;
/** src/a.ts once an answer pass followed the rule the author kept. */
const answeredA = fixedA.replace('return parse(null);', 'return parse(\'kept\');');

/** The options of `answerRun` for this sandbox, with a run budget above the spend so the pass may open. */
function answerOptions(box: ReviewSandbox, finding: string, given: Answer): AnswerOptions {
  return {
    checkpoint: box.checkpoint,
    worktree: box.repo,
    finding,
    answer: given,
    note: null,
    recordOnly: false,
    flags: { budgetUsd: 100 },
    adapter: (runtime) => defaultRuntimes().get(runtime),
    match: gitContent(box.repo, (reference) => box.checkpoint.evidence.read(reference)).match,
    log: () => {},
    rolesRoot: box.rolesRoot,
    environment: { ...baseEnvironment, FAKE_SCRIPT: box.scriptFile, FAKE_CHECKS: box.checksFile },
    preflightOptions: { timeoutMs: loadedRunnerTimeoutMs },
  };
}

/** The finding the decider decided to fix departing from a rule, which a person can reject. */
const departingOf = (run: RunState): string => run.review!.decisions!.find((decision) => decision.departure !== null)!.id;

describe('the work of a reopened fix pass', { timeout: 900_000, concurrency: sandboxConcurrency }, () => {
  it('reopens a second time when the budget stops it again, and keeps both reopenings (R11 of resumable runs)', async (t) => {
    const script: Script = {
      ...budgetScript,
      triage: { output: { candidates: [found('src/a.ts', 2, 'text is dereferenced when null'), found('src/a.ts', 6, 'other() passes null on'), found('src/a.ts', 7, 'other() is never tested')], leads: noLeads, change: null } },
      'fixer:fixes:c1-2': { ...budgetScript['fixer:fixes:c1-2'] as object, costUsd: 5 },
      'fixer:fixes:c1-3': { edits: [{ writes: { 'src/a.ts': thirdA }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Mark the check' }]) },
    };
    const { box, stopped } = await stoppedRun(t, script, [{ phase: 'fixes', key: 'c1-2' }, { phase: 'fixes', key: 'c1-3' }]);
    reportText(await box.fix('claude', { flags: { budgetUsd: 7 } }));
    const once = box.checkpoint.fold(stopped.id);
    assert.deepEqual(budgetStoppedUnits(once.review!.fix!), [{ phase: 'fixes', key: 'c1-3' }], 'the second batch spent past the new budget');
    reportText(await box.fix('claude', { flags: { budgetUsd: 100 } }));
    const twice = box.checkpoint.fold(stopped.id);
    assert.deepEqual(twice.review!.fix!.reopenings.map((reopening) => reopening.units.map((unit) => unit.key)), [['c1-2', 'c1-3'], ['c1-3']]);
    assert.deepEqual(budgetStoppedUnits(twice.review!.fix!), []);
    assert.deepEqual(launchedSince(stopped, twice), ['fixer fixes:c1-2', 'fixer fixes:c1-3', 'documentation documentation:documentation'], 'the step waits for both reopenings');
    assert.equal(readFileSync(join(box.repo, 'src', 'a.ts'), 'utf8'), thirdA);
    const last = twice.review!.fix!.reopenings.at(-1)!;
    assert.match(readFileSync(box.checkpoint.evidence.pathOf(twice.review!.report!.report), 'utf8'), new RegExp(`^Reopened: the fix pass past the run budget 2 times, the last on ${last.at.replaceAll('.', '\\.')}, after the report artifacts/[0-9a-f]{64}$`, 'm'));
  });

  it('reopens a run commit committed, and the next commit commits the reopened work as a later series (R11 of resumable runs)', async (t) => {
    const { box, stopped } = await stoppedRun(t);
    const first = commitRun({ checkpoint: box.checkpoint, worktree: box.repo });
    const text = reportText(await box.fix('claude', { flags: { budgetUsd: 100 } }));
    assert.match(text, /^What the fix pass did with each finding, in rank order\. Patch 1 is committed; patch 2, the reopened fix pass's, is in the working tree, uncommitted;/m);
    assert.match(text, /^2\. fix\(a\): Pass a text to parse \(c1-2, the reopened fix pass after the commits\): /m);
    assert.match(text, /^1\. fix\(a\): Return 0 for a null text \(c1-1\): /m);
    const later = commitRun({ checkpoint: box.checkpoint, worktree: box.repo });
    assert.equal(git(box.repo, 'rev-parse', `${later.commits[0]!.sha}^`), first.commits.at(-1)!.sha);
    assert.deepEqual(later.commits.map((commit) => commit.subject), ['fix(a): Pass a text to parse']);
    assert.equal(box.checkpoint.fold(stopped.id).review!.fix!.commits.length, 2);
  });

  it('runs the second-round batches and the repair the budget left, with the checks between, once reopened, as run 0d63437e needed (R11 of resumable runs)', async (t) => {
    // c1 owns src/a.ts with three findings, each blocked on src/b.ts, which c2 owns and fixes; the last of c1 spends past the budget, so the second round is planned and left.
    const blocked = { output: fixerAnswer([{ status: 'blocked', files: [], requiredFiles: ['src/b.ts'], note: 'needs src/b.ts' }]) };
    const secondRound = (index: number): Script[string] => ({ edits: [{ writes: { 'src/a.ts': `${fixedA}// second round ${String(index)}\n` }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'], subject: `fix(a): Second round ${String(index)}` }]) });
    const script: Script = {
      triage: { output: { candidates: [found('src/a.ts', 2, 'text is dereferenced when null'), found('src/a.ts', 6, 'other() passes null on'), found('src/a.ts', 7, 'other() is never tested'), found('src/b.ts', 1, 'b calls parse without importing it')], leads: noLeads, change: null } },
      'fixer:fixes:c1-1': blocked,
      'fixer:fixes:c1-2': blocked,
      'fixer:fixes:c1-3': { ...blocked, costUsd: 5 },
      'fixer:fixes:c2-1': { edits: [{ writes: { 'src/b.ts': 'import { parse } from \'./a.ts\';\nexport const b = parse("x");\n' }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/b.ts'], subject: 'fix(b): Import parse' }]) },
      'fixer:fixes:c3-1': secondRound(1),
      'fixer:fixes:c3-2': secondRound(2),
      'fixer:fixes:c3-3': secondRound(3),
      'fixer:repair:repair': { edits: [{ writes: { 'src/a.ts': `${fixedA}// repaired\n` }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Repair the test' }]) },
    };
    const left = [{ phase: 'fixes' as const, key: 'c3-1' }, { phase: 'fixes' as const, key: 'c3-2' }, { phase: 'fixes' as const, key: 'c3-3' }, { phase: 'repair' as const, key: 'repair' }];
    // The test check passes before the fixes, fails after them in both runs, and passes after the repair.
    const { box, stopped } = await stoppedRun(t, script, left, (sandbox) => sandbox.checks({ test: ['pass', 'fail', 'fail', 'pass'] }));
    assert.deepEqual(stopped.review!.fix!.secondRound?.batches.map((batch) => batch.key), ['c3-1', 'c3-2', 'c3-3']);
    reportText(await box.fix('claude', { flags: { budgetUsd: 100 } }));
    const state = box.checkpoint.fold(stopped.id);
    assert.deepEqual(launchedSince(stopped, state), ['fixer fixes:c3-1', 'fixer fixes:c3-2', 'fixer fixes:c3-3', 'documentation documentation:documentation', 'fixer repair:repair']);
    assert.deepEqual(budgetStoppedUnits(state.review!.fix!), []);
    const runs = state.review!.fix!.checks.runs;
    assert.deepEqual(runs.checks.filter((run) => run.kind === 'test').map((run) => run.outcome), ['failed', 'failed'], 'the checks ran again on the reopened fixes');
    assert.deepEqual(runs['repair-checks'].filter((run) => run.kind === 'test').map((run) => run.outcome), ['passed']);
    assert.equal(readFileSync(join(box.repo, 'src', 'a.ts'), 'utf8'), `${fixedA}// repaired\n`);
  });

  it('gives a reopened batch the answer an answer pass applied before the reopen, which its fixer keeps, and runs the checks again after that pass (R13 of resumable runs)', async (t) => {
    const script: Script = {
      ...budgetScript,
      decider: { output: deciderAnswer([{}, { departs: true }]) },
      'fixer:fixes:c1-2': { output: fixerAnswer([{ status: 'already-applied', files: ['src/a.ts'], note: 'the answer pass applied it' }]) },
      'fixer:answer:pass-1': { edits: [{ writes: { 'src/a.ts': answeredA }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Follow the rule the author kept' }]) },
    };
    const { box, stopped } = await stoppedRun(t, script);
    // The person rejects the departure of the finding the budget left, and an answer pass applies the rule.
    const opened = await answerRun(answerOptions(box, departingOf(stopped), { kind: 'reject' }));
    assert.equal(opened.next, 'pass');
    reportText(await box.review('claude', { flags: { budgetUsd: 100 } }));
    const passed = box.checkpoint.fold(stopped.id);
    assert.deepEqual(budgetStoppedUnits(passed.review!.fix!), [{ phase: 'fixes', key: 'c1-2' }], 'the answer pass launches no batch of the fixes');
    reportText(await box.fix('claude', { flags: { budgetUsd: 100 } }));
    const state = box.checkpoint.fold(stopped.id);
    assert.match(box.promptOf(state, 'fixer fixes:c1-2'), /the answer pass pass-1 already applied this answer, and the tree holds it: answer already-applied and keep that edit, and do not apply the default again/);
    assert.equal(state.review!.fix!.answers.fixes['c1-2']!.findings[0]!.status, 'already-applied');
    assert.equal(readFileSync(join(box.repo, 'src', 'a.ts'), 'utf8'), answeredA, 'the fixer kept what the answer pass applied');
    assert.ok(state.review!.fix!.checks.runs.checks.length > passed.review!.fix!.checks.runs.checks.length, 'the answer pass revised the tree after the last runs of the checks');
  });

  it('plans no second round while the budget left the first, says so of the finding the first round blocked, and plans and runs it once reopened (PD13, R15 of resumable runs)', async (t) => {
    // c1 owns src/a.ts, whose first batch is blocked on src/b.ts and spends past the budget, so c1-2 is left; c2 fixes src/b.ts.
    const script: Script = {
      triage: { output: { candidates: [found('src/a.ts', 2, 'text is dereferenced when null'), found('src/a.ts', 6, 'other() passes null on'), found('src/b.ts', 1, 'b calls parse without importing it')], leads: noLeads, change: null } },
      'fixer:fixes:c1-1': { costUsd: 5, output: fixerAnswer([{ status: 'blocked', files: [], requiredFiles: ['src/b.ts'], note: 'needs src/b.ts' }]) },
      'fixer:fixes:c1-2': budgetScript['fixer:fixes:c1-2']!,
      'fixer:fixes:c2-1': { edits: [{ writes: { 'src/b.ts': 'import { parse } from \'./a.ts\';\nexport const b = parse("x");\n' }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/b.ts'], subject: 'fix(b): Import parse' }]) },
      'fixer:fixes:c3-1': { edits: [{ writes: { 'src/a.ts': fixedA }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts', 'src/b.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
    };
    const { box, stopped, text } = await stoppedRun(t, script);
    assert.equal(stopped.review!.fix!.secondRound, null);
    assert.match(text, /^### 1\. SCAN-1 blocked\n\nNote: needs src\/b\.ts\n[\s\S]*?^Second round not planned: the run budget stopped the first round$/m);
    reportText(await box.fix('claude', { flags: { budgetUsd: 100 } }));
    const state = box.checkpoint.fold(stopped.id);
    assert.deepEqual(state.review!.fix!.secondRound?.batches.map((batch) => batch.key), ['c3-1'], 'planned from the whole first round');
    assert.deepEqual(launchedSince(stopped, state), ['fixer fixes:c1-2', 'fixer fixes:c3-1', 'documentation documentation:documentation']);
    assert.doesNotMatch(readFileSync(box.checkpoint.evidence.pathOf(state.review!.report!.report), 'utf8'), /Second round not planned/);
  });

  it('marks the After answers column of a run reopened after an answer pass, whose reopened batch changed the tree since (R15 of resumable runs)', async (t) => {
    const script: Script = {
      ...budgetScript,
      decider: { output: deciderAnswer([{ departs: true }, {}]) },
      'fixer:answer:pass-1': { edits: [{ writes: { 'src/a.ts': answeredA }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Follow the rule the author kept' }]) },
      'fixer:fixes:c1-2': { edits: [{ writes: { 'src/a.ts': `${answeredA}// and the second finding\n` }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Fix the second finding' }]) },
    };
    const { box, stopped } = await stoppedRun(t, script);
    assert.equal((await answerRun(answerOptions(box, departingOf(stopped), { kind: 'reject' }))).next, 'pass');
    reportText(await box.review('claude', { flags: { budgetUsd: 100 } }));
    const text = reportText(await box.fix('claude', { flags: { budgetUsd: 100 } }));
    assert.match(text, /\| After answers \(an earlier tree\) \|/);
    assert.match(text, /^- After answers: its runs checked an earlier tree, which a later revision of the fixes changed\.$/m);
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

  it('reopens the run from another directory with --repo naming its worktree, as the continue command names it', async (t) => {
    const box = sandbox(t);
    const first = await review(box, '--last-commit', '--budget-usd', '1');
    assert.equal(first.status, 0, first.stderr);
    const stopped = box.run();
    assert.ok(first.stderr.includes(` review --repo "${stopped.worktree}" --runtime claude --last-commit --fix `), first.stderr);
    const elsewhere = join(box.scratchRoot, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    const second = await node([cli, 'review', '--repo', stopped.worktree, '--runtime', 'claude', '--executable', process.execPath, '--executable-arg', fakeClaude, '--roles', box.rolesRoot, '--last-commit', '--fix', '--budget-usd', '100'], { cwd: elsewhere, env: environment(box) });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, new RegExp(`run ${stopped.id}: reopened its fix pass, which the run budget stopped, for batch c1-2; `));
    assert.equal(box.checkpoint.foldRuns().length, 1, 'no new run');
  });
});
