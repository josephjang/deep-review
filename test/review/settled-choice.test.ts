import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CandidateChoice } from '../../src/checkpoint/events.ts';
import { StructuralCheckError } from '../../src/review/errors.ts';
import { checkDecisions, deciderOutputSchema } from '../../src/review/schemas.ts';
import { settleSteps, type SettleStep } from '../../src/review/vocabulary.ts';
import { departure, History, unconfirmedFact, withReportForm, worker } from '../helpers/review-history.ts';
import { pullRequestRun } from '../helpers/pull-request-review.ts';

// Which settled choice each decision may carry (D1 of the settled choice), written out
// from the requirement rather than read from the engine's table, so a wrong row there fails.
type Need = 'required' | 'optional' | 'refused';
interface Case {
  readonly name: string;
  readonly decision: Record<string, unknown>;
  readonly named: Need;
  readonly unnamed: Need;
  readonly steps: readonly SettleStep[];
}
const fix = { decision: 'fix', fix: { approach: 'guard the null once', rejected: [] }, leave: null, ask: null, departure: null };
const leave = (reason: string): Record<string, unknown> => ({ decision: 'leave', fix: null, leave: { reason, supersededBy: reason === 'superseded' ? 'other' : null }, ask: null, departure: null });
const ask = {
  decision: 'ask', fix: null, leave: null, departure: null,
  ask: { question: 'Should parse accept an empty input?', options: [{ option: 'keep it', cost: 'c', rule: 'r', edits: false }, { option: 'refuse it', cost: 'c', rule: 'r', edits: true }], recommended: 0, applied: 0, searched: ['README.md'] },
};
const cases: readonly Case[] = [
  { name: 'a fix with no departure', decision: fix, named: 'required', unnamed: 'optional', steps: settleSteps },
  { name: 'a fix with a departure', decision: { ...fix, departure }, named: 'optional', unnamed: 'optional', steps: settleSteps },
  { name: 'a leave as intended', decision: leave('intended'), named: 'required', unnamed: 'optional', steps: ['intent', 'contract'] },
  { name: 'a leave as settled', decision: leave('settled'), named: 'required', unnamed: 'required', steps: ['shape'] },
  { name: 'a leave as superseded', decision: leave('superseded'), named: 'required', unnamed: 'optional', steps: ['intent', 'contract', 'kept', 'shape', 'scope', 'none'] },
  { name: 'a leave as outside-change-not-regression', decision: leave('outside-change-not-regression'), named: 'refused', unnamed: 'refused', steps: [] },
  { name: 'an ask', decision: ask, named: 'refused', unnamed: 'refused', steps: [] },
];

const entry = (by: SettleStep, ids: readonly string[]): Record<string, unknown> => ({ for: ids, choice: 'Parse keeps accepting an empty input.', by, source: 'The documentation says an empty input gives an empty result.' });
/** The other finding of the run, a fix that settles by `none` the choice of its primary when its verifier named one, as either finding may, so it breaks no rule and can supersede the one under test. */
const otherFix = (id: Finding): Record<string, unknown> => ({ ...fix, id, grounds: 'one sound way to act', settled: [entry('none', id === 'RIPPLE-1' ? ['RIPPLE-1'] : [])] });

const rippleChoice = 'Whether parse should throw or return null on an empty input.';
const sweepChoice = 'Whether the helper guards the null too, or leaves it to its callers.';

/**
 * The run's two findings: RIPPLE-1, whose primary's verifier named a choice for
 * the author and whose member SWEEP-2's verifier names `sweep`, or none; and
 * SWEEP-1, whose verifier names none. The sweep's group is verified rather than
 * left unverified, so SWEEP-2 has a verdict that can name a choice.
 */
function base(sweep: string | null): History {
  const noted = withReportForm(pullRequestRun(), (verdict) => ({ unconfirmed: verdict.verdict === 'PLAUSIBLE' ? unconfirmedFact : null, authorChoice: verdict.id === 'RIPPLE-1' ? rippleChoice : null }));
  const result = new History();
  for (const event of noted.events) {
    if (event.kind === 'group.unverified') {
      result.worker(34, 'verifier sweep-verification:g1').add('verdicts.recorded', { phase: 'sweep-verification', groupId: 'g1', workerId: worker(34), verdicts: [
        { id: 'SWEEP-1', verdict: 'CONFIRMED', evidence: 'the helper is written out twice', basis: 'read', runs: [], unconfirmed: null, authorChoice: null },
        { id: 'SWEEP-2', verdict: 'CONFIRMED', evidence: 'line 7 reads the null', basis: 'read', runs: [], unconfirmed: null, authorChoice: sweep },
      ] }, 3);
      continue;
    }
    result.add(event.kind, event.payload, event.version);
  }
  return result;
}
/** Each finding's candidates as the decider's task gives them, by index: what `checkDecisions` is given. */
const candidatesOf = (sweep: string | null): CandidateChoice[][] => [[{ id: 'RIPPLE-1', choice: rippleChoice }, { id: 'SWEEP-2', choice: sweep }], [{ id: 'SWEEP-1', choice: null }]];
const indexOf = { 'RIPPLE-1': 0, 'SWEEP-1': 1 } as const;
type Finding = keyof typeof indexOf;

/** The run with its decisions recorded at version 2 as given, every other event as it was. */
function decidedAt2(sweep: string | null, decided: readonly Record<string, unknown>[]): History {
  const result = new History();
  for (const event of base(sweep).events) {
    const decisions = event.kind === 'decisions.recorded';
    result.add(event.kind, decisions ? { ...(event.payload as object), decisions: decided } : event.payload, decisions ? 2 : event.version);
  }
  return result;
}

/** The two decisions of a case: the one under test on the finding `id`, settling `settled`, and the other finding's fix. */
function decisionsOf(decision: Record<string, unknown>, id: Finding, settled: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const other = id === 'RIPPLE-1' ? 'SWEEP-1' : 'RIPPLE-1';
  const left = decision.leave as { reason: string; supersededBy: string | null } | null;
  const tried = { ...decision, id, grounds: 'the grounds of the case', leave: left === null ? null : { ...left, supersededBy: left.supersededBy === null ? null : other }, settled };
  return [tried, otherFix(other)];
}

/** The same decisions as the decider answers them, by the index of the task. */
function answerOf(decided: readonly Record<string, unknown>[]): unknown {
  return {
    decisions: decided.map(({ id, leave: left, ...rest }) => {
      const reason = left as { reason: string; supersededBy: string | null } | null;
      return { ...rest, index: indexOf[id as Finding], leave: reason === null ? null : { reason: reason.reason, supersededBy: reason.supersededBy === null ? null : indexOf[reason.supersededBy as Finding] } };
    }),
  };
}

/** That the decider's check and the fold both accept, or both refuse naming the decision, the decisions given. */
function holdsAlike(sweep: string | null, decided: readonly Record<string, unknown>[], tested: Finding, expected: boolean): void {
  const output = deciderOutputSchema.parse(answerOf(decided));
  const check = (): void => checkDecisions(output, candidatesOf(sweep));
  const fold = (): unknown => decidedAt2(sweep, decided).fold();
  if (expected) {
    assert.doesNotThrow(check, 'the decider\'s check');
    assert.doesNotThrow(fold, 'the fold');
  } else {
    assert.throws(check, (error: unknown) => error instanceof StructuralCheckError && error.message.startsWith(`Decision [${String(indexOf[tested])}]`), 'the decider\'s check names the decision');
    assert.throws(fold, new RegExp(`records the decision of ${tested}, which `), 'the fold names the decision');
  }
}

const accepted = (need: Need, steps: readonly SettleStep[], by: SettleStep | null): boolean => (by === null ? need !== 'required' : need !== 'refused' && steps.includes(by));

describe('the settled choice each decision may carry, held alike by the decider\'s check and the fold (D1, TD3 of the settled choice)', () => {
  it('is the base run: its first finding names a choice for the author and its second none, and a plain fix of each folds', () => {
    assert.doesNotThrow(() => decidedAt2(null, decisionsOf(cases[1]!.decision, 'RIPPLE-1', [])).fold());
    assert.deepEqual(Object.values(decidedAt2(sweepChoice, decisionsOf(cases[1]!.decision, 'RIPPLE-1', [])).fold().review!.candidates).filter((candidate) => candidate.verdict?.authorChoice != null).map((candidate) => candidate.id), ['RIPPLE-1', 'SWEEP-2']);
  });

  const tested = { named: 'RIPPLE-1', unnamed: 'SWEEP-1' } as const;
  for (const entryCase of cases) {
    for (const finding of ['named', 'unnamed'] as const) {
      const need = entryCase[finding];
      for (const by of [null, ...settleSteps]) {
        const expected = accepted(need, entryCase.steps, by);
        it(`${expected ? 'accepts' : 'refuses'} ${entryCase.name} of a finding whose verifier named ${finding === 'named' ? 'a choice' : 'none'}, ${by === null ? 'settling no choice' : `settled by ${by}`}`, () => {
          const settled = by === null ? [] : [entry(by, finding === 'named' ? ['RIPPLE-1'] : [])];
          holdsAlike(null, decisionsOf(entryCase.decision, tested[finding], settled), tested[finding], expected);
        });
      }
    }
  }
});

// The candidates each entry of `settled` answers (PD9 of the settled choice), on RIPPLE-1, whose
// primary's verifier names a choice and whose member SWEEP-2's names another, or none.
interface ForCase {
  readonly name: string;
  readonly sweep: string | null;
  readonly decision: Record<string, unknown>;
  readonly settled: readonly (readonly string[])[];
  readonly expected: boolean;
}
const forCases: readonly ForCase[] = [
  { name: 'a fix that settles each of two candidates\' different choices in its own entry', sweep: sweepChoice, decision: fix, settled: [['RIPPLE-1'], ['SWEEP-2']], expected: true },
  { name: 'a fix that settles both candidates\' choices in one entry', sweep: sweepChoice, decision: fix, settled: [['RIPPLE-1', 'SWEEP-2']], expected: true },
  { name: 'a leave as intended that settles each candidate\'s choice in its own entry', sweep: sweepChoice, decision: leave('intended'), settled: [['RIPPLE-1'], ['SWEEP-2']], expected: true },
  { name: 'a fix that leaves the choice of one naming candidate unsettled', sweep: sweepChoice, decision: fix, settled: [['RIPPLE-1']], expected: false },
  { name: 'a leave as superseded that leaves the choice of one naming candidate unsettled', sweep: sweepChoice, decision: leave('superseded'), settled: [['SWEEP-2']], expected: false },
  { name: 'a fix with a departure that settles the choice of one naming candidate only', sweep: sweepChoice, decision: { ...fix, departure }, settled: [['RIPPLE-1']], expected: true },
  { name: 'a fix that names one candidate in two entries', sweep: sweepChoice, decision: fix, settled: [['RIPPLE-1', 'SWEEP-2'], ['SWEEP-2']], expected: false },
  { name: 'a fix with a departure that names one candidate in two entries', sweep: sweepChoice, decision: { ...fix, departure }, settled: [['RIPPLE-1'], ['RIPPLE-1']], expected: false },
  { name: 'a fix whose entry names a candidate of another finding', sweep: null, decision: fix, settled: [['RIPPLE-1', 'SWEEP-1']], expected: false },
  { name: 'a fix whose entry names a candidate the run never recorded', sweep: null, decision: fix, settled: [['RIPPLE-1', 'SCAN-9']], expected: false },
  { name: 'a fix whose entry names a candidate whose verifier named no choice', sweep: null, decision: fix, settled: [['RIPPLE-1', 'SWEEP-2']], expected: false },
  { name: 'a fix with a departure whose entry names a candidate whose verifier named no choice', sweep: null, decision: { ...fix, departure }, settled: [['SWEEP-2']], expected: false },
  { name: 'a fix that settles, beside each named choice, one no verifier named with an empty `for`', sweep: sweepChoice, decision: fix, settled: [['RIPPLE-1', 'SWEEP-2'], []], expected: true },
  { name: 'a fix that settles only a choice no verifier named, with an empty `for`, where its verifiers named two', sweep: sweepChoice, decision: fix, settled: [[]], expected: false },
];

describe('the candidates each settled choice answers, held alike by the decider\'s check and the fold (PD9 of the settled choice)', () => {
  for (const forCase of forCases) {
    it(`${forCase.expected ? 'accepts' : 'refuses'} ${forCase.name}`, () => {
      holdsAlike(forCase.sweep, decisionsOf(forCase.decision, 'RIPPLE-1', forCase.settled.map((ids) => entry('intent', ids))), 'RIPPLE-1', forCase.expected);
    });
  }

  it('accepts a leave as settled of a finding no verifier named a choice for, settling one with an empty `for`, and refuses it naming its own candidate', () => {
    holdsAlike(null, decisionsOf(leave('settled'), 'SWEEP-1', [entry('shape', [])]), 'SWEEP-1', true);
    holdsAlike(null, decisionsOf(leave('settled'), 'SWEEP-1', [entry('shape', ['SWEEP-1'])]), 'SWEEP-1', false);
  });

  it('names each fault of the candidates in the refusal: the unsettled choice, the foreign candidate and the one named twice', () => {
    const output = deciderOutputSchema.parse(answerOf(decisionsOf(fix, 'RIPPLE-1', [entry('intent', ['RIPPLE-1', 'SWEEP-1']), entry('intent', ['RIPPLE-1'])])));
    assert.throws(() => checkDecisions(output, candidatesOf(sweepChoice)), (error: unknown) => {
      assert.ok(error instanceof StructuralCheckError);
      assert.match(error.message, /Decision \[0\] settles a choice for SWEEP-1, which is not a candidate of its finding/);
      assert.match(error.message, /Decision \[0\] settles the choice of RIPPLE-1 in two entries/);
      assert.match(error.message, /Decision \[0\] is a fix with no departure and settles no choice for SWEEP-2, whose verifier named one for the author/);
      return true;
    });
  });
});
