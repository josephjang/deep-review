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

  it('refuses an empty departure on a fix that departs from no rule, and tells the next writer to give null', () => {
    const withDeparture = (departure: string): Entry => ({ ...explained, explanation: { ...explanation(), fix: { ...explanation().fix!, departure } } });
    assert.deepEqual(failures([withDeparture('')]), ['RIPPLE-1 gives an empty departure; give null, since it departs from no written rule']);
    assert.deepEqual(failures([withDeparture(' ')]), ['RIPPLE-1 gives an empty departure; give null, since it departs from no written rule']);
    assert.deepEqual(failures([withDeparture('The rule says parse() throws.')]), ['RIPPLE-1 departs from no written rule, and its fix gives the text of a departure']);
    assert.deepEqual(failures([withDeparture('')], { ...fixFacts, departs: true }), ['RIPPLE-1 departs from a written rule, and its fix does not say the rule, the fact against it and what the fix does instead']);
  });

  it('refuses an empty unconfirmed on a finding whose verdict records no reason it is not confirmed, and tells the next writer to give null', () => {
    const withUnconfirmed = (unconfirmed: string): Entry => ({ ...explained, explanation: { ...explanation(), unconfirmed } });
    assert.deepEqual(failures([withUnconfirmed('')]), ['RIPPLE-1 gives an empty unconfirmed; give null, since its verdict records no reason it is not confirmed']);
    assert.deepEqual(failures([withUnconfirmed('No test reaches the empty input.')]), ['RIPPLE-1 says why it is not confirmed, which only a finding whose PLAUSIBLE verdict records why has']);
    assert.deepEqual(failures([withUnconfirmed('')], { ...fixFacts, unconfirmed: true }), ['RIPPLE-1 has a PLAUSIBLE verdict whose verifier says why it is not confirmed, and the explanation does not say why']);
  });
});
