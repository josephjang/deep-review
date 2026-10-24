import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChangeReading, ScopeMode } from '../../src/checkpoint/events.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import type { TriageAccount } from '../../src/checkpoint/review-fold.ts';
import { briefFates, briefMarkdown, briefOf, briefShortForm, changeShapeOf, cutAtWord, gapKinds, lookConditions, shortLineLimit, type GapKind } from '../../src/review/brief.ts';
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
      assert.deepEqual(brief.change, { state: 'given', what: changeReading.what, why: changeReading.why, whyFrom: changeReading.whyFrom, restsOn: changeReading.restsOn, publicInterface: changeReading.publicInterface, wideEffect: changeReading.wideEffect });
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
      assert.equal(question.command, 'deep-review answer --finding SWEEP-1 --option 2');
      assert.equal(question.answer, null);
    });
  });

  describe('the departures (R9)', () => {
    it('shows the rule, its source, the fact against it, the fix and the commands that accept and reject it', () => {
      const [found] = briefOf(answerable()).departures;
      assert.deepEqual(found, {
        id: 'RIPPLE-1', rule: departure.rule, source: departure.source, fact: departure.reason, fix: decisions[0]!.fix!.approach,
        fate: 'not-fixed', review: null,
        accept: 'deep-review answer --finding RIPPLE-1 --accept', reject: 'deep-review answer --finding RIPPLE-1 --reject',
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

    it('leaves out a departure a person accepted or rejected, in the brief and in its short form, and keeps one nobody reviewed', () => {
      const lookAt = (state: RunState): string | undefined => briefShortForm(briefOf(state)).find((line) => line.startsWith('Look at: '));
      for (const review of ['accept', 'reject'] as const) {
        const state = decidedFixRun().add('answer.recorded', answer('RIPPLE-1', review)).fold();
        assert.ok(!briefOf(state).look.some((entry) => entry.condition === 'departure'), review);
        assert.equal(briefOf(state).departures.length, 1, `the departures part keeps it with its ${review}`);
        assert.equal(lookAt(state), 'Look at: nothing', review);
      }
      const two = readOnlyReported([{ ...decisions[0], departure }, { ...decisions[0], id: 'SWEEP-1', departure }]).add('answer.recorded', answer('RIPPLE-1', 'accept')).fold();
      assert.deepEqual(briefOf(two).look.filter((entry) => entry.condition === 'departure').map((entry) => [entry.findings, entry.text]), [[['SWEEP-1'], '1 fix goes against a written rule']], 'the unreviewed one stays, counted alone');
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
      assert.deepEqual(applied.checks, [{ kind: 'build', before: 'passed', after: 'passed' }, { kind: 'lint', before: 'passed', after: 'passed' }, { kind: 'test', before: 'passed', after: 'passed' }]);
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
      assert.deepEqual(brief.changed.checks.find((check) => check.kind === 'test'), { kind: 'test', before: 'passed', after: 'failed' });
      // With no current run, the run that checked the newest tree stands.
      const stale = { ...reopened, revisions: [...reopened.revisions, fixes] };
      assert.equal(briefOf({ ...state, review: { ...review, fix: stale } }).changed.checks.find((check) => check.kind === 'test')?.after, 'failed');
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


describe('briefShortForm (R13 of the brief of a run)', () => {
  it('says each part in a line that names its subject first, seven lines of at most 200 characters for a run that only reviews', () => {
    const lines = briefShortForm(briefOf(withAccount(answerable(), given())));
    assert.deepEqual(lines, [
      `Parse an empty input (run ${answerable().id.slice(0, 8)})`,
      'The change: The parser returns no value for an empty input, where it threw before.',
      'Questions: 1, with its default in place: SWEEP-1',
      'Against a written rule: 1 fix: RIPPLE-1',
      'Not covered: 2 gaps, the first: The FOOTGUNS angle did not run (2 attempts did not complete: failed: The answer does not match the output schema; timeout: The worker ran past its timeout). A later...',
      'Look at: 1 departure, a change to a public interface',
      'Changed: nothing; this run only reviewed',
    ]);
    for (const line of lines) assert.ok(line.length <= shortLineLimit, line);
  });

  it('gives the whole title on its first line, which only the line\'s limit cuts', () => {
    const run = answerable().id.slice(0, 8);
    // 98 characters: past the 80 the triage is asked for, which cut the gate run's title in the short form.
    const title = 'Give each run a brief: the change\'s account, a report that starts with it, and a report command';
    assert.ok(title.length > accountLimits.title);
    assert.equal(briefShortForm(briefOf(withAccount(answerable(), given({ ...changeReading, title } as unknown as ChangeReading))))[0], `${title} (run ${run})`);
    const first = briefShortForm(briefOf(withAccount(answerable(), given({ ...changeReading, title: 'word '.repeat(60).trim() } as unknown as ChangeReading))))[0]!;
    assert.ok(first.length <= shortLineLimit && first.endsWith('...'), first);
  });

  it('says the first sentence of the change, past an abbreviation and across a line or paragraph separator', () => {
    const changeLine = (what: string): string => briefShortForm(briefOf(withAccount(answerable(), given({ ...changeReading, what } as unknown as ChangeReading))))[1]!;
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

  it('says the defaults are in place only when the tree holds each open one, as the headline does', () => {
    const questionsLine = (state: RunState): string => briefShortForm(briefOf(state))[2]!;
    assert.equal(questionsLine(readOnlyReported([decisions[0], askDecision('SWEEP-1', true)]).fold()), 'Questions: 1, with a default: SWEEP-1', 'a run that only reviewed applied no default that edits');
    const fixed = (status: string): RunState => decidedFixRun([askDecision('RIPPLE-1', true), askDecision('SWEEP-1', false)], status).fold();
    assert.equal(questionsLine(fixed('applied')), 'Questions: 2, each with a default in place: RIPPLE-1 and SWEEP-1');
    assert.match(briefOf(fixed('applied')).headline.text, /Nothing waits for you: each question has a default in place\.$/, 'several questions read as several');
    assert.equal(questionsLine(fixed('deferred')), 'Questions: 2, each with a default: RIPPLE-1 and SWEEP-1', 'the fixer put off one default');
    for (const status of ['applied', 'deferred']) assert.equal(questionsLine(fixed(status)).includes('in place'), briefOf(fixed(status)).headline.text.endsWith('default in place.'), status);
  });

  it('shows at most 8 ids of a list and counts the rest, and keeps its lines however many findings the run has', () => {
    const brief = briefOf(answerable());
    const question = brief.questions[0]!;
    const many = { ...brief, questions: Array.from({ length: 12 }, (_, index) => ({ ...question, id: `SWEEP-${String(index + 1)}` })) };
    const lines = briefShortForm(many);
    assert.equal(lines.length, 7);
    assert.equal(lines[2], 'Questions: 12, each with a default in place: SWEEP-1, SWEEP-2, SWEEP-3, SWEEP-4, SWEEP-5, SWEEP-6, SWEEP-7, SWEEP-8 and 4 more');
    const long = { ...brief, title: 'word '.repeat(80), notCovered: [{ kind: 'excluded' as const, text: 'path '.repeat(100) }] };
    for (const line of briefShortForm(long)) assert.ok(line.length <= shortLineLimit, line);
  });

  it('says so on a line with nothing to say, and of a run that fixed, what it applied and where the edits are', () => {
    const state = answerable();
    const review = state.review!;
    const quiet = briefShortForm(briefOf({ ...state, review: { ...review, anglesNotRun: {}, plans: { ...review.plans, 'sweep-verification': [] }, decisions: [decisions[1]!] as never } }));
    assert.deepEqual(quiet.slice(2), ['Questions: none', 'Against a written rule: no fix', 'Not covered: nothing', 'Look at: nothing', 'Changed: nothing; this run only reviewed']);
    assert.equal(quiet[1], 'The change: not recorded; an engine before the account reviewed this run');
    assert.equal(briefShortForm(briefOf(decidedFixRun().fold())).at(-1), 'Changed: 1 fix, not committed');
    assert.equal(briefShortForm(briefOf(decidedFixRun(answerableDecisions(), 'deferred').fold())).at(-1), 'Changed: 0 fixes, 1 fix not applied');
    const answered = briefShortForm(briefOf(readOnlyReported(answerableDecisions()).add('answer.recorded', answer('SWEEP-1', 1)).add('answer.recorded', answer('RIPPLE-1', 'accept')).fold()));
    assert.deepEqual(answered.slice(2, 4), ['Questions: none open; each is answered', 'Against a written rule: no fix left to review']);
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

describe('the words of a question and a departure once a person answered (R8, R9 of the brief of a run)', () => {
  const markdown = (state: RunState): string => briefMarkdown(briefOf(state)).join('\n');

  it('says an answered question\'s answer first, and no option in place now', () => {
    const passed = passToReport(decidedFixRun().add('answer.recorded', answer('SWEEP-1', 1)).add('answer.pass', { ids: ['SWEEP-1'] }), 1, [['SWEEP-1', 'applied']], 2).fold();
    const text = markdown(passed);
    assert.match(text, /^### 1\. Should parse accept an empty input\? \(\[SWEEP-1\]\(#finding-sweep-1\)\)\n\nAnswered: option 2 on [^;]+; the tree holds it\. deep-review's choice was option 2\.$/m);
    assert.doesNotMatch(text, /In place now/);
    assert.match(text, /^\| 2, your answer, deep-review's choice \| /m);
    assert.equal(briefOf(passed).questions[0]!.answer?.kind, 'option');
  });

  it('calls a default that edits the code the default, not in place, in a run that only reviewed', () => {
    const state = readOnlyReported([decisions[0], askDecision('SWEEP-1', true)]).fold();
    const brief = briefOf(state);
    assert.equal(brief.questions[0]!.defaultApplied, false);
    const text = markdown(state);
    assert.match(text, /^The default: option 1, because it is the easiest to take back; this run only reviewed, so `review --fix` applies it\. deep-review's choice: option 2\.$/m);
    assert.match(text, /^\| 1, the default \| /m);
    assert.match(brief.headline.text, /Nothing waits for you: the question has a default\.$/);
    assert.equal(briefOf(readOnlyReported([decisions[0], askDecision('SWEEP-1', false)]).fold()).questions[0]!.defaultApplied, true, 'a default that keeps the code is in place');
  });

  it('says a departure a person rejected now follows the rule, and whether the tree holds that fix', () => {
    const readOnly = readOnlyReported(answerableDecisions()).add('answer.recorded', answer('RIPPLE-1', 'reject')).fold();
    assert.match(markdown(readOnly), /^Why deep-review went against it: every caller passes the null on an empty input\. You chose to follow the rule instead; `review --fix` applies the fix that follows it\.$/m);
    const owed = decidedFixRun().add('answer.recorded', answer('RIPPLE-1', 'reject')).fold();
    assert.match(markdown(owed), /^Why deep-review went against it: every caller passes the null on an empty input\. You chose to follow the rule instead; no fixer has applied the fix that follows it yet\.$/m);
    const held = passToReport(decidedFixRun().add('answer.recorded', answer('RIPPLE-1', 'reject')).add('answer.pass', { ids: ['RIPPLE-1'] }), 1, [['RIPPLE-1', 'applied']], 2).fold();
    assert.match(markdown(held), /^Why deep-review went against it: every caller passes the null on an empty input\. You chose to follow the rule instead; the tree holds the fix that follows it\.$/m);
    assert.doesNotMatch(markdown(held), /A fixer applied it\./);
    const accepted = decidedFixRun().add('answer.recorded', answer('RIPPLE-1', 'accept')).fold();
    assert.match(markdown(accepted), /^Why deep-review went against it: every caller passes the null on an empty input\. A fixer applied it\.$/m, 'an acceptance keeps the fix as applied');
  });

  it('keeps a default the fix pass applied in place when an answer pass cannot apply the person\'s answer, and says the answer went to the fixer', () => {
    const asked = decidedFixRun([askDecision('RIPPLE-1', true), askDecision('SWEEP-1', false)]).add('answer.recorded', answer('RIPPLE-1', 1)).add('answer.pass', { ids: ['RIPPLE-1'] });
    const brief = briefOf(passToReport(asked, 1, [['RIPPLE-1', 'blocked']], 1).fold());
    const question = brief.questions.find((entry) => entry.id === 'RIPPLE-1')!;
    assert.equal(question.defaultApplied, true, 'the fix pass applied the default, and the tree still holds it');
    assert.equal(question.answer?.applied, false);
    assert.deepEqual(brief.notCovered.filter((gap) => gap.kind === 'fix').map((gap) => gap.text), ['The answer on RIPPLE-1 went to a fixer, and its fixer could not apply it.']);
    assert.deepEqual(brief.changed.blocked, ['RIPPLE-1'], 'the changed lists keep the last pass\'s outcome, as Fixes does');
  });

  it('keeps the fix pass\'s fate of a departing fix when an answer pass cannot apply the fix a person chose that follows the rule', () => {
    const rejected = decidedFixRun().add('answer.recorded', answer('RIPPLE-1', 'reject')).add('answer.pass', { ids: ['RIPPLE-1'] });
    const state = passToReport(rejected, 1, [['RIPPLE-1', 'blocked']], 1).fold();
    const brief = briefOf(state);
    assert.equal(brief.departures[0]!.fate, 'applied', 'the fix pass applied the departing fix');
    assert.deepEqual(brief.notCovered.filter((gap) => gap.kind === 'fix').map((gap) => gap.text), ['The answer on RIPPLE-1 went to a fixer, and its fixer could not apply it.']);
    assert.match(markdown(state), /^Why deep-review went against it: every caller passes the null on an empty input\. You chose to follow the rule instead; no fixer has applied the fix that follows it yet\.$/m);
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
    assert.equal(briefOf(clean).headline.text, 'Nothing needs you: no question is open, no fix that goes against a written rule waits for your review, and the run left no document out of date that it knows of.');
    assert.equal(briefOf(documentedFixRun(stale, documentationStepAnswering([['doc-1', 'deferred'], ['search', 'already-applied']]), decisions).fold()).headline.text, '1 thing needs you: 1 document that the edits of the run left out of date. Nothing waits for you: the run went on as it decided.');
  });

  it('keeps the sentence of a run that only reviews, which edits nothing', () => {
    const brief = briefOf(readOnlyReported().fold());
    assert.equal(brief.headline.text, 'Nothing needs you: no question is open, and no fix that goes against a written rule waits for your review.');
    assert.deepEqual(brief.documents, []);
    assert.equal(brief.changed.documentation, null);
    const short = briefShortForm(brief);
    assert.equal(short.length, 7, 'seven lines');
    assert.ok(!short.some((entry) => entry.startsWith('Documents')));
    assert.doesNotMatch(briefMarkdown(brief).join('\n'), /Documents left out of date|documentation step/);
  });

  it('lists each document after the departures, its facts with who reported each, then why the run left it', () => {
    const text = briefMarkdown(briefOf(leftOne())).join('\n');
    assert.match(text, /\n## Documents left out of date \(1\)\n\nThe edits of this run made each document below out of date, and the run did not bring it in line\. Bring each in line before a merge\.\n\n- `docs\/a\.md`: parse throws on a null \(a fixer\)\. The documentation step left it: doc-1 deferred\.\n/);
    const order = ['\n## Fixes that go against a written rule', '\n## Documents left out of date', '\n## What the review did not cover'].map((marker) => text.indexOf(marker));
    assert.ok(order.every((position, index) => position > 0 && (index === 0 || order[index - 1]! < position)), JSON.stringify(order));
  });

  it('gives a fix run an eighth line of the short form, after the departures, naming at most eight files and counting the rest', () => {
    const short = briefShortForm(briefOf(leftOne()));
    assert.equal(short.length, 8);
    assert.equal(short[4], 'Documents left out of date: 1: docs/a.md');
    assert.ok(short[3]!.startsWith('Against a written rule: '));
    assert.equal(briefShortForm(briefOf(documentedFixRun([], undefined, decisions).fold()))[4], 'Documents left out of date: none');
    const many = documentedFixRun(Array.from({ length: 10 }, (_, index) => line(`docs/${String(index + 1)}.md`, 'stale')), (history) => history.start('documentation').add('documentation.planned', { items: documentationItems(history) }).add('unit.unattempted', { phase: 'documentation', key: 'documentation', cause: 'budget', reason: 'spent' }, 2).add('worktree.checked', endCheck('documentation'), 7).finish('documentation', 'degraded'), decisions).fold();
    assert.equal(briefShortForm(briefOf(many))[4], 'Documents left out of date: 10: docs/1.md, docs/2.md, docs/3.md, docs/4.md, docs/5.md, docs/6.md, docs/7.md, docs/8.md and 2 more');
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
    // A document it deferred and listed in its drift again in another spelling is one document, as the part counts it.
    const respelled = documentedFixRun(stale, documentationStepAnswering([['doc-1', 'deferred'], ['search', 'already-applied']], { drift: [line('./Docs/A.md', 'parse throws on a null')] })).fold();
    assert.deepEqual([changed(respelled), briefOf(respelled).documents.length], ['The documentation step left 1 document out of date.', 1]);
    assert.equal(changed(documentedFixRun().fold()), 'The documentation step found no document out of date.');
    const failedTwice = documentedFixRun(stale, (history) => history.start('documentation').add('documentation.planned', { items: documentationItems(history) }).add('unit.unattempted', { phase: 'documentation', key: 'documentation', cause: 'failures', reason: '2 attempts did not complete' }, 2).add('worktree.checked', endCheck('documentation'), 7).finish('documentation', 'degraded')).fold();
    assert.equal(changed(failedTwice), 'The documentation step did not run: its worker failed twice.');
    assert.match(briefMarkdown(briefOf(failedTwice)).join('\n'), /The checks passed before and after the fixes\. The documentation step did not run: its worker failed twice\.$/m);
  });

  it('gives the step that did not answer a gap of its own, and none to one with nothing to do or a run before the step', () => {
    const failedTwice = documentedFixRun(stale, (history) => history.start('documentation').add('documentation.planned', { items: documentationItems(history) }).add('unit.unattempted', { phase: 'documentation', key: 'documentation', cause: 'failures', reason: '2 attempts did not complete' }, 2).add('worktree.checked', endCheck('documentation'), 7).finish('documentation', 'degraded')).fold();
    assert.deepEqual(briefOf(failedTwice).notCovered.filter((gap) => gap.kind === 'documentation').map((gap) => gap.text), ['The documentation step did not run: its worker failed twice. The documents left are in Documents left out of date.']);
    assert.deepEqual(briefOf(documentedFixRun().fold()).notCovered.filter((gap) => gap.kind === 'documentation'), [], 'a step that answered');
    assert.deepEqual(briefOf(decidedFixRun().fold()).notCovered.filter((gap) => gap.kind === 'documentation'), [], 'a run an engine before the step configured');
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
    assert.equal(briefShortForm(brief)[4], 'Documents left out of date: 1: ./docs/a.md');
  });

  it('keeps the short form one line per part when a fixer names a file with a line break', () => {
    const state = decidedFixRun().fold();
    const fix = state.review!.fix!;
    const broken = { ...state, review: { ...state.review!, fix: { ...fix, answers: { ...fix.answers, fixes: { 'c1-1': { ...fix.answers.fixes['c1-1']!, drift: [line('docs/a\r\nb.md', 'stale')] } } } } } } as RunState;
    const short = briefShortForm(briefOf(broken));
    assert.equal(short.length, 8);
    assert.ok(short.every((entry) => !/[\r\n]/.test(entry)), JSON.stringify(short));
    assert.equal(short[4], 'Documents left out of date: 1: docs/a b.md');
  });
});
