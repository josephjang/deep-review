import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StructuralCheckError } from '../../src/review/errors.ts';
import { checkDecisions, deciderOutputSchema } from '../../src/review/schemas.ts';
import { settleSteps, type SettleStep } from '../../src/review/vocabulary.ts';
import { departure, History, withReportForm } from '../helpers/review-history.ts';
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

const settledBy = (by: SettleStep | null): Record<string, unknown> | null => (by === null ? null : { choice: 'parse keeps accepting an empty input', by, source: 'the documentation says an empty input gives an empty result' });
/** The other finding of the run, a fix that settles its choice by `none`, which either finding may carry, so it breaks no rule and can supersede the one under test. */
const otherFix = { ...fix, grounds: 'one sound way to act', settled: settledBy('none') };

// The run's two findings: RIPPLE-1, whose verifier named a choice for the author, and SWEEP-1, whose group went unverified, so it names none.
const base = withReportForm(pullRequestRun(), (verdict) => ({ unconfirmed: verdict.verdict === 'PLAUSIBLE' ? { kind: 'fact', text: 'one fact' } : null, authorChoice: verdict.id === 'RIPPLE-1' ? 'Whether parse should throw or return null on an empty input.' : null }));
const tested = { named: 'RIPPLE-1', unnamed: 'SWEEP-1' } as const;
const indexOf = { 'RIPPLE-1': 0, 'SWEEP-1': 1 } as const;

/** The run with its decisions recorded at version 2 as given, every other event as it was. */
function decidedAt2(decided: readonly Record<string, unknown>[]): History {
  const result = new History();
  for (const event of base.events) {
    const decisions = event.kind === 'decisions.recorded';
    result.add(event.kind, decisions ? { ...(event.payload as object), decisions: decided } : event.payload, decisions ? 2 : event.version);
  }
  return result;
}

/** The two decisions of a case: the one under test on the finding `id`, and the other finding's fix. */
function decisionsOf(entry: Case, id: 'RIPPLE-1' | 'SWEEP-1', by: SettleStep | null): Record<string, unknown>[] {
  const other = id === 'RIPPLE-1' ? 'SWEEP-1' : 'RIPPLE-1';
  const left = entry.decision.leave as { reason: string; supersededBy: string | null } | null;
  const tried = { ...entry.decision, id, grounds: 'the grounds of the case', leave: left === null ? null : { ...left, supersededBy: left.supersededBy === null ? null : other }, settled: settledBy(by) };
  return [tried, { ...otherFix, id: other }];
}

/** The same decisions as the decider answers them, by the index of the task. */
function answerOf(decided: readonly Record<string, unknown>[]): unknown {
  return {
    decisions: decided.map(({ id, leave: left, ...rest }) => {
      const reason = left as { reason: string; supersededBy: string | null } | null;
      return { ...rest, index: indexOf[id as keyof typeof indexOf], leave: reason === null ? null : { reason: reason.reason, supersededBy: reason.supersededBy === null ? null : indexOf[reason.supersededBy as keyof typeof indexOf] } };
    }),
  };
}

const accepted = (need: Need, steps: readonly SettleStep[], by: SettleStep | null): boolean => (by === null ? need !== 'required' : need !== 'refused' && steps.includes(by));

describe('the settled choice each decision may carry, held alike by the decider\'s check and the fold (D1, TD3 of the settled choice)', () => {
  it('is the base run: its first finding names a choice for the author and its second none, and a plain fix of each folds', () => {
    assert.doesNotThrow(() => decidedAt2(decisionsOf(cases[1]!, 'RIPPLE-1', null)).fold());
  });

  for (const entry of cases) {
    for (const finding of ['named', 'unnamed'] as const) {
      const need = entry[finding];
      for (const by of [null, ...settleSteps]) {
        const expected = accepted(need, entry.steps, by);
        it(`${expected ? 'accepts' : 'refuses'} ${entry.name} of a finding whose verifier named ${finding === 'named' ? 'a choice' : 'none'}, ${by === null ? 'settling no choice' : `settled by ${by}`}`, () => {
          const decided = decisionsOf(entry, tested[finding], by);
          const output = deciderOutputSchema.parse(answerOf(decided));
          const check = (): void => checkDecisions(output, [true, false]);
          const fold = (): unknown => decidedAt2(decided).fold();
          if (expected) {
            assert.doesNotThrow(check, 'the decider\'s check');
            assert.doesNotThrow(fold, 'the fold');
          } else {
            assert.throws(check, (error: unknown) => error instanceof StructuralCheckError && error.message.startsWith(`Decision [${String(indexOf[tested[finding]])}]`), 'the decider\'s check names the decision');
            assert.throws(fold, new RegExp(`records the decision of ${tested[finding]}, which `), 'the fold names the decision');
          }
        });
      }
    }
  }
});
