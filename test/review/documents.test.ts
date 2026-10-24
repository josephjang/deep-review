import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { leftDocumentsOf, planPathOf } from '../../src/review/documents.ts';
import { write } from '../helpers/repository.ts';
import { answer, answerableDecisions, checkRun, checksPhase, decidedOf, decisions, documentationAnswer, documentationItems, endCheck, fixAnswer, fixPlan, fixRevision, mergeRanked, noSecondRound, passAnswer, passRevision, reference, reported, statistics, withDocumentationStep, withFixPass, worker, type History } from '../helpers/review-history.ts';

// R2 and TD8 of the documentation step.
describe('planPathOf', () => {
  let directory: string;
  let worktree: string;
  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-documents-')));
    worktree = join(directory, 'repo');
    write(worktree, 'docs/Testing.md', 'x');
    write(worktree, 'CHANGES.md', 'x');
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('reads a drift line\'s path as the repository path the worktree spells, however the fixer wrote it', () => {
    const resolve = planPathOf(worktree);
    assert.equal(resolve('docs/Testing.md'), 'docs/Testing.md');
    assert.equal(resolve('./docs/Testing.md'), 'docs/Testing.md', 'a leading ./');
    assert.equal(resolve('docs\\Testing.md'), 'docs/Testing.md', 'a backslash');
    assert.equal(resolve('DOCS/testing.md'), 'docs/Testing.md', 'another case');
    assert.equal(resolve(join(worktree, 'CHANGES.md')), 'CHANGES.md', 'an absolute path inside the worktree');
    assert.equal(resolve('docs/new.md'), 'docs/new.md', 'a document the worktree does not hold keeps the path as written');
  });

  it('refuses a path outside the worktree, through .., or into the git directory, which stays an item with no path', () => {
    const resolve = planPathOf(worktree);
    assert.equal(resolve('../outside.md'), null);
    assert.equal(resolve('docs/../../outside.md'), null);
    assert.equal(resolve(join(directory, 'outside.md')), null, 'an absolute path outside the worktree');
    assert.equal(resolve('.git/config'), null);
    assert.equal(resolve('docs/.GIT/x'), null);
    assert.equal(resolve('a\0b'), null, 'a NUL');
    assert.equal(resolve(''), null, 'no path at all');
  });
});

// R7, PD10 and TD6 of the documentation step.
describe('leftDocumentsOf', () => {
  type Line = { readonly file: string; readonly what: string };
  const line = (file: string, what: string): Line => ({ file, what });
  /** A finding of the documentation step's answer, with its note and the files of its edits. */
  const item = (id: string, status: string, note = `${id} ${status}`, files: readonly string[] = status === 'applied' ? ['docs/a.md'] : []): Record<string, unknown> => ({
    id, status, file: 'docs/a.md', line: null, note, message: files.length === 0 ? null : { subject: `docs: Bring ${id} in line`, body: 'Why.' }, files: [...files], corrections: [], validation: [], requiredFiles: [],
  });
  /** A decided fix run with the step through its fixes: c1-1's fixer applies RIPPLE-1, revises src/a.ts unless `revised` is false, and reports `drift`. */
  const throughFixes = (drift: readonly Line[], revised = true): History => {
    const history = withDocumentationStep(checksPhase(decidedOf(withFixPass(mergeRanked()), answerableDecisions()), 'baseline-checks'), null)
      .start('fixes').add('fixes.planned', fixPlan).worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50), { drift }));
    if (revised) history.add('tree.revised', fixRevision(worker(50)));
    return history.add('fixes.replanned', noSecondRound).add('worktree.checked', endCheck('fixes'), 2).finish('fixes');
  };
  /** The step planned after `history`'s fixes. */
  const planned = (history: History): History => {
    history.start('documentation');
    return history.add('documentation.planned', { items: documentationItems(history) });
  };
  /** The step's worker answering with `findings` and its own `drift`, then the step finished. */
  const answered = (history: History, findings: readonly Record<string, unknown>[], drift: readonly Line[] = []): History =>
    history.worker(55, 'documentation documentation:documentation').add('fix.recorded', documentationAnswer(worker(55), [], { findings, drift }), 3).add('worktree.checked', endCheck('documentation'), 7).finish('documentation');
  /** The rest of the fix pass to its report: the checks, the repair with `repairDrift` and a revision of src/a.ts when given, and its checks. */
  const toReport = (history: History, repairDrift: readonly Line[] | null = null): History => {
    checksPhase(history, 'checks', repairDrift === null ? {} : { test: 'failed' });
    if (repairDrift === null) history.start('repair').finish('repair');
    else {
      history.start('repair').worker(60, 'fixer repair:repair')
        .add('fix.recorded', { ...fixAnswer(worker(60)), phase: 'repair', key: 'repair', findings: [{ id: 'test', status: 'applied', file: 'src/a.ts', line: 4, note: 'fixed the test', message: { subject: 'fix: Repair the test', body: 'Why.' }, files: ['src/a.ts'], corrections: [], validation: [], requiredFiles: [] }], drift: repairDrift })
        .add('tree.revised', { phase: 'repair', source: { kind: 'fix', key: 'repair', workerId: worker(60) }, change: { findings: ['test'], message: { subject: 'fix: Repair the test', body: 'Why.' } }, files: [{ path: 'src/a.ts', status: 'modified', before: { blob: reference('f') }, beforeSymlink: false, symlink: false, after: { blob: reference('8') } }] })
        .add('worktree.checked', endCheck('repair'), 2).finish('repair');
    }
    const patches = history.review().fix!.revisions.length;
    return history.start('repair-checks').finish('repair-checks').start('report').add('report.written', { report: reference('9', 4096), statistics, patches: Array.from({ length: patches }, (_, index) => reference(String(index + 1))) }, 4).finish('report');
  };
  /** The rest of the fix pass to its report with the checks failing and the run budget stopping the repair. */
  const toStoppedRepair = (history: History): History => {
    checksPhase(history, 'checks', { test: 'failed' });
    history.start('repair').add('unit.unattempted', { phase: 'repair', key: 'repair', cause: 'budget', reason: 'spent' }).add('worktree.checked', endCheck('repair'), 2).finish('repair', 'degraded');
    const patches = history.review().fix!.revisions.length;
    return history.start('repair-checks').finish('repair-checks').start('report').add('report.written', { report: reference('9', 4096), statistics, patches: Array.from({ length: patches }, (_, index) => reference(String(index + 1))) }, 4).finish('report');
  };
  /** An answer pass `n` on a complete run, its fixer applying RIPPLE-1's answer in `file` and reporting `drift`, to the pass's report. */
  const pass = (history: History, n: number, drift: readonly Line[] = [], file = 'src/a.ts'): History => {
    const workerId = worker(70 + n);
    history.add('answer.recorded', answer('RIPPLE-1', n % 2 === 1 ? 'reject' : 'accept')).add('answer.pass', { ids: ['RIPPLE-1'] });
    history.start('answer', n).worker(70 + n, `fixer answer:pass-${String(n)}`).add('fix.recorded', { ...passAnswer(workerId, n, [['RIPPLE-1', 'applied']]), drift }, 2);
    const revision = passRevision(workerId, n, 'RIPPLE-1');
    history.add('tree.revised', { ...revision, files: (revision.files as Record<string, unknown>[]).map((revised) => ({ ...revised, path: file })) }, 2).add('worktree.checked', endCheck('answer', n), 5).finish('answer', 'completed', n);
    history.start('answer-checks', n);
    for (const kind of ['build', 'lint', 'test']) history.add('check.ran', checkRun('answer-checks', kind, 'passed', n), 2);
    const patches = history.review().fix!.revisions.length;
    return history.finish('answer-checks', 'completed', n).start('report', n + 1).add('report.written', { report: reference(String(n), 4096 + n), statistics, patches: Array.from({ length: patches }, (_, index) => reference(String.fromCharCode(97 + index))) }, 5).finish('report', 'completed', n + 1);
  };
  const left = (history: History): ReturnType<typeof leftDocumentsOf> => leftDocumentsOf(history.review());
  const summary = (history: History): [string, string[], string[]][] => left(history).map((entry) => [entry.file, entry.facts.map((fact) => `${fact.what} (${fact.by})`), entry.reasons.map((reason) => `${reason.kind}: ${reason.text}`)]);

  it('counts a document the step left, by its resolved path with every line of it, and one it found at its end, but none it brought in line', () => {
    const history = toReport(answered(planned(throughFixes([line('./docs/a.md', 'parse throws on a null'), line('docs/a.md', 'the example prints 4'), line('README.md', 'parse throws')])), [item('doc-1', 'deferred', 'the text needs a choice nothing settled.'), item('doc-2', 'applied', 'README.md in line', ['README.md']), item('search', 'already-applied')], [line('CHANGES.md', 'the bytes are always kept')]));
    assert.deepEqual(summary(history), [
      ['docs/a.md', ['parse throws on a null (a fixer)', 'the example prints 4 (a fixer)'], ['left: The documentation step left it: the text needs a choice nothing settled.']],
      ['CHANGES.md', ['the bytes are always kept (the documentation step)'], ['found: The documentation step found it out of date at its end.']],
    ]);
  });

  it('counts what the search left by the step\'s own drift, never by its file, which names the first document it brought in line', () => {
    const searched = (file: string, files: readonly string[], drift: readonly Line[]): History => toReport(answered(planned(throughFixes([])), [{ ...item('search', 'deferred', 'the table is generated', files), file }], drift));
    // A partial search: it brought README.md in line and left the generated table.
    assert.deepEqual(summary(searched('README.md', ['README.md'], [line('docs/table.md', 'the table lists 3 options')])), [['docs/table.md', ['the table lists 3 options (the documentation step)'], ['found: The documentation step found it out of date at its end.']]]);
    assert.deepEqual(summary(searched('docs/table.md', [], [])), [], 'a file with no line of drift is no document left');
    assert.deepEqual(summary(searched('.', [], [])), []);
  });

  it('counts each document of a plan the step did not answer, with why: its worker failed twice, or the run budget stopped it', () => {
    const failed = planned(throughFixes([line('docs/a.md', 'parse throws on a null')]));
    for (const n of [56, 57]) failed.worker(n, 'documentation documentation:documentation').add('attempt.failed', { phase: 'documentation', key: 'documentation', workerId: worker(n), reason: 'failed', fault: 'unit' }, 8);
    failed.add('unit.unattempted', { phase: 'documentation', key: 'documentation', cause: 'failures', reason: '2 attempts did not complete' }, 2).add('worktree.checked', endCheck('documentation'), 7).finish('documentation', 'degraded');
    assert.deepEqual(summary(toReport(failed)), [['docs/a.md', ['parse throws on a null (a fixer)'], ['not-run: The documentation step did not run: its worker failed twice.']]]);
    const stopped = planned(throughFixes([line('docs/a.md', 'parse throws on a null')])).add('unit.unattempted', { phase: 'documentation', key: 'documentation', cause: 'budget', reason: 'spent' }, 2).add('worktree.checked', endCheck('documentation'), 7).finish('documentation', 'degraded');
    assert.deepEqual(summary(toReport(stopped)).map(([, , reasons]) => reasons), [['not-run: The documentation step did not run: the run budget was reached first.']]);
  });

  it('counts each line of the fixes when the step had no plan: the run budget stopped a batch, or the fixes changed no file', () => {
    // Two batches of one cluster: c1-1 answers with a line, and the budget stops c1-2.
    const both = [decisions[0], { ...decisions[0], id: 'SWEEP-1' }];
    const plan = { routes: [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }], clusters: [{ id: 'c1', findingIds: ['RIPPLE-1', 'SWEEP-1'], files: ['src/a.ts'] }], batches: [{ key: 'c1-1', cluster: 'c1', findingIds: ['RIPPLE-1'] }, { key: 'c1-2', cluster: 'c1', findingIds: ['SWEEP-1'] }] };
    const stopped = withDocumentationStep(checksPhase(decidedOf(withFixPass(mergeRanked()), both), 'baseline-checks'), null)
      .start('fixes').add('fixes.planned', plan).worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50), { drift: [line('docs/a.md', 'parse throws on a null')] })).add('tree.revised', fixRevision(worker(50)))
      .add('unit.unattempted', { phase: 'fixes', key: 'c1-2', cause: 'budget', reason: 'spent' }).add('fixes.replanned', noSecondRound).add('worktree.checked', endCheck('fixes'), 2).finish('fixes', 'degraded')
      .start('documentation').finish('documentation', 'degraded');
    assert.deepEqual(summary(toReport(stopped)), [['docs/a.md', ['parse throws on a null (a fixer)'], ['not-run: The documentation step did not run: the run budget was reached first.']]]);
    const unrevised = throughFixes([line('docs/a.md', 'parse throws on a null')], false).start('documentation').finish('documentation');
    assert.deepEqual(summary(toReport(unrevised)).map(([, , reasons]) => reasons), [['not-run: The documentation step did not run: the fixes changed no file.']]);
  });

  it('counts each line of a run an engine before the step configured, whose phase it skipped (R11)', () => {
    const older = decidedOf(withFixPass(mergeRanked()), answerableDecisions());
    const history = checksPhase(older, 'baseline-checks').start('fixes').add('fixes.planned', fixPlan).worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50), { drift: [line('docs/a.md', 'parse throws on a null')] })).add('tree.revised', fixRevision(worker(50))).add('fixes.replanned', noSecondRound).add('worktree.checked', endCheck('fixes'), 2).finish('fixes');
    assert.deepEqual(summary(toReport(history)), [['docs/a.md', ['parse throws on a null (a fixer)'], ['not-run: The documentation step did not run: an engine before the documentation step configured this run.']]]);
  });

  it('counts a line the repair or an answer pass reported after the step, grouping spellings of one file', () => {
    const repaired = toReport(answered(planned(throughFixes([])), [item('search', 'already-applied')]), [line('Docs/A.md', 'parse throws on a null')]);
    assert.deepEqual(summary(repaired), [['Docs/A.md', ['parse throws on a null (the repair)'], ['after: The repair reported it after the documentation step.']]]);
    const passed = pass(repaired, 1, [line('./docs/a.md', 'the example prints 4')]);
    assert.deepEqual(summary(passed), [['Docs/A.md', ['parse throws on a null (the repair)', 'the example prints 4 (the fixer of an answer pass)'], ['after: The repair reported it after the documentation step.', 'after: The fixer of an answer pass reported it after the documentation step.']]]);
  });

  it('ends an entry once a later answer pass revised its file and did not report it again, and not by a pass that reported it again, nor by the repair (PD10)', () => {
    // The step leaves a stale comment in src/a.ts, which every answer pass and the repair here revise.
    const base = (): History => answered(planned(throughFixes([line('src/a.ts', 'the comment says parse throws')])), [item('doc-1', 'deferred', 'the comment needs the author'), item('search', 'already-applied')]);
    const complete = toReport(base());
    assert.equal(left(complete).length, 1);
    assert.deepEqual(left(pass(complete.clone(), 1)), [], 'the pass revised src/a.ts and reported nothing of it');
    const again = pass(complete.clone(), 1, [line('src/a.ts', 'the comment still says parse throws')]);
    assert.deepEqual(summary(again).map(([file, facts]) => [file, facts.length]), [['src/a.ts', 2]], 'a pass that reports the file again keeps it');
    assert.deepEqual(left(pass(again, 2)), [], 'a later pass that brings it in line ends it');
    const repaired = toReport(base(), [line('README.md', 'parse throws')]);
    assert.deepEqual(summary(repaired).map(([file]) => file), ['src/a.ts', 'README.md'], 'a revision of the repair ends none');
  });

  it('dates a line by the last reopening that gave back its unit, so a reopening of the repair alone does not count again what an answer pass brought in line (PD10)', () => {
    // The step leaves README.md, the run budget stops the repair, and answer pass 1 brings README.md in line.
    const stopped = toStoppedRepair(answered(planned(throughFixes([line('README.md', 'parse throws')])), [item('doc-1', 'deferred', 'the text needs the author'), item('search', 'already-applied')]));
    assert.deepEqual(summary(stopped).map(([file]) => file), ['README.md']);
    const passed = pass(stopped, 1, [], 'README.md');
    assert.deepEqual(left(passed), [], 'the pass revised README.md and reported nothing of it');
    const reopened = passed.clone().add('fix.reopened', { units: [{ phase: 'repair', key: 'repair' }] });
    assert.deepEqual(reopened.review().fix!.reopenings.map((reopening) => [reopening.answerPassesBefore, reopening.repairAnswered]), [[1, false]]);
    assert.deepEqual(left(reopened), [], 'the reopening gave back the repair alone, so the step\'s answer still came before the pass');
  });

  it('dates the repair\'s lines after the reopening it answered after, by the ledger and not the clock', () => {
    const stopped = toStoppedRepair(answered(planned(throughFixes([])), [item('search', 'already-applied')]));
    const reopened = pass(stopped, 1, [], 'README.md').add('fix.reopened', { units: [{ phase: 'repair', key: 'repair' }] }).start('checks', 2);
    for (const kind of ['build', 'lint', 'test']) reopened.add('check.ran', checkRun('checks', kind, kind === 'test' ? 'failed' : 'passed', 2));
    reopened.finish('checks', 'completed', 2).start('repair', 2).worker(60, 'fixer repair:repair')
      .add('fix.recorded', { ...fixAnswer(worker(60)), phase: 'repair', key: 'repair', findings: [{ id: 'test', status: 'applied', file: 'src/a.ts', line: 4, note: 'fixed the test', message: { subject: 'fix: Repair the test', body: 'Why.' }, files: ['src/a.ts'], corrections: [], validation: [], requiredFiles: [] }], drift: [line('README.md', 'parse throws')] });
    const expected = [['README.md', ['parse throws (the repair)'], ['after: The repair reported it after the documentation step.']]];
    assert.deepEqual(summary(reopened), expected, 'answer pass 1 came before the repair\'s line, so its revision ends nothing');
    // A clock stepped back records the reopening before the pass; the ledger's order still stands.
    const review = reopened.review();
    const stepped = { ...review, fix: { ...review.fix!, reopenings: review.fix!.reopenings.map((reopening) => ({ ...reopening, at: '2000-01-01T00:00:00.000Z' })) } };
    assert.deepEqual(leftDocumentsOf(stepped).map((entry) => entry.file), ['README.md']);
  });

  it('counts nothing in a run that only reviews', () => {
    assert.deepEqual(leftDocumentsOf(decidedOf(reported()).review()), []);
  });
});
