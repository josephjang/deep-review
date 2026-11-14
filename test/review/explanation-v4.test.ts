import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { ReviewState } from '../../src/checkpoint/review-fold.ts';
import { EvidenceStore } from '../../src/evidence/store.ts';
import { checkAnswerV4, type AnswerCheckInput, type AnswerCheckInputV4, type CheckedAnswerV4, type DecisionFacts } from '../../src/review/explanation-checks.ts';
import { decisionFactsOf, findingsLeftAsIs, mergeAnswersV4 } from '../../src/review/explanation.ts';
import { decisionCountsOf } from '../../src/review/pull-request-view.ts';
import type { WriterOutputV4 } from '../../src/review/schemas.ts';
import type { ChangeMessages } from '../../src/review/tasks.ts';
import { hasCore, writerTask, type WriterTaskInput } from '../../src/review/writer-task.ts';
import { askDecision, decidedOf, decisions, departure, mergeRanked, withBaseChecks, withCitedRuns, withCoreForm, withDocumentationStep, withPullRequest, worker, type History } from '../helpers/review-history.ts';

// The checks of the writer's answer of version 4 (R2, R3, PD11, TD2, TD7, TD8 of the review in the writer's words).

/** The line counts of a fake repository: `src/a.ts` with 12 lines at the head and 10 at the base. */
const fakeLines: AnswerCheckInput['lineCount'] = (side, path) => ({ 'head:src/a.ts': 12, 'base:src/a.ts': 10 } as Record<string, number>)[`${side}:${path}`] ?? null;

type Explanation = NonNullable<WriterOutputV4['findings'][number]['explanation']>;

/** The explanation of a finding to explain, as an answer that passes gives it: a fix with no departure, or with `ask`, a question of two options. */
function explanation(id: string, decision: 'fix' | 'ask' = 'fix'): Explanation {
  return {
    title: `${id} crashes on an empty input`,
    problem: 'A caller that passes an empty file meets a crash.',
    cases: [{ sentence: 'An empty file reaches the read on line 4.', lines: { side: 'head', path: 'src/a.ts', from: 4, to: 5 } }],
    diagram: null,
    checked: 'Its verifier ran parse() on an empty file.',
    kind: null,
    action: decision === 'fix' ? 'deep-review would return early when the input is empty.' : 'deep-review asks whether an empty input is an error, and recommends that it is not.',
    unconfirmed: null,
    fix: decision === 'fix' ? { text: 'The fix returns null for an empty input before parse() reads it.', departure: null } : null,
    ask: decision === 'ask'
      ? {
        question: 'Whether an empty input is an error, which no rule of the repository says.',
        options: [
          { number: 1, means: 'An empty input returns null.', cost: 'Callers must check for null.', rule: 'An empty input is not an error.' },
          { number: 2, means: 'An empty input throws.', cost: 'A caller that sends one crashes.', rule: 'An empty input is an error.' },
        ],
        recommendation: 'Returning null keeps every caller that works today working.',
      }
      : null,
  };
}

/** An answer that passes every check against `input()`: RIPPLE-1 a major fix, SWEEP-1 a major question, MINOR-1 left as is, and REF-1 a refuted candidate. */
function goodAnswer(): WriterOutputV4 {
  return {
    core: { title: 'Parse an empty input', what: 'The change lets parse() take an empty input.', why: null, whyFrom: [], diagram: null },
    conditions: [],
    summary: 'The review found two findings that need a person: one deep-review would fix and one question.',
    areas: [{ title: 'Empty inputs crash parse()', intro: 'Both findings are about an empty input.', diagram: null, findings: ['RIPPLE-1', 'SWEEP-1'] }],
    findings: [
      { id: 'RIPPLE-1', explanation: explanation('RIPPLE-1'), unexplained: null },
      { id: 'SWEEP-1', explanation: explanation('SWEEP-1', 'ask'), unexplained: null },
    ],
    left: [{ id: 'MINOR-1', title: 'A comment names a function that was renamed', why: 'deep-review leaves it, since a later change removes the comment.' }],
    refuted: [{ id: 'REF-1', claim: 'parse() leaks a handle.', why: 'Its verifier found the handle closed on every path.' }],
    notExamined: 'Every review pass ran and a verifier examined each finding, so nothing of the change went unread.',
  };
}

const fixFacts: DecisionFacts = { decision: 'fix', departs: false, options: 0, unconfirmed: false };
const askFacts: DecisionFacts = { decision: 'ask', departs: false, options: 2, unconfirmed: false };

function input(decided: Readonly<Record<string, DecisionFacts>> = {}): AnswerCheckInputV4 {
  return {
    ids: ['RIPPLE-1', 'SWEEP-1'],
    lineCount: fakeLines,
    report: { major: ['RIPPLE-1', 'SWEEP-1'], asks: ['SWEEP-1'], refuted: ['REF-1'] },
    core: { commits: [], files: ['src/a.ts'], candidates: ['RIPPLE-1', 'SWEEP-1', 'MINOR-1', 'REF-1'], held: [] },
    decided: new Map(Object.entries({ 'RIPPLE-1': fixFacts, 'SWEEP-1': askFacts, ...decided })),
    left: ['MINOR-1'],
  };
}

/** The failures of every part of a checked answer, by part name. */
function failuresOf(checked: CheckedAnswerV4): Record<string, readonly string[]> {
  return {
    core: checked.core.failures,
    conditions: checked.conditions.failures,
    conclusion: checked.conclusion.failures,
    areas: checked.areas.failures,
    left: checked.left.failures,
    refuted: checked.refuted.failures,
    'not-examined': checked.notExamined.failures,
    ...Object.fromEntries([...checked.findings].map(([id, part]) => [`finding ${id}`, part.failures])),
  };
}

/** The parts of a checked answer that fail, with their failures. */
function failing(answer: WriterOutputV4, given: AnswerCheckInputV4 = input()): Record<string, readonly string[]> {
  return Object.fromEntries(Object.entries(failuresOf(checkAnswerV4(answer, given))).filter(([, failures]) => failures.length > 0));
}

/** The answer with the explanation of `id` changed. */
function withExplanation(id: string, change: (explained: Explanation) => void): WriterOutputV4 {
  const answer = goodAnswer();
  change(answer.findings.find((entry) => entry.id === id)!.explanation!);
  return answer;
}

describe('the checks of the writer\'s answer of version 4', () => {
  it('passes an answer whose every part keeps the rules, and keeps each finding with its new parts', () => {
    const checked = checkAnswerV4(goodAnswer(), input());
    assert.deepEqual(failing(goodAnswer()), {});
    const ask = checked.findings.get('SWEEP-1')!.value;
    assert.ok(ask !== null && !ask.unexplained);
    assert.equal(ask.ask?.options.length, 2);
    assert.equal(ask.fix, null);
    assert.equal(checked.conclusion.value, goodAnswer().summary);
  });

  it('holds a fix to a finding decided fix and a question to one decided ask, never both and never neither', () => {
    const askOnFix = withExplanation('RIPPLE-1', (explained) => {
      explained.fix = null;
      explained.ask = explanation('X', 'ask').ask;
    });
    assert.deepEqual(failing(askOnFix), { 'finding RIPPLE-1': ['RIPPLE-1 is decided fix and gives no fix', 'RIPPLE-1 is decided fix and gives a question, which only a finding decided ask has'] });
    const fixOnAsk = withExplanation('SWEEP-1', (explained) => {
      explained.ask = null;
      explained.fix = { text: 'Return null.', departure: null };
    });
    assert.deepEqual(failing(fixOnAsk), { 'finding SWEEP-1': ['SWEEP-1 is decided ask and gives no question', 'SWEEP-1 is decided ask and gives a fix, which only a finding decided fix has'] });
    const both = withExplanation('RIPPLE-1', (explained) => {
      explained.ask = explanation('X', 'ask').ask;
    });
    assert.deepEqual(failing(both), { 'finding RIPPLE-1': ['RIPPLE-1 is decided fix and gives a question, which only a finding decided ask has'] });
    const neither = withExplanation('SWEEP-1', (explained) => {
      explained.ask = null;
    });
    assert.deepEqual(failing(neither), { 'finding SWEEP-1': ['SWEEP-1 is decided ask and gives no question'] });
  });

  it('holds the text of a departure to a fix that departs from a written rule, and to no other', () => {
    assert.deepEqual(failing(goodAnswer(), input({ 'RIPPLE-1': { ...fixFacts, departs: true } })), {
      'finding RIPPLE-1': ['RIPPLE-1 departs from a written rule, and its fix does not say the rule, the fact against it and what the fix does instead'],
    });
    const departing = withExplanation('RIPPLE-1', (explained) => {
      explained.fix = { text: 'Return null.', departure: 'The rule says parse() throws on bad input; an empty file is not bad input, so the fix returns null.' };
    });
    assert.deepEqual(failing(departing, input({ 'RIPPLE-1': { ...fixFacts, departs: true } })), {});
    assert.deepEqual(failing(departing), { 'finding RIPPLE-1': ['RIPPLE-1 departs from no written rule, and its fix gives the text of a departure'] });
  });

  it('holds the options of a question to those the decision records, by number from 1, each once', () => {
    const options = (numbers: readonly number[]): WriterOutputV4 => withExplanation('SWEEP-1', (explained) => {
      explained.ask = { ...explained.ask!, options: numbers.map((number) => ({ number, means: 'It means.', cost: 'It costs.', rule: 'It rules.' })) };
    });
    const range = 'the decision records options 1 to 2';
    assert.deepEqual(failing(options([1])), { 'finding SWEEP-1': [`the question of SWEEP-1 gives no option 2; ${range}`] });
    assert.deepEqual(failing(options([1, 2, 2])), { 'finding SWEEP-1': ['the question of SWEEP-1 gives option 2 2 times, and an option has one entry'] });
    assert.deepEqual(failing(options([0, 1, 2])), { 'finding SWEEP-1': [`the question of SWEEP-1 gives option 0, which the decision does not record; ${range}`] });
    assert.deepEqual(failing(options([1, 2, 3])), { 'finding SWEEP-1': [`the question of SWEEP-1 gives option 3, which the decision does not record; ${range}`] });
    const blankCost = withExplanation('SWEEP-1', (explained) => {
      explained.ask!.options[1]!.cost = ' ';
    });
    assert.deepEqual(failing(blankCost), { 'finding SWEEP-1': ['option 2 of SWEEP-1 says not what it costs'] });
  });

  it('holds why a verdict is not confirmed to a PLAUSIBLE verdict that records why, and lets that text name the verdict', () => {
    const plausible = { 'RIPPLE-1': { ...fixFacts, unconfirmed: true } };
    assert.deepEqual(failing(goodAnswer(), input(plausible)), { 'finding RIPPLE-1': ['RIPPLE-1 has a PLAUSIBLE verdict whose verifier says why it is not confirmed, and the explanation does not say why'] });
    const said = withExplanation('RIPPLE-1', (explained) => {
      explained.unconfirmed = 'It stays PLAUSIBLE, not CONFIRMED, since no test reaches the empty input.';
    });
    assert.deepEqual(failing(said, input(plausible)), {}, 'a verdict word in unconfirmed passes');
    assert.deepEqual(failing(said), { 'finding RIPPLE-1': ['RIPPLE-1 says why it is not confirmed, which only a finding whose PLAUSIBLE verdict records why has'] });
  });

  it('holds every new text of a finding to no verdict of the review and to being said', () => {
    const verdicts = withExplanation('SWEEP-1', (explained) => {
      explained.action = 'deep-review asks, as the finding is CONFIRMED.';
      explained.ask!.recommendation = 'Option 1, since the verifier REFUTED the other path.';
    });
    assert.deepEqual(failing(verdicts), { 'finding SWEEP-1': ['the explanation of SWEEP-1 holds the verdict CONFIRMED, which the engine writes beside the finding', 'the explanation of SWEEP-1 holds the verdict REFUTED, which the engine writes beside the finding'] });
    const unsaid = withExplanation('RIPPLE-1', (explained) => {
      explained.action = '';
      explained.fix!.text = '';
    });
    assert.deepEqual(failing(unsaid), { 'finding RIPPLE-1': ['RIPPLE-1 says not what deep-review would do', 'the fix of RIPPLE-1 says not what it changes'] });
  });

  it('refuses a blank summary and a blank text of what the review did not examine, each in its own part', () => {
    const answer = { ...goodAnswer(), summary: ' ', notExamined: '' };
    assert.deepEqual(failing(answer), { conclusion: ['the summary is empty'], 'not-examined': ['what the review did not examine is empty'] });
    const verdict = { ...goodAnswer(), notExamined: 'No finding is PLAUSIBLE only.' };
    assert.deepEqual(failing(verdict), { 'not-examined': ['what the review did not examine holds the verdict PLAUSIBLE, which the engine writes beside the finding'] });
  });

  it('refuses an escaped line break, the two characters \\n, outside a code span, in the part of the text that holds it, and tells the retry to write a real one', () => {
    const escaped = (what: string): string => `${what} holds the two characters \\n outside a code span, which GitHub shows as they are; write a real line break where a line or paragraph should end, and put the characters in a code span where they are code`;
    assert.deepEqual(failing({ ...goodAnswer(), summary: 'The review found two findings.\\n\\nOne deep-review would fix.' }), { conclusion: [escaped('the summary')] });
    // The same characters in a code span are code, and a real line break is the one asked for.
    assert.deepEqual(failing({ ...goodAnswer(), summary: 'parse() splits on `\\n` and on ``a `\\n` b``.\n\nOne deep-review would fix.' }), {});
    const everywhere = withExplanation('SWEEP-1', (explained) => {
      explained.ask!.options[1]!.cost = 'A caller crashes.\\nIt must catch.';
    });
    everywhere.core.why = 'It says so.\\n';
    everywhere.areas[0]!.intro = 'Both are about an empty input.\\n';
    everywhere.left[0]!.why = 'A later change removes it.\\n';
    everywhere.refuted[0]!.why = 'The handle is closed.\\n';
    everywhere.notExamined = 'Every pass ran.\\nA verifier examined each finding.';
    const failed = failing(everywhere);
    assert.deepEqual(failed['finding SWEEP-1'], [escaped('the explanation of SWEEP-1')]);
    assert.ok(failed.core!.includes(escaped('the core')));
    assert.deepEqual(failed.areas, [escaped('area 1')]);
    assert.deepEqual(failed.left, [escaped('the entry for MINOR-1 left as is')]);
    assert.deepEqual(failed.refuted, [escaped('the refuted line for REF-1')]);
    assert.deepEqual(failed['not-examined'], [escaped('what the review did not examine')]);
    const unexplained = goodAnswer();
    unexplained.findings[0] = { id: 'RIPPLE-1', explanation: null, unexplained: 'Its evidence names no line.\\nNone at all.' };
    assert.deepEqual(failing(unexplained), { 'finding RIPPLE-1': [escaped('the reason RIPPLE-1 is unexplained')] });
  });

  it('holds no diagram to the rule of an escaped line break, and passes one drawn with real line breaks', () => {
    const drawn = withExplanation('RIPPLE-1', (explained) => {
      explained.diagram = 'sequenceDiagram\n  Caller->>parse: the input "a\\nb"\n  parse-->>Caller: crash';
    });
    drawn.areas[0]!.diagram = 'flowchart TD\n  A["an empty input"] --> B["a crash"]';
    assert.deepEqual(failing(drawn), {});
  });

  it('holds `left` to one entry for each finding left as is, and none for a finding that acts or no finding', () => {
    const answer = goodAnswer();
    answer.left = [
      { id: 'RIPPLE-1', title: 'A fix', why: 'It acts.' },
      { id: 'NOPE-9', title: 'Nothing', why: 'No such finding.' },
    ];
    assert.deepEqual(failing(answer), {
      left: [
        'the findings left as is have no entry for MINOR-1',
        'the findings left as is name RIPPLE-1, a finding that asks a person to act, which `findings` explains',
        'the findings left as is name "NOPE-9", which is no finding of the run left as is',
      ],
    });
    const blankWhy = goodAnswer();
    blankWhy.left[0]!.why = '';
    assert.deepEqual(failing(blankWhy), { left: ['the entry for MINOR-1 left as is says not why deep-review leaves it'] });
  });

  it('holds no text to a length: a text far over the size its guide gives passes', () => {
    const long = withExplanation('RIPPLE-1', (explained) => {
      explained.fix!.text = 'x'.repeat(50_000);
    });
    long.summary = 'y'.repeat(50_000);
    long.left[0]!.title = 'z'.repeat(50_000);
    assert.deepEqual(failing(long), {});
  });

  it('keeps the checks of version 3 for the parts it keeps: the core names no id of the run, and the areas hold each major finding', () => {
    const answer = goodAnswer();
    answer.core.what = 'The change fixes RIPPLE-1.';
    answer.areas[0]!.findings = ['RIPPLE-1'];
    assert.deepEqual(failing(answer), {
      core: ['the core names RIPPLE-1, an id of this review; the core is about the change as submitted, and names no finding or candidate'],
      areas: ['the areas leave out SWEEP-1, a major finding that asks a person to act'],
    });
  });
});

describe('what the run holds an answer of version 4 to', () => {
  const decidedRun = (decided: readonly unknown[] | null) => withCoreForm(withPullRequest(withCitedRuns(withBaseChecks(withDocumentationStep(decidedOf(mergeRanked(), decided), null))))).fold().review!;

  it('gives each finding to explain its decision as decided, with its departure, the count of its options and whether its verdict records why it is not confirmed', () => {
    const review = decidedRun([{ ...decisions[0], departure }, askDecision('SWEEP-1', true)]);
    assert.deepEqual([...decisionFactsOf(review)], [
      ['RIPPLE-1', { decision: 'fix', departs: true, options: 0, unconfirmed: false }],
      ['SWEEP-1', { decision: 'ask', departs: false, options: 2, unconfirmed: false }],
    ], 'SWEEP-1 is PLAUSIBLE with no verifier, so nothing records why it is not confirmed');
    assert.deepEqual(findingsLeftAsIs(review), []);
  });

  it('gives the findings left as is, and no decision facts for them', () => {
    const review = decidedRun(decisions);
    assert.deepEqual(findingsLeftAsIs(review), ['SWEEP-1']);
    assert.deepEqual([...decisionFactsOf(review).keys()], ['RIPPLE-1']);
  });

  it('counts the findings by decision once, a finding with no decision left as is, as findingsLeftAsIs lists it', () => {
    const counted = (review: ReviewState) => ({ ...decisionCountsOf(review), left: findingsLeftAsIs(review).length });
    assert.deepEqual(counted(decidedRun([{ ...decisions[0], departure }, askDecision('SWEEP-1', true)])), { fix: 1, fixAgainstRule: 1, ask: 1, leave: 0, left: 0 });
    assert.deepEqual(counted(decidedRun(decisions)), { fix: 1, fixAgainstRule: 0, ask: 0, leave: 1, left: 1 });
    assert.deepEqual(counted(decidedRun(null)), { fix: 0, fixAgainstRule: 0, ask: 0, leave: 2, left: 2 }, 'a run that recorded no decision leaves each finding as is');
  });
});

describe('the merge of the answers of version 4 (TD2 of the review in the writer\'s words)', () => {
  const ids = ['RIPPLE-1', 'SWEEP-1'];

  it('keeps a finding from the first answer that passed it and `left` from the second, and drops what no answer passed', () => {
    const first = goodAnswer();
    first.left = [];
    first.notExamined = '';
    const second = withExplanation('RIPPLE-1', (explained) => {
      explained.action = '';
    });
    second.notExamined = '';
    const merged = mergeAnswersV4([checkAnswerV4(first, input()), checkAnswerV4(second, input())], ids);
    const ripple = merged.answer.findings.find((finding) => finding.id === 'RIPPLE-1');
    assert.ok(ripple !== undefined && !ripple.unexplained);
    assert.equal(ripple.action, goodAnswer().findings[0]!.explanation!.action, 'from the first answer, which passed it');
    assert.deepEqual(merged.answer.left, second.left, 'from the second answer, since the first left MINOR-1 out');
    assert.equal(merged.answer.notExamined, null);
    assert.deepEqual(merged.dropped, [{ part: 'not-examined', failures: ['what the review did not examine is empty'] }]);
  });

  it('takes the summary only with the areas it names, from the first answer that passed both', () => {
    const noAreas = goodAnswer();
    noAreas.areas = [];
    noAreas.summary = 'The first summary.';
    const both = goodAnswer();
    both.summary = 'The second summary.';
    const merged = mergeAnswersV4([checkAnswerV4(noAreas, input()), checkAnswerV4(both, input())], ids);
    assert.equal(merged.answer.summary, 'The second summary.');
    assert.deepEqual(merged.answer.areas, both.areas);
    assert.deepEqual(merged.dropped, []);
  });

  it('takes the areas from a later answer that passed the summary too, over an earlier one whose summary failed', () => {
    const noSummary = goodAnswer();
    noSummary.summary = '';
    noSummary.areas[0]!.intro = 'The first areas.';
    const both = goodAnswer();
    both.summary = 'The second summary.';
    const merged = mergeAnswersV4([checkAnswerV4(noSummary, input()), checkAnswerV4(both, input())], ids);
    assert.equal(merged.answer.summary, 'The second summary.');
    assert.deepEqual(merged.answer.areas, both.areas, 'from the answer that passed both, not the first that passed the areas');
    assert.deepEqual(merged.dropped, []);
  });

  it('drops a finding alone when its text of the decision fails in every answer, with the failures of the latest', () => {
    const bad = withExplanation('SWEEP-1', (explained) => {
      explained.ask = null;
    });
    const merged = mergeAnswersV4([checkAnswerV4(bad, input())], ids, ['the writer ran out of time']);
    assert.deepEqual(merged.answer.findings.map((finding) => finding.id), ['RIPPLE-1']);
    assert.deepEqual(merged.dropped, [{ part: 'finding', finding: 'SWEEP-1', failures: ['SWEEP-1 is decided ask and gives no question', 'the writer ran out of time'] }]);
  });
});

describe('the writer\'s task of an answer of version 4 (R2, R6, TD6 of the review in the writer\'s words)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'deep-review-writer-v4-'));
  after(() => rmSync(directory, { recursive: true, force: true }));
  const evidence = new EvidenceStore(join(directory, 'evidence'));
  const messages: ChangeMessages = { kind: 'read', messages: [{ commit: 'f'.repeat(40), message: 'Accept an empty file' }], withTree: false };
  const input: WriterTaskInput = { worktree: join(directory, 'no-repository'), evidence, machine: { worktree: '/repo', checkpoint: '/repo/.git/deep-review-checkpoint', gitCommon: '/repo/.git', engine: '/opt/deep-review', scratch: [], environment: {}, home: '/home/me', rootEntries: ['home', 'opt', 'repo'] }, commitMessages: messages, version: 4 };
  /** The decided run of a pull request, configured at version 12, while its explanation runs: RIPPLE-1 a fix, SWEEP-1 left as is. */
  const running = (): History => withCoreForm(withPullRequest(withCitedRuns(withBaseChecks(withDocumentationStep(decidedOf(mergeRanked(), decisions), null))))).start('explanation');

  it('asks for the findings to explain and the findings left as is, gives the counts by decision and each gap as data, and asks for the parts of version 4', () => {
    const task = writerTask(running().fold(), input);
    assert.match(task, /^Explain these 1 finding, each by its id, with an entry of `findings`: RIPPLE-1\.$/m);
    assert.match(task, /^Give one entry of `left` for each of these 1 finding left as is, by its id, and for no other: SWEEP-1\.$/m);
    assert.match(task, /^No finding you explain has a PLAUSIBLE verdict whose verifier said why it is not CONFIRMED, so give every `unconfirmed` null\.$/m);
    assert.match(task, /^#### 2\. SWEEP-1: left as is: give it a title and a reason in `left`, and explain it nowhere else$/m);
    assert.match(task, /^### The counts of the run\n\nThe engine's counts, [^\n]*\n\n- candidates the review passes raised: \d+$/m);
    assert.match(task, /^- findings deep-review decided to fix: 1\n- of them, fixes against a written rule: 0\n- findings deep-review asks the author about: 0\n- findings deep-review decided to leave as is: 1$/m);
    assert.match(task, /^### What the review did not examine\n\nEach gap as the engine records it, [^\n]*\n\n- a review pass that did not run: the footguns pass; [^\n]*\n- no verifier examined: finding 2; candidates merged into finding 1$/m);
    assert.match(task, /^### The commit messages of the change$/m, 'version 4 keeps the core of version 3');
    assert.match(task, /Return `core`, `conditions`, `summary`, `areas`, `findings`, `left`, `refuted` and `notExamined` as your role prompt defines them\.$/);
    assert.doesNotMatch(task, /an action of the conclusion/);
  });

  it('asks a run configured at version 12 for version 3 unless the replay asks for version 4', () => {
    const task = writerTask(running().fold(), { worktree: input.worktree, evidence, machine: input.machine, commitMessages: messages });
    assert.match(task, /Return `conclusion`, `areas`, `findings`, `refuted`, `core` and `conditions` as your role prompt defines them\.$/);
    assert.doesNotMatch(task, /### The counts of the run|`left`/);
  });

  it('needs the commit messages exactly for the versions that have the core, as the replay reads them', () => {
    assert.deepEqual(([1, 2, 3, 4] as const).map(hasCore), [false, false, true, true]);
    assert.throws(() => writerTask(running().fold(), { ...input, commitMessages: null }), /lists the commit messages of the change and needs them/);
  });

  it('names each part an earlier answer failed by the field that holds it, and tells the retry the summary goes with the areas', () => {
    const answer = goodAnswer();
    answer.findings = [{ id: 'RIPPLE-1', explanation: { ...explanation('RIPPLE-1'), cases: [] }, unexplained: null }];
    answer.areas = [{ ...answer.areas[0]!, findings: ['RIPPLE-1'] }];
    answer.left = [{ id: 'SWEEP-1', title: 'A helper the change does not touch', why: 'It is outside the change.' }];
    answer.refuted = [];
    answer.summary = '';
    answer.notExamined = '';
    const failed = running()
      .worker(61, 'writer explanation:explanation', { output: evidence.put(JSON.stringify(answer)) })
      .add('attempt.failed', { phase: 'explanation', key: 'explanation', workerId: worker(61), reason: 'structural check: the answer fails the engine\'s checks', fault: 'unit' }, 9);
    const task = writerTask(failed.fold(), input);
    assert.match(task, /^- summary: the summary is empty$/m);
    assert.match(task, /^- notExamined: what the review did not examine is empty$/m);
    assert.match(task, /^- finding RIPPLE-1: RIPPLE-1 has no case$/m);
    assert.match(task, /The summary and the areas go together, since the summary names the areas/);
  });
});
