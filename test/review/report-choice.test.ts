import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { Checkpoint } from '../../src/checkpoint/checkpoint.ts';
import { runModel, type RunState } from '../../src/checkpoint/fold.ts';
import { chooseReportRun, noReportWords, notShownLines, shownPassedOver } from '../../src/review/report-choice.ts';
import { shortRunId } from '../../src/review/runs.ts';
import { blockerActions } from '../../src/review/vocabulary.ts';
import { fixerAnswer, type Script } from '../helpers/fake-runtime.ts';
import { baseEnvironment, node } from '../helpers/launcher.ts';
import { testModel } from '../helpers/model.ts';
import { git } from '../helpers/repository.ts';
import { answer, configured, continuedRun, continuedToReport, decidedFixRun, History, triaged } from '../helpers/review-history.ts';
import { ReviewSandbox, sandboxConcurrency } from '../helpers/review-sandbox.ts';

const cli = resolve(import.meta.dirname, '../../src/cli.ts');
const found = (file: string, line: number, summary: string): Record<string, unknown> => ({ file, line, summary, detail: `${summary}: the failure` });
const noLeads = ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'].map((angle) => ({ angle, lead: null }));
const fixedA = 'export function parse(text: string | null) {\n  return text?.length ?? 0;\n}\n';
const fixedB = 'import { parse } from \'./a.ts\';\nexport const b = parse("x");\n';

/** Two findings, one in src/a.ts and one in src/b.ts, each fixed by its cluster's fixer. */
const twoFixes: Script = {
  triage: { output: { candidates: [found('src/a.ts', 2, 'text is dereferenced when null'), found('src/b.ts', 1, 'b calls parse without importing it')], leads: noLeads, change: null } },
  'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA, 'test/a.test.ts': 'test a\n' } }], output: fixerAnswer([{ files: ['src/a.ts', 'test/a.test.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
  'fixer:fixes:c2-1': { edits: [{ writes: { 'src/b.ts': fixedB } }], output: fixerAnswer([{ files: ['src/b.ts'], subject: 'fix(b): Import parse' }]) },
};

describe('notShownLines (R8 of the questions in the chat)', () => {
  const later = (n: number, state = 'is in progress'): { run: string; state: string } => ({ run: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`, state });

  it('gives no line when report passed over no run', () => {
    assert.deepEqual(notShownLines([]), []);
  });

  it('names each later run by the first 8 characters of its id and its state, at most three, then counts the others', () => {
    assert.equal(shownPassedOver, 3);
    assert.deepEqual(notShownLines([later(1, 'was abandoned: wrong scope')]), ['Not shown: run 00000001, a later run, was abandoned: wrong scope.']);
    assert.deepEqual(notShownLines([later(4), later(3), later(2)]).map((line) => line.slice(0, 20)), ['Not shown: run 00000', 'Not shown: run 00000', 'Not shown: run 00000']);
    assert.deepEqual(notShownLines([later(5), later(4), later(3), later(2), later(1)]).slice(3), ['Not shown: 2 more later runs; deep-review status --all lists them']);
    assert.deepEqual(notShownLines([later(4), later(3), later(2), later(1)]).slice(3), ['Not shown: 1 more later run; deep-review status --all lists them']);
  });

  it('cuts a line at a word at 200 characters, since the reason of an abandon has no limit', () => {
    const [line] = notShownLines([later(1, `was abandoned: ${'very '.repeat(60)}long`)]);
    assert.ok(line!.length <= 200, String(line!.length));
    assert.ok(line!.endsWith('very...'), line!);
  });
});

describe('noReportWords (R9 of the questions in the chat)', () => {
  const blocker = { code: 'budget', detail: 'd', action: blockerActions.budget };

  it('gives the reason of an abandon, with no period of its own at the end, also between two phases', () => {
    assert.equal(noReportWords(configured().add('run.abandoned', { reason: 'wrong scope.' }).fold()), 'was abandoned: wrong scope');
    assert.equal(noReportWords(triaged().add('run.abandoned', { reason: 'the wrong\nbranch' }).fold()), 'was abandoned: the wrong branch');
    assert.equal(noReportWords(new History().add('run.created', { worktree: '/w' }).add('run.abandoned', { reason: 'r' }).fold()), 'was abandoned: r', 'an abandon comes before a review that never started');
  });

  it('keeps a reason made only of periods, so something follows the colon', () => {
    assert.equal(noReportWords(configured().add('run.abandoned', { reason: '.' }).fold()), 'was abandoned: .');
    assert.equal(noReportWords(configured().add('run.abandoned', { reason: ' ...\n' }).fold()), 'was abandoned: ...');
  });

  it('gives the code of the blocker of a blocked run, and says that a run with no blocker is in progress', () => {
    assert.equal(noReportWords(triaged().start('finders').finish('finders', 'blocked', 1, blocker).fold()), 'is blocked (budget)');
    assert.equal(noReportWords(configured().fold()), 'is in progress');
    assert.equal(noReportWords(triaged().start('finders').fold()), 'is in progress');
  });

  it('says that a run whose review never started never started it', () => {
    assert.equal(noReportWords(new History().add('run.created', { worktree: '/w' }).fold()), 'never started its review');
  });

  it('names the answer pass, the continuation or the reopened fix pass that a run works again in', () => {
    const passing = decidedFixRun().add('answer.recorded', answer('SWEEP-1', 1)).add('answer.pass', { ids: ['SWEEP-1'] }).fold();
    assert.equal(passing.review!.report, null);
    assert.equal(noReportWords(passing), 'works again in an answer pass');
    const continued = continuedRun().fold();
    assert.equal(continued.review!.report, null);
    assert.equal(noReportWords(continued), 'works again, continued into the fix pass');
    // A reopening as the fold holds it, on a run whose report it set aside.
    const fixedRun = decidedFixRun().fold();
    const reopening = { at: '2026-09-27T01:00:00.000Z', units: [], reportBefore: fixedRun.review!.report!, answerPassesBefore: 0, repairAnswered: false };
    const reopened: RunState = { ...fixedRun, review: { ...fixedRun.review!, report: null, reportSetAsideBy: 'reopened-fix-pass', fix: { ...fixedRun.review!.fix!, reopenings: [reopening] } } };
    assert.equal(noReportWords(reopened), 'works again in a reopened fix pass');
    assert.equal(noReportWords({ ...reopened, review: { ...reopened.review!, blocker: { ...blocker, code: 'budget' as const, phase: 'fixes' as const } } }), 'is blocked (budget)', 'a blocker comes first');
  });

  it('names what set the last report aside, whatever the times of the earlier reopenings', () => {
    // A continued run that then opened an answer pass; the clock of these histories wraps each minute, so the continuation's time is the later one.
    const passing = decidedFixRun().add('answer.recorded', answer('SWEEP-1', 1)).add('answer.pass', { ids: ['SWEEP-1'] }).fold();
    const continuedFrom = continuedToReport().fold().review!.continuedFrom;
    const worked: RunState = { ...passing, review: { ...passing.review!, continuedFrom } };
    assert.ok(continuedFrom!.at > passing.review!.answerPasses.at(-1)!.at, 'the continuation reads as the later one by its time');
    assert.equal(noReportWords(worked), 'works again in an answer pass');
    // At the same time, too.
    assert.equal(noReportWords({ ...worked, review: { ...worked.review!, continuedFrom: { ...continuedFrom!, at: passing.review!.answerPasses.at(-1)!.at } } }), 'works again in an answer pass');
  });
});

describe('chooseReportRun over runs this engine cannot read (R8 of the questions in the chat)', () => {
  it('names an unreadable run of this worktree and one whose worktree it cannot read, never one of another worktree', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'deep-review-report-choice-')), 'checkpoint');
    try {
      // The writer is a build whose model has test.note@1; the reader is the engine's own model, which lacks it.
      const writer = Checkpoint.open(root, { engine: '9.9.9-writer', model: testModel });
      const unreadable = (worktree: string): string => {
        const created = writer.createRun({ worktree });
        writer.append(created.id, created.lastSequence, [{ kind: 'test.note', version: 1, payload: { text: 'only the writer knows this' } }]);
        return created.id;
      };
      const here = unreadable('/here');
      unreadable('/elsewhere');
      writer.close();
      const reader = Checkpoint.open(root, { engine: '1.0.0-reader', model: runModel });
      try {
        const words = 'cannot be read by this engine (1.0.0-reader); an engine that declares its events can show it';
        assert.deepEqual(chooseReportRun(reader, '/here', () => {}), { run: null, passedOver: [], newest: { id: here, state: words } }, 'the later run of another worktree is not this worktree\'s newest');
        // A creation event at a version a later build might write, so the reader cannot tell the run's worktree.
        reader.ledger.write((tx) => {
          tx.createRun({ id: 'later', createdAt: '2026-10-25T00:00:00.000Z' });
          tx.insertEvent({ runId: 'later', kind: 'run.created', version: 2, payload: '{"worktree":"/elsewhere"}', recordedAt: '2026-10-25T00:00:00.000Z', engine: '9.9.9-writer' });
        });
        assert.deepEqual(chooseReportRun(reader, '/here', () => {}).newest, { id: 'later', state: words }, 'a run whose worktree cannot be read may be this worktree\'s, so it is named');
      } finally {
        reader.close();
      }
    } finally {
      rmSync(join(root, '..'), { recursive: true, force: true });
    }
  });
});

describe('chooseReportRun (R8 of the questions in the chat)', { timeout: 900_000, concurrency: sandboxConcurrency }, () => {
  it('shows a read-only run continued into the fix pass after a later run finished, the run that ended last, and passes no run over', async (t) => {
    const box = ReviewSandbox.forTest(t, twoFixes);
    assert.equal((await box.review('claude')).kind, 'report');
    const continued = box.checkpoint.foldRuns().at(-1)!.id;
    // A fix run that started after the read-only one, and its edits put back so the read-only run's change is as it reviewed it.
    assert.equal((await box.fix('claude', { fresh: true, flags: { concurrency: 1 } })).kind, 'report');
    const created = box.checkpoint.foldRuns().at(-1)!;
    assert.notEqual(created.id, continued);
    git(box.repo, 'checkout', '--', 'src');
    rmSync(join(box.repo, 'test'), { recursive: true });
    box.script(twoFixes);
    assert.equal((await box.fix('claude', { flags: { concurrency: 1 } })).kind, 'report');
    assert.notEqual(box.checkpoint.fold(continued).review!.continuedFrom, null, 'the read-only run was continued, not a third run created');
    assert.ok(box.checkpoint.fold(continued).createdAt < created.createdAt, 'the continued run started first');

    const choice = chooseReportRun(box.checkpoint, box.repo, () => {});
    assert.equal(choice.run?.id, continued, 'the run that ended last, not the one that started last');
    assert.deepEqual(choice.passedOver, []);
    const shown = await node([cli, 'report'], { cwd: box.repo, env: { ...baseEnvironment, HOME: box.home, USERPROFILE: box.home } });
    assert.equal(shown.status, 0, shown.stderr);
    const lines = shown.stdout.trimEnd().split('\n');
    assert.match(lines[0]!, new RegExp(`\\(run ${shortRunId(continued)}\\)$`), 'no Not shown line comes first');
    assert.ok(!lines.some((line) => line.startsWith('Not shown:')), shown.stdout);
  });
});
