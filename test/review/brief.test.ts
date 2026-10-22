import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChangeReading } from '../../src/checkpoint/events.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import type { TriageAccount } from '../../src/checkpoint/review-fold.ts';
import { briefLimits, briefMarkdown, briefOf, briefShortForm, cutAtWord, gapKinds, lookConditions, shortLineLimit, type GapKind } from '../../src/review/brief.ts';
import { answer, answerableDecisions, askDecision, changeReading, decidedFixRun, decisions, departure, launch, passToReport, readOnlyReported, worker } from '../helpers/review-history.ts';

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

  it('titles the run with the triage\'s title, cut at a word to 80 characters', () => {
    assert.equal(briefOf(withAccount(answerable(), given())).title, 'Parse an empty input');
    const long = briefOf(withAccount(answerable(), given({ ...changeReading, title: `${'word '.repeat(30)}end` } as unknown as ChangeReading))).title;
    assert.ok(long.length <= briefLimits.title && long.endsWith('...'), long);
  });

  it('counts the open questions and departures in its headline, and says that nothing waits', () => {
    const brief = briefOf(answerable());
    assert.deepEqual([brief.headline.questions, brief.headline.departures], [1, 1]);
    assert.equal(brief.headline.text, '2 things need you: 1 question and 1 fix that goes against a written rule. Nothing waits for you: each question has a default in place.');
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
    it('shows what the change does and why with their sources, and cuts each at a word to its limit', () => {
      const brief = briefOf(withAccount(answerable(), given()));
      assert.deepEqual(brief.change, { state: 'given', what: changeReading.what, why: changeReading.why, whyFrom: changeReading.whyFrom, restsOn: changeReading.restsOn, publicInterface: changeReading.publicInterface, wideEffect: changeReading.wideEffect, cut: false, titleCut: false });
      const what = `${'The parser reads input. '.repeat(40)}`.trim();
      const why = `${'Because it must. '.repeat(40)}`.trim();
      const cut = briefOf(withAccount(answerable(), given({ ...changeReading, what, why } as unknown as ChangeReading))).change;
      assert.ok(cut.state === 'given');
      assert.ok(cut.what.length <= briefLimits.what && cut.what.endsWith('...') && what.startsWith(cut.what.slice(0, -3)), cut.what);
      assert.ok(cut.why !== null && cut.why.length <= briefLimits.why && cut.why.endsWith('...'), cut.why ?? '');
      assert.equal(cut.cut, true);
    });

    it('points at the whole account when only the title was cut, and keeps `cut` for what and why', () => {
      const whole = 'The whole account is under [The change, in full](#the-change-in-full).';
      const title = `Give each run a brief ${'word '.repeat(20)}end`;
      assert.ok(title.length > briefLimits.title);
      const brief = briefOf(withAccount(answerable(), given({ ...changeReading, title } as unknown as ChangeReading)));
      assert.ok(brief.change.state === 'given' && brief.change.titleCut && !brief.change.cut, JSON.stringify(brief.change));
      assert.ok(briefMarkdown(brief).some((line) => line.endsWith(whole)), 'the brief links to the whole account');
      const short = briefOf(withAccount(answerable(), given()));
      assert.ok(!briefMarkdown(short).some((line) => line.includes(whole)), 'nothing was cut, so no link');
    });

    it('says an older run has no core, and titles it from its scope', () => {
      const brief = briefOf(answerable());
      assert.deepEqual(brief.change, { state: 'unrecorded' });
      assert.equal(brief.title, `The change from ${'1'.repeat(8)} to ${'2'.repeat(8)}`);
      assert.deepEqual(briefOf(withAccount(answerable(), { kind: 'none' })).change, { state: 'none' });
    });

    it('titles a change of the working tree as the uncommitted change on its head', () => {
      const state = answerable();
      assert.equal(briefOf({ ...state, scope: { ...state.scope!, base: state.scope!.head } }).title, `The uncommitted change on ${state.scope!.head.slice(0, 8)}`);
    });
  });

  describe('the questions (R7, R8)', () => {
    it('names the option in place now, deep-review\'s choice, each option with its cost and rule, and the command that takes the choice', () => {
      const [question] = briefOf(answerable()).questions;
      assert.ok(question !== undefined);
      assert.equal(question.id, 'SWEEP-1');
      assert.equal(question.question, 'Should parse accept an empty input?');
      assert.deepEqual([question.inPlace, question.choice], [1, 2]);
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

    it('says of a question whose default a fixer did not apply that the default went to a fixer, not that it was decided as a fix', () => {
      const asked = briefOf(decidedFixRun([askDecision('RIPPLE-1', true), askDecision('SWEEP-1', false)], 'deferred').fold());
      assert.ok(asked.notCovered.some((gap) => gap.kind === 'fix' && gap.text === 'The default of the question on RIPPLE-1 went to a fixer, and its fixer put it off.'), JSON.stringify(asked.notCovered));
    });

    it('lists the work the run budget did not start, and points at the facts of the run for the command that continues it', () => {
      const state = decidedFixRun().fold();
      const fix = state.review!.fix!;
      const stopped = { ...state, review: { ...state.review!, fix: { ...fix, notAttempted: { ...fix.notAttempted, fixes: { 'c1-1': { cause: 'budget' as const, reason: 'spent 31 USD of 30 USD' } }, repair: { repair: { cause: 'budget' as const, reason: 'spent' } } } } } };
      const gap = briefOf(stopped as RunState).notCovered.find((entry) => entry.kind === 'budget');
      // In plain words: the findings its batches hold, not the batches (R12 of the brief of a run).
      assert.equal(gap?.text, 'The run budget stopped the fixes before 1 finding and the repair of the checks were attempted. The facts of the run at the end of the report give the command that continues them.');
      const repairOnly = { ...stopped, review: { ...stopped.review, fix: { ...stopped.review.fix, notAttempted: { ...fix.notAttempted, repair: { repair: { cause: 'budget' as const, reason: 'spent' } } } } } };
      assert.equal(briefOf(repairOnly as RunState).notCovered.find((entry) => entry.kind === 'budget')?.text, 'The run budget stopped the fixes before the repair of the checks was attempted. The facts of the run at the end of the report give the command that continues them.');
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

    it('names every kind of gap the JSON form allows', () => {
      assert.deepEqual([...gapKinds], ['angle', 'unverified', 'excluded', 'oversized', 'check', 'fix', 'budget', 'stop']);
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
  it('says each part in a line that names its subject first, at most seven lines of at most 200 characters', () => {
    const lines = briefShortForm(briefOf(withAccount(answerable(), given())));
    assert.deepEqual(lines, [
      `Parse an empty input (run ${answerable().id.slice(0, 8)})`,
      'The change: The parser returns no value for an empty input, where it threw before.',
      'Questions: 1, each with a default in place: SWEEP-1',
      'Against a written rule: 1 fix: RIPPLE-1',
      'Not covered: 2 gaps, the first: The FOOTGUNS angle did not run (2 attempts did not complete: failed: The answer does not match the output schema; timeout: The worker ran past its timeout). A later...',
      'Look at: 1 departure, a change to a public interface',
      'Changed: nothing; this run only reviewed',
    ]);
    for (const line of lines) assert.ok(line.length <= shortLineLimit, line);
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
    assert.match(brief.headline.text, /Nothing waits for you: each question has a default\.$/);
    assert.equal(briefOf(readOnlyReported([decisions[0], askDecision('SWEEP-1', false)]).fold()).questions[0]!.defaultApplied, true, 'a default that keeps the code is in place');
  });

  it('says a departure a person rejected now follows the rule, and whether the tree holds that fix', () => {
    const readOnly = readOnlyReported(answerableDecisions()).add('answer.recorded', answer('RIPPLE-1', 'reject')).fold();
    assert.match(markdown(readOnly), /^What the fix does: guard the null once, before parse reads it\. You chose to follow the rule instead; `review --fix` applies the fix that follows it\.$/m);
    const owed = decidedFixRun().add('answer.recorded', answer('RIPPLE-1', 'reject')).fold();
    assert.match(markdown(owed), /^What the fix does: guard the null once, before parse reads it\. You chose to follow the rule instead; no fixer has applied the fix that follows it yet\.$/m);
    const held = passToReport(decidedFixRun().add('answer.recorded', answer('RIPPLE-1', 'reject')).add('answer.pass', { ids: ['RIPPLE-1'] }), 1, [['RIPPLE-1', 'applied']], 2).fold();
    assert.match(markdown(held), /^What the fix does: guard the null once, before parse reads it\. You chose to follow the rule instead; the tree holds the fix that follows it\.$/m);
    assert.doesNotMatch(markdown(held), /A fixer applied it\./);
    const accepted = decidedFixRun().add('answer.recorded', answer('RIPPLE-1', 'accept')).fold();
    assert.match(markdown(accepted), /^What the fix does: guard the null once, before parse reads it\. A fixer applied it\.$/m, 'an acceptance keeps the fix as applied');
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
    assert.match(markdown(state), /^What the fix does: guard the null once, before parse reads it\. You chose to follow the rule instead; no fixer has applied the fix that follows it yet\.$/m);
  });
});
