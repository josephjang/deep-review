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

// R5 of the finding names in the review: a capital only where a sentence starts.
describe('a name after an abbreviation that ends in a period', () => {
  it('keeps a name in lower case after i.e., e.g., vs., cf., etc. and viz.', () => {
    assert.equal(namedFindings('This, i.e. RIPPLE-2, fails; e.g. SWEEP-1 too, vs. RIPPLE-2.', names, english), 'This, i.e. finding 3, fails; e.g. finding 1 too, vs. finding 3.');
    assert.equal(namedFindings('Others (cf. RIPPLE-2, etc. SWEEP-1, viz. RIPPLE-2) differ. E.g. SWEEP-1 too.', names, english), 'Others (cf. finding 3, etc. finding 1, viz. finding 3) differ. E.g. finding 1 too.');
  });

  it('still capitalizes a name after a sentence that ends in a word holding such letters, or on a list item', () => {
    assert.equal(namedFindings('It runs in the dev. RIPPLE-2 waits.\n- SWEEP-1 too.', names, english), 'It runs in the dev. Finding 3 waits.\n- Finding 1 too.');
  });

  it('keeps a name in lower case after an abbreviation and what opens it', () => {
    assert.equal(namedFindings('This, e.g. (RIPPLE-2), fails, i.e. **SWEEP-1** too.', names, english), 'This, e.g. (finding 3), fails, i.e. **finding 1** too.');
  });

  it('keeps a name in lower case after an abbreviation in a note of a diagram', () => {
    assert.equal(namedInDiagram('sequenceDiagram\n  A->>B: x\n  Note over A,B: e.g. RIPPLE-2 waits', names, english), 'sequenceDiagram\n  A->>B: x\n  Note over A,B: e.g. finding 3 waits');
  });
});

// R4, R5 of the finding names in the review: a sentence opened by emphasis, a parenthesis or a quote.
describe('a name at the start of a sentence opened by emphasis, a parenthesis or a quote', () => {
  it('capitalizes a name after emphasis, a parenthesis, a bracket or a quote that opens a text, a sentence or a list item', () => {
    assert.equal(namedFindings('**RIPPLE-2** crashes parse.', names, english), '**Finding 3** crashes parse.');
    assert.equal(namedFindings('(RIPPLE-2 crashes parse.)', names, english), '(Finding 3 crashes parse.)');
    assert.equal(namedFindings('See this. **RIPPLE-2** crashes. "SWEEP-1 waits," it says. _[SWEEP-1]_ too.\n- **RIPPLE-2** first.', names, english), 'See this. **Finding 3** crashes. "Finding 1 waits," it says. _[Finding 1]_ too.\n- **Finding 3** first.');
    assert.equal(namedFindings('“RIPPLE-2” and ‘SWEEP-1’ differ.', names, english), '“Finding 3” and ‘finding 1’ differ.');
  });

  it('keeps a name in lower case after emphasis, a parenthesis or a quote inside a sentence', () => {
    assert.equal(namedFindings('This needs **RIPPLE-2** and (SWEEP-1) and "RIPPLE-2".', names, english), 'This needs **finding 3** and (finding 1) and "finding 3".');
  });

  it('capitalizes a quoted text between bars in a diagram, as every other label', () => {
    assert.equal(namedPassing('flowchart LR\n  A["Waits on RIPPLE-2"] -->|"SWEEP-1"| B["x"]'), 'flowchart LR\n  A["Waits on finding 3"] -->|"Finding 1"| B["x"]');
  });
});

// R4 of the finding names in the review: a quoted Mermaid markdown string.
describe('the name of a finding in a Mermaid markdown string', () => {
  it('names an id inside the backticks of a markdown string that holds more than the id, and keeps the backticks', () => {
    assert.equal(namedPassing('flowchart LR\n  A["`RIPPLE-2 crashes`"] --> B["`**SWEEP-1** waits`"]'), 'flowchart LR\n  A["`Finding 3 crashes`"] --> B["`**Finding 1** waits`"]');
    assert.equal(namedPassing('flowchart LR\n  A["a"] -->|"`waits on RIPPLE-2`"| B["b"]\n  B -- "`SWEEP-1 then`" --> C["c"]'), 'flowchart LR\n  A["a"] -->|"`waits on finding 3`"| B["b"]\n  B -- "`Finding 1 then`" --> C["c"]');
    assert.equal(namedPassing('sequenceDiagram\n  participant A as "`RIPPLE-2 fix`"\n  A->>B: x'), 'sequenceDiagram\n  participant A as "`Finding 3 fix`"\n  A->>B: x');
  });

  it('names a markdown string that holds one id alone in place of its backticks', () => {
    assert.equal(namedPassing('flowchart LR\n  A["`RIPPLE-2`"] --> B["`NOPE-9`"]'), 'flowchart LR\n  A["Finding 3"] --> B["`NOPE-9`"]');
  });
});

// R3, R4 of the finding names in the review: an id left where prose keeps it is no identifier.
describe('a diagram that keeps an id where prose keeps one', () => {
  it('posts a diagram whose id is left on a comment line', () => {
    assert.equal(namedPassing('flowchart LR\n  %% RIPPLE-2 is the crash\n  A["x"] --> B["y"]'), 'flowchart LR\n  %% RIPPLE-2 is the crash\n  A["x"] --> B["y"]');
    assert.equal(namedPassing('sequenceDiagram\n    %% SWEEP-1 first\n  A->>B: x'), 'sequenceDiagram\n    %% SWEEP-1 first\n  A->>B: x');
  });

  it('posts a diagram whose id is left in a path, a URL or a code span longer than it in a label', () => {
    assert.equal(namedPassing('flowchart LR\n  A["see notes/RIPPLE-2.md"] --> B["x"]'), 'flowchart LR\n  A["see notes/RIPPLE-2.md"] --> B["x"]');
    assert.equal(namedPassing('flowchart LR\n  A["`guard(RIPPLE-2)` waits on RIPPLE-2"] --> B["x"]'), 'flowchart LR\n  A["`guard(RIPPLE-2)` waits on finding 3"] --> B["x"]');
    assert.equal(namedPassing('flowchart LR\n  A["https://x.test/a?id=SWEEP-1"] --> B["x"]'), 'flowchart LR\n  A["https://x.test/a?id=SWEEP-1"] --> B["x"]');
  });

  it('names an id in the text of an edge right after its opening', () => {
    assert.equal(namedPassing('flowchart LR\n  A["x"] --RIPPLE-2 waits--> B["y"]'), 'flowchart LR\n  A["x"] --Finding 3 waits--> B["y"]');
  });

  it('still leaves out a diagram whose id is an identifier joined to an arrow, or one beside a comment', () => {
    assert.equal(namedPassing('flowchart LR\n  RIPPLE-2-->A["x"]'), null);
    assert.equal(namedPassing('flowchart LR\n  A["x"]-->RIPPLE-2'), null);
    assert.equal(namedPassing('sequenceDiagram\n  RIPPLE-2->>B: calls'), null);
    assert.equal(namedPassing('flowchart LR\n  %% a comment\n  A["x"] --> RIPPLE-2'), null);
  });
});

// R4 of the finding names in the review: the texts of a flowchart that diagramFailures reads as labels.
describe('the name of a finding in each text of a flowchart that the diagram checks read', () => {
  it('names an id in the title of a subgraph given alone, quoted or between brackets', () => {
    assert.equal(namedPassing('flowchart LR\n  subgraph RIPPLE-2 area\n  A["x"]\n  end'), 'flowchart LR\n  subgraph Finding 3 area\n  A["x"]\n  end');
    assert.equal(namedPassing('flowchart LR\n  subgraph S ["SWEEP-1 area"]\n  A["x"]\n  end'), 'flowchart LR\n  subgraph S ["Finding 1 area"]\n  A["x"]\n  end');
    assert.equal(namedPassing('flowchart LR\n  subgraph S[RIPPLE-2 area]\n  A["x"]\n  end'), 'flowchart LR\n  subgraph S[Finding 3 area]\n  A["x"]\n  end');
  });

  it('names an id in the text of an edge closed by a cross or a circle', () => {
    assert.equal(namedPassing('flowchart LR\n  A["a"] -- RIPPLE-2 --x B["b"]\n  B -- SWEEP-1 --o C["c"]'), 'flowchart LR\n  A["a"] -- Finding 3 --x B["b"]\n  B -- Finding 1 --o C["c"]');
  });

  it('names an id in the text of an edge written with no space around it', () => {
    assert.equal(namedPassing('flowchart LR\n  A["a"] ==RIPPLE-2==> B["b"]\n  B -.SWEEP-1.-> C["c"]\n  C -- RIPPLE-2-->D["d"]\n  D --SWEEP-1 waits--> E["e"]'), 'flowchart LR\n  A["a"] ==Finding 3==> B["b"]\n  B -.Finding 1.-> C["c"]\n  C -- Finding 3-->D["d"]\n  D --Finding 1 waits--> E["e"]');
  });

  it('names an id in the label of a node\'s shape, quoted or not', () => {
    assert.equal(namedPassing('flowchart LR\n  A@{ shape: rect, label: RIPPLE-2 } --> B@{ shape: rect, label: "SWEEP-1 waits" }'), 'flowchart LR\n  A@{ shape: rect, label: Finding 3 } --> B@{ shape: rect, label: "Finding 1 waits" }');
  });

  it('leaves out a diagram whose id is a node joined to a link that holds no text', () => {
    assert.equal(namedPassing('flowchart LR\n  A["a"] --- RIPPLE-2 --> C["c"]'), null);
    assert.equal(namedPassing('flowchart LR\n  A --- RIPPLE-2 --- C'), null);
    assert.equal(namedPassing('flowchart LR\n  A["a"]---RIPPLE-2'), null);
    assert.equal(namedPassing('flowchart LR\n  subgraph RIPPLE-2 [area]\n  A["x"]\n  end'), null);
  });
});
