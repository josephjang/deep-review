import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChangeReading, ScopeMode } from '../../src/checkpoint/events.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import type { TriageAccount } from '../../src/checkpoint/review-fold.ts';
import { briefChatForm, briefFates, briefLineLimit, briefMarkdown, briefOf, changeLineLimit, changeShapeOf, chatLineLimit, cutAtWord, gapKinds, lookConditions, shortLineLimit, type Brief, type GapKind } from '../../src/review/brief.ts';
import { findingWords } from '../../src/review/markdown.ts';
import { shortRunId } from '../../src/review/runs.ts';
import { accountLimits } from '../../src/review/tasks.ts';
import { answer, answerableDecisions, askDecision, changeReading, decidedFixRun, decisions, departure, documentationItems, documentationStepAnswering, documentedFixRun, endCheck, launch, passToReport, readOnlyReported, worker } from '../helpers/review-history.ts';

/** The run with the triage's account as the fold holds it, for a history whose triage recorded version 1. */
const withAccount = (state: RunState, change: TriageAccount): RunState => ({ ...state, review: { ...state.review!, change } });
const given = (reading: ChangeReading = changeReading as unknown as ChangeReading): TriageAccount => ({ kind: 'given', reading });

/** A read-only run whose decisions ask SWEEP-1 and fix RIPPLE-1 against a written rule. */
const answerable = (): RunState => readOnlyReported(answerableDecisions()).fold();



describe('briefOf (R1, R2 of the brief of a run)', () => {
  it('gives the same value for the same fold, twice', () => {
    const state = withAccount(answerable(), given());
    assert.deepEqual(briefOf(state), briefOf(state));
  });

  it('titles the run with the triage\'s whole title, past the length the triage is asked to keep', () => {
    assert.equal(briefOf(withAccount(answerable(), given())).title, 'Parse an empty input');
    const title = `${'word '.repeat(30)}end`;
    assert.ok(title.length > accountLimits.title);
    assert.equal(briefOf(withAccount(answerable(), given({ ...changeReading, title } as unknown as ChangeReading))).title, title);
  });

  it('counts the open questions and departures in its headline, and says that nothing waits', () => {
    const brief = briefOf(answerable());
    assert.deepEqual([brief.headline.questions, brief.headline.departures], [1, 1]);
    assert.equal(brief.headline.text, '2 things need you: 1 question and 1 fix that goes against a written rule. Nothing waits for you: the question has a default in place.');
  });

  it('takes a question out of the headline once a person answers it, and a departure once a person accepts or rejects it', () => {
    const answered = readOnlyReported(answerableDecisions()).add('answer.recorded', answer('SWEEP-1', 1)).fold();
    const brief = briefOf(answered);
    assert.deepEqual([brief.headline.questions, brief.headline.departures], [0, 1]);
    assert.equal(brief.headline.text, '1 thing needs you: 1 fix that goes against a written rule. Nothing waits for you: the run went on as it decided.');
    assert.deepEqual(brief.questions[0]!.answer, { kind: 'option', option: 2, words: 'option 2', at: brief.questions[0]!.answer!.at, applied: false }, 'the question stays, with its answer');
    for (const review of ['accept', 'reject'] as const) {
      const reviewed = briefOf(readOnlyReported(answerableDecisions()).add('answer.recorded', answer('SWEEP-1', 1)).add('answer.recorded', answer('RIPPLE-1', review)).fold());
      assert.deepEqual([reviewed.headline.questions, reviewed.headline.departures], [0, 0], review);
      assert.equal(reviewed.headline.text, 'Nothing needs you: no question is open, and no fix that goes against a written rule waits for your review.');
      assert.equal(reviewed.departures[0]!.review?.words, review === 'accept' ? 'accepted' : 'rejected');
    }
  });

  describe('the core of the change (R3, R18)', () => {
    it('shows what the change does and why with their sources, whole', () => {
      const brief = briefOf(withAccount(answerable(), given()));
      assert.deepEqual(brief.change, { state: 'given', what: changeReading.what, why: changeReading.why, whyFrom: changeReading.whyFrom, restsOn: changeReading.restsOn, publicInterface: changeReading.publicInterface, wideEffect: changeReading.wideEffect, beforeEdits: false });
    });

    describe('the mark of the change before the fixes (R5 of the questions in the chat)', () => {
      const marked = (state: RunState): { beforeEdits: boolean | null; line: string; sentence: boolean } => {
        const brief = briefOf(state);
        return {
          beforeEdits: brief.change.state === 'given' ? brief.change.beforeEdits : null,
          line: briefChatForm(brief)[1]!,
          sentence: briefMarkdown(brief).some((line) => line.includes('deep-review wrote this account of the change as submitted, before its fixes, and no verifier examined it.')),
        };
      };
      const first = 'The change: The parser returns no value for an empty input, where it threw before.';
      const before = 'The change before the fixes: The parser returns no value for an empty input, where it threw before.';

      it('marks the account of a fix run with an applied fix, in its paragraph of whose account it is and on the line of the change, and keeps the title line', () => {
        const state = withAccount(decidedFixRun().fold(), given());
        assert.deepEqual(marked(state), { beforeEdits: true, line: before, sentence: true });
        assert.equal(briefChatForm(briefOf(state))[0], `Parse an empty input (run ${state.id.slice(0, 8)})`);
        const markdown = briefMarkdown(briefOf(state));
        assert.ok(markdown[6]!.includes('deep-review wrote this account of the change as submitted, before its fixes, and no verifier examined it.'), 'the third paragraph of the account, before the status line (R1 of the report for the person)');
        assert.ok(markdown[8]!.startsWith('deep-review\'s fix run '), String(markdown[8]));
      });

      it('leaves the account of a run that only reviewed, and of a fix run with no patch, as it was', () => {
        assert.deepEqual(marked(withAccount(answerable(), given())), { beforeEdits: false, line: first, sentence: false });
        assert.deepEqual(marked(withAccount(decidedFixRun(answerableDecisions(), 'deferred').fold(), given())), { beforeEdits: false, line: first, sentence: false });
        assert.deepEqual(marked(withAccount(decidedFixRun(answerableDecisions(), 'already-applied').fold(), given())), { beforeEdits: false, line: first, sentence: false });
      });

      it('leaves the account of a fix run whose only patch is the rewrite of a check, or an edit of the documentation step, as it was', () => {
        const state = withAccount(decidedFixRun(answerableDecisions(), 'deferred').fold(), given());
        const fix = state.review!.fix!;
        const revision = decidedFixRun().fold().review!.fix!.revisions[0]!;
        const repaired: RunState = { ...state, review: { ...state.review!, fix: { ...fix, revisions: [{ ...revision, phase: 'repair', source: { kind: 'fix', key: 'repair' } } as never] } } };
        assert.deepEqual(marked(repaired), { beforeEdits: false, line: first, sentence: false });
        const documented = withAccount(documentedFixRun([], undefined, answerableDecisions((decisions[0] as Record<string, unknown>))).fold(), given());
        assert.equal(marked(documented).beforeEdits, briefOf(documented).changed.applied.length > 0, 'only a fixer\'s fix marks it');
      });

      it('marks the account once an answer pass applies the first answer', () => {
        const passed = passToReport(decidedFixRun(answerableDecisions(), 'deferred').add('answer.recorded', answer('SWEEP-1', 1)).add('answer.pass', { ids: ['SWEEP-1'] }), 1, [['SWEEP-1', 'applied']], 1).fold();
        assert.equal(briefOf(passed).changed.applied.includes('RIPPLE-1'), false, 'no fixer of the fix pass applied a fix');
        assert.ok(passed.review!.answers.some((given) => given.appliedBy !== null && given.appliedBy !== 'tree'));
        assert.deepEqual(marked(withAccount(passed, given())), { beforeEdits: true, line: before, sentence: true });
      });

      it('marks no run whose triage gave no account or recorded none, which has no account to mark', () => {
        const fixed = decidedFixRun().fold();
        assert.equal(briefChatForm(briefOf(withAccount(fixed, { kind: 'none' })))[1], 'The change: deep-review gave no account of it');
        assert.equal(briefChatForm(briefOf(fixed))[1], 'The change: not recorded; an engine before the account reviewed this run');
        assert.ok(!briefMarkdown(briefOf(fixed)).some((line) => line.includes('before its fixes')));
      });
    });

    it('keeps a what and a why longer than the triage is asked for whole, in the value and in the Markdown, and points nowhere else for them (R3)', () => {
      // 959 and 679 characters: past the 600 the brief used to show of what and the 400 it showed of why.
      const what = `${'The parser reads input. '.repeat(40)}`.trim();
      const why = `${'Because it must. '.repeat(40)}`.trim();
      assert.ok(what.length > 600 && why.length > accountLimits.why);
      const brief = briefOf(withAccount(answerable(), given({ ...changeReading, what, why } as unknown as ChangeReading)));
      assert.ok(brief.change.state === 'given');
      assert.equal(brief.change.what, what);
      assert.equal(brief.change.why, why);
      const markdown = briefMarkdown(brief);
      assert.ok(markdown.includes(what), 'what, whole, as its own paragraph');
      assert.ok(markdown.some((line) => line.startsWith(`Why, in the change's own words: ${why} (`)), 'why, whole');
      assert.ok(!markdown.some((line) => line.includes('...') || line.includes('The whole account is under')), 'nothing cut, nothing to point at');
    });

    it('says an older run has no core, and titles it from its scope', () => {
      const brief = briefOf(answerable());
      assert.deepEqual(brief.change, { state: 'unrecorded' });
      assert.equal(brief.title, `The uncommitted change on ${'2'.repeat(8)}`);
      assert.deepEqual(briefOf(withAccount(answerable(), { kind: 'none' })).change, { state: 'none' });
    });

    it('titles the change by the mode of its scope: the working tree, one commit, or commits with the working tree', () => {
      const state = answerable();
      const titled = (mode: ScopeMode, base = state.scope!.base): string => briefOf({ ...state, scope: { ...state.scope!, mode, base } }).title;
      assert.equal(titled('worktree', state.scope!.head), `The uncommitted change on ${'2'.repeat(8)}`);
      assert.equal(titled('last-commit'), `The commit ${'2'.repeat(8)}`);
      // A root commit's base is the empty tree, which the title never names as a commit.
      const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
      assert.equal(titled('last-commit', emptyTree), `The commit ${'2'.repeat(8)}`);
      for (const mode of ['ref', 'range'] as const) assert.equal(titled(mode), `The change from ${'1'.repeat(8)} to ${'2'.repeat(8)}, with the working tree`, mode);
      assert.equal(titled('ref', state.scope!.head), `The change from ${'2'.repeat(8)} to ${'2'.repeat(8)}, with the working tree`, 'a ref at HEAD is still a ref scope');
      assert.deepEqual((['worktree', 'last-commit', 'ref', 'range'] as const).map((mode) => changeShapeOf({ mode })), ['working-tree', 'commit', 'commits-and-tree', 'commits-and-tree']);
    });
  });

  describe('the questions (R7, R8)', () => {
    it('names the option in place now, deep-review\'s choice, each option with its cost and rule, and the command that takes the choice', () => {
      const [question] = briefOf(answerable()).questions;
      assert.ok(question !== undefined);
      assert.equal(question.id, 'SWEEP-1');
      assert.equal(question.question, 'Should parse accept an empty input?');
      assert.deepEqual([question.default, question.choice], [1, 2]);
      assert.deepEqual(question.options.map((option) => [option.number, option.option, option.edits]), [[1, 'keep accepting it', false], [2, 'accept it and return an empty result', true]]);
      assert.equal(question.command, `deep-review answer --run ${shortRunId(answerable().id)} --finding 2 --option 2`, 'by its number and its run (R3, R7 of the report for the person)');
      assert.equal(question.answer, null);
    });
  });

  describe('the departures (R9)', () => {
    it('shows the rule, its source, the fact against it, the fix and the commands that accept and reject it', () => {
      const [found] = briefOf(answerable()).departures;
      assert.deepEqual(found, {
        id: 'RIPPLE-1', rule: departure.rule, source: departure.source, fact: departure.reason, fix: decisions[0]!.fix!.approach,
        fate: 'not-fixed', review: null,
        accept: `deep-review answer --run ${shortRunId(answerable().id)} --finding 1 --accept`, reject: `deep-review answer --run ${shortRunId(answerable().id)} --finding 1 --reject`,
      });
    });

    it('shows each fate of its fix in a run that fixed', () => {
      const fates: [string, string][] = [['applied', 'applied'], ['already-applied', 'already-in-tree'], ['deferred', 'deferred'], ['blocked', 'blocked']];
      for (const [status, fate] of fates) assert.equal(briefOf(decidedFixRun(answerableDecisions(), status).fold()).departures[0]!.fate, fate, status);
    });

    it('names every fate the JSON form allows', () => {
      assert.deepEqual([...briefFates], ['applied', 'already-in-tree', 'deferred', 'blocked', 'not-attempted', 'not-fixed']);
    });
  });

  describe('what the run did not cover (R10)', () => {
    const kinds = (state: RunState): GapKind[] => briefOf(state).notCovered.map((gap) => gap.kind);

    it('lists the angle that did not run and the group no verifier examined, and no line saying it covered everything', () => {
      const brief = briefOf(answerable());
      assert.deepEqual(brief.notCovered.map((gap) => gap.kind), ['angle', 'unverified']);
      assert.match(brief.notCovered[0]!.text, /^The FOOTGUNS angle did not run \(2 attempts did not complete: [^)]*\)\. A later pass looked for what it would have found\.$/);
      assert.match(brief.notCovered[1]!.text, /^No verifier examined SWEEP-1, SWEEP-2 \(2 attempts did not complete: failed; failed again\); each counts as PLAUSIBLE\.$/);
      assert.equal(brief.covered, null);
    });

    it('lists the paths the settings left out and the files too large to freeze', () => {
      const state = answerable();
      const scope = { ...state.scope!, request: { ...state.scope!.request, exclude: ['dist/**'] }, excluded: { paths: ['dist/a.js', 'dist/b.js'], count: 2 }, files: [...state.scope!.files, { path: 'big.bin', status: 'added' as const, symlink: false, before: null, after: { oversized: { sha256: 'f'.repeat(64), size: 9_000_000 } } }] };
      const brief = briefOf({ ...state, scope });
      assert.deepEqual(brief.notCovered.filter((gap) => gap.kind === 'excluded' || gap.kind === 'oversized').map((gap) => gap.text), ['2 changed paths under dist/**, which the settings leave out.', '1 file too large to freeze, which no worker was given: big.bin.']);
    });

    it('lists a check with no command, and each fix no fixer applied, by why', () => {
      for (const [status, words] of [['deferred', 'its fixer put it off'], ['blocked', 'its fixer could not apply it']] as const) {
        const brief = briefOf(decidedFixRun(answerableDecisions(), status).fold());
        assert.ok(brief.notCovered.some((gap) => gap.kind === 'check' && /^No typecheck check ran: .+.$/.test(gap.text)), JSON.stringify(brief.notCovered));
        assert.ok(brief.notCovered.some((gap) => gap.kind === 'fix' && gap.text === `RIPPLE-1 was decided as a fix, and ${words}.`), status);
      }
    });

    it('lists a check that did not finish, before the fixes and after them, and not one that ran to an outcome', () => {
      const state = decidedFixRun().fold();
      const fix = state.review!.fix!;
      const kind = fix.checks.runs['baseline-checks'][0]!.kind;
      const ended = (phase: 'baseline-checks' | 'checks', outcome: string): unknown[] => fix.checks.runs[phase].map((run) => (run.kind === kind ? { ...run, outcome } : run));
      const gapsWith = (before: string, after: string): string[] => briefOf({ ...state, review: { ...state.review!, fix: { ...fix, checks: { ...fix.checks, runs: { ...fix.checks.runs, 'baseline-checks': ended('baseline-checks', before), checks: ended('checks', after) } } } } } as RunState)
        .notCovered.filter((gap) => gap.kind === 'check' && gap.text.startsWith(`The ${kind} check`)).map((gap) => gap.text);
      assert.deepEqual(gapsWith('timeout', 'skipped'), [`The ${kind} check did not finish: it timed out, then was skipped.`]);
      assert.deepEqual(gapsWith('passed', 'not-started'), [`The ${kind} check did not finish: it did not start.`]);
      assert.deepEqual(gapsWith('passed', 'failed'), []);
      assert.ok(gapsWith('passed', 'cut').every((gap) => !gap.includes('did not finish')));
    });

    it('says of a question whose default a fixer did not apply that the default went to a fixer, not that it was decided as a fix', () => {
      const asked = briefOf(decidedFixRun([askDecision('RIPPLE-1', true), askDecision('SWEEP-1', false)], 'deferred').fold());
      assert.ok(asked.notCovered.some((gap) => gap.kind === 'fix' && gap.text === 'The default of the question on RIPPLE-1 went to a fixer, and its fixer put it off.'), JSON.stringify(asked.notCovered));
    });

    it('lists the work the run budget did not start, and points at the facts of the run for the command that continues it', () => {
      const state = decidedFixRun().fold();
      const fix = state.review!.fix!;
      // The budget stopped batch c1-1 before its fixer answered, so RIPPLE-1 was not attempted.
      const stopped = { ...state, review: { ...state.review!, fix: { ...fix, answers: { ...fix.answers, fixes: {} }, notAttempted: { ...fix.notAttempted, fixes: { 'c1-1': { cause: 'budget' as const, reason: 'spent 31 USD of 30 USD' } }, repair: { repair: { cause: 'budget' as const, reason: 'spent' } } } } } };
      const brief = briefOf(stopped as RunState);
      // In plain words: the findings its batches hold, not the batches (R12 of the brief of a run).
      assert.equal(brief.notCovered.find((entry) => entry.kind === 'budget')?.text, 'The run budget stopped the fixes before 1 finding and the repair of the checks were attempted. The facts of the run at the end of the report give the command that continues them.');
      // Each finding it counts is listed once more with why no fixer attempted it.
      assert.deepEqual(brief.notCovered.filter((entry) => entry.kind === 'fix').map((entry) => entry.text), ['RIPPLE-1 was decided as a fix, and no fixer attempted it before the run budget was reached.']);
      const repairOnly = { ...stopped, review: { ...stopped.review, fix: { ...stopped.review.fix, notAttempted: { ...fix.notAttempted, repair: { repair: { cause: 'budget' as const, reason: 'spent' } } } } } };
      assert.equal(briefOf(repairOnly as RunState).notCovered.find((entry) => entry.kind === 'budget')?.text, 'The run budget stopped the fixes before the repair of the checks was attempted. The facts of the run at the end of the report give the command that continues them.');
    });

    it('counts in the budget gap only the findings no fixer attempted, not one of a stopped batch a fixer already answered', () => {
      const state = decidedFixRun().fold();
      const fix = state.review!.fix!;
      // RIPPLE-1's fixer applied it, as the first round answers a finding a stopped second-round batch holds again.
      const stopped = { ...state, review: { ...state.review!, fix: { ...fix, notAttempted: { ...fix.notAttempted, fixes: { 'c1-1': { cause: 'budget' as const, reason: 'spent 31 USD of 30 USD' } } } } } };
      const brief = briefOf(stopped as RunState);
      assert.equal(brief.notCovered.find((entry) => entry.kind === 'budget')?.text, 'The run budget stopped the fixes before some of the fixes were attempted. The facts of the run at the end of the report give the command that continues them.');
      assert.ok(!brief.notCovered.some((entry) => entry.kind === 'fix'), JSON.stringify(brief.notCovered));
    });

    it('says why no fixer attempted a fix: two failures, or no recorded cause', () => {
      const state = decidedFixRun().fold();
      const fix = state.review!.fix!;
      const unanswered = { ...fix, answers: { ...fix.answers, fixes: {} } };
      const failed = { ...state, review: { ...state.review!, fix: { ...unanswered, notAttempted: { ...fix.notAttempted, fixes: { 'c1-1': { cause: 'failures' as const, reason: '2 attempts did not complete: failed; failed again' } } } } } };
      const fixGaps = (run: unknown): string[] => briefOf(run as RunState).notCovered.filter((entry) => entry.kind === 'fix').map((entry) => entry.text);
      assert.deepEqual(fixGaps(failed), ['RIPPLE-1 was decided as a fix, and its fixer failed twice and gave no answer.']);
      assert.ok(!briefOf(failed as RunState).notCovered.some((entry) => entry.kind === 'budget'));
      assert.deepEqual(fixGaps({ ...state, review: { ...state.review!, fix: unanswered } }), ['RIPPLE-1 was decided as a fix, and no fixer attempted it.']);
    });

    it('lists a worker a stop ended whose work did not run again, and not one that ran again', () => {
      const lost = readOnlyReported(answerableDecisions()).add('worker.launched', launch(worker(90), 'decider decision:decision')).add('worker.lost', { workerId: worker(90), phase: null, key: null, reason: 'the engine exited while the worker ran' }).fold();
      assert.equal(kinds(lost).filter((kind) => kind === 'stop').length, 1);
      assert.equal(briefOf(lost).notCovered.find((gap) => gap.kind === 'stop')?.text, 'A stop ended 1 worker whose work did not run again; the notes of the run name it.');
      assert.ok(!kinds(answerable()).includes('stop'), 'the WRAPPERS worker lost in the finders ran again');
    });

    it('says in one line that the run covered everything, for a run with no gap', () => {
      const state = answerable();
      const review = state.review!;
      const clean = { ...state, review: { ...review, anglesNotRun: {}, plans: { ...review.plans, 'sweep-verification': [] } } };
      assert.deepEqual(briefOf(clean).notCovered, []);
      assert.equal(briefOf(clean).covered, 'Each angle ran, and a verifier examined each candidate.');
    });

    it('names every kind of gap the JSON form allows, the documentation step\'s last (R7 of the documentation step)', () => {
      assert.deepEqual([...gapKinds], ['angle', 'unverified', 'excluded', 'oversized', 'check', 'fix', 'budget', 'stop', 'documentation']);
    });
  });

  describe('where to look (R11)', () => {
    it('names the departures, and the findings decided as fixes on a PLAUSIBLE verdict in a run that only reviewed', () => {
      const brief = briefOf(readOnlyReported([{ ...decisions[0], departure }, { ...decisions[0], id: 'SWEEP-1' }]).fold());
      assert.deepEqual(brief.look.map((entry) => [entry.condition, entry.findings, entry.text]), [
        ['departure', ['RIPPLE-1'], '1 fix goes against a written rule'],
        ['plausible', ['SWEEP-1'], '1 finding decided as a fix rests on a verdict that is only PLAUSIBLE'],
      ]);
    });

    it('leaves out of what needs you a departure a person accepted or rejected, and keeps one nobody reviewed', () => {
      for (const review of ['accept', 'reject'] as const) {
        const state = decidedFixRun().add('answer.recorded', answer('RIPPLE-1', review)).fold();
        assert.ok(!briefOf(state).look.some((entry) => entry.condition === 'departure'), review);
        assert.equal(briefOf(state).departures.length, 1, `the departures keep it with its ${review}`);
        assert.ok(!briefOf(state).needs.some((need) => need.condition === 'departure'), review);
      }
      const two = readOnlyReported([{ ...decisions[0], departure }, { ...decisions[0], id: 'SWEEP-1', departure }]).add('answer.recorded', answer('RIPPLE-1', 'accept')).fold();
      assert.deepEqual(briefOf(two).look.filter((entry) => entry.condition === 'departure').map((entry) => [entry.findings, entry.text]), [[['SWEEP-1'], '1 fix goes against a written rule']], 'the unreviewed one stays, counted alone');
      assert.deepEqual(briefOf(two).needs.filter((need) => need.condition === 'departure').map((need) => need.finding), [2]);
    });

    it('counts in a run that fixed only the fixes a fixer applied on a PLAUSIBLE verdict', () => {
      const brief = briefOf(decidedFixRun().fold());
      assert.deepEqual(brief.look.map((entry) => entry.condition), ['departure'], 'RIPPLE-1 is CONFIRMED, and SWEEP-1 was asked, not fixed');
    });

    it('names the triage\'s two judgments as its own, and neither when they do not hold or the run has no account', () => {
      const brief = briefOf(withAccount(answerable(), given({ ...changeReading, wideEffect: { holds: true, what: 'every caller', files: [] } } as unknown as ChangeReading)));
      assert.deepEqual(brief.look.filter((entry) => entry.condition === 'public-interface' || entry.condition === 'wide-effect').map((entry) => [entry.condition, entry.text]), [
        ['public-interface', 'The change alters a public interface, in the triage\'s judgment: parse() can now return null (src/a.ts)'],
        ['wide-effect', 'The change affects many files beyond the ones it changes, in the triage\'s judgment: every caller'],
      ]);
      assert.ok(!briefOf(answerable()).look.some((entry) => entry.condition === 'public-interface' || entry.condition === 'wide-effect'));
      assert.deepEqual([...lookConditions], ['departure', 'plausible', 'public-interface', 'wide-effect']);
    });
  });

  describe('what deep-review changed (R2)', () => {
    it('says a run that only reviewed fixed nothing, and names what it decided to fix and left', () => {
      const { changed } = briefOf(answerable());
      assert.equal(changed.fixed, false);
      assert.equal(changed.decided, true);
      assert.deepEqual([changed.applied, changed.toFix, changed.left, changed.patches, changed.commits], [[], ['RIPPLE-1'], [], 0, null]);
      assert.deepEqual(briefOf(readOnlyReported().fold()).changed.left, ['SWEEP-1']);
    });


    it('counts the deferred and the blocked fixes beside the applied ones, and the checks before and after', () => {
      const applied = briefOf(decidedFixRun().fold()).changed;
      assert.deepEqual([applied.fixed, applied.applied, applied.deferred, applied.patches, applied.commits], [true, ['RIPPLE-1'], [], 1, null]);
      const passed = (kind: string): unknown => ({ kind, before: 'passed', last: { outcome: 'passed', when: 'fixes' }, earlier: { passed: 'before', failed: null }, base: null, fault: null });
      assert.deepEqual(applied.checks, [passed('build'), passed('lint'), passed('test')]);
      assert.deepEqual(briefOf(decidedFixRun(answerableDecisions(), 'deferred').fold()).changed.deferred, ['RIPPLE-1']);
      assert.deepEqual(briefOf(decidedFixRun(answerableDecisions(), 'blocked').fold()).changed.blocked, ['RIPPLE-1']);
    });

    it('says a check failed after the fixes when its newest run failed, not what a repair-checks run a later revision made old said', () => {
      const state = decidedFixRun().fold();
      const review = state.review!;
      const fix = review.fix!;
      const ran = fix.checks.runs.checks.find((run) => run.kind === 'test')!;
      const fixes = fix.revisions[0]!;
      // The checks failed, the repair revised and its checks passed; a reopened fix pass revised again, the checks failed, and the repair made no revision, so its checks did not run again.
      const reopened = {
        ...fix,
        revisions: [fixes, { ...fixes, phase: 'repair' as const }, fixes],
        checks: { ...fix.checks, runs: { ...fix.checks.runs, checks: [{ ...ran, outcome: 'failed' as const, revisionsBefore: 1 }, { ...ran, attempt: 2, outcome: 'failed' as const, revisionsBefore: 3 }], 'repair-checks': [{ ...ran, phase: 'repair-checks' as const, revisionsBefore: 2 }] } },
      };
      const brief = briefOf({ ...state, review: { ...review, fix: reopened } });
      assert.deepEqual(brief.changed.checks.find((check) => check.kind === 'test')?.last, { outcome: 'failed', when: 'fixes' });
      // With no current run, the run that checked the newest tree stands.
      const stale = { ...reopened, revisions: [...reopened.revisions, fixes] };
      assert.equal(briefOf({ ...state, review: { ...review, fix: stale } }).changed.checks.find((check) => check.kind === 'test')?.last?.outcome, 'failed');
    });

    describe('the validation of the fixes (R7 of the facts before a merge)', () => {
      /** The decided fix run, its fixer reporting RIPPLE-1 applied with a validation entry of each method given. */
      const validated = (methods: readonly string[]): RunState => {
        const state = decidedFixRun().fold();
        const fix = state.review!.fix!;
        const answer = fix.answers.fixes['c1-1']!;
        const findings = answer.findings.map((finding) => ({ ...finding, validation: methods.map((method) => ({ method, source: 'test/a.test.ts', evidence: 'it ran' })) }));
        return { ...state, review: { ...state.review!, fix: { ...fix, answers: { ...fix.answers, fixes: { 'c1-1': { ...answer, findings } } } } } } as RunState;
      };



      it('takes the strongest method of a fix that gives several', () => {
        assert.deepEqual(briefOf(validated(['limited', 'existing', 'mutation'])).changed.validation.test, ['RIPPLE-1']);
        assert.deepEqual(briefOf(validated(['limited', 'static', 'existing'])).changed.validation.existing, ['RIPPLE-1']);
        assert.deepEqual(briefOf(validated(['limited', 'static'])).changed.validation.static, ['RIPPLE-1']);
      });



    });

    it('names the commits that hold the edits once deep-review commit made them', () => {
      const series = { commits: [{ sha: 'c'.repeat(40), revision: 'change', subject: 'feat: The change' }, { sha: 'a'.repeat(40), revision: 0, subject: 'fix: Guard the null' }], from: '2'.repeat(40), to: 'a'.repeat(40) };
      const committed = briefOf(decidedFixRun().add('commits.created', series).fold()).changed;
      assert.deepEqual(committed.commits, { shas: ['c'.repeat(40), 'a'.repeat(40)], uncommittedPatches: 0 });
    });
  });
});

describe('cutAtWord', () => {
  it('keeps a text that fits, and cuts a longer one at a word with three periods', () => {
    assert.equal(cutAtWord('short', 10), 'short');
    assert.equal(cutAtWord('one two three four', 12), 'one two...');
    assert.equal(cutAtWord('one, two, three', 12), 'one, two...', 'no punctuation before the periods');
    assert.equal(cutAtWord('x'.repeat(20), 10), `${'x'.repeat(7)}...`, 'a word longer than the room is cut where the limit falls');
    assert.equal(cutAtWord('abc', 3), 'abc');
  });

  it('never splits a character of two UTF-16 units where the limit falls', () => {
    const cut = cutAtWord(`Fix ${'x'.repeat(72)}😀😀😀😀`, 80);
    assert.ok(cut.isWellFormed(), JSON.stringify(cut));
    assert.equal(cut, `Fix ${'x'.repeat(72)}...`);
    assert.equal(cutAtWord(`Fix ${'x'.repeat(71)}😀😀😀😀`, 80), `Fix ${'x'.repeat(71)}😀...`, 'a whole character before the limit stays');
  });
});




describe('the line that says the run covered everything (R10 of the brief of a run)', () => {
  /** A fix run with no gap of R10: every angle ran, every group was verified, and each planned check has a command. */
  const covered = (status: string): RunState => {
    const state = decidedFixRun(answerableDecisions(), status).fold();
    const review = state.review!;
    const fix = review.fix!;
    const planned = fix.checks.planned!;
    return { ...state, review: { ...review, anglesNotRun: {}, plans: { ...review.plans, 'sweep-verification': [] }, fix: { ...fix, checks: { ...fix.checks, planned: { ...planned, checks: planned.checks.filter((check) => check.command !== null) } } } } };
  };

  it('says each check ran before and after the fixes only when they ran after them', () => {
    assert.equal(briefOf(covered('applied')).covered, 'Each angle ran, a verifier examined each candidate, and each check ran before and after the fixes.');
    assert.equal(briefOf(covered('already-applied')).covered, 'Each angle ran, a verifier examined each candidate, and each check ran before the fixes; no fix changed a file, so they did not run after them.');
  });
});


// R7, R10, R11 and PD6 of the documentation step.
describe('the documents a run left out of date in the brief', () => {
  const line = (file: string, what: string): { file: string; what: string } => ({ file, what });
  const stale = [line('./docs/a.md', 'parse throws on a null')];
  /** A fix run whose step left its one document, with its own reason. */
  const leftOne = (): RunState => documentedFixRun(stale, documentationStepAnswering([['doc-1', 'deferred'], ['search', 'already-applied']])).fold();

  it('counts them in the headline, beside the questions and the departures, and says a fix run with none left none it knows of', () => {
    assert.equal(briefOf(leftOne()).headline.text, '3 things need you: 1 question, 1 fix that goes against a written rule and 1 document that the edits of the run left out of date. Nothing waits for you: the question has a default in place.');
    assert.equal(briefOf(leftOne()).headline.documents, 1);
    const clean = documentedFixRun([], undefined, decisions).fold();
    assert.equal(briefOf(clean).headline.text, 'Nothing needs you: no question is open, no fix that goes against a written rule waits for your review, the run left no document out of date that it knows of, and its edits made no check fail.');
    assert.equal(briefOf(documentedFixRun(stale, documentationStepAnswering([['doc-1', 'deferred'], ['search', 'already-applied']]), decisions).fold()).headline.text, '1 thing needs you: 1 document that the edits of the run left out of date. Nothing waits for you: the run went on as it decided.');
  });




  it('says in what deep-review changed what the step did: how many documents it updated and left, none found, or why it did not run', () => {
    const changed = (state: RunState): string | null => briefOf(state).changed.documentation;
    assert.equal(changed(documentedFixRun(stale, documentationStepAnswering([['doc-1', 'applied'], ['search', 'already-applied']], { drift: [line('CHANGES.md', 'always translated')] })).fold()), 'The documentation step updated 1 document and left 1.');
    assert.equal(changed(documentedFixRun(stale, documentationStepAnswering([['doc-1', 'applied'], ['search', 'already-applied']])).fold()), 'The documentation step updated 1 document.');
    assert.equal(changed(leftOne()), 'The documentation step left 1 document out of date.');
    // A partial search: it brought README.md in line, which its file names, and left CHANGES.md in its drift.
    const finding = (id: string, status: string, file: string): Record<string, unknown> => ({ id, status, file, line: null, note: `${id} ${status}`, message: { subject: `docs: Bring ${file} in line`, body: 'Why.' }, files: [file], corrections: [], validation: [], requiredFiles: [] });
    const searched = documentedFixRun(stale, documentationStepAnswering([], { findings: [finding('doc-1', 'applied', 'docs/a.md'), finding('search', 'deferred', 'README.md')], drift: [line('CHANGES.md', 'always translated')] })).fold();
    assert.equal(changed(searched), 'The documentation step updated 2 documents and left 1.');
    assert.deepEqual(briefOf(searched).documents.map((document) => document.file), ['CHANGES.md']);
    // A document it deferred and listed in its drift again in another spelling of its repository path is one document, as the part counts it.
    const respelled = documentedFixRun(stale, documentationStepAnswering([['doc-1', 'deferred'], ['search', 'already-applied']], { drift: [line('./docs/a.md', 'parse throws on a null')] })).fold();
    assert.deepEqual([changed(respelled), briefOf(respelled).documents.length], ['The documentation step left 1 document out of date.', 1]);
    // A spelling in another case is another document, as the plan keys a repository path exactly (TD8): the ledger does not say whether the worktree folds case.
    const recased = documentedFixRun(stale, documentationStepAnswering([['doc-1', 'deferred'], ['search', 'already-applied']], { drift: [line('./Docs/A.md', 'parse throws on a null')] })).fold();
    assert.deepEqual([changed(recased), briefOf(recased).documents.length], ['The documentation step left 2 documents out of date.', 2]);
    assert.equal(changed(documentedFixRun().fold()), 'The documentation step found no document out of date.');
    const failedTwice = documentedFixRun(stale, (history) => history.start('documentation').add('documentation.planned', { items: documentationItems(history) }).add('unit.unattempted', { phase: 'documentation', key: 'documentation', cause: 'failures', reason: '2 attempts did not complete' }, 2).add('worktree.checked', endCheck('documentation'), 7).finish('documentation', 'degraded')).fold();
    assert.equal(changed(failedTwice), 'The documentation step did not run: its worker failed twice.');
    assert.ok(briefOf(failedTwice).notExamined.includes('The documentation step did not run: its worker failed twice.'), 'a gap of what the run did not examine (R4 of the report for the person)');
  });

  it('gives the step that did not answer a gap of its own, and none to one with nothing to do or a run before the step', () => {
    const failedTwice = documentedFixRun(stale, (history) => history.start('documentation').add('documentation.planned', { items: documentationItems(history) }).add('unit.unattempted', { phase: 'documentation', key: 'documentation', cause: 'failures', reason: '2 attempts did not complete' }, 2).add('worktree.checked', endCheck('documentation'), 7).finish('documentation', 'degraded')).fold();
    assert.deepEqual(briefOf(failedTwice).notCovered.filter((gap) => gap.kind === 'documentation').map((gap) => gap.text), ['The documentation step did not run: its worker failed twice. The documents left are in Documents left out of date.']);
    assert.deepEqual(briefOf(documentedFixRun().fold()).notCovered.filter((gap) => gap.kind === 'documentation'), [], 'a step that answered');
    assert.deepEqual(briefOf(decidedFixRun().fold()).notCovered.filter((gap) => gap.kind === 'documentation'), [], 'a run an engine before the step configured');
    // A step with no plan: one whose fixes changed no file had nothing to do, and one whose fixes did has not run yet.
    const unplanned = documentedFixRun(stale, (history) => history.start('documentation').finish('documentation')).fold();
    const fix = unplanned.review!.fix!;
    const withRevisions = (revisions: typeof fix.revisions): RunState => ({ ...unplanned, review: { ...unplanned.review!, fix: { ...fix, documentation: null, revisions } } });
    const unrevised = briefOf(withRevisions([]));
    assert.deepEqual([unrevised.documents.length, unrevised.notCovered.filter((gap) => gap.kind === 'documentation')], [1, []], 'the fixes changed no file');
    assert.deepEqual(briefOf(withRevisions(fix.revisions)).notCovered.filter((gap) => gap.kind === 'documentation').map((gap) => gap.text), ['The documentation step did not run: it has not run yet. The documents left are in Documents left out of date.']);
  });

  it('names no fixer in the step\'s gap when only the repair named a document', () => {
    const searchOnly = documentedFixRun([], (history) => history.start('documentation').add('documentation.planned', { items: documentationItems(history) }).add('unit.unattempted', { phase: 'documentation', key: 'documentation', cause: 'failures', reason: '2 attempts did not complete' }, 2).add('worktree.checked', endCheck('documentation'), 7).finish('documentation', 'degraded')).fold();
    const fix = searchOnly.review!.fix!;
    const repaired = { ...searchOnly, review: { ...searchOnly.review!, fix: { ...fix, answers: { ...fix.answers, repair: { repair: { drift: [line('docs/api.md', 'the check name changed')] } } } } } } as unknown as RunState;
    const brief = briefOf(repaired);
    assert.deepEqual(brief.documents.map((document) => document.file), ['docs/api.md']);
    assert.deepEqual(brief.notCovered.filter((gap) => gap.kind === 'documentation').map((gap) => gap.text), ['The documentation step did not run: its worker failed twice. The documents left are in Documents left out of date.']);
  });

  it('counts the drift lines of a run an engine before the step configured, and says nothing of the step it never had (R11)', () => {
    const state = decidedFixRun().fold();
    const fix = state.review!.fix!;
    const older = { ...state, review: { ...state.review!, fix: { ...fix, answers: { ...fix.answers, fixes: { 'c1-1': { ...fix.answers.fixes['c1-1']!, drift: stale } } } } } } as RunState;
    const brief = briefOf(older);
    assert.deepEqual(brief.documents.map((document) => [document.file, document.reasons.map((reason) => reason.kind)]), [['./docs/a.md', ['not-run']]]);
    assert.equal(brief.headline.documents, 1);
    assert.equal(brief.changed.documentation, null);
    assert.deepEqual(brief.needs.filter((need) => need.condition === 'document').map((need) => need.document), ['./docs/a.md']);
  });

});

// R1 to R5, R12, R14 of the report for the person.
describe('the brief for the person', () => {
  const plain = (): unknown[] => [decisions[0], askDecision('SWEEP-1', false)];
  const items = (brief: Brief): string[][] => brief.needs.map((need) => [...need.lines]);
  const run = (state: RunState): string => shortRunId(state.id);

  it('puts the account, the status line and what needs you first, with what needs you at line 11 (R1)', () => {
    const state = withAccount(decidedFixRun().fold(), given());
    const lines = briefMarkdown(briefOf(state));
    assert.equal(lines[0], '# Parse an empty input');
    assert.equal(lines[10], '## What needs you');
    const parts = ['## What needs you', '## Before you merge', '## What deep-review fixed'].map((heading) => lines.indexOf(heading));
    assert.ok(parts.every((position, index) => position > 0 && (index === 0 || parts[index - 1]! < position)), JSON.stringify(parts));
    assert.equal(lines[8], `deep-review's fix run ${run(state)} has 2 findings. It fixed 1 in your working tree, against a written rule. It asks you 1 question.`);
  });

  it('counts the findings of a run by what became of them, in a run that only reviewed, after an answer, and once the fixes are committed (R14)', () => {
    assert.equal(briefOf(answerable()).status.text, `deep-review's review run ${run(answerable())} has 2 findings. It changed no file and ran no check. It would fix 1, against a written rule. It asks you 1 question.`);
    const answered = decidedFixRun().add('answer.recorded', answer('SWEEP-1', 0)).fold();
    assert.equal(briefOf(answered).status.text, `deep-review's fix run ${run(answered)} has 2 findings. It fixed 1 in your working tree, against a written rule. It follows your answers to finding 2 and left 1 finding as is.`);
    const series = { commits: [{ sha: 'c'.repeat(40), revision: 'change', subject: 'feat: The change' }, { sha: 'a'.repeat(40), revision: 0, subject: 'fix: Guard the null' }], from: '2'.repeat(40), to: 'a'.repeat(40) };
    const committed = briefOf(decidedFixRun().add('commits.created', series).fold());
    assert.match(committed.status.text, /It fixed 1, against a written rule, and the fixes are committed\./);
    assert.ok(!committed.needs.some((need) => need.condition === 'uncommitted'), 'no patch is left to commit');
    assert.match(committed.needs.find((need) => need.condition === 'departure')!.lines[0]!, /The fix is committed\.$/);
  });

  it('gives an open question the item of rank 6 when deep-review\'s choice is another option, and of rank 7 when it is the default (R3)', () => {
    const brief = briefOf(answerable());
    const [, asked] = items(brief);
    assert.deepEqual(asked, [
      '**Finding 2 asks you a question, and deep-review\'s choice is not its default.** Should parse accept an empty input?',
      'Option 1, the default, in place now: keep accepting it. Cost: callers that pass one now see the change. Rule: parse rejects an empty input.',
      'Option 2, deep-review\'s choice: accept it and return an empty result. Cost: an empty input passes silently. Rule: parse accepts an empty input.',
      `If you do nothing, option 1 stays, and deep-review's choice is option 2. To take it: \`deep-review answer --run ${run(answerable())} --finding 2 --option 2\`.`,
    ]);
    assert.equal(brief.needs[1]!.rank, 6);
    const same = { ...askDecision('SWEEP-1', false), ask: { ...(askDecision('SWEEP-1', false).ask as Record<string, unknown>), recommended: 0 } };
    const choice = briefOf(readOnlyReported([decisions[0], same]).fold());
    const item = choice.needs.find((need) => need.finding === 2)!;
    assert.equal(item.rank, 7);
    assert.equal(item.lines[1], 'Option 1, the default, in place now, deep-review\'s choice: keep accepting it. Cost: callers that pass one now see the change. Rule: parse rejects an empty input.');
    assert.match(item.lines.at(-1)!, /^If you do nothing, option 1 stays, and it is deep-review's choice\. To take another option: `deep-review answer --run \S+ --finding 2 --option <n>`, with its number\.$/);
  });

  it('says whether the tree holds the default of a question, in a run that only reviewed and after a fixer that did not apply it, and gives the question one rank (R3)', () => {
    const readOnly = briefOf(readOnlyReported([decisions[0], askDecision('SWEEP-1', true)]).fold());
    const item = readOnly.needs.find((need) => need.finding === 2)!;
    assert.equal(item.lines[1], 'Option 1, the default, which this run did not apply, since it only reviewed: reject it with an error. Cost: callers that pass one now see the change. Rule: parse rejects an empty input.');
    assert.match(item.lines.at(-1)!, /^If you do nothing, the fix pass applies option 1, and deep-review's choice is option 2\./);
    const blocked = briefOf(decidedFixRun([askDecision('RIPPLE-1', true), askDecision('SWEEP-1', false)], 'blocked').fold());
    const asked = blocked.needs.filter((need) => need.finding === 1);
    assert.deepEqual(asked.map((need) => need.condition), ['question-other'], 'the question, not unfinished work');
    assert.match(asked[0]!.lines[1]!, /^Option 1, the default, which no fixer applied: /);
  });

  it('gives an open fix against a written rule its rule, where it is written, why, and both commands (R3)', () => {
    const state = decidedFixRun().fold();
    assert.deepEqual(items(briefOf(state))[0], [
      '**Finding 1 is fixed against a written rule.** The fix is in your working tree.',
      'The rule: parse throws on a null input',
      'Where it is written: docs/parse.md',
      'Why deep-review went against it: every caller passes the null on an empty input',
      `If you do nothing, the fix stays, and the rule stays as it is written. To keep the fix and change the rule: \`deep-review answer --run ${run(state)} --finding 1 --accept\`. To follow the rule: \`deep-review answer --run ${run(state)} --finding 1 --reject\`.`,
    ]);
  });

  it('gives work the run did not finish an item of rank 4: a fix no fixer applied, the run budget among the reasons, with no local path (R2)', () => {
    const blocked = briefOf(decidedFixRun(plain(), 'blocked').fold());
    assert.deepEqual(blocked.needs.filter((need) => need.rank === 4).map((need) => need.lines[0]), ['**Finding 1 is not fixed: its fixer could not apply it.** If you do nothing, the finding stays as it is.']);
    assert.match(blocked.needsLine, /^Before a merge: 1 piece of work not finished and 1 question whose default is not deep-review's choice\. The edits of this run made no check fail, and the run left no document out of date\.$/);
    const state = decidedFixRun(plain()).fold();
    const fix = state.review!.fix!;
    const stopped = briefOf({ ...state, review: { ...state.review!, fix: { ...fix, answers: { ...fix.answers, fixes: {} }, notAttempted: { ...fix.notAttempted, fixes: { 'c1-1': { cause: 'budget' as const, reason: 'spent 31 USD of 30 USD' } } } } } } as RunState);
    assert.equal(stopped.needs.find((need) => need.rank === 4)!.lines[0], '**Finding 1 is not fixed: the run budget stopped the fixes before it, and the end of the report gives the command that continues them.** If you do nothing, the finding stays as it is.');
    assert.doesNotMatch(briefMarkdown(stopped).join('\n'), /node |main\.mjs|\/w\b/);
  });

  it('gives the edits of a fixer that did not finish an item, when no later fixer of the same work answered, and names them to read first when one did (R2)', () => {
    const state = decidedFixRun().fold();
    const fix = state.review!.fix!;
    const answered = fix.revisions[0]!;
    const attempt = (key: string): unknown => ({ ...answered, source: { kind: 'attempt', key, workerId: worker(60) } });
    const left = briefOf({ ...state, review: { ...state.review!, fix: { ...fix, revisions: [answered, attempt('c9-1')] } } } as RunState);
    assert.deepEqual(left.needs.filter((need) => need.condition === 'unfinished-edits').map((need) => need.lines[0]), ['**Patch 2 holds edits of a fixer that did not finish, for finding 1.** No later fixer of the same work answered. If you do nothing, the edits are committed as they are.']);
    const finished = briefOf({ ...state, review: { ...state.review!, fix: { ...fix, revisions: [answered, attempt('c1-1')] } } } as RunState);
    assert.ok(!finished.needs.some((need) => need.condition === 'unfinished-edits'));
    assert.equal(finished.needs.find((need) => need.condition === 'uncommitted')!.lines[0], `**Review the 2 uncommitted patches, then commit them.** Read first patch 2, edits of a fixer that did not finish, which a later fixer of the same work completed. If you do nothing, the fixes stay uncommitted in your working tree. To commit them: \`deep-review commit --run ${run(state)}\`.`);
  });

  it('gives a document left out of date an item with its facts, and names the fix of a finding the verifier did not confirm to read first (R2)', () => {
    const brief = briefOf(documentedFixRun([{ file: './docs/a.md', what: 'parse throws on a null' }], documentationStepAnswering([['doc-1', 'deferred'], ['search', 'already-applied']])).fold());
    assert.deepEqual(brief.needs.filter((need) => need.condition === 'document').map((need) => need.lines[0]), ['**`docs/a.md` is out of date.** Parse throws on a null (a fixer). The documentation step left it: doc-1 deferred. If you do nothing, the document stays out of date.']);
    const state = decidedFixRun(plain()).fold();
    const fix = state.review!.fix!;
    const unconfirmed = briefOf({ ...state, review: { ...state.review!, fix: { ...fix, revisions: [{ ...fix.revisions[0]!, change: { ...fix.revisions[0]!.change, findings: ['SWEEP-1'] } }] } } } as RunState);
    assert.match(unconfirmed.needs.find((need) => need.condition === 'uncommitted')!.lines[0]!, /Read first patch 1, the fix of finding 2, which the verifier did not confirm\./);
  });

  it('says that nothing needs the person, and names the conditions it checked, in a fix run and in a run that only reviewed (R2)', () => {
    const series = { commits: [{ sha: 'c'.repeat(40), revision: 'change', subject: 'feat: The change' }, { sha: 'a'.repeat(40), revision: 0, subject: 'fix: Guard the null' }], from: '2'.repeat(40), to: 'a'.repeat(40) };
    const done = briefOf(decidedFixRun([decisions[0], decisions[1]]).add('commits.created', series).fold());
    assert.deepEqual(done.needs, []);
    assert.equal(done.needsLine, 'Nothing needs you. The edits of this run made no check fail, no check fails because of the change or is left without a comparison with the base, the run left no work unfinished and no document out of date, no fix against a written rule waits for your review, no question is open, and every fix is committed.');
    const readOnly = briefOf(readOnlyReported([decisions[1], { ...decisions[1], id: 'RIPPLE-1' }]).fold());
    assert.equal(readOnly.needsLine, 'Nothing needs you. No fix against a written rule waits for your review, no question is open, and deep-review decided no fix.');
    assert.deepEqual(briefMarkdown(readOnly).slice(briefMarkdown(readOnly).indexOf('## What needs you'), briefMarkdown(readOnly).indexOf('## Before you merge')), ['## What needs you', '', readOnly.needsLine, '']);
  });

  it('gives a run that only reviewed the item that applies its fixes last, and what it would fix in its table (R14)', () => {
    const brief = briefOf(answerable());
    assert.equal(brief.needs.at(-1)!.lines[0], '**Apply the 1 fix that deep-review decided.** This run only reviewed. If you do nothing, the change stays as it is. To fix, ask your agent to continue this review with fixes, or run `deep-review review --fix` on the same change with the same runtime.');
    const lines = briefMarkdown(brief);
    assert.deepEqual(lines.slice(lines.indexOf('## What deep-review would fix')), ['## What deep-review would fix', '', '| Finding | The planned fix |', '|---|---|', '| [1](#finding-1), major, against a written rule | guard the null once, before parse reads it |']);
    assert.match(lines[lines.indexOf('## Before you merge') + 2]!, /^No check ran: this run only reviewed\. The major findings stay open: finding 1\./);
  });

  it('gives each applied fix a row with how its fixer reports checking it and its patch, links in the report and plain numbers in the chat (R5)', () => {
    const state = decidedFixRun().fold();
    const fix = state.review!.fix!;
    const validated = (methods: readonly string[]): Brief => {
      const answer = fix.answers.fixes['c1-1']!;
      const findings = answer.findings.map((finding) => ({ ...finding, validation: methods.map((method) => ({ method, source: 'test/a.test.ts', evidence: 'it ran' })) }));
      return briefOf({ ...state, review: { ...state.review!, fix: { ...fix, answers: { ...fix.answers, fixes: { 'c1-1': { ...answer, findings } } } } } } as RunState);
    };
    const row = (brief: Brief, form: 'report' | 'chat' = 'report'): string => briefMarkdown(brief, form).at(-1)!;
    assert.equal(row(validated(['limited', 'old-code', 'existing'])), '| [1](#finding-1), major, against a written rule | fix: Guard the null | a new test fails on the code before the fix; existing tests and checks rerun; a limited check | 1 |');
    assert.equal(row(validated([]), 'chat'), '| 1, major, against a written rule | fix: Guard the null | none reported | 1 |');
    assert.ok(briefMarkdown(validated([])).includes('| Finding | The fix | How its fixer reports checking it | Patch |'), 'the heading says the fixer reports it');
  });

  it('shows at most ten fixes, and names the others in one row, marking a plausible one, which it says the verifier did not confirm (R5)', () => {
    const brief = briefOf(decidedFixRun().fold());
    const fixes = Array.from({ length: 12 }, (_, index) => ({ finding: index + 1, severity: 'minor' as const, plausible: index === 11, againstRule: false, subject: `fix ${String(index + 1)}`, kinds: [], patches: [index + 1] }));
    const lines = briefMarkdown({ ...brief, fixes });
    const table = lines.slice(lines.indexOf('## What deep-review fixed')).filter((line) => line.startsWith('| ') && !line.startsWith('| Finding'));
    assert.equal(table.length, 11);
    assert.equal(table.at(-1), '| 2 more: findings 11 and 12 | finding 12, plausible | | |');
    assert.equal(lines.at(-1), 'A plausible finding is one that the verifier did not confirm.');
  });

  it('shows at most three decisions and three items of unfinished work, and names the others in one more item each (R2, R3)', () => {
    const brief = briefOf(answerable());
    const question = brief.needs.find((need) => need.finding === 2)!;
    const decided = Array.from({ length: 5 }, (_, index) => ({ ...question, finding: index + 3 }));
    const documents = Array.from({ length: 5 }, (_, index) => ({ rank: 4 as const, condition: 'document' as const, finding: null, check: null, document: `docs/${String(index)}.md`, patch: null, lines: [`**\`docs/${String(index)}.md\` is out of date.**`] }));
    const lines = briefMarkdown({ ...brief, needs: [...documents, ...decided] });
    assert.ok(lines.includes('4. **2 more:** `docs/3.md` and `docs/4.md`.'), lines.join('\n'));
    assert.ok(lines.includes('8. **2 more decisions:** findings 6 and 7. `deep-review report --finding <number>` prints each with its options and commands.'), lines.join('\n'));
  });

  it('holds the brief to 72 lines and the chat form to 52 for any number of findings, with every list at its cap (R1, R12)', () => {
    const brief = briefOf(withAccount(decidedFixRun().fold(), given()));
    const long = (word: string): string => `${word} `.repeat(80).trim();
    const question = { ...brief.needs.find((need) => need.finding === 2)!, lines: [long('lead'), ...Array.from({ length: 4 }, () => long('option')), long('nothing')] };
    const check = (kind: 'build' | 'typecheck' | 'lint' | 'test', condition: 'edits' | 'change-breaks' | 'not-compared', rank: 1 | 2 | 3) => ({ rank, condition, finding: null, check: kind, document: null, patch: null, lines: [long(kind)] });
    const needs = [
      check('build', 'edits', 1), check('typecheck', 'change-breaks', 2), check('lint', 'change-breaks', 2), check('test', 'not-compared', 3),
      ...Array.from({ length: 6 }, (_, index) => ({ rank: 4 as const, condition: 'unapplied-fix' as const, finding: index + 1, check: null, document: null, patch: null, lines: [long('work')] })),
      ...Array.from({ length: 10 }, (_, index) => ({ ...question, finding: index + 1 })),
      { rank: 8 as const, condition: 'uncommitted' as const, finding: null, check: null, document: null, patch: null, lines: [long('commit')] },
    ];
    const checks = (['build', 'typecheck', 'lint', 'test'] as const).map((kind) => ({ ...brief.checks[0]!, kind }));
    const fixes = Array.from({ length: 20 }, (_, index) => ({ finding: index + 1, severity: 'minor' as const, plausible: true, againstRule: false, subject: long('subject'), kinds: [], patches: [index + 1] }));
    const full: Brief = { ...brief, title: long('title'), needs, checks, fixes, notExamined: Array.from({ length: 30 }, () => long('gap')) };
    assert.equal(briefMarkdown(full).length, briefLineLimit, 'every list at its cap reaches the maximum');
    assert.ok(briefChatForm(full).length <= chatLineLimit, String(briefChatForm(full).length));
    assert.ok(briefChatForm(briefOf(answerable())).length < chatLineLimit);
  });

  it('gives the chat form the title with the run, the line of the change, the parts of the brief made by the same functions, and the line of the fixes, with no link (R12)', () => {
    const state = withAccount(decidedFixRun().fold(), given());
    const brief = briefOf(state);
    const chat = briefChatForm(brief);
    const markdown = briefMarkdown(brief, 'chat');
    assert.equal(chat[0], `Parse an empty input (run ${run(state)})`);
    assert.equal(chat[1], 'The change before the fixes: The parser returns no value for an empty input, where it threw before.');
    assert.equal(chat[3], brief.status.text);
    const parts = markdown.slice(markdown.indexOf('## What needs you'), markdown.indexOf('## What deep-review fixed'));
    assert.deepEqual(chat.slice(5, 5 + parts.length), parts, 'What needs you and Before you merge as the brief has them');
    assert.equal(chat.at(-1), `What deep-review fixed: deep-review report --fixes --run ${run(state)}`);
    assert.doesNotMatch(chat.join('\n'), /\]\(#|RIPPLE-|SWEEP-/);
  });

  // The title line and the line of the change of the chat form keep the rules of the short form they replace (R4, R5 of the questions in the chat).
  it('gives the whole title on its first line, which only the line\'s limit cuts', () => {
    const run = answerable().id.slice(0, 8);
    // 98 characters: past the 80 the triage is asked for, which cut the gate run's title in the short form.
    const title = 'Give each run a brief: the change\'s account, a report that starts with it, and a report command';
    assert.ok(title.length > accountLimits.title);
    assert.equal(briefChatForm(briefOf(withAccount(answerable(), given({ ...changeReading, title } as unknown as ChangeReading))))[0], `${title} (run ${run})`);
    const first = briefChatForm(briefOf(withAccount(answerable(), given({ ...changeReading, title: 'word '.repeat(60).trim() } as unknown as ChangeReading))))[0]!;
    assert.ok(first.length <= shortLineLimit && first.endsWith('...'), first);
  });

  it('keeps the first sentence of the change whole up to 400 characters, and cuts a longer one at a word (R4 of the questions in the chat)', () => {
    const changeLine = (what: string): string => briefChatForm(briefOf(withAccount(answerable(), given({ ...changeReading, what } as unknown as ChangeReading))))[1]!;
    assert.equal(changeLineLimit, 400);
    const sentence = (length: number): string => `${'Reads the input '.repeat(40).slice(0, length - 1).trimEnd()}.`;
    const three = sentence(300);
    assert.equal(changeLine(`${three} More.`), `The change: ${three}`, 'a sentence of 300 characters, past the 200 of the other lines');
    assert.ok(changeLine(`${three} More.`).length > shortLineLimit);
    const five = sentence(500);
    const cut = changeLine(`${five} More.`);
    assert.ok(cut.startsWith('The change: ') && cut.endsWith('...'), cut);
    const kept = cut.slice('The change: '.length, -3);
    assert.ok(kept.length + 3 <= changeLineLimit, 'the limit counts the sentence');
    assert.ok(five.startsWith(kept) && five[kept.length] === ' ', 'cut at a word, with three periods');
  });

  it('counts the limit of the line of the change on the sentence alone, past the mark of the change before the fixes (R4, R5 of the questions in the chat)', () => {
    const changeLine = (state: RunState, what: string): string => briefChatForm(briefOf(withAccount(state, given({ ...changeReading, what } as unknown as ChangeReading))))[1]!;
    const sentence = (length: number): string => `${'Reads the input '.repeat(40).slice(0, length - 1).trimEnd()}.`;
    const whole = sentence(changeLineLimit - 10);
    assert.equal(whole.length, changeLineLimit - 10);
    assert.equal(changeLine(answerable(), `${whole} More.`), `The change: ${whole}`);
    assert.equal(changeLine(decidedFixRun().fold(), `${whole} More.`), `The change before the fixes: ${whole}`);
    const longer = sentence(changeLineLimit + 20);
    const cut = changeLine(decidedFixRun().fold(), `${longer} More.`);
    assert.ok(cut.startsWith('The change before the fixes: ') && cut.endsWith('...'), cut);
    const kept = cut.slice('The change before the fixes: '.length, -3);
    assert.ok(kept.length + 3 <= changeLineLimit && longer.startsWith(kept) && longer[kept.length] === ' ', 'cut at a word');
  });

  it('says the first sentence of the change, past an abbreviation and across a line or paragraph separator', () => {
    const changeLine = (what: string): string => briefChatForm(briefOf(withAccount(answerable(), given({ ...changeReading, what } as unknown as ChangeReading))))[1]!;
    assert.equal(changeLine('Adds a flag, e.g. --json, to report. More.'), 'The change: Adds a flag, e.g. --json, to report.');
    assert.equal(changeLine('Reads i.e. parses the input, vs. the old cf. path. More.'), 'The change: Reads i.e. parses the input, vs. the old cf. path.');
    assert.equal(changeLine('Keeps the paths, the names, etc. in the report. More.'), 'The change: Keeps the paths, the names, etc. in the report.');
    assert.equal(changeLine('Keeps the paths, the names, etc. More.'), 'The change: Keeps the paths, the names, etc.', 'etc. ends a sentence before an upper-case word');
    assert.equal(changeLine('Closes issue No. 5 of the parser. More.'), 'The change: Closes issue No. 5 of the parser.');
    assert.equal(changeLine('Says No. More follows.'), 'The change: Says No.', 'No. ends a sentence before a word');
    assert.equal(changeLine('Reads the input\u2028and parses it. More.'), 'The change: Reads the input and parses it.');
    assert.equal(changeLine('Reads the input \u2029 and parses it'), 'The change: Reads the input and parses it');
    assert.equal(changeLine('Is it new? Yes.'), 'The change: Is it new?');
  });


  it('names a finding by its number, with a run of three or more as a span', () => {
    assert.equal(findingWords([3]), 'finding 3');
    assert.equal(findingWords([9, 2, 5]), 'findings 2, 5 and 9');
    assert.equal(findingWords([9, 11, 12, 13, 14, 19]), 'findings 9, 11 to 14 and 19');
  });

  it('writes none of the words of the engine above the findings when the workers wrote none (R10)', () => {
    const words = /\b(departure|angle|triage|cluster|batch|attempt|phase|Held by|repair|sweep|scope)\b/i;
    const ids = /\b(CONFIRMED|PLAUSIBLE|REFUTED|[A-Z]+-\d+)\b/;
    for (const state of [answerable(), decidedFixRun().fold(), withAccount(decidedFixRun().fold(), given()), readOnlyReported().fold()]) {
      for (const line of [...briefMarkdown(briefOf(state)), ...briefChatForm(briefOf(state))]) {
        assert.doesNotMatch(line, words, line);
        assert.doesNotMatch(line, ids, line);
      }
    }
  });
});
