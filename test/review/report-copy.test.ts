import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Checkpoint } from '../../src/checkpoint/checkpoint.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { continueCommand, rolesPlaceholder } from '../../src/review/continue-command.ts';
import { renderReport } from '../../src/review/report.ts';
import { refreshReportCopy, reportCopyPath, reportInputOf, reportsDirectoryName, writeReportCopy, type CopyContext } from '../../src/review/report-copy.ts';
import { budgetSpendOf } from '../../src/review/spend.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { answer, decidedFixRun, pin, readOnlyReported } from '../helpers/review-history.ts';
import { reportText, ReviewSandbox, sandboxConcurrency } from '../helpers/review-sandbox.ts';

describe('the copy of the report (R14 of the brief of a run)', () => {
  let sandbox: string;
  let logs: string[];
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'deep-review-copy-'));
    logs = [];
  });
  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  const log = (line: string): void => {
    logs.push(line);
  };
  /** A checkpoint as the copy reads it: its root, its engine, and where its store is. */
  const checkpointAt = (root: string): Pick<Checkpoint, 'root' | 'engine' | 'evidence'> => ({ root, engine: '0.0.0+copy', evidence: { root: join(root, 'artifacts') } as Checkpoint['evidence'] });
  // The engine's own roles differ from the roles the histories pinned, d repeated.
  const context: CopyContext = { engineEntry: '/opt/engine/main.mjs', adapter: claudeAdapter, continueRoles: () => rolesPlaceholder, home: '/home/me' };

  it('lives beside the ledger, named by the day the run started in UTC and the first 8 characters of the run', () => {
    const path = reportCopyPath('/repo/.git/deep-review-checkpoint', { id: '38e9b68a-1111-4222-8333-444444444444', createdAt: '2026-10-17T23:59:59.000Z' });
    assert.equal(path, join('/repo/.git/deep-review-checkpoint', reportsDirectoryName, '2026-10-17-38e9b68a.md'));
  });

  it('is written whole, its directory created, and replaced whole by the next write', () => {
    const path = join(sandbox, 'checkpoint', 'reports', '2026-10-17-run.md');
    assert.equal(writeReportCopy(path, 'first\n', 'run-1', log), path);
    assert.equal(readFileSync(path, 'utf8'), 'first\n');
    assert.equal(writeReportCopy(path, 'second\n', 'run-1', log), path);
    assert.equal(readFileSync(path, 'utf8'), 'second\n');
    assert.deepEqual(logs, []);
  });

  it('logs a copy it cannot write and gives null, failing nothing', () => {
    const blocker = join(sandbox, 'checkpoint');
    writeFileSync(blocker, 'a file where the directory would be');
    const path = join(blocker, 'reports', 'copy.md');
    assert.equal(writeReportCopy(path, 'text\n', 'run-1', log), null);
    assert.equal(logs.length, 1);
    assert.ok(logs[0]!.startsWith(`run run-1: could not write the copy of the report to ${path}: `), logs.join(' '));
  });

  it('logs a copy it cannot render and gives null, failing nothing (TD6 of the brief of a run)', () => {
    const state = decidedFixRun().fold();
    const fix = state.review!.fix!;
    // A fix pass the run budget stopped names the command that continues it, which reads the engine's own roles.
    const stopped = { ...state, review: { ...state.review!, fix: { ...fix, notAttempted: { ...fix.notAttempted, fixes: { 'c1-2': { cause: 'budget' as const, reason: 'spent' } } } } } } as RunState;
    const broken: CopyContext = { ...context, continueRoles: () => { throw new Error('the roles cannot be read'); } };
    assert.equal(refreshReportCopy(checkpointAt(join(sandbox, 'checkpoint')), stopped, broken, log), null);
    assert.deepEqual(logs, [`run ${stopped.id}: could not render the copy of the report: the roles cannot be read`]);
  });

  it('renders the report from the ledger as it is now, so it names an answer the record of its moment does not', () => {
    const root = join(sandbox, 'checkpoint');
    const state = decidedFixRun().add('answer.recorded', answer('SWEEP-1', 1)).fold();
    const path = refreshReportCopy(checkpointAt(root), state, context, log);
    assert.equal(path, reportCopyPath(root, state));
    const text = readFileSync(path!, 'utf8');
    assert.equal(text, renderReport(state, reportInputOf(checkpointAt(root), state, context)));
    assert.match(text, /^Answered: option 2 on [^;]+; not yet applied\. deep-review's choice was option 2\.$/m);
    assert.match(text, /^Engine: 0\.0\.0\+copy \(run created by 0\.0\.0\)$/m, 'the copy names the engine that rendered it');
  });

  it('names the commits once deep-review commit made them', () => {
    const root = join(sandbox, 'checkpoint');
    const series = { commits: [{ sha: 'c'.repeat(40), revision: 'change', subject: 'feat: The change' }, { sha: 'a'.repeat(40), revision: 0, subject: 'fix: Guard the null' }], from: '2'.repeat(40), to: 'a'.repeat(40) };
    const state = decidedFixRun().add('commits.created', series).fold();
    const text = readFileSync(refreshReportCopy(checkpointAt(root), state, context, log)!, 'utf8');
    assert.match(text, /They are in 2 commits\./);
    assert.match(text, /^Fix pass: [^\n]*patch 1 is committed$/m);
  });

  it('writes nothing while a run works again, its report cleared: an answer pass and a continuation into the fix pass', () => {
    const root = join(sandbox, 'checkpoint');
    const working: [string, RunState][] = [
      ['an answer pass', decidedFixRun().add('answer.recorded', answer('SWEEP-1', 1)).add('answer.pass', { ids: ['SWEEP-1'] }).fold()],
      ['a continuation', readOnlyReported().add('fix.pinned', pin()).fold()],
    ];
    for (const [name, state] of working) {
      assert.equal(state.review!.report, null, name);
      assert.equal(refreshReportCopy(checkpointAt(root), state, context, log), null, name);
      assert.equal(existsSync(reportCopyPath(root, state)), false, name);
    }
    assert.throws(() => reportInputOf(checkpointAt(root), working[0]![1], context), /has no current report/);
  });

  it('keeps its last bytes while the run works again, until the run writes its next report', () => {
    const root = join(sandbox, 'checkpoint');
    const complete = decidedFixRun().add('answer.recorded', answer('SWEEP-1', 1));
    const path = refreshReportCopy(checkpointAt(root), complete.fold(), context, log)!;
    const bytes = readFileSync(path, 'utf8');
    assert.equal(refreshReportCopy(checkpointAt(root), complete.add('answer.pass', { ids: ['SWEEP-1'] }).fold(), context, log), null);
    assert.equal(readFileSync(path, 'utf8'), bytes);
  });

  it('names the command that continues a fix pass the run budget stopped, with a placeholder for roles not the engine\'s own', () => {
    const state = decidedFixRun().fold();
    const fix = state.review!.fix!;
    const stopped = { ...state, review: { ...state.review!, fix: { ...fix, notAttempted: { ...fix.notAttempted, fixes: { 'c1-2': { cause: 'budget' as const, reason: 'spent' } } } } } } as RunState;
    const spend = budgetSpendOf(stopped, claudeAdapter).usd!;
    const own = reportInputOf(checkpointAt(sandbox), stopped, { ...context, continueRoles: () => null }).fix?.continueCommand;
    assert.equal(own, continueCommand(stopped, context.engineEntry, null, spend), 'the engine\'s own roles go unnamed');
    assert.equal(reportInputOf(checkpointAt(sandbox), stopped, context).fix?.continueCommand, continueCommand(stopped, context.engineEntry, rolesPlaceholder, spend));
    assert.equal(reportInputOf(checkpointAt(sandbox), state, context).fix?.continueCommand, null, 'a run the budget did not stop');
  });
});

describe('the copy that review writes (R14 of the brief of a run)', { concurrency: sandboxConcurrency }, () => {
  it('is the string the record holds, beside the ledger outside the worktree', async (t) => {
    const box = ReviewSandbox.forTest(t);
    const outcome = await box.review('claude');
    assert.ok(outcome.kind === 'report');
    const run = box.run();
    assert.equal(outcome.copyPath, reportCopyPath(box.checkpoint.root, run));
    assert.equal(readFileSync(outcome.copyPath!, 'utf8'), reportText(outcome), 'the copy equals the record of the same moment');
    assert.match(outcome.copyPath!, /[\\/]\.git[\\/]deep-review-checkpoint[\\/]reports[\\/]\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.md$/);
  });
});
