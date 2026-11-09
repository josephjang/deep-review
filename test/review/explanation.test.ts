import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { NewEvent } from '../../src/checkpoint/checkpoint.ts';
import { explanationRecordedV1, explanationRecordedV2, type ExplanationRecorded } from '../../src/checkpoint/events.ts';
import { EvidenceStore } from '../../src/evidence/store.ts';
import { noCheckSettings } from '../../src/review/checks/discover.ts';
import { checkAnswer, diagramFailures, droppedExplanation, findingsToExplain, gitLineCounts, lineCountOf, mergeAnswers, recordedAnswerOf, writerTask, type AnswerCheckInput, type WriterTaskInput } from '../../src/review/explanation.ts';
import { contributionOf, invocationFor, type PhaseContext } from '../../src/review/phases.ts';
import { fenceFor } from '../../src/review/prompts.ts';
import type { MachineContext } from '../../src/review/public-text.ts';
import { writerOutputSchemaV2, type WriterOutput, type WriterOutputV2 } from '../../src/review/schemas.ts';
import { nextStep, type Live, type Step } from '../../src/review/steps.ts';
import { reviewRoles } from '../../src/review/vocabulary.ts';
import type { AssembledRole } from '../../src/roles/assemble.ts';
import { claudeTools } from '../../src/runtime/claude.ts';
import type { WorkerReceipt } from '../../src/runtime/launcher.ts';
import { askDecision, configuration, decidedOf, decisions, History, launch, mergeRanked, pullRequestFacts, pullRequestScope, readOnlyReported, withBaseChecks, withCitedRuns, withDocumentationStep, withPullRequest, withReportForm, worker } from '../helpers/review-history.ts';
import { commitAll, createRepository, remove, write } from '../helpers/repository.ts';

/** Ten numbered lines, as the base's `src/a.ts` holds them. */
const numbered = (count: number, word = 'line'): string => Array.from({ length: count }, (_, index) => `${word} ${String(index + 1)}`).join('\n') + '\n';

/** An answer that passes every check against the repository below, for RIPPLE-1 and, when asked, SWEEP-1. */
function goodAnswer(ids: readonly string[] = ['RIPPLE-1']): WriterOutput {
  return {
    conclusion: {
      why: 'An empty input crashes parse(), so the pull request needs a fix before a merge.',
      actions: ids.map((id) => ({ id, sentence: `Act on ${id} as decided.` })),
      diagram: 'flowchart LR\n  A["empty input"] --> B(["parse() reads null"])\n  B -->|"no guard"| C{"crash"}',
    },
    account: {
      terms: [{ term: 'parse()', meaning: 'reads a file into a value' }],
      problem: { text: 'An empty file made parse() throw.', diagram: null },
      change: { text: 'parse() returns null for an empty file, and its callers check for it.', diagram: 'sequenceDiagram\n  Caller->>parse: an empty file\n  parse-->>Caller: null' },
    },
    findings: ids.map((id) => ({
      id,
      explanation: {
        title: `${id} names its cause`,
        problem: 'A caller that passes an empty file meets a crash.',
        cases: [{ sentence: 'An empty file reaches the read on line 4.', lines: { side: 'head', path: 'src/a.ts', from: 4, to: 5 } }],
        diagram: null,
        decision: 'deep-review would guard the null once, before parse() reads it.',
      },
      unexplained: null,
    })),
  };
}

/** The line counts of a fake repository: `src/a.ts` with 12 lines at the head and 10 at the base, `src/gone.ts` with 3 at the base only. */
const fakeLines: AnswerCheckInput['lineCount'] = (side, path) => ({ 'head:src/a.ts': 12, 'base:src/a.ts': 10, 'base:src/gone.ts': 3 } as Record<string, number>)[`${side}:${path}`] ?? null;
const check = (output: WriterOutput, ids: readonly string[] = ['RIPPLE-1']) => checkAnswer(output, { ids, lineCount: fakeLines });
/** The failures of every part of a checked answer, by part. */
const failuresOf = (output: WriterOutput, ids: readonly string[] = ['RIPPLE-1']): Record<string, readonly string[]> => {
  const checked = check(output, ids);
  return { conclusion: checked.conclusion.failures, account: checked.account?.failures ?? [], ...Object.fromEntries([...checked.findings].map(([id, part]) => [`finding ${id}`, part.failures])) };
};
const withFinding = (change: (finding: NonNullable<WriterOutput['findings'][number]['explanation']>) => void): WriterOutput => {
  const answer = goodAnswer();
  change(answer.findings[0]!.explanation!);
  return answer;
};

// R19, TD9 of the review on the pull request.
describe('the checks of the writer\'s answer', () => {
  it('passes an answer whose every part keeps the rules', () => {
    for (const [part, failures] of Object.entries(failuresOf(goodAnswer()))) assert.deepEqual(failures, [], part);
  });

  it('refuses a conclusion that names an id of no finding to explain, misses one, or names one twice, and keeps an entry of no finding out of every part', () => {
    const answer = goodAnswer();
    answer.conclusion.actions.push({ id: 'SWEEP-1', sentence: 'Extract the helper.' }, { id: 'NOPE-9', sentence: 'Do something.' });
    assert.deepEqual(failuresOf(answer).conclusion, [
      'the conclusion names "SWEEP-1", which is no finding of the run that asks a person to act',
      'the conclusion names "NOPE-9", which is no finding of the run that asks a person to act',
    ]);
    const missing = goodAnswer();
    missing.conclusion.actions = [];
    assert.deepEqual(failuresOf(missing).conclusion, ['the conclusion has no sentence for RIPPLE-1']);
    const twice = goodAnswer();
    twice.conclusion.actions.push({ id: 'RIPPLE-1', sentence: 'Again.' });
    assert.deepEqual(failuresOf(twice).conclusion, ['the conclusion has more than one sentence for RIPPLE-1']);
    const stray = goodAnswer();
    stray.findings.push({ ...stray.findings[0]!, id: 'NOPE-9' });
    const checked = check(stray);
    assert.deepEqual(checked.strays, ['NOPE-9']);
    assert.deepEqual(checked.findings.get('RIPPLE-1')?.failures, [], 'a stray entry costs no part');
  });

  it('refuses a finding the answer leaves out, explains twice, or gives both an explanation and a reason or neither', () => {
    const left = goodAnswer();
    left.findings = [];
    assert.deepEqual(failuresOf(left)['finding RIPPLE-1'], ['the answer does not explain RIPPLE-1']);
    const twice = goodAnswer();
    twice.findings.push(twice.findings[0]!);
    assert.deepEqual(failuresOf(twice)['finding RIPPLE-1'], ['the answer explains RIPPLE-1 2 times']);
    const both = goodAnswer();
    both.findings[0]!.unexplained = 'the evidence says too little';
    assert.deepEqual(failuresOf(both)['finding RIPPLE-1'], ['RIPPLE-1 has both an explanation and the reason it is unexplained']);
    const neither = goodAnswer();
    neither.findings[0]!.explanation = null;
    assert.deepEqual(failuresOf(neither)['finding RIPPLE-1'], ['RIPPLE-1 has neither an explanation nor the reason it is unexplained']);
  });

  it('takes a finding marked unexplained with its reason, and holds the reason to the rules of a text', () => {
    const marked = goodAnswer();
    marked.findings[0] = { id: 'RIPPLE-1', explanation: null, unexplained: 'Its evidence names no line of the head.' };
    const part = check(marked).findings.get('RIPPLE-1')!;
    assert.deepEqual(part, { value: { id: 'RIPPLE-1', unexplained: true, reason: 'Its evidence names no line of the head.' }, failures: [] });
    marked.findings[0].unexplained = 'The verifier left it PLAUSIBLE.';
    assert.deepEqual(failuresOf(marked)['finding RIPPLE-1'], ['the reason RIPPLE-1 is unexplained holds the verdict PLAUSIBLE, which the engine writes beside the finding']);
  });

  it('refuses a case that cites a path or a range its side does not hold, or no path from the root, and takes a case on removed code at the merge base', () => {
    const cited = (lines: { side: 'head' | 'base'; path: string; from: number; to: number }) => failuresOf(withFinding((finding) => { finding.cases = [{ sentence: 'It breaks.', lines }]; }))['finding RIPPLE-1'];
    assert.deepEqual(cited({ side: 'head', path: 'src/missing.ts', from: 1, to: 1 }), ['case 1 of RIPPLE-1 cites src/missing.ts at the head, which holds no such file']);
    assert.deepEqual(cited({ side: 'head', path: 'src/a.ts', from: 11, to: 13 }), ['case 1 of RIPPLE-1 cites src/a.ts:11-13, which has 12 lines at the head']);
    assert.deepEqual(cited({ side: 'base', path: 'src/a.ts', from: 11, to: 11 }), ['case 1 of RIPPLE-1 cites src/a.ts:11, which has 10 lines at the merge base']);
    assert.deepEqual(cited({ side: 'head', path: 'src/gone.ts', from: 1, to: 2 }), ['case 1 of RIPPLE-1 cites src/gone.ts at the head, which holds no such file'], 'the head no longer holds a removed file');
    assert.deepEqual(cited({ side: 'base', path: 'src/gone.ts', from: 1, to: 3 }), [], 'removed code is cited at the merge base');
    assert.deepEqual(cited({ side: 'head', path: 'src/a.ts', from: 5, to: 4 }), ['case 1 of RIPPLE-1 cites lines 5 to 4 of src/a.ts, which is no range of lines']);
    assert.deepEqual(cited({ side: 'head', path: 'src/a.ts', from: 0, to: 2 }), ['case 1 of RIPPLE-1 cites lines 0 to 2 of src/a.ts, which is no range of lines']);
    for (const path of ['/w/src/a.ts', '../src/a.ts', './src/a.ts', 'src\\a.ts', 'C:/w/src/a.ts', '']) {
      assert.deepEqual(cited({ side: 'head', path, from: 1, to: 1 }), [`case 1 of RIPPLE-1 cites ${JSON.stringify(path)}, which is not a path from the root of the repository`], path);
    }
    assert.deepEqual(failuresOf(withFinding((finding) => { finding.cases = []; }))['finding RIPPLE-1'], ['RIPPLE-1 has no case']);
  });

  it('refuses a verdict of the review in upper case in any part, and passes a severity word and a verdict in other case', () => {
    const verdicts = goodAnswer();
    verdicts.conclusion.why = 'RIPPLE-1 is CONFIRMED, so act on it.';
    verdicts.account.change.text = 'Nothing here is REFUTED.';
    verdicts.findings[0]!.explanation!.cases[0]!.sentence = 'A PLAUSIBLE case.';
    const failures = failuresOf(verdicts);
    assert.deepEqual(failures.conclusion, ['the conclusion holds the verdict CONFIRMED, which the engine writes beside the finding']);
    assert.deepEqual(failures.account, ['the account holds the verdict REFUTED, which the engine writes beside the finding']);
    assert.deepEqual(failures['finding RIPPLE-1'], ['the explanation of RIPPLE-1 holds the verdict PLAUSIBLE, which the engine writes beside the finding']);
    const words = goodAnswer();
    words.conclusion.why = 'A critical defect and a minor one: the verifier confirmed both, and nothing UNCONFIRMED is left.';
    words.findings[0]!.explanation!.problem = 'This major problem meets every caller.';
    assert.deepEqual(failuresOf(words), { conclusion: [], account: [], 'finding RIPPLE-1': [] }, 'the severities are ordinary words, left to the gate');
  });

  it('refuses an empty text of a part, part by part', () => {
    const empty = goodAnswer();
    empty.conclusion.why = ' ';
    empty.account.terms.push({ term: 'helper', meaning: '' });
    empty.findings[0]!.explanation!.title = '';
    const failures = failuresOf(empty);
    assert.deepEqual(failures.conclusion, ['the conclusion says no why']);
    assert.deepEqual(failures.account, ['the account\'s term "helper" has no meaning']);
    assert.deepEqual(failures['finding RIPPLE-1'], ['RIPPLE-1 has no title']);
  });
});

describe('the rules of a diagram GitHub draws (R19)', () => {
  it('takes a flowchart whose every node label is quoted, a sequence diagram and a state diagram', () => {
    assert.deepEqual(diagramFailures('flowchart TD\n  A["a"] --> B(("b")) --> C{{"c"}}\n  C -.-> D[/"d"/]\n  D ==>|"e"| E>"e"]\n  style A fill:#f9f\n  %% a comment; with a semicolon'), []);
    assert.deepEqual(diagramFailures('\nsequenceDiagram\n  participant A as The caller\n  A->>B: an empty file\n  Note right of B: reads null\n  alt input is empty\n  B-->>A: null\n  end'), []);
    assert.deepEqual(diagramFailures('stateDiagram-v2\n  [*] --> Open\n  Open --> Closed : logout()\n  note right of Closed\n    the token is gone\n  end note'), []);
  });

  it('refuses a diagram of another kind, or one that starts with anything but its kind', () => {
    assert.deepEqual(diagramFailures('graph TD\n  A["a"] --> B["b"]'), ['it starts with "graph TD", not with flowchart, sequenceDiagram or stateDiagram-v2, the kinds GitHub draws']);
    assert.deepEqual(diagramFailures('classDiagram\n  A <|-- B'), ['it starts with "classDiagram", not with flowchart, sequenceDiagram or stateDiagram-v2, the kinds GitHub draws']);
    assert.deepEqual(diagramFailures('```mermaid\nflowchart LR\n  A["a"]\n```'), ['it starts with "```mermaid", not with flowchart, sequenceDiagram or stateDiagram-v2, the kinds GitHub draws']);
    assert.deepEqual(diagramFailures('%%{init: {}}%%\nflowchart LR\n  A["a"]'), ['it starts with "%%{init: {}}%%", not with flowchart, sequenceDiagram or stateDiagram-v2, the kinds GitHub draws']);
    assert.deepEqual(diagramFailures(''), ['it starts with nothing, not with flowchart, sequenceDiagram or stateDiagram-v2, the kinds GitHub draws']);
  });

  it('refuses a directive after the first line, as a line of its own or in a label, and keeps a comment', () => {
    assert.deepEqual(diagramFailures('flowchart LR\n  %%{init: {"securityLevel": "loose"}}%%\n  A["a"]'), ['line 2 holds a directive, %%{, which changes how Mermaid draws the diagram']);
    assert.deepEqual(diagramFailures('sequenceDiagram\n  A->>B: %%{init: {}}%%'), ['line 2 holds a directive, %%{, which changes how Mermaid draws the diagram']);
    assert.deepEqual(diagramFailures('stateDiagram-v2\n  %% a comment\n  [*] --> Open'), []);
  });

  it('refuses the unquoted label of a node of a flowchart, whatever its shape', () => {
    assert.deepEqual(diagramFailures('flowchart LR\n  A[parse] --> B("ok")'), ['the label of node A on line 2 is not quoted']);
    assert.deepEqual(diagramFailures('flowchart LR\n  A{guard?} --> B((done))\n  노드[읽기]'), ['the label of node A on line 2 is not quoted', 'the label of node B on line 2 is not quoted', 'the label of node 노드 on line 3 is not quoted']);
    assert.deepEqual(diagramFailures('flowchart LR\n  A["open --> B'), ['line 2 opens a label it does not close']);
  });

  it('reads no word of the text of an edge as a node, and still refuses an unquoted node on the same line', () => {
    assert.deepEqual(diagramFailures('flowchart LR\n  A["a"] -- calls parse(x) --> B["b"]\n  B -- uses map[k] --> C["c"]\n  C -- <local path> --> D["d"]\n  D -. "q" then f{y} .-> E["e"]'), []);
    assert.deepEqual(diagramFailures('flowchart LR\n  A["a"] -- calls parse(x) --> B[b]'), ['the label of node B on line 2 is not quoted']);
    assert.deepEqual(diagramFailures('flowchart LR\n  A[a] -- calls parse(x) --> B["b"]; B --x C(c)'), ['the label of node A on line 2 is not quoted', 'the label of node C on line 2 is not quoted']);
  });

  it('refuses an HTML entity and a semicolon in a label of a flowchart, in a message and in a note', () => {
    assert.deepEqual(diagramFailures('flowchart LR\n  A["a &lt; b"] --> B["x; y"]\n  B -->|"c &#59; d"| C["c"]'), [
      'the label on line 2 holds the HTML entity &lt;',
      'the label on line 2 holds a semicolon',
      'the label on line 3 holds the HTML entity &#59;',
    ]);
    assert.deepEqual(diagramFailures('flowchart LR\n  A -- a;b --> B\n  B -. a &amp; b .-> C\n  C == x;y ==> D\n  D <-- p &lt; q --- E'), [
      'the text of an edge on line 2 holds a semicolon',
      'the text of an edge on line 3 holds the HTML entity &amp;',
      'the text of an edge on line 4 holds a semicolon',
      'the text of an edge on line 5 holds the HTML entity &lt;',
    ]);
    assert.deepEqual(diagramFailures('flowchart LR\n  A["a"] --> B["b"]; B --- C["c"]; C -.-> D["d"]; D ==> E["e"]; E -- "t" --> F["f"]; F == ok ==> G["g"]'), [], 'a semicolon that ends a statement, and an edge whose text holds none');
    assert.deepEqual(diagramFailures('sequenceDiagram\n  A->>B: read; then parse\n  Note over A: a &amp; b'), [
      'the text after the colon on line 2 holds a semicolon',
      'the text after the colon on line 3 holds the HTML entity &amp;',
    ]);
    assert.deepEqual(diagramFailures('sequenceDiagram\n  loop each line; again\n  A->>B: read\n  end'), ['the label on line 2 holds a semicolon']);
    assert.deepEqual(diagramFailures('stateDiagram-v2\n  Open --> Closed : on logout; always\n  note left of Open\n    a &quot;session&quot;\n  end note'), [
      'the text after the colon on line 2 holds a semicolon',
      'the note on line 4 holds the HTML entity &quot;',
    ]);
  });

  it('reads a cross or circle arrow as an arrow, not as the opening of the text of an edge', () => {
    assert.deepEqual(diagramFailures('flowchart LR\n  A --x B; B --> C\n  A --o B; C --> D\n  A["a"] --x B["b"]; B["b"] ==o C["c"]; C x--x D; D o--o E'), [], 'a semicolon that ends a statement after a cross or circle arrow');
    assert.deepEqual(diagramFailures('flowchart LR\n  A["a"] --o B["b"] -- &amp; --> C["c"]\n  C --x D -- a;b --x E'), [
      'the text of an edge on line 2 holds the HTML entity &amp;',
      'the text of an edge on line 3 holds a semicolon',
    ]);
  });

  it('refuses an HTML entity and a semicolon in the label of a shape, the title of a subgraph and the title of a sequence diagram', () => {
    assert.deepEqual(diagramFailures('flowchart LR\n  A@{ shape: rect, label: x;y }\n  B@{ shape: rect, label: "p &lt; q" } --> C@{ label: done, shape: stadium }'), [
      'the label of node A on line 2 holds a semicolon',
      'the label on line 3 holds the HTML entity &lt;',
    ]);
    assert.deepEqual(diagramFailures('flowchart LR\n  A@{ shape: rect, label: "a }'), ['line 2 opens the shape of node A it does not close']);
    assert.deepEqual(diagramFailures('flowchart LR\n  subgraph S [a;b]\n  end\n  subgraph T [a &amp; b]\n  end\n  subgraph U ["c;d"]\n  end\n  subgraph The parser\n  end'), [
      'the title of the subgraph on line 2 holds a semicolon',
      'the title of the subgraph on line 4 holds the HTML entity &amp;',
      'the label on line 6 holds a semicolon',
    ]);
    assert.deepEqual(diagramFailures('sequenceDiagram\n  title a;b\n  A->>B: read'), ['the title on line 2 holds a semicolon']);
    assert.deepEqual(diagramFailures('sequenceDiagram\n  title The login\n  A->>B: read'), []);
  });

  it('takes a diagram that holds three backticks, which the fence of the form keeps inside', () => {
    const diagram = 'flowchart LR\n  A["```js"] --> B["code"]';
    assert.deepEqual(diagramFailures(diagram), []);
    assert.equal(fenceFor(diagram), '````', 'a fence one backtick longer than any run the diagram holds');
  });

  it('names the part whose diagram fails', () => {
    const answer = goodAnswer();
    answer.account.problem.diagram = 'pie\n  "a" : 1';
    assert.deepEqual(failuresOf(answer).account, ['the diagram of the problem before the change is no diagram GitHub draws: it starts with "pie", not with flowchart, sequenceDiagram or stateDiagram-v2, the kinds GitHub draws']);
  });
});

describe('the merge of a first and a second answer (R19)', () => {
  it('takes each part from the first answer that passed it, so a retry replaces only the parts that failed', () => {
    const first = goodAnswer();
    first.findings[0]!.explanation!.cases[0]!.lines.to = 99;
    const second = goodAnswer();
    second.conclusion.why = 'The second conclusion.';
    second.account.problem.text = 'REFUTED';
    const merged = mergeAnswers(1, [check(first), check(second)], ['RIPPLE-1']);
    assert.deepEqual(merged.dropped, []);
    assert.equal(merged.answer.conclusion?.why, first.conclusion.why, 'the conclusion that passed the first time is kept');
    assert.deepEqual(merged.answer.account, first.account, 'the account the second answer broke is the first one\'s');
    assert.deepEqual(merged.answer.findings, [{ id: 'RIPPLE-1', unexplained: false, ...second.findings[0]!.explanation!, checked: null, kind: null }], 'the finding the first answer failed is the second one\'s');
  });

  it('drops a part that fails again, with the second answer\'s failures and any extra reason, and keeps every part that passed once', () => {
    const first = goodAnswer();
    first.account.change.text = '';
    first.findings[0]!.explanation!.cases[0]!.lines.path = 'src/missing.ts';
    const second = goodAnswer();
    second.account.change.text = 'CONFIRMED';
    second.findings[0]!.explanation!.cases[0]!.lines.from = 40;
    second.findings[0]!.explanation!.cases[0]!.lines.to = 41;
    const merged = mergeAnswers(1, [check(first), check(second)], ['RIPPLE-1'], ['the run budget stopped the writer']);
    assert.deepEqual(merged.dropped, [
      { part: 'account', failures: ['the account holds the verdict CONFIRMED, which the engine writes beside the finding', 'the run budget stopped the writer'] },
      { part: 'finding', finding: 'RIPPLE-1', failures: ['case 1 of RIPPLE-1 cites src/a.ts:40-41, which has 12 lines at the head', 'the run budget stopped the writer'] },
    ]);
    assert.deepEqual(merged.answer, { conclusion: first.conclusion, account: null, areas: null, refuted: null, core: null, conditions: null, findings: [] });
  });

  it('drops every part, each with the reason, when no answer came', () => {
    assert.deepEqual(mergeAnswers(1, [], ['RIPPLE-1', 'SWEEP-1'], ['2 attempts did not complete']).dropped.map((part) => [part.part, part.part === 'finding' ? part.finding : null, part.failures]), [
      ['conclusion', null, ['2 attempts did not complete']],
      ['account', null, ['2 attempts did not complete']],
      ['finding', 'RIPPLE-1', ['2 attempts did not complete']],
      ['finding', 'SWEEP-1', ['2 attempts did not complete']],
    ]);
  });
});

describe('the lines of a path at a side, read with git (R19)', () => {
  let directory = '';
  before(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-lines-')));
  });
  after(() => rmSync(directory, { recursive: true, force: true }));

  it('counts the lines of a file at the commit of its side, so a worktree that moved reads the same lines', () => {
    const repo = createRepository(join(directory, 'repo'));
    write(repo, 'src/a.ts', numbered(10));
    write(repo, 'src/gone.ts', 'a\nb\nc');
    const base = commitAll(repo, 'base');
    write(repo, 'src/a.ts', numbered(12));
    remove(repo, 'src/gone.ts');
    const head = commitAll(repo, 'head');
    write(repo, 'src/a.ts', 'moved on\n');
    const lines = gitLineCounts(repo, { base, head });
    assert.equal(lines('head', 'src/a.ts'), 12, 'the head\'s lines, not the working tree\'s');
    assert.equal(lines('base', 'src/a.ts'), 10);
    assert.equal(lines('base', 'src/gone.ts'), 3, 'a last line with no line feed counts');
    assert.equal(lines('head', 'src/gone.ts'), null);
    assert.equal(lines('head', 'src'), null, 'a directory is no file');
    assert.equal(lineCountOf(Buffer.alloc(0)), 0);
    const nul = goodAnswer();
    nul.findings[0]!.explanation!.cases[0]!.lines.path = 'src/a\0.ts';
    assert.deepEqual(checkAnswer(nul, { ids: ['RIPPLE-1'], lineCount: lines }).findings.get('RIPPLE-1')!.failures, ['case 1 of RIPPLE-1 cites "src/a\\u0000.ts", which is not a path from the root of the repository'], 'a NUL, which no argument of git can hold, is a failed check');
  });

  it('reads every path it is given for a side with the first count asked of that side, and a path outside them alone', () => {
    const repo = createRepository(join(directory, 'batched'));
    write(repo, 'src/a.ts', numbered(10));
    write(repo, 'src/b.ts', '');
    write(repo, 'src/c.ts', 'one line, no line feed');
    write(repo, 'src/d.ts', numbered(3));
    const base = commitAll(repo, 'base');
    write(repo, 'src/a.ts', numbered(12));
    const head = commitAll(repo, 'head');
    const many = Array.from({ length: 400 }, (_, index) => `src/missing/${'x'.repeat(40)}-${String(index)}.ts`);
    const lines = gitLineCounts(repo, { base, head }, { head: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src', 'src/a.ts', 'src/a\0.ts', ...many], base: ['src/a.ts'] });
    assert.equal(lines('head', 'src/a.ts'), 12);
    const away = join(directory, 'batched-git');
    renameSync(join(repo, '.git'), away);
    try {
      assert.equal(lines('head', 'src/b.ts'), 0, 'an empty file, read with the first count of the head');
      assert.equal(lines('head', 'src/c.ts'), 1);
      assert.equal(lines('head', 'src'), null, 'a directory is no file');
      assert.equal(lines('head', many.at(-1)!), null, 'a path past the first git ls-tree');
      assert.throws(() => lines('base', 'src/a.ts'), /git/, 'the base is read with the first count asked of it');
      assert.throws(() => lines('head', 'src/d.ts'), /git/, 'a path outside the given ones is read when it is asked');
    } finally {
      renameSync(away, join(repo, '.git'));
    }
    assert.equal(lines('base', 'src/a.ts'), 10);
    assert.equal(lines('head', 'src/d.ts'), 3);
  });
});

/** A repository whose base and head the histories below are rewritten to: `src/a.ts` with 10 lines, then 12, and `src/gone.ts` removed. */
interface Fixture {
  readonly repo: string;
  readonly base: string;
  readonly head: string;
  readonly evidence: EvidenceStore;
}

/** The history with its pull request's change at the repository's commits. */
function atCommits(history: History, fixture: Fixture): History {
  const result = new History();
  for (const event of history.events) {
    const scope = { ...pullRequestScope, base: fixture.base, head: fixture.head, request: { ...pullRequestScope.request, range: { from: fixture.base, to: 'HEAD', mergeBase: false } } };
    result.add(event.kind, event.kind === 'scope.captured' ? scope : event.payload, event.version);
  }
  return result;
}

/** A read-only run of a pull request through its decision, RIPPLE-1 decided fix and SWEEP-1 as `sweep` says, at the fixture's commits. */
const decided = (fixture: Fixture, sweep: unknown = decisions[1]): History =>
  atCommits(withPullRequest(withCitedRuns(withBaseChecks(withDocumentationStep(decidedOf(mergeRanked(), [decisions[0], sweep]), null)))), fixture);

const receipt = (output: unknown, workerId = worker(62), change: Partial<WorkerReceipt> = {}): WorkerReceipt => {
  const reference = { sha256: 'a'.repeat(64), bytes: 1 };
  return {
    workerId,
    outcome: 'completed',
    error: null,
    cause: null,
    finish: null,
    process: { exitCode: 0, signal: null, termination: 'exited', startedAt: '2026-11-01T00:00:00.000Z', endedAt: '2026-11-01T00:00:01.000Z' },
    runtime: { name: 'claude', version: '2.1.283', sessionIds: [], usage: null },
    denials: [],
    runs: [],
    output,
    evidence: { prompt: reference, schema: reference, stdout: reference, stderr: reference, finalMessage: null, output: reference },
    ...change,
  };
};

const writerUnit = { phase: 'explanation', key: 'explanation', role: 'writer' } as const;

/** The events a writer's receipt becomes in `history`. */
const contribution = (history: History, fixture: Fixture, answer: WorkerReceipt, logged: string[] = []): NewEvent[] =>
  contributionOf(writerUnit, answer, { state: history.fold(), worktree: fixture.repo, evidence: fixture.evidence, match: () => { throw new Error('the writer compares no file'); }, claims: null, survey: () => { throw new Error('the writer has no survey'); }, claimsLost: false, log: (line) => logged.push(line) });

/** The explanation an event records, held to the schema of its version, as the fold holds it. */
const recorded = (event: NewEvent | undefined): ExplanationRecorded => {
  assert.equal(event?.kind, 'explanation.recorded', JSON.stringify(event));
  if (event.version === 2) return { ...explanationRecordedV2.parse(event.payload), version: 2 };
  assert.equal(event.version, 1);
  return { ...explanationRecordedV1.parse(event.payload), version: 1 };
};

/** The payload an explanation was recorded with, as the ledger holds it, without the version the fold adds. */
const payloadOf = ({ version: _version, ...payload }: ExplanationRecorded): Omit<ExplanationRecorded, 'version'> => payload;

/** The history after a writer, `n`, answered `answer` and its attempt failed the checks. */
const failedOnce = (history: History, fixture: Fixture, answer: WriterOutput, n = 61): History =>
  history.worker(n, 'writer explanation:explanation', { output: fixture.evidence.put(JSON.stringify(answer)) })
    .add('attempt.failed', { phase: 'explanation', key: 'explanation', workerId: worker(n), reason: 'structural check: the answer fails the engine\'s checks', fault: 'unit' }, 9);

const machine = (repo: string): MachineContext => ({ worktree: repo, checkpoint: join(repo, '.git', 'deep-review-checkpoint'), gitCommon: join(repo, '.git'), engine: '/opt/deep-review', scratch: [], environment: {}, home: '/home/me', rootEntries: ['home', 'opt', 'tmp'] });

const counted = (usd: number): Live['spend'] => ({ usd, charged: 0, lost: 0 });
const idle: Live = { running: new Set(), spend: counted(0), evidencePath: (reference) => `/evidence/${reference.sha256.slice(0, 8)}`, checkSettings: noCheckSettings, claimsLost: null };

/** The reason of the step that drops the explanation, the phase's one degradation, failing the test for any other step. */
function droppedReason(step: Step): string {
  assert.ok(step.kind === 'degrade' && step.phase === 'explanation', JSON.stringify(step));
  assert.equal(step.degradations.length, 1, JSON.stringify(step));
  const [degradation] = step.degradations;
  assert.equal(degradation!.kind, 'explanation.dropped', JSON.stringify(step));
  return degradation!.reason;
}

describe('the explanation phase (R18, R19, TD8)', () => {
  let directory = '';
  let fixture: Fixture;
  before(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-explanation-')));
    const repo = createRepository(join(directory, 'repo'));
    write(repo, 'src/a.ts', numbered(10));
    write(repo, 'src/gone.ts', 'a\nb\nc\n');
    const base = commitAll(repo, 'base');
    write(repo, 'src/a.ts', numbered(12));
    remove(repo, 'src/gone.ts');
    const head = commitAll(repo, 'head');
    fixture = { repo, base, head, evidence: new EvidenceStore(join(directory, 'evidence')) };
  });
  after(() => rmSync(directory, { recursive: true, force: true }));

  it('explains each finding decided fix or ask, in rank order, and none left as is', () => {
    assert.deepEqual(findingsToExplain(decided(fixture).review()), ['RIPPLE-1']);
    assert.deepEqual(findingsToExplain(decided(fixture, askDecision('SWEEP-1', true)).review()), ['RIPPLE-1', 'SWEEP-1']);
  });

  it('plans one writer right after the decision in a run of a pull request, and none in a run configured at version 9', () => {
    const history = decided(fixture);
    assert.deepEqual(nextStep(history.review(), idle), { kind: 'start-phase', phase: 'explanation', attempt: 1 });
    assert.deepEqual(nextStep(history.start('explanation').review(), idle), { kind: 'launch', units: [writerUnit] });
    assert.equal(readOnlyReported().review().phases.explanation.status, 'skipped');
  });

  it('records an answer whose every part passes, frozen as the form reads it', () => {
    const events = contribution(decided(fixture).start('explanation'), fixture, receipt(goodAnswer()));
    assert.equal(events.length, 1);
    const explanation = recorded(events[0]);
    assert.equal(explanation.workerId, worker(62));
    assert.deepEqual(explanation.dropped, []);
    assert.deepEqual(explanation.unexplained, []);
    const answer = recordedAnswerOf(explanation, fixture.evidence);
    assert.deepEqual(answer?.conclusion, goodAnswer().conclusion);
    assert.deepEqual(answer?.findings.map((finding) => [finding.id, finding.unexplained]), [['RIPPLE-1', false]]);
    const after = decided(fixture).start('explanation').worker(62, 'writer explanation:explanation', { output: fixture.evidence.put(JSON.stringify(goodAnswer())) }).add('explanation.recorded', payloadOf(explanation), explanation.version);
    assert.deepEqual(nextStep(after.review(), idle), { kind: 'finish-phase', phase: 'explanation', attempt: 1, outcome: 'completed', blocker: null }, 'an explanation no part of which was dropped does not degrade the phase');
  });

  it('records a finding the writer marked unexplained, which the review gives in the ledger\'s words with the mark', () => {
    const answer = goodAnswer();
    answer.findings[0] = { id: 'RIPPLE-1', explanation: null, unexplained: 'Its evidence names no line it reads.' };
    const explanation = recorded(contribution(decided(fixture).start('explanation'), fixture, receipt(answer))[0]);
    assert.deepEqual(explanation.unexplained, ['RIPPLE-1']);
    assert.deepEqual(recordedAnswerOf(explanation, fixture.evidence)?.findings, [{ id: 'RIPPLE-1', unexplained: true, reason: 'Its evidence names no line it reads.' }]);
  });

  it('refuses an answer that fails a check on the unit\'s first attempt, naming each part, and gives the next writer the failures', () => {
    const bad = goodAnswer();
    bad.findings[0]!.explanation!.cases[0]!.lines.to = 30;
    const logged: string[] = [];
    bad.findings.push({ ...bad.findings[0]!, id: 'NOPE-9' });
    const history = decided(fixture).start('explanation');
    const [failure] = contribution(history, fixture, receipt(bad), logged);
    assert.equal(failure?.kind, 'attempt.failed');
    assert.equal(failure?.version, 9, 'the version that names the explanation');
    assert.match((failure?.payload as { reason: string }).reason, /^structural check: the answer fails the engine's checks: finding RIPPLE-1: case 1 of RIPPLE-1 cites src\/a\.ts:4-30, which has 12 lines at the head$/);
    assert.deepEqual(logged, ['the answer explains NOPE-9, which is no finding of the run that asks a person to act; not kept']);
    const retried = failedOnce(history, fixture, bad);
    assert.deepEqual(nextStep(retried.review(), idle), { kind: 'launch', units: [writerUnit] }, 'a failed check runs the writer again once');
    const task = writerTask(retried.fold(), { worktree: fixture.repo, evidence: fixture.evidence, machine: machine(fixture.repo) });
    assert.match(task, /### What failed in the earlier answer\n\n[^\n]*the engine keeps every other part of it[^\n]*\n\n- finding RIPPLE-1: case 1 of RIPPLE-1 cites src\/a\.ts:4-30, which has 12 lines at the head\n/);
    assert.doesNotMatch(task, /The conclusion and the areas go together/, 'a finding alone failed');
  });

  it('records the second answer with each part that still fails dropped and named, keeping each part that passed the first time', () => {
    const first = goodAnswer();
    first.findings[0]!.explanation!.cases[0]!.lines = { side: 'head', path: 'src/gone.ts', from: 1, to: 1 };
    const second = goodAnswer();
    second.conclusion.why = 'PLAUSIBLE at best.';
    second.findings[0]!.explanation!.cases[0]!.lines.path = 'src/also-missing.ts';
    const history = failedOnce(decided(fixture).start('explanation'), fixture, first);
    const explanation = recorded(contribution(history, fixture, receipt(second))[0]);
    assert.equal(explanation.workerId, worker(62), 'the writer whose answer completed the unit');
    assert.deepEqual(explanation.dropped, [{ part: 'finding', finding: 'RIPPLE-1', failures: ['case 1 of RIPPLE-1 cites src/also-missing.ts at the head, which holds no such file'] }]);
    const answer = recordedAnswerOf(explanation, fixture.evidence);
    assert.equal(answer?.conclusion?.why, first.conclusion.why, 'the conclusion the first answer passed is kept over the second one\'s');
    assert.deepEqual(answer?.findings, []);
    // A case on removed code cites the merge base, which holds it.
    const removed = goodAnswer();
    removed.findings[0]!.explanation!.cases[0]!.lines = { side: 'base', path: 'src/gone.ts', from: 1, to: 3 };
    const after = history.worker(62, 'writer explanation:explanation', { output: fixture.evidence.put(JSON.stringify(second)) }).add('explanation.recorded', payloadOf(explanation), explanation.version);
    assert.deepEqual(nextStep(after.review(), idle), { kind: 'finish-phase', phase: 'explanation', attempt: 1, outcome: 'degraded', blocker: null }, 'a part dropped degrades the phase');
    assert.deepEqual(recorded(contribution(history, fixture, receipt(removed))[0]).dropped, []);
  });

  it('does not drop a part after a writer lost with its engine: the unit blocks, and the next command gives it fresh attempts', () => {
    const bad = goodAnswer();
    bad.conclusion.actions = [];
    const lost = decided(fixture).start('explanation')
      .add('worker.launched', launch(worker(61), 'writer explanation:explanation'))
      .add('worker.lost', { workerId: worker(61), phase: 'explanation', key: 'explanation', reason: 'the engine exited while the worker ran' }, 7);
    const [failure] = contribution(lost, fixture, receipt(bad));
    assert.equal(failure?.kind, 'attempt.failed', 'an interruption is not the unit failing, so the answer is refused, not recorded with a part dropped');
  });

  it('degrades a writer that fails twice with no answer, keeping each part an earlier answer passed, and the run goes on to its report', () => {
    const first = goodAnswer();
    first.account.problem.text = '';
    const history = failedOnce(decided(fixture).start('explanation'), fixture, first)
      .worker(62, 'writer explanation:explanation', { outcome: 'timeout', termination: 'killed', exitCode: null, signal: 'SIGKILL', output: null, error: 'The worker ran past its timeout' })
      .add('attempt.failed', { phase: 'explanation', key: 'explanation', workerId: worker(62), reason: 'timeout: The worker ran past its timeout', fault: 'unit' }, 9);
    const reason = droppedReason(nextStep(history.review(), idle));
    assert.match(reason, /^2 attempts did not complete: structural check: [^;]*; timeout: The worker ran past its timeout$/);
    const event = droppedExplanation(history.fold(), { worktree: fixture.repo, evidence: fixture.evidence }, reason);
    const explanation = recorded(event);
    assert.equal(explanation.workerId, null, 'the phase degraded without an answer that completed it');
    assert.deepEqual(explanation.dropped, [{ part: 'account', failures: ['the account says no problem before the change', reason] }]);
    assert.deepEqual(recordedAnswerOf(explanation, fixture.evidence)?.findings.map((finding) => finding.id), ['RIPPLE-1']);
    const after = history.add('explanation.recorded', payloadOf(explanation), explanation.version);
    assert.deepEqual(nextStep(after.review(), idle), { kind: 'finish-phase', phase: 'explanation', attempt: 1, outcome: 'degraded', blocker: null });
    assert.deepEqual(nextStep(after.finish('explanation', 'degraded').review(), idle), { kind: 'start-phase', phase: 'report', attempt: 1 }, 'the run writes its report');
  });

  it('degrades at the run budget instead of blocking, dropping each part no answer passed, and records no answer when none passed any part', () => {
    const history = decided(fixture).start('explanation');
    const runBudgetUsd = history.review().limits.runBudgetUsd!;
    const reason = droppedReason(nextStep(history.review(), { ...idle, spend: counted(runBudgetUsd) }));
    assert.match(reason, /^spent \d+\.\d\d USD of the \d+\.\d\d USD run budget$/);
    const explanation = recorded(droppedExplanation(history.fold(), { worktree: fixture.repo, evidence: fixture.evidence }, reason));
    assert.equal(explanation.answer, null);
    assert.deepEqual(explanation.dropped.map((part) => (part.part === 'finding' ? `finding ${part.finding}` : part.part)), ['conclusion', 'account', 'finding RIPPLE-1']);
    for (const part of explanation.dropped) assert.deepEqual(part.failures, [reason]);
    const after = history.add('explanation.recorded', payloadOf(explanation), explanation.version);
    assert.deepEqual(nextStep(after.review(), { ...idle, spend: counted(runBudgetUsd) }), { kind: 'finish-phase', phase: 'explanation', attempt: 1, outcome: 'degraded', blocker: null });
    assert.deepEqual(after.review().fix, null, 'no fix state, so no unit is left not attempted for the budget');
  });

  it('blocks a writer lost with its engine and then failed, and gives it fresh attempts when the phase is entered again', () => {
    const history = decided(fixture).start('explanation')
      .add('worker.launched', launch(worker(61), 'writer explanation:explanation'))
      .add('worker.lost', { workerId: worker(61), phase: 'explanation', key: 'explanation', reason: 'the engine exited while the worker ran' }, 7)
      .worker(62, 'writer explanation:explanation', { outcome: 'failed', output: null, error: 'The answer does not match the output schema' })
      .add('attempt.failed', { phase: 'explanation', key: 'explanation', workerId: worker(62), reason: 'failed: The answer does not match the output schema', fault: 'unit' }, 9);
    const step = nextStep(history.review(), idle);
    assert.ok(step.kind === 'finish-phase' && step.outcome === 'blocked' && step.blocker?.code === 'worker-failed', JSON.stringify(step));
    const resumed = history.finish('explanation', 'blocked', 1, step.kind === 'finish-phase' ? step.blocker : null).start('explanation', 2);
    assert.deepEqual(nextStep(resumed.review(), idle), { kind: 'launch', units: [writerUnit] });
  });

  it('gives the writer the brief, every ranked finding with its decision and evidence cleaned, which to explain and the language, and neither the title nor the body of the pull request', () => {
    const history = new History();
    for (const event of decided(fixture, askDecision('SWEEP-1', true)).start('explanation').events) {
      const payload = event.kind === 'ranking.recorded'
        ? { ...(event.payload as object), findings: (event.payload as { findings: { id: string; reason: string }[] }).findings.map((finding) => (finding.id === 'RIPPLE-1' ? { ...finding, reason: 'the notes at /home/me/notes.txt say so, @octocat' } : finding)) }
        : event.payload;
      history.add(event.kind, payload, event.version);
    }
    const task = writerTask(history.fold(), { worktree: fixture.repo, evidence: fixture.evidence, machine: machine(fixture.repo) });
    assert.match(task, /^Write every text of your answer in the language `en` \(English\)\.$/m);
    assert.match(task, /^Explain these 2 findings, each by its id, [^\n]*: RIPPLE-1, SWEEP-1\./m);
    assert.match(task, /^### The brief of the run\n\n[^\n]*\n\n```markdown\n# /m);
    assert.match(task, /^#### 1\. RIPPLE-1: explain it\n\n {4}severity: major; verdict: CONFIRMED\n/m);
    assert.match(task, /^ {4}reason: the notes at \\<local path> say so, `@octocat`$/m, 'a worker\'s words are cleaned and escaped as the review posts them');
    assert.match(task, /^1\. \*\*Finding 2 asks you a question/m, 'the fenced brief is cleaned as code, and not escaped');
    assert.match(task, /^ {4}decision: fix\n {8}grounds: [^\n]+\n {8}approach: guard the null once, before parse reads it\n/m);
    assert.match(task, /^ {4}decision: ask the author\n[\s\S]*?^ {8}option 2: accept it and return an empty result; [^\n]*; recommended$/m);
    assert.match(task, /^ {8}evidence: line 4 dereferences null$/m);
    assert.doesNotMatch(task, /What failed in the earlier answer/);
    assert.ok(!task.includes(pullRequestFacts.title), 'the title of the pull request (PD8)');
    assert.ok(!task.includes(pullRequestFacts.body.sha256), 'the body of the pull request');
    assert.ok(!task.includes('/home/me'), 'no local path');
  });

  it('gives the writer the choice each decision settles, the step in words, as the decision\'s and not the author\'s to make (R5 of the settled choice)', () => {
    const settled = { choice: 'An empty input gives an empty result.', by: 'intent' as const, source: 'The change says that an empty input gives an empty result.' };
    const folded = decided(fixture).start('explanation').fold();
    const task = (decisions: NonNullable<typeof folded.review>['decisions']): string => writerTask({ ...folded, review: { ...folded.review!, decisions } }, { worktree: fixture.repo, evidence: fixture.evidence, machine: machine(fixture.repo) });
    const withSettled = task(folded.review!.decisions!.map((decision) => (decision.id === 'RIPPLE-1' ? { ...decision, settled: [{ ...settled, for: [] }] } : decision)));
    assert.match(withSettled, /^ {8}approach: [^\n]*\n(?: {8}rejected: [^\n]*\n)* {8}settled by the decision: An empty input gives an empty result; settled by the stated intent of the change: The change says that an empty input gives an empty result\.$/m);
    assert.match(withSettled, /A choice a decision settles, on its line `settled by the decision`, is the decision's and not the author's to make, whatever a verifier's note says: explain it as decided\./);
    const without = task(folded.review!.decisions);
    assert.doesNotMatch(without, /settled by the decision/, 'a run whose decisions settle no choice is told nothing of it');
  });

  it('gives the writer, under a merged finding\'s decision, the choice each settled choice answers and the one no settled choice answers (PD9 of the settled choice)', () => {
    const folded = decided(fixture).start('explanation').fold();
    const named = (id: string, authorChoice: string) => ({ ...folded.review!.candidates[id]!, unverified: false, verdict: { verdict: 'CONFIRMED' as const, evidence: `${id} evidence`, basis: 'read' as const, runs: [], unconfirmed: null, authorChoice } });
    const candidates = { ...folded.review!.candidates, 'RIPPLE-1': named('RIPPLE-1', 'Guard in parse, or in each caller.'), 'SWEEP-2': named('SWEEP-2', 'Keep the helper, or inline it.') };
    const settled = [{ for: ['RIPPLE-1'], choice: 'Parse guards the null itself.', by: 'intent' as const, source: 'The change says parse accepts an empty input.' }];
    const decisions = folded.review!.decisions!.map((decision) => (decision.id === 'RIPPLE-1' ? { ...decision, settled } : decision));
    const task = writerTask({ ...folded, review: { ...folded.review!, candidates, decisions } }, { worktree: fixture.repo, evidence: fixture.evidence, machine: machine(fixture.repo) });
    assert.match(task, /^ {8}the verifier's choice for the author: Guard in parse, or in each caller\.\n {8}settled by the decision: Parse guards the null itself; settled by the stated intent of the change: The change says parse accepts an empty input\.\n {8}the verifier's choice for the author, which the decision did not settle: Keep the helper, or inline it\.$/m);
  });

  it('writes in the language the run recorded', () => {
    const history = new History();
    for (const event of decided(fixture).start('explanation').events) {
      const payload = event.kind === 'review.configured' ? { ...(event.payload as { settings: { values: object; layers: object } }), settings: { ...(event.payload as { settings: { values: object; layers: object } }).settings, values: { ...(event.payload as { settings: { values: object } }).settings.values, 'review.language': 'ko' }, layers: { ...(event.payload as { settings: { layers: object } }).settings.layers, 'review.language': 'repository' } } } : event.payload;
      history.add(event.kind, payload, event.version);
    }
    assert.match(writerTask(history.fold(), { worktree: fixture.repo, evidence: fixture.evidence, machine: machine(fixture.repo) }), /^Write every text of your answer in the language `ko` \(Korean\)\.$/m);
  });

  it('launches the writer read-only, without a shell on a runtime that can withhold one, and with the read-only shell of a verifier elsewhere', () => {
    const roles = new Map<string, AssembledRole>(reviewRoles.map((key) => [key, { key, fragments: [], prompt: `You are ${key}.\n`, sha256: 'b'.repeat(64) }]));
    const context = (withholdShell: boolean | null): PhaseContext => ({
      state: decided(fixture).start('explanation').fold(),
      worktree: fixture.repo,
      roles,
      configuration: { ...configuration, roles: reviewRoles.map((role) => ({ role, model: 'opus', effort: 'high' as const, budgetUsd: 8, timeoutMs: 1_800_000 })) },
      scopeBlock: () => '## Scope',
      survey: () => { throw new Error('no survey'); },
      commitMessages: () => { throw new Error('no commit message'); },
      evidence: fixture.evidence,
      newScratch: () => { throw new Error('the writer has no scratch'); },
      snapshotCommand: () => 'snapshot',
      unelevatedEditors: false,
      readerScratch: true,
      claims: { directoryOf: () => '/claims', command: () => 'claim', live: () => null, caseInsensitive: () => false },
      documentation: () => ({ patches: [], exclude: [] }),
      ...(withholdShell === null ? {} : { writer: () => ({ machine: machine(fixture.repo), withholdShell }) }),
    });
    const claude = invocationFor(writerUnit, context(true));
    assert.equal(claude.shell, false);
    assert.equal(claude.access, 'read-only');
    assert.equal(claude.scratch, undefined);
    assert.equal(claude.label, 'writer explanation:explanation');
    assert.equal(claude.timeoutMs, 1_800_000);
    assert.deepEqual(claudeTools(claude.access, claude.shell), ['Read', 'Glob', 'Grep'], 'on Claude Code, the tools that read files and not Bash');
    assert.match(claude.prompt, /^You are writer\.\n\n## Task\n\nRole: writer\nUnit: explanation\nPhase: explanation\n\nWrite every text of your answer in the language `en`/);
    const codex = invocationFor(writerUnit, context(false));
    assert.equal(codex.shell, true, 'a runtime that gives every worker a shell');
    assert.equal(codex.access, 'read-only', 'the read-only sandbox of a verifier');
    assert.throws(() => invocationFor(writerUnit, context(null)), /The writer is launched with the machine its task is cleaned of/);
  });
});

/** An answer in the form of the review that reads as a report that passes every check: RIPPLE-1, major, in an area, SWEEP-1 minor with a kind, and a line for SCAN-1, refuted. */
function goodReport(ids: readonly string[] = ['RIPPLE-1', 'SWEEP-1']): WriterOutputV2 {
  const first = goodAnswer(ids);
  return {
    conclusion: first.conclusion,
    areas: [{ title: 'A caller that passes an empty file meets a crash', intro: 'parse() reads the value an empty file gives before any guard.', diagram: 'flowchart LR\n  A["empty file"] --> B["crash"]', findings: ids.filter((id) => id === 'RIPPLE-1') }],
    findings: first.findings.map((entry) => ({ ...entry, explanation: { ...entry.explanation!, checked: 'The verifier traced an empty file from the caller to the read on line 4.', kind: entry.id === 'RIPPLE-1' ? null : 'code' } })),
    refuted: [{ id: 'SCAN-1', claim: 'parse() never closes the file it opens.', why: 'The caller closes it on the next line.' }],
  };
}

/** What the run of these tests holds an answer of version 2 to: RIPPLE-1 major, SWEEP-1 minor, neither a question, SCAN-1 refuted. */
const report = { major: ['RIPPLE-1'], asks: [], refuted: ['SCAN-1'] };
const checkReport = (output: WriterOutputV2, ids: readonly string[] = ['RIPPLE-1', 'SWEEP-1']) => checkAnswer(output, { ids, lineCount: fakeLines, report });
/** The failures of every part of a checked answer of version 2, by part. */
const reportFailures = (output: WriterOutputV2): Record<string, readonly string[]> => {
  const checked = checkReport(output);
  assert.equal(checked.account, null, 'an answer of version 2 has no account');
  return { conclusion: checked.conclusion.failures, areas: checked.areas!.failures, refuted: checked.refuted!.failures, ...Object.fromEntries([...checked.findings].map(([id, part]) => [`finding ${id}`, part.failures])) };
};

// R4, R10, R11, R13, TD2 of the review that reads as a report.
describe('the checks of the writer\'s answer in the form of the review that reads as a report', () => {
  it('passes an answer whose every part keeps the rules, and keeps how each finding was checked and its kind', () => {
    for (const [part, failures] of Object.entries(reportFailures(goodReport()))) assert.deepEqual(failures, [], part);
    const sweep = checkReport(goodReport()).findings.get('SWEEP-1')?.value;
    assert.ok(sweep !== null && sweep !== undefined && !sweep.unexplained);
    assert.deepEqual([sweep.checked, sweep.kind], ['The verifier traced an empty file from the caller to the read on line 4.', 'code']);
  });

  it('refuses areas that leave a major finding out, put it in two, hold a minor finding or an id of no finding, or say nothing', () => {
    const answer = (areas: WriterOutputV2['areas']): WriterOutputV2 => ({ ...goodReport(), areas });
    const area = (findings: string[], change: Partial<WriterOutputV2['areas'][number]> = {}): WriterOutputV2['areas'][number] => ({ title: 'A caller meets a crash', intro: 'One sentence.', diagram: null, findings, ...change });
    assert.deepEqual(reportFailures(answer([])).areas, ['the areas leave out RIPPLE-1, a major finding that asks a person to act']);
    assert.deepEqual(reportFailures(answer([area(['RIPPLE-1']), area(['RIPPLE-1'])])).areas, ['RIPPLE-1 is in 2 areas, and a finding is in one']);
    assert.deepEqual(reportFailures(answer([area(['RIPPLE-1', 'SWEEP-1', 'NOPE-9'])])).areas, ['the areas name SWEEP-1, a minor finding, which no area holds', 'the areas name "NOPE-9", which is no major finding of the run that asks a person to act']);
    assert.deepEqual(reportFailures(answer([area(['RIPPLE-1'], { title: ' ', intro: '' }), area([])])).areas, ['area 1 has no title', 'area 1 has no intro', 'area 2 names no finding']);
    assert.deepEqual(reportFailures(answer([area(['RIPPLE-1'], { intro: 'It is CONFIRMED.', diagram: 'pie\n  "a" : 1' })])).areas, [
      'area 1 holds the verdict CONFIRMED, which the engine writes beside the finding',
      'the diagram of area 1 is no diagram GitHub draws: it starts with "pie", not with flowchart, sequenceDiagram or stateDiagram-v2, the kinds GitHub draws',
    ]);
    assert.deepEqual(checkAnswer({ ...goodReport(['SWEEP-1']), areas: [] }, { ids: ['SWEEP-1'], lineCount: fakeLines, report: { major: [], asks: [], refuted: ['SCAN-1'] } }).areas?.failures, [], 'a run with no major finding to explain has no area');
  });

  it('holds the sentence of a question, which the form does not post, to nothing, and still refuses an id of no finding', () => {
    const asked = { ...report, asks: ['SWEEP-1'] };
    const conclusionOf = (actions: WriterOutputV2['conclusion']['actions']): readonly string[] => checkAnswer({ ...goodReport(), conclusion: { ...goodReport().conclusion, actions } }, { ids: ['RIPPLE-1', 'SWEEP-1'], lineCount: fakeLines, report: asked }).conclusion.failures;
    const fix = { id: 'RIPPLE-1', sentence: 'Guard the null once, before parse reads it.' };
    assert.deepEqual(conclusionOf([fix, { id: 'SWEEP-1', sentence: 'It asks, and recommends the CONFIRMED fix.' }]), [], 'a verdict word in the sentence of a question');
    assert.deepEqual(conclusionOf([fix]), [], 'no sentence for a question');
    assert.deepEqual(conclusionOf([fix, { id: 'SWEEP-1', sentence: ' ' }, { id: 'SWEEP-1', sentence: 'Again.' }]), [], 'an empty sentence for a question, given twice');
    assert.deepEqual(conclusionOf([{ ...fix, sentence: 'Fix it, as CONFIRMED.' }, { id: 'NOPE-9', sentence: 'It is CONFIRMED.' }]), [
      'the conclusion names "NOPE-9", which is no finding of the run that asks a person to act',
      'the conclusion holds the verdict CONFIRMED, which the engine writes beside the finding',
    ], 'the sentence of a fix, and of an id of no finding, is still checked');
    assert.deepEqual(conclusionOf([{ id: 'SWEEP-1', sentence: 'It asks.' }]), ['the conclusion has no sentence for RIPPLE-1'], 'a fix still needs its sentence');
    assert.deepEqual(checkReport({ ...goodReport(), conclusion: { ...goodReport().conclusion, actions: [fix] } }).conclusion.failures, ['the conclusion has no sentence for SWEEP-1'], 'a finding to fix that is minor still needs its sentence');
  });

  it('refuses refuted lines that leave a refuted candidate out, give it two, name another id, or say nothing', () => {
    const answer = (refuted: WriterOutputV2['refuted']): WriterOutputV2 => ({ ...goodReport(), refuted });
    const line = goodReport().refuted[0]!;
    assert.deepEqual(reportFailures(answer([])).refuted, ['the refuted lines have no line for SCAN-1']);
    assert.deepEqual(reportFailures(answer([line, line, { ...line, id: 'RIPPLE-1' }])).refuted, ['the refuted lines have 2 lines for SCAN-1, and a candidate has one', 'the refuted lines name "RIPPLE-1", which is no refuted candidate of the run']);
    assert.deepEqual(reportFailures(answer([{ ...line, claim: '', why: 'It was REFUTED.' }])).refuted, ['the refuted line for SCAN-1 says no claim', 'the refuted line for SCAN-1 holds the verdict REFUTED, which the engine writes beside the finding']);
  });

  it('refuses a minor finding with no kind, a major one with a kind, and a major explanation that says nothing of how it was checked or holds a verdict there', () => {
    const answer = goodReport();
    answer.findings[0]!.explanation!.kind = 'user';
    answer.findings[0]!.explanation!.checked = ' ';
    answer.findings[1]!.explanation!.kind = null;
    const failures = reportFailures(answer);
    assert.deepEqual(failures['finding RIPPLE-1'], ['RIPPLE-1 says nothing of how its verifier checked it', 'RIPPLE-1 is a major finding and has the kind user, which only a minor finding has']);
    assert.deepEqual(failures['finding SWEEP-1'], ['SWEEP-1 is a minor finding and has no kind']);
    const verdict = goodReport();
    verdict.findings[0]!.explanation!.checked = 'The run left it PLAUSIBLE.';
    assert.deepEqual(reportFailures(verdict)['finding RIPPLE-1'], ['the explanation of RIPPLE-1 holds the verdict PLAUSIBLE, which the engine writes beside the finding']);
  });

  it('keeps a conclusion and a finding whose posted words pass, whatever the conclusion\'s diagram and the decision say, which the form does not post', () => {
    const answer = goodReport();
    answer.conclusion.diagram = 'graph TD\n  A["CONFIRMED"] --> B';
    answer.findings[0]!.explanation!.decision = ' ';
    answer.findings[1]!.explanation!.decision = 'It is CONFIRMED, so fix it.';
    for (const [part, failures] of Object.entries(reportFailures(answer))) assert.deepEqual(failures, [], part);
    const merged = mergeAnswers(2, [checkReport(answer), checkReport(answer)], ['RIPPLE-1', 'SWEEP-1']);
    assert.deepEqual(merged.dropped, []);
    assert.equal(merged.answer.conclusion?.why, answer.conclusion.why);
    assert.deepEqual(merged.answer.findings.map((finding) => finding.id), ['RIPPLE-1', 'SWEEP-1']);
    const older = goodAnswer();
    older.conclusion.diagram = answer.conclusion.diagram;
    older.findings[0]!.explanation!.decision = ' ';
    assert.deepEqual(failuresOf(older), {
      conclusion: ['the conclusion holds the verdict CONFIRMED, which the engine writes beside the finding', 'the conclusion\'s diagram is no diagram GitHub draws: it starts with "graph TD", not with flowchart, sequenceDiagram or stateDiagram-v2, the kinds GitHub draws'],
      account: [],
      'finding RIPPLE-1': ['RIPPLE-1 says nothing of its decision'],
    }, 'an answer of version 1 keeps every check');
  });

  it('keeps a minor finding whose title and problem pass, whatever its cases, diagram and check say, which its comment does not post', () => {
    /** The answer with each finding given a case past the end of its file, a diagram GitHub does not draw, a blank check and a verdict in its case. */
    const flawed = (): WriterOutputV2 => {
      const answer = goodReport();
      for (const entry of answer.findings) {
        const explanation = entry.explanation!;
        explanation.cases = [{ sentence: 'It is CONFIRMED.', lines: { side: 'head', path: 'src/a.ts', from: 40, to: 41 } }];
        explanation.diagram = 'pie\n  "a" : 1';
        explanation.checked = ' ';
      }
      return answer;
    };
    const failures = reportFailures(flawed());
    assert.deepEqual(failures['finding SWEEP-1'], [], 'a minor finding');
    assert.deepEqual(failures['finding RIPPLE-1'], [
      'case 1 of RIPPLE-1 cites src/a.ts:40-41, which has 12 lines at the head',
      'RIPPLE-1 says nothing of how its verifier checked it',
      'the explanation of RIPPLE-1 holds the verdict CONFIRMED, which the engine writes beside the finding',
      'the diagram of RIPPLE-1 is no diagram GitHub draws: it starts with "pie", not with flowchart, sequenceDiagram or stateDiagram-v2, the kinds GitHub draws',
    ], 'a major finding keeps every check');
    const noCase = goodReport();
    noCase.findings[1]!.explanation!.cases = [];
    assert.deepEqual(reportFailures(noCase)['finding SWEEP-1'], [], 'a minor finding with no case');
    const merged = mergeAnswers(2, [checkReport(flawed()), checkReport(flawed())], ['RIPPLE-1', 'SWEEP-1']);
    assert.deepEqual(merged.dropped.map((part) => (part.part === 'finding' ? part.finding : part.part)), ['RIPPLE-1'], 'only the major finding is dropped');
    const sweep = merged.answer.findings.find((finding) => finding.id === 'SWEEP-1');
    assert.ok(sweep !== undefined && !sweep.unexplained, 'the minor finding keeps its explanation');
    assert.equal(sweep.title, goodReport().findings[1]!.explanation!.title);
  });

  it('drops the areas or the refuted lines that fail twice, alone, and every part when no answer came', () => {
    const first = goodReport();
    first.areas = [];
    const second = goodReport();
    second.areas = [];
    second.refuted = [];
    const merged = mergeAnswers(2, [checkReport(first), checkReport(second)], ['RIPPLE-1', 'SWEEP-1']);
    assert.deepEqual(merged.dropped, [{ part: 'areas', failures: ['the areas leave out RIPPLE-1, a major finding that asks a person to act'] }]);
    assert.deepEqual([merged.answer.areas, merged.answer.refuted, merged.answer.account], [null, first.refuted, null], 'the refuted lines the first answer passed are kept');
    assert.deepEqual(mergeAnswers(2, [], ['RIPPLE-1'], ['the run budget stopped the writer']).dropped.map((part) => (part.part === 'finding' ? `finding ${part.finding}` : part.part)), ['conclusion', 'areas', 'refuted', 'finding RIPPLE-1']);
  });

  it('takes the conclusion and the areas it names from one answer, and keeps the areas when no answer passed both', () => {
    const noAreas = goodReport();
    noAreas.conclusion.why = 'The first summary names an area the retry dropped.';
    noAreas.areas = [];
    const both = goodReport();
    both.conclusion.why = 'The second summary names the areas of the second answer.';
    both.areas[0]!.title = 'The area of the second answer';
    const paired = mergeAnswers(2, [checkReport(noAreas), checkReport(both)], ['RIPPLE-1', 'SWEEP-1']);
    assert.deepEqual(paired.dropped, []);
    assert.deepEqual([paired.answer.conclusion?.why, paired.answer.areas?.[0]?.title], [both.conclusion.why, 'The area of the second answer'], 'the conclusion that passed first is replaced by the one beside the areas');
    const badConclusion = goodReport();
    badConclusion.conclusion.why = 'It is CONFIRMED.';
    const apart = mergeAnswers(2, [checkReport(badConclusion), checkReport(noAreas)], ['RIPPLE-1', 'SWEEP-1']);
    assert.deepEqual(apart.dropped, [{ part: 'conclusion', failures: ['the conclusion holds the verdict CONFIRMED, which the engine writes beside the finding'] }], 'the conclusion of the answer whose areas are kept, with its failures');
    assert.deepEqual([apart.answer.conclusion, apart.answer.areas], [null, badConclusion.areas]);
    const withoutAreas = mergeAnswers(2, [checkReport(noAreas), checkReport({ ...noAreas, conclusion: badConclusion.conclusion })], ['RIPPLE-1', 'SWEEP-1']);
    assert.deepEqual(withoutAreas.dropped.map((part) => part.part), ['areas']);
    assert.equal(withoutAreas.answer.conclusion?.why, noAreas.conclusion.why, 'with no areas kept, the first conclusion that passed');
    assert.equal(mergeAnswers(1, [check(goodAnswer()), check(goodAnswer())], ['RIPPLE-1']).answer.conclusion?.why, goodAnswer().conclusion.why, 'an answer of version 1 has no areas');
  });
});

describe('the explanation phase of a run whose review reads as a report (R4, R10, R11, R13, TD2)', () => {
  let directory = '';
  let fixture: Fixture;
  before(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-report-form-')));
    const repo = createRepository(join(directory, 'repo'));
    write(repo, 'src/a.ts', numbered(10));
    const base = commitAll(repo, 'base');
    write(repo, 'src/a.ts', numbered(12));
    const head = commitAll(repo, 'head');
    fixture = { repo, base, head, evidence: new EvidenceStore(join(directory, 'evidence')) };
  });
  after(() => rmSync(directory, { recursive: true, force: true }));

  /**
   * A decided run of a pull request configured at version 11: SCAN-1 is no
   * longer merged into RIPPLE-1 but verified on its own and refuted;
   * RIPPLE-1's verifier leaves the author a choice; SWEEP-1 asks.
   */
  const reporting = (): History => {
    const verified = new History();
    for (const event of decided(fixture, askDecision('SWEEP-1', true)).events) {
      const payload = event.payload as { phase?: string; verdicts?: Record<string, unknown>[] };
      if (event.kind === 'deduplication.recorded' && payload.phase === 'deduplication') verified.add(event.kind, { ...payload, groups: [] }, event.version);
      else if (event.kind === 'verification.planned' && payload.phase === 'verification') verified.add(event.kind, { ...payload, groups: [{ id: 'g1', candidateIds: ['RIPPLE-1', 'SCAN-1'] }] }, event.version);
      else if (event.kind === 'verdicts.recorded') verified.add(event.kind, { ...payload, verdicts: [...payload.verdicts!, { id: 'SCAN-1', verdict: 'REFUTED', evidence: 'the caller at /home/me/x.ts closes it first', basis: 'read', runs: [] }] }, event.version);
      else verified.add(event.kind, event.payload, event.version);
    }
    return withReportForm(verified, (verdict) => ({ unconfirmed: null, authorChoice: verdict.id === 'RIPPLE-1' ? 'return null for an empty file, or throw a named error' : null }));
  };
  const input = (): WriterTaskInput => ({ worktree: fixture.repo, evidence: fixture.evidence, machine: machine(fixture.repo) });

  it('asks for the areas, the kinds and the refuted lines, gives the refuted candidates and the notes of each verdict, and asks for no account', () => {
    const task = writerTask(reporting().start('explanation').fold(), input());
    assert.match(task, /^Explain these 2 findings, each by its id, [^\n]*: RIPPLE-1, SWEEP-1\./m);
    assert.match(task, /^Put each of these 1 major finding in exactly one area of `areas`, and no other finding in any: RIPPLE-1\.$/m);
    assert.match(task, /^Give each of these 1 minor finding a `kind`, and every other finding none: SWEEP-1\.$/m);
    assert.match(task, /^Give one line in `refuted` for each of these 1 refuted candidate, by its id, and for no other: SCAN-1\.$/m);
    assert.match(task, /^#### 1\. RIPPLE-1: explain it, in an area$/m);
    assert.match(task, /^#### 2\. SWEEP-1: explain it, with a kind$/m);
    assert.match(task, /^ {8}the choice its verifier leaves to the author: return null for an empty file, or throw a named error$/m);
    assert.match(task, /^### The refuted candidates\n\nThe 1 candidate the verifiers refuted, [^\n]*\n\n {4}- SCAN-1 \(SCAN\) at [^\n]*: REFUTED\n {8}summary: [^\n]*\n {8}detail: [^\n]*\n {8}evidence: the caller at \\<local path> closes it first$/m, 'the evidence of a refuted candidate, cleaned');
    assert.match(task, /^Return `conclusion`, `areas`, `findings` and `refuted` as your role prompt defines them\.$/m);
    assert.doesNotMatch(task, /`account`/);
    const older = writerTask(decided(fixture).start('explanation').fold(), input());
    assert.match(older, /^Return `conclusion`, `account` and `findings`\. /m, 'a run configured at version 10 keeps its answer, which has the account');
    assert.doesNotMatch(older, /`areas`|### The refuted candidates/);
  });

  it('gives the note of a PLAUSIBLE verdict that is not settled', () => {
    const plausible = new History();
    for (const event of reporting().events) {
      const payload = event.payload as { verdicts?: Record<string, unknown>[] };
      plausible.add(event.kind, event.kind === 'verdicts.recorded' ? { ...payload, verdicts: payload.verdicts!.map((verdict) => (verdict.id === 'RIPPLE-1' ? { ...verdict, verdict: 'PLAUSIBLE', unconfirmed: { kind: 'fact', text: 'whether a caller passes an empty file' } } : verdict)) } : event.payload, event.version);
    }
    assert.match(writerTask(plausible.start('explanation').fold(), input()), /^ {8}not CONFIRMED, a fact not settled: whether a caller passes an empty file$/m);
  });

  it('answers in the schema of the second form, and records the answer at version 2, frozen as the form reads it', () => {
    const history = reporting().start('explanation');
    const roles = new Map<string, AssembledRole>(reviewRoles.map((key) => [key, { key, fragments: [], prompt: `You are ${key}.\n`, sha256: 'b'.repeat(64) }]));
    const context: PhaseContext = {
      state: history.fold(), worktree: fixture.repo, roles,
      configuration: { ...configuration, roles: reviewRoles.map((role) => ({ role, model: 'opus', effort: 'high' as const, budgetUsd: 8, timeoutMs: 1_800_000 })) },
      scopeBlock: () => '## Scope', survey: () => { throw new Error('no survey'); }, commitMessages: () => { throw new Error('no commit message'); }, evidence: fixture.evidence,
      newScratch: () => { throw new Error('the writer has no scratch'); }, snapshotCommand: () => 'snapshot', unelevatedEditors: false, readerScratch: true,
      claims: { directoryOf: () => '/claims', command: () => 'claim', live: () => null, caseInsensitive: () => false }, documentation: () => ({ patches: [], exclude: [] }),
      writer: () => ({ machine: machine(fixture.repo), withholdShell: true }),
    };
    assert.equal(invocationFor(writerUnit, context).outputSchema, writerOutputSchemaV2);
    const [event] = contribution(history, fixture, receipt(goodReport()));
    assert.deepEqual([event?.kind, event?.version], ['explanation.recorded', 2]);
    const explanation = recorded(event);
    assert.deepEqual(explanation.dropped, []);
    const answer = recordedAnswerOf(explanation, fixture.evidence);
    assert.deepEqual([answer?.account, answer?.areas, answer?.refuted], [null, goodReport().areas, goodReport().refuted]);
    const checked = 'The verifier traced an empty file from the caller to the read on line 4.';
    assert.deepEqual(answer?.findings.map((finding) => (finding.unexplained ? null : [finding.id, finding.checked, finding.kind])), [['RIPPLE-1', checked, null], ['SWEEP-1', checked, 'code']]);
    const after = history.worker(62, 'writer explanation:explanation', { output: fixture.evidence.put(JSON.stringify(goodReport())) }).add('explanation.recorded', payloadOf(explanation), explanation.version);
    assert.equal(after.fold().explanation?.version, 2);
  });

  it('refuses an answer whose areas fail on the first attempt, and drops them alone on the last, recorded at version 2', () => {
    const bad = goodReport();
    bad.areas = [];
    const history = reporting().start('explanation');
    const [failure] = contribution(history, fixture, receipt(bad));
    assert.equal(failure?.kind, 'attempt.failed');
    assert.match((failure?.payload as { reason: string }).reason, /^structural check: the answer fails the engine's checks: areas: the areas leave out RIPPLE-1, a major finding that asks a person to act$/);
    const retried = failedOnce(history, fixture, bad as unknown as WriterOutput);
    const task = writerTask(retried.fold(), input());
    assert.match(task, /^- areas: the areas leave out RIPPLE-1, a major finding that asks a person to act$/m);
    assert.match(task, /The conclusion and the areas go together, since the conclusion's summary names the areas: when either is listed here, the engine takes both from your answer if both pass/);
    const explanation = recorded(contribution(retried, fixture, receipt(bad))[0]);
    assert.equal(explanation.version, 2);
    assert.deepEqual(explanation.dropped, [{ part: 'areas', failures: ['the areas leave out RIPPLE-1, a major finding that asks a person to act'] }]);
    assert.equal(recordedAnswerOf(explanation, fixture.evidence)?.areas, null);
  });

  it('reads an answer of version 1 with no areas, no refuted lines, and no note on a finding', () => {
    const v1 = recorded(contribution(decided(fixture).start('explanation'), fixture, receipt(goodAnswer()))[0]);
    assert.equal(v1.version, 1);
    const answer = recordedAnswerOf(v1, fixture.evidence);
    assert.deepEqual([answer?.areas, answer?.refuted, answer?.account], [null, null, goodAnswer().account]);
    assert.deepEqual(answer?.findings.map((finding) => (finding.unexplained ? null : [finding.checked, finding.kind])), [[null, null]]);
  });
});
