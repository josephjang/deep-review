import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { formOf, pullRequestRun as run } from '../helpers/pull-request-review.ts';
import { decisions } from '../helpers/review-history.ts';

const choice = 'Whether parse should throw or return null on an empty file.';
const otherChoice = 'Whether the helper at line 7 guards the null too, or leaves it to its callers.';
const first = `**The choice.** Its verifier left this choice to the author: ${choice} deep-review did not settle it.`;
const second = `**The choice.** Its verifier left this choice to the author: ${otherChoice} deep-review did not settle it.`;

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

describe('the choices beside one decision, a paragraph each (PD9 of the settled choice)', () => {
  it('parts the choices of a merged finding\'s fix by a blank line in its comment', () => {
    const comment = formOf(withTwoChoices(run().fold())).comments[0]!.body;
    assert.ok(comment.includes(`${first}\n\n${second}`), comment);
  });

  it('parts the choices of a merged finding left as is by a blank line in the body', () => {
    const body = formOf(withTwoChoices(run([leftIntended, decisions[1]]).fold())).body;
    assert.ok(body.includes(`${first}\n\n${second}`), body);
  });
});
