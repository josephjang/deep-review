import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import type { PullRequestFile } from '../../src/github/pull-request.ts';
import type { Core, WriterAnswer } from '../../src/review/explanation.ts';
import { publicationMarker } from '../../src/review/markers.ts';
import type { PullRequestForm } from '../../src/review/pull-request-form.ts';
import { pullRequestWordTables } from '../../src/review/pull-request-words.ts';
import { filesWith, longFindingHistory, paddedAnswer, pullRequestRun as run, renderedOf, sampleBoundaries, stepsOf, withSettings, writerAnswer, type WrittenFinding } from '../helpers/pull-request-review.ts';

const includes = (text: string, part: string): void => assert.ok(text.includes(part), `${JSON.stringify(part)} in:\n${text}`);
const excludes = (text: string, part: string): void => assert.ok(!text.includes(part), `no ${JSON.stringify(part)} in:\n${text}`);

/** The files of the pull request with only line 1 of `src/a.ts` changed, so every finding that acts is in full in the body. */
const noLine: PullRequestFile[] = [{ path: 'src/a.ts', status: 'modified', previousPath: null, patch: '@@ -1,1 +1,1 @@\n-old 1\n+new 1' }];

/** The state with the verdict of candidate `id` changed as `change` says. */
const withVerdict = (state: RunState, id: string, change: Record<string, unknown>): RunState => {
  const candidate = state.review!.candidates[id]!;
  return { ...state, review: { ...state.review!, candidates: { ...state.review!.candidates, [id]: { ...candidate, verdict: { ...candidate.verdict!, ...change } } } } };
};

/** The writer's answer with the problem of finding 1, a fix against a written rule, padded with `pad` characters, and finding 2's text as it is. */
const answerPadded = (pad: number): WriterAnswer => {
  const said = writerAnswer();
  const fix = said.findings[0] as WrittenFinding;
  return { ...said, findings: [{ ...fix, problem: `${fix.problem} ${'q'.repeat(pad)}` }, said.findings[1]!] };
};

/** The form whose body has left out exactly `steps`, among those sampled. */
const at = (forms: readonly PullRequestForm[], steps: readonly string[]): string => {
  const found = forms.find((form) => JSON.stringify(stepsOf(form)) === JSON.stringify(steps));
  assert.ok(found !== undefined, `a form at ${steps.join(', ')}`);
  return found.body;
};

// R2, R3, R6 of the review that always posts.
describe('the pieces a body leaves out one finding at a time', () => {
  // Findings 1, a major fix, and 2, a minor fix, are in full; finding 3, left as is, waits on a person by a choice no one settled, which is padded so that only its own step fits the body.
  const state = withVerdict(longFindingHistory().fold(), 'SWEEP-1', { authorChoice: 'c' });
  const core: Core = { title: 'parse() accepts an empty file', what: 'parse() now returns null for an empty file.', why: null, whyFrom: [], diagram: 'flowchart LR\n  E["empty file"] --> N["null"]' };
  const answer = (): WriterAnswer => ({ ...paddedAnswer(1), core, conditions: [] });
  const order = ['minor-table', 'record:SWEEP-2', 'record:RIPPLE-1', 'refuted', 'diagrams', 'text:SWEEP-2', 'text:RIPPLE-1', 'line:SWEEP-2', 'left:SWEEP-1'];
  // The notice under the heading that the first step adds is longer than the table of one minor finding, so a body that loses only the table never fits where the whole one did not, and the form goes on to the next step.
  const expected = order.map((_, index) => order.slice(0, index)).concat([order]).filter((steps) => steps.length !== 1);
  let sampled: PullRequestForm[] | undefined;
  /** The forms at each state, sampled once when a test first asks, so a state the order does not reach fails under that test. */
  const samples = (): PullRequestForm[] => {
    sampled ??= sampleBoundaries((pad) => renderedOf(withVerdict(state, 'SWEEP-1', { authorChoice: `Whether ${'c'.repeat(pad)}` }), answer(), noLine), 60_000, expected).flatMap(({ below, at: atLimit, above }) => [below, atLimit, above]);
    return sampled;
  };

  it('takes each step of the order in turn, a finding that waits on a person last, until the body fits, even a step that alone does not shorten it', () => {
    const forms = samples();
    assert.deepEqual([...new Set(forms.map((form) => JSON.stringify(stepsOf(form))))].map((steps) => JSON.parse(steps) as string[]), expected);
  });

  it('leaves the diagram of the core of the change with those of the areas, with a notice of its own in the core (R2 row 5)', () => {
    const forms = samples();
    const before = at(forms, order.slice(0, 4));
    includes(before, 'E["empty file"] --> N["null"]');
    const after = at(forms, order.slice(0, 5));
    excludes(after, 'E["empty file"] --> N["null"]');
    includes(after, '**parse() accepts an empty file**\n\nparse() now returns null for an empty file.\n\nReason: none stated in the change\'s commit messages or documents.\n\nTo fit the length GitHub takes, the diagram of the change is left out; the writer\'s answer on the machine that holds the run keeps it.\n\nThis is deep-review\'s reading of the change');
  });

  it('gives a minor finding whose text left an item with its anchor, its line and the command that prints it, apart from the blocks of the others (R2 row 6)', () => {
    const body = at(samples(), order.slice(0, 6));
    excludes(body, '### Finding 2');
    includes(body, '### Finding 1');
    includes(body, '**Findings whose text is left out.** To fit the length GitHub takes, the text of each of these findings is left out; the report of the run prints each, in the words of the workers that recorded it.\n\n- <a id="finding-2"></a>**[Finding 2](#finding-2).** In the words of deep-review\'s ranking: s');
    includes(body, 'Command that prints it: `deep-review report --run run-1 --finding 2`.');
    includes(body, 'Findings whose text is left out: 1.');
  });

  it('keeps a major finding whose text left as its line in its area, with no link and with the command that prints it (R2 row 6, R6)', () => {
    const body = at(samples(), order.slice(0, 7));
    excludes(body, '### Finding 1');
    excludes(body, '(#finding-1)');
    includes(body, '- **Finding 1.** parse() reads the null before any guard. Verdict: CONFIRMED. Decision: fix. Guard the null before parse reads it. Command that prints it: `deep-review report --run run-1 --finding 1`.');
    excludes(body, '- <a id="finding-1"></a>');
  });

  it('counts a minor finding whose line left as not listed, and names it nowhere as a link (R2 row 7)', () => {
    const body = at(samples(), order.slice(0, 8));
    excludes(body, '#finding-2');
    excludes(body, '**Findings whose text is left out.**');
    includes(body, 'Not listed here: 1. To fit the length GitHub takes, these findings are not listed here; the report of the run prints each.');
    includes(body, 'Minor findings: 1. Reach what a user sees: 0. About the code alone: 0. Reach not given: 1. In a comment on their line: 0.');
    includes(body, 'Findings whose text is left out: 1. Findings that are not listed: 1.');
  });

  it('keeps a finding left as is that waits on a person, with its choice in view, until every other finding has lost all it can (R4)', () => {
    const forms = samples();
    includes(at(forms, order.slice(0, 8)), 'Choice its verifier left to the author: Whether c');
    const last = at(forms, order);
    excludes(last, 'Whether c');
    includes(last, 'Findings left as is that are not listed: 1.');
  });
});

describe('the record of a finding that waits on a person', () => {
  // Finding 1 is a fix against a written rule and finding 2 a question, both in full and both waiting; finding 1's verifier named a choice the decision did not settle, and its text is padded, so it stays until the floor.
  const choice = 'Whether parse should throw or return null on an empty file.';
  const named = withVerdict(run().fold(), 'RIPPLE-1', { authorChoice: choice });
  // Grounds of the question longer than a decider gives, so that its record alone makes the body fit where the notice under the heading did not.
  const state: RunState = { ...named, review: { ...named.review!, decisions: named.review!.decisions!.map((decision) => (decision.id === 'SWEEP-1' ? { ...decision, grounds: `${decision.grounds} ${'g'.repeat(3000)}` } : decision)) } };
  const expected = [[], ['minor-table', 'refuted', 'record:SWEEP-1'], ['minor-table', 'refuted', 'record:SWEEP-1', 'record:RIPPLE-1']];
  let sampled: PullRequestForm[] | undefined;
  /** The forms at each state, sampled once when a test first asks, so a state the order does not reach fails under that test. */
  const samples = (): PullRequestForm[] => {
    sampled ??= sampleBoundaries((pad) => renderedOf(state, answerPadded(pad), noLine), 60_000, expected).flatMap(({ below, at: atLimit, above }) => [below, atLimit, above]);
    return sampled;
  };

  it('leaves last of what a finding loses, the last-ranked first, and keeps its question and its departure in view (R4 row 8)', () => {
    const forms = samples();
    const question = at(forms, expected[1]!);
    includes(question, '**The question.**');
    includes(question, '| Option | In the words of deep-review\'s decider |');
    includes(question, 'The decision as deep-review recorded it is left out here to fit the length GitHub takes. Command that prints it: `deep-review report --run run-1 --finding 2`.');
    const fix = at(forms, expected[2]!);
    includes(fix, '**Against a written rule.**');
    includes(fix, '- **Fix against a written rule: [Finding 1](#finding-1).**');
    includes(fix, '- **Question: [Finding 2](#finding-2).**');
  });

  it('shows in view, once the record leaves, each choice no one settled, as the verifier\'s, after the command that prints the record (R4)', () => {
    const fix = at(samples(), expected[2]!);
    includes(fix, `The decision as deep-review recorded it is left out here to fit the length GitHub takes. Command that prints it: \`deep-review report --run run-1 --finding 1\`.\n\n- Choice its verifier left to the author: ${choice} Settled as: not settled by deep-review`);
    excludes(fix, 'Grounds: Parse reads the null');
  });
});

// R1, R5, TD6, TD7 of the review that always posts.
describe('the floor', () => {
  const choice = 'Whether parse should throw or return null on an empty file.';
  const named = withVerdict(run().fold(), 'RIPPLE-1', { authorChoice: choice });
  /** Findings 1, a fix against a written rule, and 2, a question, both waiting, finding 1's text padded so that only the floor fits. */
  const floorOf = (files: PullRequestFile[] = noLine): PullRequestForm => {
    const form = renderedOf(named, answerPadded(70_000), files);
    assert.equal(form.kind, 'rendered');
    return form as PullRequestForm;
  };

  it('is posted when nothing less fits, as the last step of the order, under the limit and with the marker of the publication last', () => {
    const form = floorOf();
    assert.deepEqual(stepsOf(form), ['minor-table', 'refuted', 'record:SWEEP-1', 'record:RIPPLE-1', 'floor']);
    assert.ok(form.body.length < 60_000, String(form.body.length));
    assert.equal(form.body.split('\n').at(-1), `<!-- ${publicationMarker('run-1', 1)} -->`);
  });

  it('holds, in order, what the run reviewed, the notice in its form for the floor, the counts, what waits on a person with the command, the kinds of gap, the tables and the last line, and no text of a worker', () => {
    const { body } = floorOf();
    const at = (part: string): number => {
      const index = body.indexOf(part);
      assert.ok(index !== -1, `${JSON.stringify(part)} in:\n${body}`);
      return index;
    };
    const parts = [
      '## deep-review\'s review of this pull request\n\nHead: `22222222`. Merge base: `11111111`. Files changed: 1. After the review: no file changed.',
      'The text of this review does not fit the length GitHub takes, so it gives only the counts of the run, what waits on a person, and where to read the rest.',
      'Command that prints a finding: `deep-review report --run run-1 --finding <n>`.',
      '### Summary\n\n| Findings | Critical | Major | Minor | To fix | To ask the author | Left as is |',
      'Command that applies the fixes: `deep-review review --pr 42 --fix`.',
      '### What needs a person\n\nQuestions not answered: 1. Fixes against a written rule not accepted or rejected: 1. Choices its verifiers left to the author that deep-review did not settle: 1.',
      'Command: `deep-review answer --run run-1 --finding <n>`. With one of: `--option <k>`, `--accept`, `--reject`.',
      '### What this review did not examine\n\n',
      '### How far to trust this review\n\n| Verdict | Findings |',
      'Reviewed by: deep-review 0.0.0+dev. Runtime: claude. Run: `run-1`. Commits: 11111111..22222222.',
    ];
    const indexes = parts.map(at);
    assert.deepEqual([...indexes].sort((a, b) => a - b), indexes);
    for (const text of ['q'.repeat(50), 'parse() reads the null', 'An empty input still crashes', choice, 'Should parse accept an empty input?', 'Models:', 'A model wrote the sentences']) excludes(body, text);
  });

  it('gives the notice that a model wrote the sentences only when a comment posted with it holds a text of the writer', () => {
    // Finding 1 on its line, with the writer's text in its comment; finding 2's question, in the body, padded so that only the floor fits.
    const state: RunState = { ...named, review: { ...named.review!, decisions: named.review!.decisions!.map((decision) => (decision.id === 'SWEEP-1' && decision.decision === 'ask' ? { ...decision, ask: { ...decision.ask, question: `Should parse accept an empty input? ${'w'.repeat(70_000)}` } } : decision)) } };
    const form = renderedOf(state, writerAnswer(), filesWith()) as PullRequestForm;
    assert.equal(stepsOf(form).at(-1), 'floor');
    includes(form.body, 'A model wrote the sentences');
    includes(form.comments[0]!.body, 'parse() reads the null before any guard.');
  });

  it('fits for a run far larger than any on record: 2,000 findings with long texts in the body, the most a publication records, each comment beside it', () => {
    const state = largeRun(1997, 2000);
    const files: PullRequestFile[] = [{ path: 'src/a.ts', status: 'modified', previousPath: null, patch: `@@ -100,0 +100,100 @@\n${Array.from({ length: 100 }, (_, index) => `+added ${String(100 + index)}`).join('\n')}` }];
    const form = renderedOf(state, writerAnswer(), files) as PullRequestForm;
    assert.equal(form.kind, 'rendered');
    assert.equal(form.places.length, 2000);
    assert.equal(stepsOf(form).at(-1), 'floor');
    assert.ok(form.body.length < 60_000, String(form.body.length));
    includes(form.body, '| 2000 |');
    assert.equal(form.comments.length, 67, 'the fixes on lines 100 to 199, each with its comment');
    for (const comment of form.comments) assert.ok(comment.body.length <= 60_000);
  });
});

/**
 * The run of `longFindingHistory` with `count` more findings at lines 100
 * and after of `src/a.ts`, each with texts of `length` characters: a major
 * fix, a minor fix and a finding left as is in turn.
 */
function largeRun(count: number, length: number): RunState {
  const state = longFindingHistory().fold();
  const review = state.review!;
  const ids = Array.from({ length: count }, (_, index) => `BULK-${String(index + 1)}`);
  const candidates = { ...review.candidates, ...Object.fromEntries(ids.map((id, index) => [id, { ...review.candidates['RIPPLE-1']!, id, line: 100 + index, rawLine: 100 + index, summary: 's'.repeat(length), detail: 'd'.repeat(length) }])) };
  const ranking = [...review.ranking!, ...ids.map((id, index) => ({ id, members: [], severity: index % 3 === 1 ? 'minor' as const : 'major' as const, summary: 'x'.repeat(length), reason: 'r' }))];
  const decisions = [...review.decisions!, ...ids.map((id, index) => (index % 3 === 2 ? { ...review.decisions![1]!, id, grounds: 'g'.repeat(length) } : { ...review.decisions![0]!, id, grounds: 'g'.repeat(length), fix: { approach: 'a'.repeat(length), rejected: [] } }))];
  return { ...state, review: { ...review, candidates, ranking, decisions } as RunState['review'] };
}

describe('what is left out, in the language the run recorded (R6, R10 of the review in the writer\'s words)', () => {
  const korean = (history: ReturnType<typeof run>): RunState => withSettings(history, { 'review.language': 'ko' }, { 'review.language': 'repository' }).fold();

  it('takes the notice under the heading, the record\'s place, the floor and the facts form of a comment from the Korean table', () => {
    const ko = pullRequestWordTables.ko;
    const floor = renderedOf(korean(run()), answerPadded(70_000), noLine);
    assert.equal(stepsOf(floor).at(-1), 'floor');
    includes(floor.body, ko.floorNotice);
    includes(floor.body, `${ko.waitingLabels.questions}: 1.`);
    const comment = renderedOf(korean(run()), answerPadded(70_000), filesWith());
    includes(comment.comments[0]!.body, ko.commentFactsNotice);
    includes(comment.body, `${ko.leftOutLabels.commentTexts}: 1.`);
    includes(comment.body, ko.leftOutNotice);
    for (const text of [floor.body, comment.body, comment.comments[0]!.body]) {
      for (const entry of [pullRequestWordTables.en.floorNotice, pullRequestWordTables.en.leftOutNotice, pullRequestWordTables.en.commentFactsNotice, pullRequestWordTables.en.printCommandLabel, pullRequestWordTables.en.reportCommandLabel]) excludes(text, entry);
    }
  });
});
