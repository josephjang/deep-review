import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import type { PullRequestFile } from '../../src/github/pull-request.ts';
import { findingMarker } from '../../src/review/markers.ts';
import type { PullRequestForm } from '../../src/review/pull-request-form.ts';
import { longFindingHistory, paddedAnswer, renderedOf } from '../helpers/pull-request-review.ts';

const includes = (text: string, part: string): void => assert.ok(text.includes(part), `${JSON.stringify(part)} in:\n${text}`);
const excludes = (text: string, part: string): void => assert.ok(!text.includes(part), `no ${JSON.stringify(part)} in:\n${text}`);

/** The state with the verdict of candidate `id` changed as `change` says. */
const withVerdict = (state: RunState, id: string, change: Record<string, unknown>): RunState => {
  const candidate = state.review!.candidates[id]!;
  return { ...state, review: { ...state.review!, candidates: { ...state.review!.candidates, [id]: { ...candidate, verdict: { ...candidate.verdict!, ...change } } } } };
};

// R4, R7 of the review that always posts: what waits on a person stays in view when a comment is posted with its facts alone.
describe('a comment posted with its facts alone', () => {
  /** The files of the pull request with lines 4 to 7 of `src/a.ts` changed, so the fix on line 4 has its comment. */
  const onLine: PullRequestFile[] = [{ path: 'src/a.ts', status: 'modified', previousPath: null, patch: '@@ -4,4 +4,4 @@\n-old 4\n+new 4\n line 5\n line 6\n-old 7\n+new 7' }];
  const choice = 'Whether parse should throw or return null on an empty file.';
  const rippleOf = (form: PullRequestForm): string => form.comments.find((comment) => comment.finding === 'RIPPLE-1')!.body;

  it('still shows each choice its verifiers left to the author that deep-review did not settle, labeled as the verifier\'s', () => {
    const state = withVerdict(longFindingHistory().fold(), 'RIPPLE-1', { authorChoice: choice });
    const form = renderedOf(state, paddedAnswer(60_000), onLine);
    assert.deepEqual(form.leftOut.comments, [{ finding: 'RIPPLE-1', piece: 'text' }]);
    const comment = rippleOf(form);
    assert.ok(comment.length <= 60_000, String(comment.length));
    includes(comment, `Command that prints it: \`deep-review report --run run-1 --finding 1\`.\n\n- Choice its verifier left to the author: ${choice} Settled as: not settled by deep-review`);
    excludes(comment, 'd'.repeat(100));
    assert.equal(comment.split('\n').at(-1), `<!-- ${findingMarker('run-1', 'RIPPLE-1')} -->`);
  });

  it('leaves the choices out too when they alone are over the limit, so the comment still fits', () => {
    const long = `Whether ${'c'.repeat(60_000)}`;
    const state = withVerdict(longFindingHistory().fold(), 'RIPPLE-1', { authorChoice: long });
    const form = renderedOf(state, paddedAnswer(1), onLine);
    assert.deepEqual(form.leftOut.comments, [{ finding: 'RIPPLE-1', piece: 'text' }]);
    const comment = rippleOf(form);
    assert.ok(comment.length <= 60_000, String(comment.length));
    excludes(comment, 'Choice its verifier left to the author');
    assert.equal(comment.split('\n').at(-1), `<!-- ${findingMarker('run-1', 'RIPPLE-1')} -->`);
  });
});
