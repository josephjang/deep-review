import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diagramFailures } from '../../src/review/explanation.ts';
import { namedFindings, namedInDiagram, type NamedId } from '../../src/review/finding-names.ts';
import { pullRequestWords } from '../../src/review/pull-request-words.ts';

const english = pullRequestWords('en').naming;
/** RIPPLE-2 is finding 3 and SWEEP-1 finding 1. */
const names = new Map<string, NamedId>([
  ['RIPPLE-2', { kind: 'finding', number: 3 }],
  ['SWEEP-1', { kind: 'finding', number: 1 }],
]);

/** A diagram the checks pass, as the review names it; the named diagram passes them too. */
function namedPassing(diagram: string): string | null {
  assert.deepEqual(diagramFailures(diagram), [], 'the diagram as written passes the checks');
  const named = namedInDiagram(diagram, names, english);
  if (named !== null) assert.deepEqual(diagramFailures(named), [], 'the named diagram passes the checks');
  return named;
}

// R4 of the finding names in the review: a shown text that holds a colon.
describe('the name of a finding in a shown text of a sequence or state diagram that holds a colon', () => {
  it('names an id in the label of a block whose label holds a colon', () => {
    assert.equal(namedPassing('sequenceDiagram\n  loop until RIPPLE-2: done\n  A->>B: x\n  end'), 'sequenceDiagram\n  loop until finding 3: done\n  A->>B: x\n  end');
    assert.equal(namedPassing('sequenceDiagram\n  alt SWEEP-1: applies\n  A->>B: x\n  end'), 'sequenceDiagram\n  alt Finding 1: applies\n  A->>B: x\n  end');
  });

  it('names an id in a quoted alias that holds a colon', () => {
    assert.equal(namedPassing('sequenceDiagram\n  participant A as "RIPPLE-2: fix"\n  A->>B: x'), 'sequenceDiagram\n  participant A as "Finding 3: fix"\n  A->>B: x');
  });

  it('splits a line at its first colon outside a quoted text', () => {
    assert.equal(namedPassing('stateDiagram-v2\n  state "RIPPLE-2: parse" as P\n  P --> Q: SWEEP-1 waits'), 'stateDiagram-v2\n  state "Finding 3: parse" as P\n  P --> Q: Finding 1 waits');
  });
});

// R3 of the finding names in the review: an id inside a URL stays.
describe('an id in a URL', () => {
  it('leaves an id in the query of a bare URL and of a Markdown link target, and names one past the link', () => {
    const text = 'See https://github.com/o/r/issues?q=RIPPLE-2 and [x](https://x.test/a?id=RIPPLE-2&b=1), then RIPPLE-2.';
    assert.equal(namedFindings(text, names, english), 'See https://github.com/o/r/issues?q=RIPPLE-2 and [x](https://x.test/a?id=RIPPLE-2&b=1), then finding 3.');
  });

  it('leaves an id in a URL whose path holds parentheses, and in an autolink', () => {
    const text = 'Read <https://x.test/a?SWEEP-1> and https://x.test/wiki/A_(b)?x=SWEEP-1 first.';
    assert.equal(namedFindings(text, names, english), text);
  });

  it('names an id after an equals sign outside a URL', () => {
    assert.equal(namedFindings('Set key=RIPPLE-2 aside.', names, english), 'Set key=finding 3 aside.');
  });
});
