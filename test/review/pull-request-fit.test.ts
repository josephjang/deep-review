import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { firstFit, fitOrder, leftOutOf, takes, waitsOnPerson, type FitStep } from '../../src/review/pull-request-fit.ts';
import type { FindingView, FormView } from '../../src/review/pull-request-view.ts';

/** What a built finding is: its number, severity, decision, place and what it waits on. */
interface Built {
  readonly number: number;
  readonly severity?: 'critical' | 'major' | 'minor';
  readonly decision?: 'fix' | 'ask' | 'leave' | null;
  readonly place?: 'line' | 'body';
  readonly verdict?: 'CONFIRMED' | 'PLAUSIBLE';
  /** The writer's text of a finding left as is. */
  readonly leftText?: boolean;
  /** A question with no answer. */
  readonly open?: boolean;
  /** A fix against a written rule with no review. */
  readonly departure?: boolean;
  /** A verifier's choice, settled by the decision or not. */
  readonly choice?: 'settled' | 'open';
}

/** A finding as the order reads it, built from `built`, its id `F<number>`. */
function finding(built: Built): FindingView {
  const id = `F${String(built.number)}`;
  const decision = built.decision === undefined ? 'fix' : built.decision;
  const settled = built.choice === 'settled' ? [{ for: [id], choice: 'keep it', by: 'repository', source: 'docs' }] : [];
  return {
    finding: { id, number: built.number, severity: built.severity ?? 'major', verdict: built.verdict ?? 'CONFIRMED' },
    decision: decision === null ? null : { id, decision, settled },
    placement: { finding: id, place: built.place ?? (decision === 'fix' || decision === 'ask' ? 'body' : 'body'), reason: 'outside-the-diff' },
    question: decision === 'ask' ? { id, answer: built.open === false ? { option: 1 } : null } : null,
    departure: built.departure === true ? { id, review: null } : null,
    left: built.leftText === true ? { id, title: 't', why: 'w' } : null,
    choices: built.choice === undefined ? [] : [{ id, choice: 'keep it' }],
    kind: null,
  } as unknown as FindingView;
}

/** A view of built findings, with refuted candidates, a diagram of an area and a minor table as given. */
function viewOf(findings: readonly Built[], extra: { refuted?: number; areaDiagram?: boolean; coreDiagram?: boolean } = {}): FormView {
  return {
    findings: findings.map(finding),
    refuted: Array.from({ length: extra.refuted ?? 0 }, () => ({})),
    areas: extra.areaDiagram === true ? [{ title: 'a', intro: 'i', diagram: 'flowchart LR', findings: [] }] : null,
    core: extra.coreDiagram === true ? { kind: 'writer', core: { diagram: 'flowchart LR' } } : { kind: 'none', state: 'none' },
  } as unknown as FormView;
}

/** A step as a short string, `piece` or `piece:number`, for readable expectations. */
const said = (step: FitStep): string => ('finding' in step ? `${step.piece}:${step.finding.slice(1)}` : step.piece);
const orderOf = (findings: readonly Built[], extra: Parameters<typeof viewOf>[1] = {}): string[] => fitOrder(viewOf(findings, extra)).map(said);

// R2, R3, R4, TD1, TD2 of the review that always posts.
describe('the order of what leaves a body that does not fit', () => {
  it('lists the rows of R2 in order, each row\'s findings the last-ranked first, and the floor last', () => {
    const order = orderOf([
      { number: 1 },
      { number: 2 },
      { number: 3, severity: 'minor' },
      { number: 4, severity: 'minor', place: 'line' },
      { number: 5, decision: 'leave', leftText: true },
      { number: 6, decision: 'leave', leftText: true },
    ], { refuted: 2, areaDiagram: true });
    assert.deepEqual(order, [
      'minor-table',
      'record:6', 'record:5',
      'record:3', 'record:2', 'record:1',
      'refuted',
      'left:6', 'left:5',
      'diagrams',
      'text:3', 'text:2', 'text:1',
      'line:3',
      'floor',
    ]);
  });

  it('takes the records of the findings left as is before the record of any finding in full, whatever their numbers (R3)', () => {
    assert.deepEqual(orderOf([{ number: 1, decision: 'leave', leftText: true }, { number: 2 }]), ['record:1', 'record:2', 'left:1', 'text:2', 'floor']);
  });

  it('gives a record step only to a finding whose block folds a record: none to a finding left as is with no writer\'s text, or with no decision', () => {
    assert.deepEqual(orderOf([{ number: 1, decision: 'leave' }, { number: 2, decision: null }]), ['left:2', 'left:1', 'floor']);
  });

  it('takes nothing of a finding on its line, whose comment is fitted on its own', () => {
    assert.deepEqual(orderOf([{ number: 1, place: 'line' }, { number: 2, severity: 'minor', place: 'line' }]), ['minor-table', 'floor']);
  });

  it('names no piece the run does not have: no minor table, refuted candidates or diagrams', () => {
    assert.deepEqual(orderOf([]), ['floor']);
    assert.deepEqual(orderOf([], { refuted: 1 }), ['refuted', 'floor']);
    assert.deepEqual(orderOf([], { areaDiagram: true }), ['floor'], 'the diagram of an area with no major finding that acts is not shown');
    assert.deepEqual(orderOf([], { coreDiagram: true }), ['diagrams', 'floor']);
  });

  it('keeps a finding that waits on a person, by a question, a departure or a choice no one settled, out of rows 2, 4, 6 and 7 and takes it in rows 8 and 9 (R4)', () => {
    const order = orderOf([
      { number: 1, decision: 'ask' },
      { number: 2, departure: true, severity: 'minor' },
      { number: 3, decision: 'leave', leftText: true, choice: 'open' },
      { number: 4, decision: 'leave', choice: 'open' },
      { number: 5, choice: 'open' },
      { number: 6 },
    ]);
    assert.deepEqual(order, ['minor-table', 'record:6', 'text:6', 'record:5', 'record:3', 'record:2', 'record:1', 'left:4', 'left:3', 'floor']);
  });

  it('takes a finding left as is whose verifier named a choice the decision settled in rows 2 and 4, as any other (R4, PD8)', () => {
    assert.deepEqual(orderOf([{ number: 1, decision: 'leave', leftText: true, choice: 'settled' }]), ['record:1', 'left:1', 'floor']);
  });

  it('lets an answered question and a reviewed departure wait on no one, and a question\'s verifiers\' choices never make it wait', () => {
    assert.equal(waitsOnPerson(finding({ number: 1, decision: 'ask', open: false })), false);
    assert.equal(waitsOnPerson(finding({ number: 1, decision: 'ask', open: false, choice: 'open' })), false);
    assert.equal(waitsOnPerson(finding({ number: 1, decision: 'ask' })), true);
    assert.equal(waitsOnPerson(finding({ number: 1, departure: true })), true);
    assert.equal(waitsOnPerson(finding({ number: 1, choice: 'open' })), true);
    assert.equal(waitsOnPerson(finding({ number: 1, decision: null, choice: 'open' })), true, 'a finding with no decision settles no choice');
    assert.equal(waitsOnPerson(finding({ number: 1, choice: 'settled' })), false);
  });

  it('gives the line step to the minor findings in full only, since a major one keeps its line in its area', () => {
    assert.deepEqual(orderOf([{ number: 1 }, { number: 2, severity: 'minor' }]), ['minor-table', 'record:2', 'record:1', 'text:2', 'text:1', 'line:2', 'floor']);
  });
});

describe('what a prefix of the order leaves out', () => {
  it('keeps for each finding the most a step took from it, and the whole pieces taken', () => {
    const steps = fitOrder(viewOf([{ number: 1 }, { number: 2, severity: 'minor' }, { number: 3, decision: 'leave', leftText: true }], { refuted: 1 }));
    const atText = leftOutOf(steps.slice(0, steps.findIndex((step) => step.piece === 'text') + 1));
    assert.equal(atText.minorTable, true);
    assert.equal(atText.refuted, true);
    assert.equal(atText.diagrams, false);
    assert.equal(atText.floor, false);
    assert.deepEqual([...atText.findings], [['F3', 'left'], ['F2', 'text'], ['F1', 'record']]);
    assert.equal(takes(atText, 'F2', 'record'), true);
    assert.equal(takes(atText, 'F2', 'line'), false);
    assert.equal(takes(atText, 'F1', 'text'), false);
    assert.equal(takes(atText, 'F9', 'record'), false);
    assert.equal(leftOutOf(steps).floor, true);
  });
});

describe('the first prefix that fits (TD3, OQ1)', () => {
  /** The prefix a render after each step finds: the first whose size is at most the limit, else the last. */
  const naive = (sizes: readonly number[], limit: number): number => {
    const found = sizes.findIndex((size) => size <= limit);
    return found === -1 ? sizes.length - 1 : found;
  };

  it('finds the prefix a render after each step finds, for sizes that rise and fall, with every true bound of what a step shortens', () => {
    let seed = 7;
    const random = (below: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % below;
    };
    for (let trial = 0; trial < 2000; trial += 1) {
      const steps = 1 + random(30);
      const sizes = [200 + random(400)];
      for (let step = 0; step < steps; step += 1) sizes.push(Math.max(0, sizes.at(-1)! - random(60) + (random(4) === 0 ? random(40) : 0)));
      // A bound at least what each step shortens, often more, and unbounded for some steps.
      const bounds = sizes.slice(1).map((size, step) => (random(6) === 0 ? Infinity : Math.max(0, sizes[step]! - size) + random(3) * random(50)));
      const limit = random(600);
      const rendered: number[] = [];
      const found = firstFit(steps, (prefix) => {
        rendered.push(prefix);
        return sizes[prefix]!;
      }, (step) => bounds[step]!, limit);
      assert.equal(found, naive(sizes, limit), JSON.stringify({ sizes, bounds, limit }));
      assert.equal(rendered.at(-1), found, 'the prefix found is the last one rendered, so its render is the text posted');
      assert.deepEqual([...rendered].sort((a, b) => a - b), rendered, 'each prefix is rendered once, in order');
    }
  });

  it('renders each prefix when no bound is known, and none past the first that fits', () => {
    const rendered: number[] = [];
    assert.equal(firstFit(4, (prefix) => {
      rendered.push(prefix);
      return [10, 9, 8, 5, 1][prefix]!;
    }, () => Infinity, 6), 3);
    assert.deepEqual(rendered, [0, 1, 2, 3]);
  });
});
