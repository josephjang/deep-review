import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PullRequestFile } from '../../src/github/pull-request.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { diagramFailures, findingsToExplain, type ExplainedFinding, type RecordedAnswer } from '../../src/review/explanation.ts';
import { findingMarker, publicationMarker } from '../../src/review/markers.ts';
import { dryRunLines } from '../../src/review/publish.ts';
import { bodyCuts, formRefusalWords, maxPostedLength, placeFindings, type FormRefusal, type PullRequestForm } from '../../src/review/pull-request-form.ts';
import { pullRequestWordTables } from '../../src/review/pull-request-words.ts';
import type { History } from '../helpers/review-history.ts';
import { filesWith, formOf, pullRequestRun as run, pullRequestRunBeforeExplanation as runBeforeExplanation, renderedOf, rewritten, withSettings, writerAnswer, answerWithArea, sampleBoundaries, type Boundary, longFindingHistory, paddedAnswer } from '../helpers/pull-request-review.ts';
import { answer, answerableDecisions, askDecision, decisions, departure, explanation, withReportForm, worker } from '../helpers/review-history.ts';

const head = '2'.repeat(40);
const base = '1'.repeat(40);
const blob = (commit: string, path: string, lines: string): string => `https://github.com/octo/parse/blob/${commit}/${path}#L${lines}`;

const lastLine = (text: string): string => text.split('\n').at(-1)!;
const includes = (text: string, part: string): void => assert.ok(text.includes(part), `${JSON.stringify(part)} in:\n${text}`);
const excludes = (text: string, part: string): void => assert.ok(!text.includes(part), `no ${JSON.stringify(part)} in:\n${text}`);
/** That each part is in the text, in the order given. */
const inOrder = (text: string, parts: readonly string[]): void => {
  const at = parts.map((part) => text.indexOf(part));
  assert.deepEqual(parts.filter((_, index) => at[index] === -1), [], text);
  assert.deepEqual([...at].sort((a, b) => a - b), at, `in order:\n${text}`);
};
/** The section of the body under a heading, up to the next heading of its level, the next block in full or the last line. */
const section = (body: string, heading: string): string => {
  const from = body.indexOf(`${heading}\n`);
  assert.ok(from !== -1, `${heading} in:\n${body}`);
  const ends = ['\n### ', '\n<a id="', '\nReviewed by deep-review '].map((end) => body.indexOf(end, from + heading.length)).filter((at) => at !== -1);
  return body.slice(from, ends.length === 0 ? undefined : Math.min(...ends));
};

/** The history with the ranking's findings and verdicts changed: `ranked` gives each finding of the ranking anew, `verdicts` each verdict of the first verification. */
const reranked = (history: History, ranked: (finding: Record<string, unknown>) => Record<string, unknown>, verdicts: (verdict: Record<string, unknown>) => Record<string, unknown> = (verdict) => verdict): History => rewritten(history, (kind, payload) => {
  if (kind === 'ranking.recorded') return { ...payload, findings: (payload.findings as Record<string, unknown>[]).map(ranked) };
  if (kind === 'verdicts.recorded' && payload.phase === 'verification') return { ...payload, verdicts: (payload.verdicts as Record<string, unknown>[]).map(verdicts) };
  return undefined;
});

describe('the place of a finding (R10, TD4)', () => {
  const placesOf = (decided: readonly unknown[], files: PullRequestFile[]) => placeFindings(run(decided).review(), files);

  it('puts a fix on its line when its line is on the new side of a hunk, added or context', () => {
    // RIPPLE-1 points at src/a.ts:4.
    assert.deepEqual(placesOf(decisions, filesWith())[0], { finding: 'RIPPLE-1', place: 'line', reason: 'on-the-diff', location: { path: 'src/a.ts', line: 4 }, diff: 'added' });
    assert.deepEqual(placesOf(decisions, filesWith('@@ -2,4 +2,4 @@\n line 2\n line 3\n line 4\n-old 5\n+new 5'))[0], { finding: 'RIPPLE-1', place: 'line', reason: 'on-the-diff', location: { path: 'src/a.ts', line: 4 }, diff: 'context' });
  });

  it('puts in the body a fix whose line only the old side holds, one whose file has no patch, and one whose file the pull request does not change', () => {
    assert.deepEqual(placesOf(decisions, filesWith('@@ -3,3 +3,1 @@\n line 3\n-old 4\n-old 5'))[0], { finding: 'RIPPLE-1', place: 'body', reason: 'outside-the-diff', location: { path: 'src/a.ts', line: 4 }, diff: 'outside-the-hunks' });
    assert.deepEqual(placesOf(decisions, filesWith(null))[0], { finding: 'RIPPLE-1', place: 'body', reason: 'no-patch', location: { path: 'src/a.ts', line: 4 }, diff: 'no-patch' });
    assert.deepEqual(placesOf(decisions, [])[0], { finding: 'RIPPLE-1', place: 'body', reason: 'outside-the-diff', location: { path: 'src/a.ts', line: 4 }, diff: 'not-in-the-pull-request' });
  });

  it('puts in the body a finding left as is wherever its line is, and a question with no place in the repository', () => {
    assert.deepEqual(placesOf(decisions, filesWith())[1], { finding: 'SWEEP-1', place: 'body', reason: 'left', location: null, diff: null });
    assert.deepEqual(placesOf([decisions[0], askDecision('SWEEP-1', true)], filesWith())[1], { finding: 'SWEEP-1', place: 'body', reason: 'no-place', location: null, diff: null });
    const leftOnTheDiff = placesOf([{ ...decisions[0], decision: 'leave', fix: null, leave: { reason: 'intended', supersededBy: null } }, decisions[1]], filesWith())[0];
    assert.deepEqual(leftOnTheDiff, { finding: 'RIPPLE-1', place: 'body', reason: 'left', location: { path: 'src/a.ts', line: 4 }, diff: 'added' });
  });
});

// The default run: RIPPLE-1, major and CONFIRMED by tracing, a fix against a written rule on src/a.ts:4 with SWEEP-2 merged in; SWEEP-1, minor and unverified, a question with no place; RIPPLE-2 refuted.
describe('the body of the review (R1 to R4, R11 to R13)', () => {
  const form = formOf(run().fold());
  const { body } = form;

  it('puts first what a person must know and do and what the review did not examine, then how the review worked, the findings and how far to trust it, the marker last (R9 of the core of the change on the pull request)', () => {
    inOrder(body, [
      '## deep-review\'s review of this pull request\n\ndeep-review reviewed this pull request at its head `22222222`, the 1 file changed from the merge base `11111111`, and changed no file.\n\n### What this change does',
      '### Summary',
      '### What needs a person',
      '### What this review did not examine',
      '### How the review worked',
      '### The major findings',
      '### Finding 2: extract the helper',
      '### The minor findings',
      '### How far to trust this review',
      'Reviewed by deep-review 0.0.0+dev on claude 2.1.283 with opus and sonnet, run `run-1`, commits 11111111..22222222.',
    ]);
    assert.equal(lastLine(body), `<!-- ${publicationMarker('run-1', 1)} -->`, 'the marker of the publication is the very last line');
  });

  it('posts none of the sections the report form replaced: no account of the pull request, no table of every finding, no legend, no evidence', () => {
    for (const gone of ['What this pull request does', 'For a reader new to this change', '### Findings\n', 'Before the merge:', 'The words of this review', 'Evidence that', '- Summary:', '- Reason:', '- Evidence:', '/files#diff-']) excludes(body, gone);
  });

  it('names a finding by its number wherever a worker named it by id, in the review\'s language, and keeps the id in the trace line alone (R1, R4, R6 of the finding names in the review)', () => {
    const named = (language: string): PullRequestForm => {
      const answer = answerWithArea('flowchart LR\n  A["RIPPLE-1"] --> B["`SWEEP-1` waits"]');
      answer.conclusion.why = 'RIPPLE-1 crashes parse(), and `SWEEP-1` waits on its answer.';
      answer.findings[0] = { ...answer.findings[0]!, unexplained: false, problem: 'A caller that passes an empty file meets a crash before SWEEP-1 can help.' } as typeof answer.findings[0];
      return formOf(withSettings(run(), { 'review.language': language }, { 'review.language': 'repository' }).fold(), answer);
    };
    const en = named('en');
    includes(section(en.body, '### Summary'), 'Finding 1 crashes parse(), and finding 2 waits on its answer.');
    includes(en.body, 'A["Finding 1"] --> B["Finding 2 waits"]');
    const comment = en.comments.find((posted) => posted.body.includes('meets a crash before'))!.body;
    includes(comment, 'meets a crash before finding 2 can help.');
    includes(comment, '<sub>Finding `RIPPLE-1` of run ');
    for (const text of [en.body, ...en.comments.map((posted) => posted.body.split('\n').filter((line) => !line.includes('<sub>') && !line.includes('<!--')).join('\n'))]) excludes(text, 'RIPPLE-1');
    includes(section(named('ko').body, '### 요약'), '지적 사항 1');
  });

  it('names an id before joining the lines of a worker\'s text, so a name that starts a list item or a paragraph is capitalized and one after a line break inside a sentence is not (R5 of the finding names in the review)', () => {
    const answer = writerAnswer();
    answer.findings[0] = { ...answer.findings[0]!, unexplained: false, problem: 'Two causes:\n- RIPPLE-1 crashes parse.\n- SWEEP-1 waits.\n\n- SWEEP-1 waits too.\n\nThis waits on\nSWEEP-1 first.' } as typeof answer.findings[0];
    const comment = formOf(run().fold(), answer).comments.find((posted) => posted.body.includes('Two causes:'))!.body;
    includes(comment, 'Two causes: - Finding 1 crashes parse. - Finding 2 waits.');
    includes(comment, '\n\n\\- Finding 2 waits too.\n\n');
    includes(comment, '\n\nThis waits on finding 2 first.');
  });

  it('sums up the counts, the writer\'s sentence on the areas, what deep-review decided and that nothing changes before `--fix`', () => {
    includes(section(body, '### Summary'), '### Summary\n\nThe review keeps 2 findings. The major one is what matters before the merge; the minor one is smaller. An empty input still crashes parse(), and the author must choose how parse treats one.\n\ndeep-review would fix 1 finding and asks the author 1 question. Nothing on this branch changes until the person who ran the review applies the fixes, and the answers given by then, with `deep-review review --pr 42 --fix` in their clone and pushes them.');
  });

  it('lists what needs a person: a question with the option recommended and the one that stands, a fix against a written rule, then the one command that answers', () => {
    assert.equal(section(body, '### What needs a person'), [
      '### What needs a person',
      '',
      '- **[Question on finding 2](#finding-2).** Should parse accept an empty input? deep-review recommends option 2: Accept it and return an empty result. Until someone answers, option 1 stands, the easiest to take back: the code stays as it is.',
      `- **[Finding 1](${blob(head, 'src/a.ts', '4')}) is a fix against a written rule.** The rule: "parse throws on a null input." \`--fix\` makes it as decided unless the person who ran the review rejects it first; a rejection after the fix sends that finding back to a fixer.`,
      '',
      'The person who ran the review answers with `deep-review answer --run run-1 --finding <n>` and one of `--option <k>`, `--accept` or `--reject`. A reply on this pull request is not read yet.',
      '',
    ].join('\n'));
  });

  it('says in one sentence when nothing needs a person, and that the run has no judgment of a public interface or a wide effect when its triage gave no account (R7 of the core of the change on the pull request)', () => {
    const quiet = formOf(run(decisions).fold(), { ...writerAnswer(), findings: [writerAnswer().findings[0]!] });
    assert.equal(section(quiet.body, '### What needs a person'), '### What needs a person\n\nNothing here needs a person that deep-review can name: it asks no question, and no fix goes against a written rule or rests on a PLAUSIBLE verdict. deep-review has no judgment for this run of whether the change alters a public interface or affects files beyond its own.\n');
  });

  it('gives the answered question and departure as answered, and the recommended option that stands as one option', () => {
    const answered = formOf(run().add('answer.recorded', answer('SWEEP-1', 1)).add('answer.recorded', answer('RIPPLE-1', 'reject')).fold());
    const needs = section(answered.body, '### What needs a person');
    includes(needs, 'Should parse accept an empty input? The person who ran this review answered it with option 2, on ');
    includes(needs, 'The rule: "parse throws on a null input." The person who ran this review rejected the departure, so the fix follows the rule, on ');
    const same = askDecision('SWEEP-1', true) as { ask: Record<string, unknown> };
    const standing = formOf(run([{ ...decisions[0], departure }, { ...same, ask: { ...same.ask, recommended: 0 } }]).fold());
    includes(section(standing.body, '### What needs a person'), 'deep-review recommends option 1: Reject it with an error. It also stands until someone answers: `--fix` applies it.');
  });

  it('says how the review worked with the counts the state gives, a diagram that passes the checks, and what each verdict and severity means', () => {
    const how = section(body, '### How the review worked');
    // Five candidates: RIPPLE-1 and RIPPLE-2 of the finders, a duplicate of the finders, SWEEP-1 and SWEEP-2 of the sweep; RIPPLE-2 refuted, SWEEP-2 merged into RIPPLE-1.
    includes(how, 'Here 5 candidates became 4 after merging duplicates; the verifiers refuted 1 and kept 3, and 1 of those joined another finding, which leaves 2.');
    includes(how, '```mermaid\nflowchart TD\n  subgraph RV["review --pr 42, read-only: done"]');
    includes(how, '  A --> X["review --pr 42 --fix: fixers apply and test each fix"]\n```');
    includes(how, 'CONFIRMED means a verifier reproduced the problem by running it or traced the code path to the wrong result. PLAUSIBLE means');
    includes(how, 'A PLAUSIBLE finding marked unverified is one that no verifier examined');
    for (const words of Object.values(pullRequestWordTables)) assert.deepEqual(diagramFailures(words.howDiagram(42)), []);
  });

  it('gives each major finding that acts as one line in an area: for an older run, one area named by the engine with no diagram, since its conclusion\'s diagram names findings by id', () => {
    assert.equal(section(body, '### The major findings'), [
      '### The major findings',
      '',
      '**The major findings that deep-review would fix or asks about.**',
      '',
      `- **[1. parse() reads the null before any guard.](${blob(head, 'src/a.ts', '4')}).** CONFIRMED. Fix: Guard the null before parse reads it. Against a written rule.`,
      '',
    ].join('\n'));
  });

  it('gives a major question\'s line with what it recommends, and says when no major finding acts', () => {
    const asked = formOf(run([askDecision('RIPPLE-1', false), decisions[1]]).fold());
    includes(section(asked.body, '### The major findings'), `- **[1. parse() reads the null before any guard.](${blob(head, 'src/a.ts', '4')}).** CONFIRMED. A question for the author; deep-review recommends option 2: Accept it and return an empty result.`);
    const left = formOf(run([{ ...decisions[0], decision: 'leave', fix: null, leave: { reason: 'intended', supersededBy: null } }, decisions[1]]).fold(), null);
    assert.equal(section(left.body, '### The major findings'), '### The major findings\n\nNo major finding asks for a fix or a question.\n');
  });

  it('gives in full a finding that acts and has no line in the diff, with its anchor, and links it by the anchor', () => {
    includes(body, '<a id="finding-2"></a>\n\n### Finding 2: extract the helper\n\nMinor. PLAUSIBLE, unverified. deep-review asks the author. This finding names no place that the repository holds.');
    const outside = formOf(run().fold(), writerAnswer(), filesWith('@@ -1,1 +1,1 @@\n-a\n+b'));
    assert.deepEqual(outside.comments, []);
    includes(outside.body, '<a id="finding-1"></a>\n\n### Finding 1: parse() reads the null before any guard.\n\nMajor. CONFIRMED, traced through the code. deep-review would fix this against a written rule. This pull request does not change this line.');
    includes(section(outside.body, '### The major findings'), '- **[1. parse() reads the null before any guard.](#finding-1).**');
    includes(formOf(run().fold(), writerAnswer(), []).body, 'Major. CONFIRMED, traced through the code. deep-review would fix this against a written rule. This pull request does not change this file.');
    includes(formOf(run().fold(), writerAnswer(), filesWith(null)).body, 'deep-review would fix this against a written rule. GitHub shows no diff of this file, so this finding has no comment on its line.');
  });

  it('folds the minor findings in a table after their counts and which of them need a person', () => {
    assert.equal(section(body, '### The minor findings'), [
      '### The minor findings',
      '',
      '1 minor finding, in full above. Finding 2 among them needs a person, as "What needs a person" says.',
      '',
      '<details><summary>The minor finding</summary>',
      '',
      '| # | Finding | Verdict | What deep-review would do |',
      '|---|---|---|---|',
      '| 2 | [extract the helper](#finding-2) | PLAUSIBLE, unverified | A question for the author; deep-review recommends option 2: Accept it and return an empty result. |',
      '',
      '</details>',
      '',
    ].join('\n'));
  });

  it('folds the findings left as is, each with why and its grounds', () => {
    const left = formOf(run(decisions).fold(), { ...writerAnswer(), findings: [writerAnswer().findings[0]!] });
    includes(left.body, '### The findings left as is\n\n<details><summary>The finding left as is</summary>\n\n<a id="finding-2"></a>\n\n**2. extract the helper**\n\nMinor. PLAUSIBLE, unverified. deep-review leaves this as is: outside the change, and not a regression.\n\nWhy: The helper would edit only lines the change does not touch.\n\n</details>');
    excludes(left.body, '### The minor findings');
  });

  it('says what the run did not examine: no check, each gap, and the refuted candidates folded, each with its line and the engine\'s words where the writer gave none', () => {
    assert.equal(section(body, '### What this review did not examine'), [
      '### What this review did not examine',
      '',
      '- No check ran: this run only reviewed, so no test ran against the change.',
      '- The footguns review pass did not run, and a later pass looked for what it would have found.',
      '- No verifier examined finding 2 and a candidate merged into finding 1; it counts as plausible.',
      '- The candidate that the verifiers refuted is listed below, so a point raised again can be answered from it.',
      '',
      '<details><summary>The refuted candidate</summary>',
      '',
      `- [\`src/a.ts:9\`](${blob(head, 'src/a.ts', '9')}): a stale cache entry after logout. Refuted: The evidence that refuted it is in the report of the run.`,
      '',
      '</details>',
      '',
    ].join('\n'));
  });

  it('names the patterns that left paths out, with their count and the layer that set them', () => {
    const history = rewritten(withSettings(run(), { 'scope.exclude': ['*.lock', 'vendor/**'] }, { 'scope.exclude': 'repository' }), (kind, payload) => (kind === 'scope.captured'
      ? { ...payload, request: { ...(payload.request as object), exclude: ['*.lock', 'vendor/**'] }, excluded: { paths: ['a.lock', 'vendor/x.js', 'vendor/y.js'], count: 3 } }
      : undefined));
    const notExamined = section(formOf(history.fold()).body, '### What this review did not examine');
    includes(notExamined, '\n- 3 changed paths under `*.lock` and `vendor/**` were left out, as the repository\'s file sets `scope.exclude`, and no worker read them.\n');
    excludes(notExamined, 'which the settings leave out');
  });

  it('says how far to trust the review in counts, and what a model wrote', () => {
    assert.equal(section(body, '### How far to trust this review'), '### How far to trust this review\n\n1 of the 2 findings is CONFIRMED and 1 PLAUSIBLE, 1 of them unverified; the major one is CONFIRMED. Across all 2, 1 was checked by tracing it, and 1 has no basis on record. The verifiers refuted 1 of 5 candidates, so the finders\' claims did not pass unchecked. A model wrote the explanations from the verifiers\' evidence, which the report of the run holds, and only that evidence was verified.\n\nThis run\'s writer answered before deep-review\'s writer gave the core of the change, so the review opens with no account of the change.\n');
  });

  it('links every piece of code at the reviewed head, or at the merge base for removed lines, and never into the diff', () => {
    const text = [body, ...form.comments.map((comment) => comment.body)].join('\n');
    const links = [...text.matchAll(/\]\((https?:[^)]+)\)/g)].map((match) => match[1]!);
    assert.ok(links.length >= 4, links.join('\n'));
    for (const link of links) assert.match(link, new RegExp(`^https://github\\.com/octo/parse/blob/(?:${head}|${base})/`), link);
    assert.deepEqual(links.filter((link) => link.includes(`/blob/${base}/`)), [blob(base, 'src/gone.ts', '2')], 'only the case on removed lines is at the merge base');
  });

  it('falls back to the engine\'s words for each part the writer dropped, names it, and for a run with no explanation', () => {
    const dropped = run(answerableDecisions(), explanation(worker(60), { dropped: [{ part: 'conclusion', failures: ['x'] }, { part: 'account', failures: ['x'] }, { part: 'finding', finding: 'RIPPLE-1', failures: ['x'] }], unexplained: ['SWEEP-1'] })).fold();
    const fallback = formOf(dropped, { conclusion: null, account: null, areas: null, refuted: null, core: null, conditions: null, findings: [writerAnswer().findings[1]!] });
    includes(fallback.body, `- **[1. null dereference](${blob(head, 'src/a.ts', '4')}).** CONFIRMED. Fix: Guard the null once, before parse reads it. Against a written rule.`);
    excludes(fallback.body, '```mermaid\nflowchart LR');
    includes(section(fallback.body, '### How far to trust this review'), '\n\nThe writer gave no summary that deep-review could keep, so the summary and the actions are in deep-review\'s own words.\n\nThe writer gave no explanation of finding 1 that passed deep-review\'s checks, so it is given in deep-review\'s own words.');
    const none = formOf(runBeforeExplanation().fold(), null);
    includes(none.body, 'deep-review recorded no explanation by its writer for this run, so the review is in deep-review\'s own words.');
    excludes(none.body, 'A model wrote the explanations');
    includes(section(fallback.body, '### How far to trust this review'), 'A model wrote the explanations');
    excludes(none.comments[0]!.body, 'did not explain this finding');
  });

  it('says a model wrote the explanations only when the review posts some text of the writer, whatever answer it froze', () => {
    const trustOf = (state: RunState, answer: RecordedAnswer): string => section(formOf(state, answer).body, '### How far to trust this review');
    const empty: RecordedAnswer = { conclusion: null, account: null, areas: null, refuted: null, core: null, conditions: null, findings: [] };
    // A writer that completed its unit has its answer frozen, even with every part dropped.
    const nothingKept = run(answerableDecisions(), explanation(worker(60), { dropped: [{ part: 'conclusion', failures: ['x'] }, { part: 'account', failures: ['x'] }, { part: 'finding', finding: 'RIPPLE-1', failures: ['x'] }, { part: 'finding', finding: 'SWEEP-1', failures: ['x'] }] })).fold();
    excludes(trustOf(nothingKept, empty), 'A model wrote the explanations');
    const accountOnly = run(answerableDecisions(), explanation(worker(60), { dropped: [{ part: 'conclusion', failures: ['x'] }, { part: 'finding', finding: 'RIPPLE-1', failures: ['x'] }, { part: 'finding', finding: 'SWEEP-1', failures: ['x'] }] })).fold();
    excludes(trustOf(accountOnly, { ...empty, account: writerAnswer().account }), 'A model wrote the explanations');
    // With its areas dropped the summary leaves out the conclusion's why, and the sentence of a question gives way to the option recommended.
    const conclusionOnly = (decided: readonly unknown[]): RunState => withReportForm(run(decided, explanation(worker(60), { dropped: [{ part: 'areas', failures: ['x'] }, { part: 'refuted', failures: ['x'] }, { part: 'finding', finding: 'RIPPLE-1', failures: ['x'] }, { part: 'finding', finding: 'SWEEP-1', failures: ['x'] }] }))).fold();
    excludes(trustOf(conclusionOnly(answerableDecisions(askDecision('RIPPLE-1', false))), { ...empty, conclusion: writerAnswer().conclusion }), 'A model wrote the explanations');
    includes(trustOf(conclusionOnly(answerableDecisions()), { ...empty, conclusion: writerAnswer().conclusion }), 'A model wrote the explanations');
    includes(trustOf(nothingKept, { ...empty, refuted: [{ id: 'RIPPLE-2', claim: 'A cache entry outlives a logout.', why: 'Logout clears the cache first.' }] }), 'A model wrote the explanations');
  });

  it('names the writer\'s summary, areas and refuted lines when the checks dropped them, in each language', () => {
    /** The trust section of a run whose review reads as a report, in `language`, its explanation dropping the part named. */
    const trustOf = (language: string, part: string): string => {
      const history = withSettings(run(answerableDecisions(), explanation(worker(60), { dropped: [{ part, failures: ['x'] }], unexplained: ['SWEEP-1'] })), { 'review.language': language }, { 'review.language': 'repository' });
      const words = pullRequestWordTables[language as keyof typeof pullRequestWordTables];
      const body = formOf(withReportForm(history).fold(), { ...writerAnswer(), areas: null, refuted: null }).body;
      return section(body, words.trustHeading);
    };
    for (const language of ['en', 'ko'] as const) {
      const { areasDropped, refutedDropped, conclusionDropped } = pullRequestWordTables[language];
      const areas = trustOf(language, 'areas');
      includes(areas, `\n\n${areasDropped}\n`);
      for (const other of [refutedDropped, conclusionDropped]) excludes(areas, other);
      const refuted = trustOf(language, 'refuted');
      includes(refuted, `\n\n${refutedDropped}\n`);
      for (const other of [areasDropped, conclusionDropped]) excludes(refuted, other);
      const conclusion = trustOf(language, 'conclusion');
      includes(conclusion, `\n\n${conclusionDropped}\n`);
      for (const other of [areasDropped, refutedDropped]) excludes(conclusion, other);
    }
    // A summary that passed is dropped when its answer's areas were not kept, so the note says none could be kept, not that none passed.
    includes(trustOf('en', 'conclusion'), 'The writer gave no summary that deep-review could keep, so the summary and the actions are in deep-review\'s own words.');
    excludes(trustOf('en', 'conclusion'), 'no summary that passed');
    includes(trustOf('en', 'areas'), 'The writer gave no areas that passed deep-review\'s checks, so the major findings are listed in one area in deep-review\'s own words.');
    includes(trustOf('en', 'refuted'), 'The writer gave no lines for the refuted candidates that passed deep-review\'s checks, so each is given by its finder\'s summary.');
  });

  it('names the findings whose answers the explanation predates', () => {
    const answered = formOf(run().add('answer.recorded', answer('SWEEP-1', 1)).add('answer.recorded', answer('RIPPLE-1', 'reject')).fold());
    includes(answered.body, 'The writer explained this review before the answers to findings 1 and 2 were recorded; deep-review\'s own words give each answer.');
    includes(answered.body, 'The person who ran this review answered it with option 2, on ');
    includes(answered.comments[0]!.body, 'The person who ran this review rejected the departure, so the fix follows the rule, on ');
    excludes(answered.body, '--option <k>`, where');
  });
});


// R6 of the review of a fix run: the review of a run that went on into its fix pass says what followed the review, and names --fix nowhere.
describe('the review of a run continued into its fix pass (R6 of the review of a fix run)', () => {
  /** The form of `state` as publish renders a run that went on into its fix pass. */
  const continued = (state: RunState = run().fold()): PullRequestForm => formOf(state, writerAnswer(), filesWith(), { fixPass: 'continued' });
  /** The body and every comment of a form, as one text. */
  const textOf = (form: PullRequestForm): string => [form.body, ...form.comments.map((comment) => comment.body)].join('\n');
  const { body, comments } = continued();

  it('says that deep-review went on to fix on the machine of the person who ran the review, that its edits are not part of the review, and that they reach the branch only when that person pushes them', () => {
    includes(body, '## deep-review\'s review of this pull request\n\ndeep-review reviewed this pull request at its head `22222222`, the 1 file changed from the merge base `11111111`. It then went on to fix the findings it decided to fix, in the fix pass of its own run on the machine of the person who ran the review; those edits are not part of this review, and once its fix pass has ended, the report of the run on that machine says what each fix did.\n');
    includes(section(body, '### Summary'), 'deep-review would fix 1 finding and asks the author 1 question. What its fix pass changed reaches this branch only when the person who ran the review pushes it.');
    excludes(body, 'changed no file');
    excludes(body, 'Nothing on this branch changes until');
  });

  it('says that the fix pass sets out to make a departure as decided and that a rejection sends it back to a fixer, with no claim that it made the fix', () => {
    includes(section(body, '### What needs a person'), 'The rule: "parse throws on a null input." The fix pass that followed this review sets out to make it as decided; a rejection by the person who ran the review sends that finding back to a fixer.');
    includes(comments[0]!.body, 'The person who ran this review accepts the departure with `deep-review answer --run run-1 --finding 1 --accept` or rejects it with `deep-review answer --run run-1 --finding 1 --reject`, on the machine that holds the run, once the fix pass of the run has ended; the fix pass that followed this review sets out to make the fix as decided, and a rejection sends the finding back to a fixer.');
    includes(comments[0]!.body, 'deep-review would fix this against a written rule.');
    // `answer` refuses a run with no current report, so a departure is answered, as a question is, once the fix pass has ended.
    const korean = continued(withSettings(run(), { 'review.language': 'ko' }, { 'review.language': 'repository' }).fold());
    includes(korean.comments[0]!.body, '`deep-review answer --run run-1 --finding 1 --reject` 명령으로 거부합니다. 답은 그 실행의 수정 단계가 끝난 뒤에 할 수 있습니다. 이 리뷰 뒤에 이어진 수정 단계는');
  });

  it('says that the command that answers a question applies the answer once the fix pass has ended, and that the fix pass makes the edit of an option that stands', () => {
    includes(body, '**How to answer.** Once the fix pass of the run has ended, the person who ran this review answers on the machine that holds the run, with `deep-review answer --run run-1 --finding 2 --option <k>`, where `<k>` is the number of the option, and that command applies the answer. A reply on this pull request is not read yet.');
    const same = askDecision('SWEEP-1', true) as { ask: Record<string, unknown> };
    const standing = continued(run([{ ...decisions[0], departure }, { ...same, ask: { ...same.ask, recommended: 0 } }]).fold());
    includes(section(standing.body, '### What needs a person'), 'deep-review recommends option 1: Reject it with an error. It also stands until someone answers: the fix pass makes its edit while this option stands.');
  });

  it('draws the review done and the fix pass started on that machine, and says no check ran in the review and where the checks of the fix pass are', () => {
    const how = section(body, '### How the review worked');
    includes(how, '```mermaid\nflowchart TD\n  subgraph RV["The review of pull request 42: done"]');
    includes(how, '  W --> X["The fix pass started on the machine that ran the review, and once it ends, its report there holds what it changed"]\n  W --> P["publish cleans the text and posts this review"]\n  P --> A["The person who ran the review answers the questions"]\n```');
    includes(section(body, '### What this review did not examine'), '- No check ran in this review. The fix pass that followed runs the repository\'s checks on the machine that ran it, and once it ends, its report there holds their results.');
    for (const words of Object.values(pullRequestWordTables)) assert.deepEqual(diagramFailures(words.continued.howDiagram(42)), []);
  });

  it('takes each of those words from the table of the run\'s language, and names --fix nowhere, in the body or a comment, in each language', () => {
    for (const [language, words] of Object.entries(pullRequestWordTables)) {
      const text = textOf(continued(withSettings(run(), { 'review.language': language }, { 'review.language': 'repository' }).fold()));
      excludes(text, '--fix');
      for (const part of [words.continued.reviewed('`22222222`', 1, '`11111111`'), words.continued.summaryNext({ fixes: 1, questions: 1, left: 0 }), words.continued.departureStands, words.continued.howDiagram(42), words.continued.noCheck]) includes(text, part);
      for (const readOnly of [words.reviewed('`22222222`', 1, '`11111111`'), words.departureStands, words.howDiagram(42), words.noCheck]) excludes(text, readOnly);
    }
  });
});
describe('the parts that the newer writer and verifier give (R4, R7, R9 to R11)', () => {
  /** The state with the verdict of candidate `id` changed as `change` says. */
  const withVerdict = (state: RunState, id: string, change: Record<string, unknown>): RunState => {
    const candidate = state.review!.candidates[id]!;
    return { ...state, review: { ...state.review!, candidates: { ...state.review!.candidates, [id]: { ...candidate, verdict: { ...candidate.verdict!, ...change } } } } };
  };

  it('gives each area of the writer with its title, intro and diagram', () => {
    const body = formOf(run().fold(), answerWithArea('flowchart LR\n  E["empty file"] --> P["parse()"]')).body;
    includes(section(body, '### The major findings'), '**Parsing an empty input.** What parse() does with an empty file.\n\n```mermaid\nflowchart LR\n  E["empty file"] --> P["parse()"]\n```');
    excludes(body, 'The major findings that deep-review would fix or asks about.');
  });

  it('says how the verifier checked a finding in the writer\'s line, not in the words of its basis', () => {
    const said = writerAnswer();
    said.findings[0] = { ...(said.findings[0] as ExplainedFinding), checked: 'A probe passed an empty file and parse() threw.' };
    const comment = formOf(run().fold(), said).comments[0]!.body;
    includes(comment, '<details><summary>How the verifier checked it</summary>\n\nA probe passed an empty file and parse() threw.\n\n</details>');
  });

  it('gives a refuted candidate the writer\'s claim and why it was refuted', () => {
    const body = formOf(run().fold(), { ...writerAnswer(), refuted: [{ id: 'RIPPLE-2', claim: 'A cache entry outlives a logout.', why: 'Logout clears the cache first.' }] }).body;
    includes(body, 'A cache entry outlives a logout. Refuted: Logout clears the cache first.');
    excludes(body, 'The evidence that refuted it is in the report of the run.');
  });

  it('says why a verdict is PLAUSIBLE as its verifier gave it', () => {
    const state = withVerdict(run().fold(), 'RIPPLE-1', { verdict: 'PLAUSIBLE', unconfirmed: { kind: 'choice', text: 'which of the two guards to keep' } });
    includes(formOf(state).comments[0]!.body, 'which of the two guards to keep');
  });

  const choice = 'Whether parse should throw or return null on an empty file.';
  /** The section of the findings left as is, each block in it, up to the next section. */
  const leftOf = (body: string): string => {
    const from = body.indexOf('### The findings left as is\n');
    assert.ok(from !== -1, body);
    const end = body.indexOf('\n### ', from + 1);
    return body.slice(from, end === -1 ? undefined : end);
  };
  const leftIntended = { ...decisions[0], decision: 'leave', fix: null, departure: null, leave: { reason: 'intended', supersededBy: null } };
  /** The state with the decision of finding `id` changed as `change` says, as a decider at version 2 records one. */
  const withDecision = (state: RunState, id: string, change: Record<string, unknown>): RunState => ({ ...state, review: { ...state.review!, decisions: state.review!.decisions!.map((decision) => (decision.id === id ? { ...decision, ...change } as typeof decision : decision)) } });
  const settled = { for: ['RIPPLE-1'], choice: 'Parse keeps returning null on an empty file.', by: 'contract', source: 'The documentation of parse says that an empty file gives null.' };

  it('folds a finding left as is whose verifier named a choice with the findings left as is, and shows the choice there as the verifier\'s, which deep-review did not settle (R4; PD8, PD7 of the settled choice)', () => {
    const state = withVerdict(run([leftIntended, decisions[1]]).fold(), 'RIPPLE-1', { authorChoice: choice });
    const body = formOf(state).body;
    excludes(section(body, '### What needs a person'), 'Finding 1');
    excludes(body, 'is left as is, but its verifier leaves a choice to the author');
    inOrder(leftOf(body), ['**1. ', 'Why: ', `**The choice.** Its verifier left this choice to the author: ${choice} deep-review did not settle it.`, 'Code at the reviewed head:']);
  });

  it('gives a finding left as is no text in full, since it asks no person to act, and shows it only in the findings left as is (PD7 of the settled choice)', () => {
    const state = withVerdict(run([leftIntended, decisions[1]]).fold(), 'RIPPLE-1', { authorChoice: choice });
    const full = writerAnswer();
    const asked = findingsToExplain(state.review!);
    assert.equal(asked.length, 0);
    const body = formOf(state, { ...full, findings: full.findings.filter((finding) => asked.includes(finding.id)) }).body;
    excludes(body, '### Finding 1:');
    includes(leftOf(body), '<a id="finding-1"></a>');
  });

  it('says in the summary that nothing needs to change when every finding is left as is, whatever their verifiers named (PD7 of the settled choice)', () => {
    const answer = { ...writerAnswer(), conclusion: { ...writerAnswer().conclusion, actions: [] } };
    const withChoice = withVerdict(run([leftIntended, decisions[1]]).fold(), 'RIPPLE-1', { authorChoice: choice });
    for (const state of [withChoice, run([leftIntended, decisions[1]]).fold()]) includes(section(formOf(state, answer).body, '### Summary'), 'deep-review leaves 2 findings as is, so nothing on this branch needs to change.');
  });

  it('shows the choice that a PLAUSIBLE member names on the line of a finding left as is whose CONFIRMED primary names none (R4 of the settled choice)', () => {
    const folded = run([leftIntended, decisions[1]]).fold();
    const primary = folded.review!.candidates['RIPPLE-1']!.verdict!;
    const state = withVerdict({ ...folded, review: { ...folded.review!, candidates: { ...folded.review!.candidates, 'SWEEP-2': { ...folded.review!.candidates['SWEEP-2']!, verdict: primary } } } }, 'SWEEP-2', { verdict: 'PLAUSIBLE', evidence: 'line 7 reads the value. Not CONFIRMED: one caller.', unconfirmed: { kind: 'choice', text: 'whether an empty file is an error' }, authorChoice: choice });
    assert.equal(primary.authorChoice, null);
    const body = formOf(state).body;
    excludes(section(body, '### What needs a person'), 'Finding 1');
    includes(leftOf(body), `**The choice.** Its verifier left this choice to the author: ${choice} deep-review did not settle it.`);
  });

  it('shows beside a finding left as is the choice its decision settles, the step in the review\'s words and its source, after the verifier\'s choice (R4, PD8 of the settled choice)', () => {
    const state = withDecision(withVerdict(run([leftIntended, decisions[1]]).fold(), 'RIPPLE-1', { authorChoice: choice }), 'RIPPLE-1', { settled: [settled] });
    includes(leftOf(formOf(state).body), `**The choice.** Its verifier left this choice to the author: ${choice} deep-review decided: Parse keeps returning null on an empty file. What settles it: what the repository states. The documentation of parse says that an empty file gives null.`);
    const unnamed = withDecision(run([leftIntended, decisions[1]]).fold(), 'RIPPLE-1', { leave: { reason: 'settled', supersededBy: null }, settled: [{ ...settled, for: [], by: 'shape' }] });
    const left = leftOf(formOf(unnamed).body);
    includes(left, 'deep-review leaves this as is: a choice of shape, settled in favor of the code as it is.');
    includes(left, '**The choice.** deep-review decided: Parse keeps returning null on an empty file. What settles it: the shape the code around it already uses, or else the one that adds less.');
    excludes(leftOf(formOf(run([leftIntended, decisions[1]]).fold()).body), '**The choice.**');
  });

  it('shows in a fix\'s comment, after what deep-review would do, the choice it settles, and the verifier\'s choice beside it (R5, PD8 of the settled choice)', () => {
    const settledFix = withDecision(withVerdict(run().fold(), 'RIPPLE-1', { authorChoice: choice }), 'RIPPLE-1', { settled: [{ ...settled, by: 'intent' }] });
    inOrder(formOf(settledFix).comments[0]!.body, ['**What deep-review would do.**', `**The choice.** Its verifier left this choice to the author: ${choice} deep-review decided: Parse keeps returning null on an empty file. What settles it: the stated intent of the change.`, '**This fix goes against a written rule.**', '<details><summary>The fix as decided</summary>']);
    const departing = withVerdict(run().fold(), 'RIPPLE-1', { authorChoice: choice });
    includes(formOf(departing).comments[0]!.body, `**The choice.** Its verifier left this choice to the author: ${choice} deep-review did not settle it.`);
    excludes(formOf(run().fold()).comments[0]!.body, '**The choice.**');
  });

  /** The state with SWEEP-2, the member of RIPPLE-1, verified CONFIRMED and naming its own choice beside RIPPLE-1's. */
  const otherChoice = 'Whether the helper at line 7 guards the null too, or leaves it to its callers.';
  const withTwoChoices = (state: RunState): RunState => {
    const named = withVerdict(state, 'RIPPLE-1', { authorChoice: choice });
    const primary = named.review!.candidates['RIPPLE-1']!.verdict!;
    return withVerdict({ ...named, review: { ...named.review!, candidates: { ...named.review!.candidates, 'SWEEP-2': { ...named.review!.candidates['SWEEP-2']!, unverified: false, verdict: primary } } } }, 'SWEEP-2', { evidence: 'line 7 reads the null too', authorChoice: otherChoice });
  };
  const helperSettled = { for: ['SWEEP-2'], choice: 'The helper guards the null too.', by: 'scope', source: 'The helper is new in this change.' };

  it('shows each choice of a merged finding left as is beside the settled choice that answers it, a paragraph each (PD9 of the settled choice)', () => {
    const state = withDecision(withTwoChoices(run([leftIntended, decisions[1]]).fold()), 'RIPPLE-1', { settled: [settled, { ...helperSettled, by: 'intent' }] });
    const left = leftOf(formOf(state).body);
    inOrder(left, [
      `**The choice.** Its verifier left this choice to the author: ${choice} deep-review decided: Parse keeps returning null on an empty file. What settles it: what the repository states. The documentation of parse says that an empty file gives null.`,
      `**The choice.** Its verifier left this choice to the author: ${otherChoice} deep-review decided: The helper guards the null too. What settles it: the stated intent of the change. The helper is new in this change.`,
    ]);
    excludes(left, 'deep-review did not settle it');
  });

  it('shows in a merged finding\'s fix each choice its decision settles, and each choice it does not settle as not settled by deep-review (PD9 of the settled choice)', () => {
    const partly = formOf(withDecision(withTwoChoices(run().fold()), 'RIPPLE-1', { settled: [helperSettled] })).comments[0]!.body;
    inOrder(partly, [
      '**What deep-review would do.**',
      `**The choice.** Its verifier left this choice to the author: ${otherChoice} deep-review decided: The helper guards the null too. What settles it: keeping the fix to the part inside the change. The helper is new in this change.`,
      `**The choice.** Its verifier left this choice to the author: ${choice} deep-review did not settle it.`,
      '**This fix goes against a written rule.**',
    ]);
    const unsettled = formOf(withTwoChoices(run().fold())).comments[0]!.body;
    inOrder(unsettled, [`**The choice.** Its verifier left this choice to the author: ${choice} deep-review did not settle it.`, `**The choice.** Its verifier left this choice to the author: ${otherChoice} deep-review did not settle it.`]);
  });

  it('keeps, when it cuts the findings left as is, a merged finding whose member alone named a choice (R4, PD9 of the settled choice)', () => {
    const folded = run([leftIntended, decisions[1]]).fold();
    const primary = folded.review!.candidates['RIPPLE-1']!.verdict!;
    const memberNamed = withVerdict({ ...folded, review: { ...folded.review!, candidates: { ...folded.review!.candidates, 'SWEEP-2': { ...folded.review!.candidates['SWEEP-2']!, unverified: false, verdict: primary } } } }, 'SWEEP-2', { authorChoice: otherChoice });
    const form = formOf(withDecision(memberNamed, 'SWEEP-1', { grounds: 'g'.repeat(maxPostedLength) }));
    assert.ok(form.cuts.includes('left'), JSON.stringify(form.cuts));
    includes(leftOf(form.body), `**The choice.** Its verifier left this choice to the author: ${otherChoice} deep-review did not settle it.`);
  });

  it('keeps, when it cuts the findings left as is, those whose verifier named a choice, and gives the others their count (R4 of the settled choice)', () => {
    // Grounds longer than a decider gives, so that the body overflows by the finding a cut takes.
    const state = withDecision(withVerdict(run([leftIntended, decisions[1]]).fold(), 'RIPPLE-1', { authorChoice: choice }), 'SWEEP-1', { grounds: 'g'.repeat(maxPostedLength) });
    const form = formOf(state);
    assert.ok(form.cuts.includes('left'), JSON.stringify(form.cuts));
    const left = leftOf(form.body);
    includes(left, `**The choice.** Its verifier left this choice to the author: ${choice} deep-review did not settle it.`);
    includes(left, 'To fit the length GitHub takes, the other finding left as is is not listed here; the report of the run holds it.');
    excludes(form.body, 'g'.repeat(100));
  });

  it('names, in a dry run, the cut of the findings left as is as of those whose verifiers named no choice, since it keeps the others (R4 of the settled choice)', () => {
    const state = withDecision(withVerdict(run([leftIntended, decisions[1]]).fold(), 'RIPPLE-1', { authorChoice: choice }), 'SWEEP-1', { grounds: 'g'.repeat(maxPostedLength) });
    const form = formOf(state);
    assert.deepEqual(form.cuts, ['refuted', 'left']);
    assert.ok(dryRunLines(state, [], form, []).includes('Cut from the body to fit: the refuted candidates, then the findings left as is whose verifiers named no choice.'), form.cuts.join());
  });
});

describe('the comment of a finding (R5, R7, R8, R10, R14)', () => {
  const comment = formOf(run().fold()).comments[0]!.body;

  it('says each part of a major fix against a written rule once, in order, and ends with the id and the marker', () => {
    inOrder(comment, [
      '**1. parse() reads the null before any guard.**\n\nMajor. CONFIRMED, traced through the code. deep-review would fix this against a written rule.',
      '**What goes wrong.** A caller that passes an empty file meets a crash.',
      '```mermaid\nsequenceDiagram\n  Caller->>parse: an empty file\n  parse-->>Caller: crash\n```',
      '**What deep-review would do.** Guard the null before parse reads it.',
      '**This fix goes against a written rule.** The rule: "parse throws on a null input." Its source: docs/parse.md. The fact against it: Every caller passes the null on an empty input. The person who ran this review accepts the departure with `deep-review answer --run run-1 --finding 1 --accept` or rejects it with `deep-review answer --run run-1 --finding 1 --reject`, on the machine that holds the run; `deep-review review --pr 42 --fix` makes the fix as decided unless it is rejected first.',
      '<details><summary>The fix as decided</summary>\n\nGuard the null once, before parse reads it.\n\n- Rejected: Catch the throw in each caller. Leaves the null in parse.\n\n</details>',
      '<details><summary>How the verifier checked it</summary>\n\nThe verifier traced the code to the result; the report of the run holds its evidence.\n\n</details>',
      `Code at the reviewed head:\n- [\`src/a.ts:3-4\`](${blob(head, 'src/a.ts', '3-L4')}) An empty file reaches the read on line 4.\n- [\`src/gone.ts:2\`](${blob(base, 'src/gone.ts', '2')}) (at the merge base) The removed guard stood here.`,
      '<sub>Finding `RIPPLE-1` of run `run-1`.</sub>',
    ]);
    assert.equal(lastLine(comment), `<!-- ${findingMarker('run-1', 'RIPPLE-1')} -->`, 'the marker of a finding is the last line of its comment');
  });

  it('posts neither the verifier\'s summary, reason, evidence and runs nor the writer\'s words on the decision', () => {
    for (const gone of ['Evidence that', 'null dereference', 'same root cause at lines 4 and 7', 'line 4 dereferences null', 'How the verifier established it', 'deep-review would guard the null once, so every caller is safe.']) excludes(comment, gone);
  });

  it('gives a question with why it is one, its options and their costs, the option recommended and the one that stands, and the command that answers', () => {
    const asked = formOf(run([askDecision('RIPPLE-1', false), decisions[1]]).fold()).comments[0]!.body;
    inOrder(asked, [
      'Major. CONFIRMED, traced through the code. deep-review asks the author.',
      '**What goes wrong.** A caller that passes an empty file meets a crash.',
      '**Why it is a question.** Nothing in the repository states which behavior is meant.',
      '**The question.** Should parse accept an empty input?',
      '1. **Keep accepting it.** Callers that pass one now see the change.\n2. **Accept it and return an empty result.** An empty input passes silently.',
      'deep-review recommends option 2. Until someone answers, option 1 stands, the easiest to take back: the code stays as it is.',
      '**How to answer.** The person who ran this review answers on the machine that holds the run, with `deep-review answer --run run-1 --finding 1 --option <k>`, where `<k>` is the number of the option. `deep-review review --pr 42 --fix` then applies the answer. A reply on this pull request is not read yet.',
      '<details><summary>How the verifier checked it</summary>',
      'Code at the reviewed head:',
    ]);
    excludes(asked, 'The fix as decided');
  });

  it('gives a minor fix its problem and action in one paragraph, its departure, the folded fix and one line of code, and no folded check', () => {
    const minor = formOf(reranked(run(), (finding) => (finding.id === 'RIPPLE-1' ? { ...finding, severity: 'minor' } : finding)).fold()).comments[0]!.body;
    inOrder(minor, [
      '**1. parse() reads the null before any guard.**\n\nMinor. CONFIRMED, traced through the code. deep-review would fix this against a written rule.\n\nA caller that passes an empty file meets a crash. Fix: Guard the null before parse reads it.\n\n**This fix goes against a written rule.**',
      '<details><summary>The fix as decided</summary>',
      `Code at the reviewed head: [\`src/a.ts:4\`](${blob(head, 'src/a.ts', '4')}).\n\n<sub>Finding \`RIPPLE-1\` of run \`run-1\`.</sub>`,
    ]);
    for (const gone of ['**What goes wrong.**', 'How the verifier checked it', 'sequenceDiagram', 'An empty file reaches the read']) excludes(minor, gone);
  });

  it('says why a PLAUSIBLE verdict is not CONFIRMED: a verdict recorded before verifiers gave a reason on its own, or no verifier at all', () => {
    const plausible = formOf(reranked(run(), (finding) => finding, (verdict) => (verdict.id === 'RIPPLE-1' ? { ...verdict, verdict: 'PLAUSIBLE' } : verdict)).fold());
    includes(plausible.comments[0]!.body, 'Major. PLAUSIBLE, traced through the code.');
    includes(plausible.comments[0]!.body, '**What goes wrong.** A caller that passes an empty file meets a crash. Why PLAUSIBLE: this verdict was recorded before verifiers gave their reason on its own; the report of the run holds its evidence.');
    includes(formOf(run().fold()).body, 'Finding 2 detail Why PLAUSIBLE: no verifier examined it, since its verifier failed twice.');
  });

  it('gives how the verifier checked it from the basis of the verdict', () => {
    const ran = formOf(rewritten(run(), (kind, payload) => (kind === 'verdicts.recorded' && payload.phase === 'verification'
      ? { ...payload, verdicts: (payload.verdicts as Record<string, unknown>[]).map((verdict) => (verdict.id === 'RIPPLE-1' ? { ...verdict, basis: 'ran', runs: [{ command: 'node /tmp/x/probe.mjs', printed: ['TypeError: null'], probe: null, at: 3, exitCode: 1 }] } : verdict)) }
      : undefined)).fold()).comments[0]!.body;
    includes(ran, 'Major. CONFIRMED, reproduced by running it.');
    includes(ran, '<details><summary>How the verifier checked it</summary>\n\nThe verifier ran code to check it; the report of the run holds what it ran and what it saw.\n\n</details>');
    excludes(ran, 'probe.mjs');
  });

  it('gives a finding the writer did not explain the mark, then the finder\'s own account', () => {
    const dropped = run(answerableDecisions(), explanation(worker(60), { dropped: [{ part: 'finding', finding: 'RIPPLE-1', failures: ['x'] }], unexplained: ['SWEEP-1'] })).fold();
    const fallback = formOf(dropped, { ...writerAnswer(), findings: [writerAnswer().findings[1]!] }).comments[0]!.body;
    includes(fallback, '**1. null dereference**\n\nMajor. CONFIRMED, traced through the code. deep-review would fix this against a written rule.\n\ndeep-review\'s writer did not explain this finding, so it is given in deep-review\'s own words: look at it yourself.\n\n**What goes wrong.** Finding 1 detail\n\n**What deep-review would do.** Guard the null before parse reads it.');
    includes(fallback, `Code at the reviewed head: [\`src/a.ts:4\`](${blob(head, 'src/a.ts', '4')}).`);
  });

  it('keeps on one line the text of a link to a path that holds a line break, a cited case\'s and a refuted candidate\'s, so neither opens a block of its own', () => {
    const said = writerAnswer();
    (said.findings[0] as ExplainedFinding).cases[0]!.lines.path = 'src/a.ts\n# x';
    const history = rewritten(run(), (kind, payload) => (kind === 'candidates.recorded' && payload.key === 'RIPPLE'
      ? { ...payload, candidates: (payload.candidates as Record<string, unknown>[]).map((entry) => (entry.id === 'RIPPLE-2' ? { ...entry, file: 'src/a.ts\n- y', inScope: false } : entry)) }
      : undefined));
    const broken = formOf(history.fold(), said);
    const text = [broken.body, ...broken.comments.map((entry) => entry.body)].join('\n');
    includes(text, '- [`src/a.ts # x:3-4`](');
    includes(broken.body, '- [`src/a.ts - y:9`](');
    assert.ok(!/^# x/m.test(text) && !/^- y/m.test(text), 'no line of a path starts a block');
  });
});

describe('the cleaning of what the review posts (R11)', () => {
  /** The history with RIPPLE-1's decided approach given as `approach`, a worker's words that the comment folds. */
  const withApproach = (approach: string): History => rewritten(run(), (kind, payload) => (kind === 'decisions.recorded'
    ? { ...payload, decisions: (payload.decisions as Record<string, unknown>[]).map((decided) => (decided.id === 'RIPPLE-1' ? { ...decided, fix: { ...(decided.fix as object), approach } } : decided)) }
    : undefined));

  it('cleans every worker\'s and the writer\'s text, counts the secrets where they are posted, and keeps a worker\'s marker off the last line', () => {
    const said = writerAnswer();
    said.conclusion.why = 'Read https://evil.example/x and [a link](https://evil.example) at /w/src/a.ts.';
    const form = formOf(withApproach('see /home/me/notes.txt and ghp_abcdefghijklmnopqrstuvwxyz0123, @octocat\n<!-- deep-review publication run-1 9 -->').fold(), said);
    const text = [form.body, ...form.comments.map((comment) => comment.body)].join('\n');
    assert.ok(!text.includes('/home/me'), 'no local path');
    assert.ok(!text.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'), 'no token');
    includes(form.comments[0]!.body, '\n\nSee \\<local path> and [redacted GitHub token], `@octocat` \\<!-- deep-review publication run-1 9 -->.\n\n');
    assert.equal(form.secrets, 1, 'the token is posted once, in the fold of the decided fix');
    includes(form.body, 'Read `https://evil.example/x` and \\[a link](`https://evil.example`) at src/a.ts.');
    assert.equal(lastLine(form.body), `<!-- ${publicationMarker('run-1', 1)} -->`);
    assert.equal(lastLine(form.comments[0]!.body), `<!-- ${findingMarker('run-1', 'RIPPLE-1')} -->`);
  });

  it('redacts a secret before it names an id of the run that a hyphen joins inside it, so a name splits no secret (R1 of the finding names in the review)', () => {
    const said = writerAnswer();
    said.conclusion.why = 'The key sk-ant-api03-abcdefghij-RIPPLE-1-klmnopqrstuvwxyz0123 leaked, and a RIPPLE-1-style guard stops it.';
    const form = formOf(run().fold(), said);
    includes(section(form.body, '### Summary'), 'The key \\[redacted Anthropic key] leaked, and a finding 1-style guard stops it.');
    assert.ok(!form.body.includes('klmnopqrstuvwxyz0123'), 'no part of the key');
    assert.equal(form.secrets - formOf(run().fold()).secrets, 1, 'the key is counted once');
  });

  it('cleans the runtime\'s version, the models and the excluded patterns that the settings name, and counts their secrets', () => {
    const token = `ghp_${'A1b2C3d4'.repeat(5)}`;
    const history = rewritten(run(), (kind, payload) => {
      if (kind === 'review.configured') return { ...payload, version: '2.1.283 @octocat', models: { strong: `/home/me/models/${token}`, fast: '@octocat' } };
      if (kind === 'scope.captured') return { ...payload, request: { ...(payload.request as object), exclude: [`x/${token}`, 'vendor/**'] }, excluded: { paths: ['vendor/a.js'], count: 1 } };
      return undefined;
    });
    const plain = formOf(run().fold());
    const form = formOf(history.fold());
    includes(form.body, '\nReviewed by deep-review 0.0.0+dev on claude 2.1.283 `@octocat` with \\<local path>[redacted GitHub token] and `@octocat`, run `run-1`, commits 11111111..22222222.\n');
    includes(form.body, '1 changed path under `x/[redacted GitHub token]` and `vendor/**` was left out');
    assert.ok(!form.body.includes(token), 'no token');
    assert.equal(form.secrets - plain.secrets, 2, 'the token in the path of the model and in the excluded pattern');
  });

  it('checks each diagram again once cleaned, and leaves out with a line one that its cleaning broke (R11, R19)', () => {
    const broken = answerWithArea('flowchart LR\n  A["x"] --> /tmp/x');
    const left = formOf(run().fold(), broken).body;
    includes(left, '\n\nA diagram is left out here, because cleaning it of secrets and of the places of the machine that ran this review broke it; the writer\'s answer on the machine that holds the run keeps it.\n');
    assert.ok(!left.includes('--> <local path>') && !left.includes('/tmp/x'), 'the broken diagram is not posted');
    const edge = answerWithArea('flowchart LR\n  A["x"] -- /tmp/x --> B["b"]');
    includes(formOf(run().fold(), edge).body, '```mermaid\nflowchart LR\n  A["x"] -- <local path> --> B["b"]\n```');
    const secret = answerWithArea(`flowchart LR\n  A["x"] -- ghp_${'a1B2'.repeat(9)} --> B["b"]`);
    assert.equal(formOf(run().fold(), secret).secrets - formOf(run().fold()).secrets, 1, 'a secret of a diagram left out is still counted');
  });

  it('fences each diagram longer than any run of backticks in it, so no diagram ends its fence (R19)', () => {
    const said = answerWithArea('flowchart LR\n  A["```js"] --> B["code"]\n```\n# a heading');
    includes(formOf(run().fold(), said).body, '````mermaid\nflowchart LR\n  A["```js"] --> B["code"]\n```\n# a heading\n````');
  });

  describe('keeps code that the form puts on one line or splits into paragraphs from turning into live text', () => {
    /** Each `<!--` that a backslash does not escape, which hides what follows it up to the next `-->`. */
    const commentOpeners = (text: string): number => text.match(/(?<!\\)<!--/g)?.length ?? 0;
    const markedLast = (form: PullRequestForm): void => {
      assert.equal(lastLine(form.body), `<!-- ${publicationMarker('run-1', 1)} -->`);
      assert.equal(commentOpeners(form.body), 1, 'the marker is the body\'s only comment');
      assert.equal(lastLine(form.comments[0]!.body), `<!-- ${findingMarker('run-1', 'RIPPLE-1')} -->`);
      assert.equal(commentOpeners(form.comments[0]!.body), 1, 'the marker is the comment\'s only comment');
    };

    it('a worker\'s fenced block, which the form joins onto one line', () => {
      const form = formOf(withApproach('~~~\n@octocat #12 <img src=x>\n~~~').fold());
      includes(form.comments[0]!.body, '\n\n\\~~~ `@octocat` `#12` \\<img src=x> ~~~.\n\n');
      markedLast(form);
    });

    it('a writer\'s code block at the start of a paragraph, which stays code on its one line', () => {
      const said = writerAnswer();
      (said.findings[0] as ExplainedFinding).problem = '```ts\n@Injectable() class X {} // see #12\n```';
      const form = formOf(run().fold(), said);
      includes(form.comments[0]!.body, '\n\n**What goes wrong.** ```ts @Injectable() class X {} // see #12 ```\n\n');
      markedLast(form);
    });

    it('a fence split at a blank line, whose second paragraph would open an HTML comment that hides the rest of the review', () => {
      const said = writerAnswer();
      said.conclusion.why = '~~~\nx\n\n<!--\n~~~';
      (said.findings[0] as ExplainedFinding).problem = '~~~\nx\n\n<!--\n~~~';
      const form = formOf(withApproach('~~~\nx\n\n<!--\n~~~').fold(), said);
      includes(form.body, '\\~~~ x\n\n\\<!-- ~~~\n\n');
      includes(form.comments[0]!.body, '\n\n**What goes wrong.** \\~~~ x\n\n\\<!-- ~~~\n\n');
      markedLast(form);
    });

    it('a diagram whose cleaned places join two runs of backticks into a line that would close a fence chosen before', () => {
      const said = answerWithArea('flowchart LR\n  A["a"]\n``/w/``\n  B["@octocat"]');
      const form = formOf(run().fold(), said);
      includes(form.body, '\n\n`````mermaid\nflowchart LR\n  A["a"]\n````\n  B["@octocat"]\n`````\n\n');
      markedLast(form);
    });
  });
});

describe('the fit of the review (TD5)', () => {
  const state = longFindingHistory().fold();
  /** The files of the pull request with lines 4 and 7 of `src/a.ts` added, or, `outside`, line 7 alone, so the fix on line 4 is in full in the body and does not grow its comment. */
  const filesOf = (outside: boolean): PullRequestFile[] => [{ path: 'src/a.ts', status: 'modified', previousPath: null, patch: outside ? '@@ -7,1 +7,1 @@\n-old 7\n+new 7' : '@@ -4,4 +4,4 @@\n-old 4\n+new 4\n line 5\n line 6\n-old 7\n+new 7' }];
  const limit = 60_000;
  const expectedCuts = [[], ['refuted'], ['refuted', 'left'], ['refuted', 'left', 'minor-table'], ['refuted', 'left', 'minor-table', 'area-diagrams']];
  const markedLast = (form: PullRequestForm): void => {
    assert.equal(lastLine(form.body), `<!-- ${publicationMarker('run-1', 1)} -->`);
    for (const comment of form.comments) assert.equal(lastLine(comment.body), `<!-- ${findingMarker('run-1', comment.finding)} -->`);
  };
  interface Samples { cuts: string[][]; forms: PullRequestForm[]; last: PullRequestForm | FormRefusal; boundaries: Boundary[] }
  const sampled = new Map<boolean, Samples>();
  /** Calibrate only padding length; the fixed cap and literal expected cut states remain independent oracles. */
  const samples = (diagram: boolean): Samples => {
    const known = sampled.get(diagram);
    if (known !== undefined) return known;
    const boundaries = sampleBoundaries((pad) => renderedOf(state, paddedAnswer(pad, diagram), filesOf(true)), limit, diagram ? expectedCuts : expectedCuts.slice(0, 4));
    const forms = boundaries.flatMap(({ below, at, above }) => [below, at, ...(above.kind === 'rendered' ? [above] : [])]);
    const cuts = forms.filter((form, index) => index === 0 || JSON.stringify(forms[index - 1]!.cuts) !== JSON.stringify(form.cuts)).map((form) => [...form.cuts]);
    const result = { cuts, forms, last: boundaries.at(-1)!.above, boundaries };
    sampled.set(diagram, result);
    return result;
  };

  it('cuts a body that does not fit in the order of TD5, one cut more at a time, and posts each under the limit', () => {
    const { cuts, forms } = samples(true);
    assert.deepEqual([...bodyCuts], ['refuted', 'left', 'minor-table', 'area-diagrams']);
    assert.deepEqual(cuts, expectedCuts);
    assert.equal(maxPostedLength, limit, 'the public posting cap is 60000 characters');
    for (const form of forms) assert.ok(form.body.length <= maxPostedLength, String(form.body.length));
    for (const form of forms) markedLast(form);
  });

  it('names each cut where it is made, and never cuts the core of the change, what needs a person, the areas or the findings in full', () => {
    const { forms } = samples(true);
    const cutTo = (count: number): string => forms.find((form) => form.cuts.length === count)!.body;
    for (const form of forms) includes(form.body, '### What this change does\n\ndeep-review has no account of this change, because an engine before the account reviewed it.\n\n### Summary');
    includes(cutTo(1), '- To fit the length GitHub takes, the candidate that the verifiers refuted is not listed here; the report of the run holds each with its evidence.');
    excludes(cutTo(1), '<details><summary>The refuted candidate</summary>');
    includes(cutTo(2), '### The findings left as is\n\nTo fit the length GitHub takes, the finding left as is is not listed here; the report of the run holds it.');
    includes(cutTo(3), 'To fit the length GitHub takes, the table of the minor findings is left out; each has its comment on its line or its text above, and the report of the run holds them all.');
    includes(cutTo(4), 'To fit the length GitHub takes, the diagrams of the areas are left out; the writer\'s answer on the machine that holds the run keeps them.');
    excludes(cutTo(4), `A["${'d'.repeat(1000)}"]`);
    for (const form of [...forms, ...samples(false).forms]) {
      includes(form.body, '### What needs a person');
      includes(form.body, '### The major findings');
      includes(form.body, '**Parsing an empty input.** What parse() does with an empty file.');
      includes(form.body, '- **[1. parse() reads the null before any guard.](#finding-1).**');
      includes(form.body, '### Finding 1: parse() reads the null before any guard.');
      markedLast(form);
    }
  });

  it('makes and names no cut that takes nothing from the body', () => {
    const { cuts } = samples(false);
    assert.deepEqual(cuts, expectedCuts.slice(0, 4));
  });

  it('refuses a body that does not fit after every cut, with its size and parts', () => {
    const { last } = samples(true);
    assert.equal(last.kind, 'refused');
    const { text, size, limit, parts } = last as FormRefusal;
    assert.deepEqual(text, { kind: 'body' });
    assert.ok(size > maxPostedLength);
    assert.equal(limit, maxPostedLength);
    assert.deepEqual(parts.map((part) => part.part), ['heading', 'core', 'summary', 'needs', 'not examined', 'how', 'areas', 'findings in full', 'minor', 'left as is', 'trust', 'last line']);
    assert.equal(parts.reduce((sum, part) => sum + part.size, 0) + 2 * (parts.length - 1), size, 'the parts and the blank lines between them make the body');
    assert.match(formRefusalWords(last as FormRefusal), /^the body of the review, after every cut, is \d+ characters, over the 60000 a review posts: heading \d+, core \d+, summary \d+, needs \d+/);
  });

  it('refuses a comment over the limit, with its size and parts', () => {
    const seed = formOf(state, paddedAnswer(1), filesOf(false));
    const atPad = 1 + limit - seed.comments.find((comment) => comment.finding === 'RIPPLE-1')!.body.length;
    assert.ok(atPad > 1 && atPad <= limit, 'the comment boundary has positive, bounded padding');
    for (const [offset, size] of [[-1, limit - 1], [0, limit]] as const) {
      const form = formOf(state, paddedAnswer(atPad + offset), filesOf(false));
      assert.equal(form.comments.find((comment) => comment.finding === 'RIPPLE-1')!.body.length, size);
      markedLast(form);
    }
    const refused = renderedOf(state, paddedAnswer(atPad + 1), filesOf(false)) as FormRefusal;
    assert.equal(refused.kind, 'refused');
    assert.equal(refused.size, limit + 1);
    assert.equal(refused.limit, limit);
    assert.deepEqual(refused.text, { kind: 'comment', finding: 'RIPPLE-1', path: 'src/a.ts', line: 4 });
    assert.deepEqual(refused.parts.map((part) => part.part), ['explanation', 'decision', 'checked', 'code']);
    assert.match(formRefusalWords(refused), /^the comment of RIPPLE-1 on src\/a\.ts:4 is \d+ characters, over the 60000 a review posts: explanation \d+, decision \d+, checked \d+, code \d+$/);
  });
});
