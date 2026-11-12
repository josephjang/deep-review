import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkAnswerV4, type AnswerCheckInput, type AnswerCheckInputV4, type CheckedAnswerV4, type DecisionFacts } from '../../src/review/explanation-checks.ts';
import { writerBoundsV4, type WriterOutputV4 } from '../../src/review/schemas.ts';

// The checks of the writer's answer of version 4 (R2, R3, PD11, TD2, TD7, TD8 of the review in the writer's words).

/** The line counts of a fake repository: `src/a.ts` with 12 lines at the head and 10 at the base. */
const fakeLines: AnswerCheckInput['lineCount'] = (side, path) => ({ 'head:src/a.ts': 12, 'base:src/a.ts': 10 } as Record<string, number>)[`${side}:${path}`] ?? null;

type Explanation = NonNullable<WriterOutputV4['findings'][number]['explanation']>;

/** The explanation of a finding to explain, as an answer that passes gives it: a fix with no departure, or with `ask`, a question of two options. */
function explanation(id: string, decision: 'fix' | 'ask' = 'fix'): Explanation {
  return {
    title: `${id} crashes on an empty input`,
    problem: 'A caller that passes an empty file meets a crash.',
    cases: [{ sentence: 'An empty file reaches the read on line 4.', lines: { side: 'head', path: 'src/a.ts', from: 4, to: 5 } }],
    diagram: null,
    checked: 'Its verifier ran parse() on an empty file.',
    kind: null,
    action: decision === 'fix' ? 'deep-review would return early when the input is empty.' : 'deep-review asks whether an empty input is an error, and recommends that it is not.',
    unconfirmed: null,
    fix: decision === 'fix' ? { text: 'The fix returns null for an empty input before parse() reads it.', departure: null } : null,
    ask: decision === 'ask'
      ? {
        question: 'Whether an empty input is an error, which no rule of the repository says.',
        options: [
          { number: 1, means: 'An empty input returns null.', cost: 'Callers must check for null.', rule: 'An empty input is not an error.' },
          { number: 2, means: 'An empty input throws.', cost: 'A caller that sends one crashes.', rule: 'An empty input is an error.' },
        ],
        recommendation: 'Returning null keeps every caller that works today working.',
      }
      : null,
  };
}

/** An answer that passes every check against `input()`: RIPPLE-1 a major fix, SWEEP-1 a major question, MINOR-1 left as is, and REF-1 a refuted candidate. */
function goodAnswer(): WriterOutputV4 {
  return {
    core: { title: 'Parse an empty input', what: 'The change lets parse() take an empty input.', why: null, whyFrom: [], diagram: null },
    conditions: [],
    summary: 'The review found two findings that need a person: one deep-review would fix and one question.',
    areas: [{ title: 'Empty inputs crash parse()', intro: 'Both findings are about an empty input.', diagram: null, findings: ['RIPPLE-1', 'SWEEP-1'] }],
    findings: [
      { id: 'RIPPLE-1', explanation: explanation('RIPPLE-1'), unexplained: null },
      { id: 'SWEEP-1', explanation: explanation('SWEEP-1', 'ask'), unexplained: null },
    ],
    left: [{ id: 'MINOR-1', title: 'A comment names a function that was renamed', why: 'deep-review leaves it, since a later change removes the comment.' }],
    refuted: [{ id: 'REF-1', claim: 'parse() leaks a handle.', why: 'Its verifier found the handle closed on every path.' }],
    notExamined: 'Every review pass ran and a verifier examined each finding, so nothing of the change went unread.',
  };
}

const fixFacts: DecisionFacts = { decision: 'fix', departs: false, options: 0, unconfirmed: false };
const askFacts: DecisionFacts = { decision: 'ask', departs: false, options: 2, unconfirmed: false };

function input(decided: Readonly<Record<string, DecisionFacts>> = {}): AnswerCheckInputV4 {
  return {
    ids: ['RIPPLE-1', 'SWEEP-1'],
    lineCount: fakeLines,
    report: { major: ['RIPPLE-1', 'SWEEP-1'], asks: ['SWEEP-1'], refuted: ['REF-1'] },
    core: { commits: [], files: ['src/a.ts'], candidates: ['RIPPLE-1', 'SWEEP-1', 'MINOR-1', 'REF-1'], held: [] },
    decided: new Map(Object.entries({ 'RIPPLE-1': fixFacts, 'SWEEP-1': askFacts, ...decided })),
    left: ['MINOR-1'],
  };
}

/** The failures of every part of a checked answer, by part name. */
function failuresOf(checked: CheckedAnswerV4): Record<string, readonly string[]> {
  return {
    core: checked.core.failures,
    conditions: checked.conditions.failures,
    conclusion: checked.conclusion.failures,
    areas: checked.areas.failures,
    left: checked.left.failures,
    refuted: checked.refuted.failures,
    'not-examined': checked.notExamined.failures,
    ...Object.fromEntries([...checked.findings].map(([id, part]) => [`finding ${id}`, part.failures])),
  };
}

/** The parts of a checked answer that fail, with their failures. */
function failing(answer: WriterOutputV4, given: AnswerCheckInputV4 = input()): Record<string, readonly string[]> {
  return Object.fromEntries(Object.entries(failuresOf(checkAnswerV4(answer, given))).filter(([, failures]) => failures.length > 0));
}

/** The answer with the explanation of `id` changed. */
function withExplanation(id: string, change: (explained: Explanation) => void): WriterOutputV4 {
  const answer = goodAnswer();
  change(answer.findings.find((entry) => entry.id === id)!.explanation!);
  return answer;
}

describe('the checks of the writer\'s answer of version 4', () => {
  it('passes an answer whose every part keeps the rules, and keeps each finding with its new parts', () => {
    const checked = checkAnswerV4(goodAnswer(), input());
    assert.deepEqual(failing(goodAnswer()), {});
    const ask = checked.findings.get('SWEEP-1')!.value;
    assert.ok(ask !== null && !ask.unexplained);
    assert.equal(ask.ask?.options.length, 2);
    assert.equal(ask.fix, null);
    assert.equal(checked.conclusion.value, goodAnswer().summary);
  });

  it('holds a fix to a finding decided fix and a question to one decided ask, never both and never neither', () => {
    const askOnFix = withExplanation('RIPPLE-1', (explained) => {
      explained.fix = null;
      explained.ask = explanation('X', 'ask').ask;
    });
    assert.deepEqual(failing(askOnFix), { 'finding RIPPLE-1': ['RIPPLE-1 is decided fix and gives no fix', 'RIPPLE-1 is decided fix and gives a question, which only a finding decided ask has'] });
    const fixOnAsk = withExplanation('SWEEP-1', (explained) => {
      explained.ask = null;
      explained.fix = { text: 'Return null.', departure: null };
    });
    assert.deepEqual(failing(fixOnAsk), { 'finding SWEEP-1': ['SWEEP-1 is decided ask and gives no question', 'SWEEP-1 is decided ask and gives a fix, which only a finding decided fix has'] });
    const both = withExplanation('RIPPLE-1', (explained) => {
      explained.ask = explanation('X', 'ask').ask;
    });
    assert.deepEqual(failing(both), { 'finding RIPPLE-1': ['RIPPLE-1 is decided fix and gives a question, which only a finding decided ask has'] });
    const neither = withExplanation('SWEEP-1', (explained) => {
      explained.ask = null;
    });
    assert.deepEqual(failing(neither), { 'finding SWEEP-1': ['SWEEP-1 is decided ask and gives no question'] });
  });

  it('holds the text of a departure to a fix that departs from a written rule, and to no other', () => {
    assert.deepEqual(failing(goodAnswer(), input({ 'RIPPLE-1': { ...fixFacts, departs: true } })), {
      'finding RIPPLE-1': ['RIPPLE-1 departs from a written rule, and its fix does not say the rule, the fact against it and what the fix does instead'],
    });
    const departing = withExplanation('RIPPLE-1', (explained) => {
      explained.fix = { text: 'Return null.', departure: 'The rule says parse() throws on bad input; an empty file is not bad input, so the fix returns null.' };
    });
    assert.deepEqual(failing(departing, input({ 'RIPPLE-1': { ...fixFacts, departs: true } })), {});
    assert.deepEqual(failing(departing), { 'finding RIPPLE-1': ['RIPPLE-1 departs from no written rule, and its fix gives the text of a departure'] });
  });

  it('holds the options of a question to those the decision records, by number from 1, each once', () => {
    const options = (numbers: readonly number[]): WriterOutputV4 => withExplanation('SWEEP-1', (explained) => {
      explained.ask = { ...explained.ask!, options: numbers.map((number) => ({ number, means: 'It means.', cost: 'It costs.', rule: 'It rules.' })) };
    });
    const range = 'the decision records options 1 to 2';
    assert.deepEqual(failing(options([1])), { 'finding SWEEP-1': [`the question of SWEEP-1 gives no option 2; ${range}`] });
    assert.deepEqual(failing(options([1, 2, 2])), { 'finding SWEEP-1': ['the question of SWEEP-1 gives option 2 2 times, and an option has one entry'] });
    assert.deepEqual(failing(options([0, 1, 2])), { 'finding SWEEP-1': [`the question of SWEEP-1 gives option 0, which the decision does not record; ${range}`] });
    assert.deepEqual(failing(options([1, 2, 3])), { 'finding SWEEP-1': [`the question of SWEEP-1 gives option 3, which the decision does not record; ${range}`] });
    const blankCost = withExplanation('SWEEP-1', (explained) => {
      explained.ask!.options[1]!.cost = ' ';
    });
    assert.deepEqual(failing(blankCost), { 'finding SWEEP-1': ['option 2 of SWEEP-1 says not what it costs'] });
  });

  it('holds why a verdict is not confirmed to a PLAUSIBLE verdict that records why, and lets that text name the verdict', () => {
    const plausible = { 'RIPPLE-1': { ...fixFacts, unconfirmed: true } };
    assert.deepEqual(failing(goodAnswer(), input(plausible)), { 'finding RIPPLE-1': ['RIPPLE-1 has a PLAUSIBLE verdict whose verifier says why it is not confirmed, and the explanation does not say why'] });
    const said = withExplanation('RIPPLE-1', (explained) => {
      explained.unconfirmed = 'It stays PLAUSIBLE, not CONFIRMED, since no test reaches the empty input.';
    });
    assert.deepEqual(failing(said, input(plausible)), {}, 'a verdict word in unconfirmed passes');
    assert.deepEqual(failing(said), { 'finding RIPPLE-1': ['RIPPLE-1 says why it is not confirmed, which only a finding whose PLAUSIBLE verdict records why has'] });
  });

  it('holds every new text of a finding to no verdict of the review and to being said', () => {
    const verdicts = withExplanation('SWEEP-1', (explained) => {
      explained.action = 'deep-review asks, as the finding is CONFIRMED.';
      explained.ask!.recommendation = 'Option 1, since the verifier REFUTED the other path.';
    });
    assert.deepEqual(failing(verdicts), { 'finding SWEEP-1': ['the explanation of SWEEP-1 holds the verdict CONFIRMED, which the engine writes beside the finding', 'the explanation of SWEEP-1 holds the verdict REFUTED, which the engine writes beside the finding'] });
    const unsaid = withExplanation('RIPPLE-1', (explained) => {
      explained.action = '';
      explained.fix!.text = '';
    });
    assert.deepEqual(failing(unsaid), { 'finding RIPPLE-1': ['RIPPLE-1 says not what deep-review would do', 'the fix of RIPPLE-1 says not what it changes'] });
  });

  it('refuses a blank summary and a blank text of what the review did not examine, each in its own part', () => {
    const answer = { ...goodAnswer(), summary: ' ', notExamined: '' };
    assert.deepEqual(failing(answer), { conclusion: ['the summary is empty'], 'not-examined': ['what the review did not examine is empty'] });
    const verdict = { ...goodAnswer(), notExamined: 'No finding is PLAUSIBLE only.' };
    assert.deepEqual(failing(verdict), { 'not-examined': ['what the review did not examine holds the verdict PLAUSIBLE, which the engine writes beside the finding'] });
  });

  it('holds `left` to one entry for each finding left as is, and none for a finding that acts or no finding', () => {
    const answer = goodAnswer();
    answer.left = [
      { id: 'RIPPLE-1', title: 'A fix', why: 'It acts.' },
      { id: 'NOPE-9', title: 'Nothing', why: 'No such finding.' },
    ];
    assert.deepEqual(failing(answer), {
      left: [
        'the findings left as is have no entry for MINOR-1',
        'the findings left as is name RIPPLE-1, a finding that asks a person to act, which `findings` explains',
        'the findings left as is name "NOPE-9", which is no finding of the run left as is',
      ],
    });
    const blankWhy = goodAnswer();
    blankWhy.left[0]!.why = '';
    assert.deepEqual(failing(blankWhy), { left: ['the entry for MINOR-1 left as is says not why deep-review leaves it'] });
  });

  it('fails a text over its bound in its own part alone, and tells the retry which text and by how much', () => {
    const long = withExplanation('RIPPLE-1', (explained) => {
      explained.fix!.text = 'x'.repeat(writerBoundsV4.fixText + 7);
    });
    assert.deepEqual(failing(long), { 'finding RIPPLE-1': [`the fix of RIPPLE-1 is ${String(writerBoundsV4.fixText + 7)} characters, over its bound of ${String(writerBoundsV4.fixText)} by 7; say it in fewer words`] });
    const summary = { ...goodAnswer(), summary: 'y'.repeat(writerBoundsV4.summary + 1) };
    assert.deepEqual(Object.keys(failing(summary)), ['conclusion']);
    const leftTitle = goodAnswer();
    leftTitle.left[0]!.title = 'z'.repeat(writerBoundsV4.leftTitle + 1);
    assert.deepEqual(Object.keys(failing(leftTitle)), ['left']);
  });

  it('keeps the checks of version 3 for the parts it keeps: the core names no id of the run, and the areas hold each major finding', () => {
    const answer = goodAnswer();
    answer.core.what = 'The change fixes RIPPLE-1.';
    answer.areas[0]!.findings = ['RIPPLE-1'];
    assert.deepEqual(failing(answer), {
      core: ['the core names RIPPLE-1, an id of this review; the core is about the change as submitted, and names no finding or candidate'],
      areas: ['the areas leave out SWEEP-1, a major finding that asks a person to act'],
    });
  });
});
