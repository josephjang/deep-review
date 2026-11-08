import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diagramFailures } from '../../src/review/explanation.ts';
import { namedInDiagram, type NamedId } from '../../src/review/finding-names.ts';
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
