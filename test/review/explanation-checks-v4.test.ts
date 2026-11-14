import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkAnswerV4, type AnswerCheckInputV4, type DecisionFacts } from '../../src/review/explanation-checks.ts';
import type { WriterOutputV4 } from '../../src/review/schemas.ts';

// The checks of one finding of the writer's answer of version 4, read from its own part alone (R2, R3, TD2 of the review in the writer's words).

type Entry = WriterOutputV4['findings'][number];
type Explanation = NonNullable<Entry['explanation']>;

/** The explanation of RIPPLE-1, a major finding decided fix with no departure, as an answer that passes gives it. */
function explanation(): Explanation {
  return {
    title: 'parse() crashes on an empty input',
    problem: 'A caller that passes an empty file meets a crash.',
    cases: [{ sentence: 'An empty file reaches the read on line 4.', lines: { side: 'head', path: 'src/a.ts', from: 4, to: 5 } }],
    diagram: null,
    checked: 'Its verifier ran parse() on an empty file.',
    kind: null,
    action: 'deep-review would return early when the input is empty.',
    unconfirmed: null,
    fix: { text: 'The fix returns null for an empty input before parse() reads it.', departure: null },
    ask: null,
  };
}

const explained: Entry = { id: 'RIPPLE-1', explanation: explanation(), unexplained: null };

/** The answer with `findings` as its entries; its other parts are not read here. */
function answer(findings: readonly Entry[]): WriterOutputV4 {
  return {
    core: { title: 'Parse an empty input', what: 'The change lets parse() take an empty input.', why: null, whyFrom: [], diagram: null },
    conditions: [],
    summary: 'The review found one finding that deep-review would fix.',
    areas: [{ title: 'Empty inputs', intro: 'An empty input crashes parse().', diagram: null, findings: ['RIPPLE-1'] }],
    findings: [...findings],
    left: [],
    refuted: [],
    notExamined: 'A verifier examined each finding.',
  };
}

const fixFacts: DecisionFacts = { decision: 'fix', departs: false, options: 0, unconfirmed: false };

function input(facts: DecisionFacts = fixFacts): AnswerCheckInputV4 {
  return {
    ids: ['RIPPLE-1'],
    lineCount: (side, path) => (side === 'head' && path === 'src/a.ts' ? 12 : null),
    report: { major: ['RIPPLE-1'], asks: [], refuted: [] },
    core: { commits: [], files: ['src/a.ts'], candidates: ['RIPPLE-1'], held: [] },
    decided: new Map([['RIPPLE-1', facts]]),
    left: [],
  };
}

/** The failures of RIPPLE-1's part when the answer gives `findings`. */
function failures(findings: readonly Entry[], facts?: DecisionFacts): readonly string[] {
  return checkAnswerV4(answer(findings), input(facts)).findings.get('RIPPLE-1')!.failures;
}

describe('the checks of one finding of an answer of version 4', () => {
  it('passes the explanation as given', () => {
    assert.deepEqual(failures([explained]), []);
  });

  it('holds a finding to one entry, explained or unexplained and not both, as every version does', () => {
    assert.deepEqual(failures([]), ['the answer does not explain RIPPLE-1']);
    assert.deepEqual(failures([explained, explained]), ['the answer explains RIPPLE-1 2 times']);
    assert.deepEqual(failures([{ ...explained, explanation: null }]), ['RIPPLE-1 has neither an explanation nor the reason it is unexplained']);
    assert.deepEqual(failures([{ ...explained, unexplained: 'Its evidence names no line.' }]), ['RIPPLE-1 has both an explanation and the reason it is unexplained']);
    assert.deepEqual(failures([{ ...explained, explanation: null, unexplained: ' ' }]), ['the reason RIPPLE-1 is unexplained is empty']);
    const unexplained = checkAnswerV4(answer([{ ...explained, explanation: null, unexplained: 'Its evidence names no line.' }]), input()).findings.get('RIPPLE-1')!;
    assert.deepEqual(unexplained, { value: { id: 'RIPPLE-1', unexplained: true, reason: 'Its evidence names no line.' }, failures: [] });
  });
});
