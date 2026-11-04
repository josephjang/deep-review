import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { History } from '../helpers/review-history.ts';
import { formOf, pullRequestRun as run, rewritten } from '../helpers/pull-request-review.ts';

const includes = (text: string, part: string): void => assert.ok(text.includes(part), `${JSON.stringify(part)} in:\n${text}`);

describe('a worker\'s text posted as a sentence', () => {
  /** The history with RIPPLE-1's decided approach given as `approach`, which its comment folds as a sentence. */
  const withApproach = (approach: string): History => rewritten(run(), (kind, payload) => (kind === 'decisions.recorded'
    ? { ...payload, decisions: (payload.decisions as Record<string, unknown>[]).map((decided) => (decided.id === 'RIPPLE-1' ? { ...decided, fix: { ...(decided.fix as object), approach } } : decided)) }
    : undefined));
  const commentOf = (approach: string): string => formOf(withApproach(approach).fold()).comments[0]!.body;

  it('capitalizes a leading lower-case word whether a space or the end of the text follows it', () => {
    includes(commentOf('refactor'), '\n\nRefactor.\n\n');
    includes(commentOf('refactor it'), '\n\nRefactor it.\n\n');
  });

  it('leaves a text as written when it starts with a capital, a code span or a word joined to what follows', () => {
    includes(commentOf('Refactor it'), '\n\nRefactor it.\n\n');
    includes(commentOf('`npm` again'), '\n\n`npm` again.\n\n');
    includes(commentOf('foo.bar is renamed'), '\n\nfoo.bar is renamed.\n\n');
  });
});
