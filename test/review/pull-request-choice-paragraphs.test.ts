import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { formOf, pullRequestRun as run } from '../helpers/pull-request-review.ts';
import { decisions } from '../helpers/review-history.ts';

const choice = 'Whether parse should throw or return null on an empty file.';
const otherChoice = 'Whether the helper at line 7 guards the null too, or leaves it to its callers.';
const first = `- Choice its verifier left to the author: ${choice} Settled as: not settled by deep-review`;
const second = `- Choice its verifier left to the author: ${otherChoice} Settled as: not settled by deep-review`;

/** The state with the verdict of candidate `id` changed as `change` says. */
const withVerdict = (state: RunState, id: string, change: Record<string, unknown>): RunState => {
  const candidate = state.review!.candidates[id]!;
  return { ...state, review: { ...state.review!, candidates: { ...state.review!.candidates, [id]: { ...candidate, verdict: { ...candidate.verdict!, ...change } } } } };
};
/** The state with RIPPLE-1 a merged finding whose primary and member SWEEP-2 each name a choice for the author. */
const withTwoChoices = (state: RunState): RunState => {
  const named = withVerdict(state, 'RIPPLE-1', { authorChoice: choice });
  const primary = named.review!.candidates['RIPPLE-1']!.verdict!;
  return withVerdict({ ...named, review: { ...named.review!, candidates: { ...named.review!.candidates, 'SWEEP-2': { ...named.review!.candidates['SWEEP-2']!, unverified: false, verdict: primary } } } }, 'SWEEP-2', { evidence: 'line 7 reads the null too', authorChoice: otherChoice });
};
const leftIntended = { ...decisions[0], decision: 'leave', fix: null, departure: null, leave: { reason: 'intended', supersededBy: null } };

describe('the choices beside one decision, a list item each (PD9 of the settled choice; R4 of the review in the writer\'s words)', () => {
  it('gives each choice of a merged finding\'s fix an item of its own in the record its comment folds', () => {
    const comment = formOf(withTwoChoices(run().fold())).comments[0]!.body;
    assert.ok(comment.includes(`${first}\n${second}`), comment);
  });

  it('gives each choice of a merged finding left as is an item of its own in the body', () => {
    const body = formOf(withTwoChoices(run([leftIntended, decisions[1]]).fold())).body;
    assert.ok(body.includes(`${first}\n${second}`), body);
  });
});
