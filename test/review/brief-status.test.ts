import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { briefOf } from '../../src/review/brief.ts';
import { decidedFixRun } from '../helpers/review-history.ts';

/** The run with no revision of the fix pass: a fixer reported its fix applied, and the tree held no change of it. */
const withoutRevisions = (state: RunState): RunState => ({ ...state, review: { ...state.review!, fix: { ...state.review!.fix!, revisions: [] } } });

describe('the status of a fix in the brief', () => {
  it('says a fix against a written rule is committed only when a committed patch holds it', () => {
    const departure = (state: RunState): string => briefOf(state).needs.find((need) => need.condition === 'departure')!.lines[0]!;
    assert.equal(departure(withoutRevisions(decidedFixRun().fold())), '**Finding 1 is fixed against a written rule.** The fix is in your working tree.');
  });
});
