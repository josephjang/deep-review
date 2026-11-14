import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PullRequestFile } from '../../src/github/pull-request.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { diagramFailures } from '../../src/review/explanation-checks.ts';
import { findingsToExplain, type WriterAnswer } from '../../src/review/explanation.ts';
import { findingMarker, publicationMarker } from '../../src/review/markers.ts';
import { dryRunLines } from '../../src/review/publish.ts';
import { maxPostedLength, type PullRequestForm } from '../../src/review/pull-request-form.ts';
import { placeFindings } from '../../src/review/pull-request-view.ts';
import { pullRequestWordTables } from '../../src/review/pull-request-words.ts';
import type { History } from '../helpers/review-history.ts';
import { filesWith, formOf, pullRequestRun as run, pullRequestRunBeforeExplanation as runBeforeExplanation, renderedOf, rewritten, withSettings, writerAnswer, answerWithArea, sampleBoundaries, stepsOf, type Boundary, longFindingHistory, paddedAnswer, type WrittenFinding } from '../helpers/pull-request-review.ts';
import { answer, answerableDecisions, askDecision, candidate, decisions, explanation, withReportForm, worker } from '../helpers/review-history.ts';

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
  const ends = ['\n### ', '\n<a id="', '\nReviewed by: ', '\n리뷰한 엔진: '].map((end) => body.indexOf(end, from + heading.length)).filter((at) => at !== -1);
  return body.slice(from, ends.length === 0 ? undefined : Math.min(...ends));
};

/** The history with the ranking's findings and verdicts changed: `ranked` gives each finding of the ranking anew, `verdicts` each verdict of the first verification. */
const reranked = (history: History, ranked: (finding: Record<string, unknown>) => Record<string, unknown>, verdicts: (verdict: Record<string, unknown>) => Record<string, unknown> = (verdict) => verdict): History => rewritten(history, (kind, payload) => {
  if (kind === 'ranking.recorded') return { ...payload, findings: (payload.findings as Record<string, unknown>[]).map(ranked) };
  if (kind === 'verdicts.recorded' && payload.phase === 'verification') return { ...payload, verdicts: (payload.verdicts as Record<string, unknown>[]).map(verdicts) };
  return undefined;
});

/** An answer that kept no part. */
const empty: WriterAnswer = { core: null, conditions: null, summary: null, areas: null, findings: [], left: null, refuted: null, notExamined: null };

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
describe('the body of the review (R1 to R8 of the review in the writer\'s words)', () => {
  const form = formOf(run().fold());
  const { body } = form;

  it('puts first what a person must know and do and what the review did not examine, then how the review worked, the findings and how far to trust it, the marker last (R9 of the core of the change on the pull request)', () => {
    inOrder(body, [
      '## deep-review\'s review of this pull request\n\nHead: `22222222`. Merge base: `11111111`. Files changed: 1. After the review: no file changed.\n\n### What this change does',
      '### Summary',
      '### What needs a person',
      '### What this review did not examine',
      '### How the review worked',
      '### The major findings',
      '### Finding 2\n\nIn the words of deep-review\'s ranking: extract the helper',
      '### The minor findings',
      '### How far to trust this review',
      'Reviewed by: deep-review 0.0.0+dev. Runtime: claude 2.1.283. Models: opus, sonnet. Run: `run-1`. Commits: 11111111..22222222.',
    ]);
    assert.equal(lastLine(body), `<!-- ${publicationMarker('run-1', 1)} -->`, 'the marker of the publication is the very last line');
  });

  it('posts none of the sections the report form replaced, and no sentence that code built around a fact', () => {
    for (const gone of ['What this pull request does', 'For a reader new to this change', '### Findings\n', 'Before the merge:', 'The words of this review', 'Evidence that', '- Summary:', '- Reason:', '- Evidence:', '/files#diff-', 'The review keeps', 'deep-review would fix 1', 'Here 5 candidates', 'of the 2 findings is CONFIRMED']) excludes(body, gone);
  });

  it('names a finding by its number wherever a worker named it by id, in the review\'s language, and keeps the id in the trace line alone (R1, R4, R6 of the finding names in the review)', () => {
    const named = (language: string): PullRequestForm => {
      const answer = answerWithArea('flowchart LR\n  A["RIPPLE-1"] --> B["`SWEEP-1` waits"]');
      answer.summary = 'RIPPLE-1 crashes parse(), and `SWEEP-1` waits on its answer.';
      (answer.findings[0] as WrittenFinding).problem = 'A caller that passes an empty file meets a crash before SWEEP-1 can help.';
      return formOf(withSettings(run(), { 'review.language': language }, { 'review.language': 'repository' }).fold(), answer);
    };
    const en = named('en');
    includes(section(en.body, '### Summary'), 'Finding 1 crashes parse(), and finding 2 waits on its answer.');
    includes(en.body, 'A["Finding 1"] --> B["Finding 2 waits"]');
    const comment = en.comments.find((posted) => posted.body.includes('meets a crash before'))!.body;
    includes(comment, 'meets a crash before finding 2 can help.');
    includes(comment, '<sub>Finding: `RIPPLE-1`. Run: ');
    for (const text of [en.body, ...en.comments.map((posted) => posted.body.split('\n').filter((line) => !line.includes('<sub>') && !line.includes('<!--')).join('\n'))]) excludes(text, 'RIPPLE-1');
    includes(section(named('ko').body, '### 요약'), '지적 사항 1');
  });

  it('names an id before joining the lines of a worker\'s text, so a name that starts a list item or a paragraph is capitalized and one after a line break inside a sentence is not (R5 of the finding names in the review)', () => {
    const answer = writerAnswer();
    (answer.findings[0] as WrittenFinding).problem = 'Two causes:\n- RIPPLE-1 crashes parse.\n- SWEEP-1 waits.\n\n- SWEEP-1 waits too.\n\nThis waits on\nSWEEP-1 first.';
    const comment = formOf(run().fold(), answer).comments.find((posted) => posted.body.includes('Two causes:'))!.body;
    includes(comment, 'Two causes: - Finding 1 crashes parse. - Finding 2 waits.');
    includes(comment, '\n\n\\- Finding 2 waits too.\n\n');
    includes(comment, '\n\nThis waits on finding 2 first.');
  });

  it('gives the writer\'s summary, the findings by severity and by decision as a table, and the notice of what happens next with the command that applies the fixes', () => {
    assert.equal(section(body, '### Summary'), [
      '### Summary',
      '',
      'An empty input still crashes parse(), and the author must choose how parse treats one.',
      '',
      '| Findings | Critical | Major | Minor | To fix | To ask the author | Left as is |',
      '|---|---|---|---|---|---|---|',
      '| 2 | 0 | 1 | 1 | 1 | 1 | 0 |',
      '',
      'Nothing on this branch changes until the person who ran the review applies the fixes, and the answers given by then, in their clone with the command below, and pushes them. Command that applies the fixes: `deep-review review --pr 42 --fix`.',
      '',
    ].join('\n'));
  });

  it('lists what needs a person: a question with the writer\'s text or the decider\'s recorded words and its facts, a fix against a written rule with the writer\'s departure, then the notice and the one command that answers', () => {
    assert.equal(section(body, '### What needs a person'), [
      '### What needs a person',
      '',
      '- **Question: [Finding 2](#finding-2).** In the words of deep-review\'s decider: Should parse accept an empty input? Recommended option: 2. Option that stands until an answer: 1. Edits the code: no. Status: not answered.',
      `- **Fix against a written rule: [Finding 1](${blob(head, 'src/a.ts', '4')}).** The rule says each caller guards its own input; the fix guards it once in parse() instead, since every caller passes the same file. Status: stands.`,
      '',
      'The person who ran the review answers on the machine that holds the run, with the command below, and the fix pass then applies the answer. A reply on this pull request is not read yet. Command: `deep-review answer --run run-1 --finding <n>`. With one of: `--option <k>`, `--accept`, `--reject`.',
      '',
    ].join('\n'));
  });

  it('gives the facts that nothing needs a person, and that the run has no judgment of a public interface or a wide effect when its triage gave no account (R7 of the core of the change on the pull request)', () => {
    const quiet = formOf(run(decisions).fold(), { ...writerAnswer(), findings: [writerAnswer().findings[0]!] });
    assert.equal(section(quiet.body, '### What needs a person'), '### What needs a person\n\nQuestions: none. Fixes against a written rule: none. Reasons to look: not judged for this run.\n');
  });

  it('gives the answered question and departure as answered, with when, and no command', () => {
    const answered = formOf(run().add('answer.recorded', answer('SWEEP-1', 1)).add('answer.recorded', answer('RIPPLE-1', 'reject')).fold());
    const needs = section(answered.body, '### What needs a person');
    includes(needs, 'Recommended option: 2. Status: answered. Answered with option: 2. Answered on: ');
    includes(needs, 'Status: rejected, so the fix follows the rule. Answered on: ');
    excludes(needs, 'Command:');
  });

  it('gives the counts of how the review worked as a table, a diagram that passes the checks, and what each verdict and severity means', () => {
    const how = section(body, '### How the review worked');
    // Five candidates: RIPPLE-1 and RIPPLE-2 of the finders, a duplicate of the finders, SWEEP-1 and SWEEP-2 of the sweep; RIPPLE-2 refuted, SWEEP-2 merged into RIPPLE-1.
    includes(how, '| Candidates | After merging duplicates | Refuted | Kept | Joined another finding | Findings |\n|---|---|---|---|---|---|\n| 5 | 4 | 1 | 3 | 1 | 2 |');
    includes(how, '```mermaid\nflowchart TD\n  subgraph RV["review --pr 42, read-only: done"]');
    includes(how, '  A --> X["review --pr 42 --fix: fixers apply and test each fix"]\n```');
    includes(how, 'CONFIRMED means a verifier reproduced the problem by running it or traced the code path to the wrong result. PLAUSIBLE means');
    includes(how, 'A PLAUSIBLE finding marked unverified is one that no verifier examined');
    const diagram = /```mermaid\n([\s\S]*?)\n```/.exec(how)![1]!;
    assert.deepEqual(diagramFailures(diagram), []);
    for (const language of ['en', 'ko']) {
      const other = section(formOf(withSettings(run(), { 'review.language': language }, { 'review.language': 'repository' }).fold(), writerAnswer(), filesWith(), { fixPass: 'continued' }).body, pullRequestWordTables[language as 'en' | 'ko'].howHeading);
      assert.deepEqual(diagramFailures(/```mermaid\n([\s\S]*?)\n```/.exec(other)![1]!), [], language);
    }
  });

  it('gives each major finding that acts as one line in an area, with its facts and the writer\'s action: for an answer with no areas, one area under the label of the table, with no diagram', () => {
    assert.equal(section(body, '### The major findings'), [
      '### The major findings',
      '',
      '**The major findings that deep-review would fix or asks about.**',
      '',
      `- **[Finding 1](${blob(head, 'src/a.ts', '4')}).** parse() reads the null before any guard. Verdict: CONFIRMED. Decision: fix against a written rule. Guard the null before parse reads it.`,
      '',
    ].join('\n'));
  });

  it('gives a major question\'s line with the option it recommends, and says when no major finding acts', () => {
    const asked = formOf(run([askDecision('RIPPLE-1', false), decisions[1]]).fold());
    includes(section(asked.body, '### The major findings'), `- **[Finding 1](${blob(head, 'src/a.ts', '4')}).** parse() reads the null before any guard. Verdict: CONFIRMED. Decision: ask the author. Recommended option: 2.`);
    const left = formOf(run([{ ...decisions[0], decision: 'leave', fix: null, leave: { reason: 'intended', supersededBy: null } }, decisions[1]]).fold(), null);
    assert.equal(section(left.body, '### The major findings'), '### The major findings\n\nNo major finding asks for a fix or a question.\n');
  });

  it('gives a question with no writer\'s action the option it recommends as the decider\'s recorded words, in an area line and a minor row, as an older answer has none (R8 of the review in the writer\'s words)', () => {
    // An answer of version 1 to 3 is adapted with no action for a question.
    const older = (): WriterAnswer => {
      const said = writerAnswer();
      return { ...said, findings: [{ ...(said.findings[0] as WrittenFinding), action: null, fix: null, ask: null }] };
    };
    const major = formOf(run([askDecision('RIPPLE-1', false), decisions[1]]).fold(), older());
    includes(section(major.body, '### The major findings'), `- **[Finding 1](${blob(head, 'src/a.ts', '4')}).** parse() reads the null before any guard. Verdict: CONFIRMED. Decision: ask the author. Recommended option: 2. In the words of deep-review's decider: Accept it and return an empty result.\n`);
    const minor = formOf(run([decisions[0], askDecision('SWEEP-1', false)]).fold(), { ...older(), findings: [writerAnswer().findings[0]!, { ...(older().findings[0] as WrittenFinding), id: 'SWEEP-1', title: 'An empty input has no defined meaning' }] });
    includes(section(minor.body, '### The minor findings'), '| [Finding 2](#finding-2) | An empty input has no defined meaning | not given | PLAUSIBLE, unverified | In the words of deep-review\'s decider: Accept it and return an empty result. Recommended option: 2. |');
  });

  it('gives in full a finding that acts and has no line in the diff, with its anchor and its facts, and links it by the anchor', () => {
    includes(body, '<a id="finding-2"></a>\n\n### Finding 2\n\nIn the words of deep-review\'s ranking: extract the helper\n\nSeverity: minor. Verdict: PLAUSIBLE, unverified. Decision: ask the author. Its line: no place in the repository.');
    const outside = formOf(run().fold(), writerAnswer(), filesWith('@@ -1,1 +1,1 @@\n-a\n+b'));
    assert.deepEqual(outside.comments, []);
    includes(outside.body, '<a id="finding-1"></a>\n\n### Finding 1\n\n**parse() reads the null before any guard.**\n\nSeverity: major. Verdict: CONFIRMED. Checked by: tracing the code. Decision: fix against a written rule. Its line: not changed by this pull request.');
    includes(section(outside.body, '### The major findings'), '- **[Finding 1](#finding-1).**');
    includes(formOf(run().fold(), writerAnswer(), []).body, 'Decision: fix against a written rule. Its line: in a file this pull request does not change.');
    includes(formOf(run().fold(), writerAnswer(), filesWith(null)).body, 'Decision: fix against a written rule. Its line: in a file GitHub shows no diff of.');
  });

  it('folds the minor findings in a table after their counts as facts', () => {
    assert.equal(section(body, '### The minor findings'), [
      '### The minor findings',
      '',
      'Minor findings: 1. Reach what a user sees: 0. About the code alone: 0. Reach not given: 1. In a comment on their line: 0. Need a person: [Finding 2](#finding-2).',
      '',
      '<details><summary>The minor findings</summary>',
      '',
      '| # | Finding | Reaches | Verdict | What deep-review would do |',
      '|---|---|---|---|---|',
      '| [Finding 2](#finding-2) | In the words of deep-review\'s ranking: extract the helper | not given | PLAUSIBLE, unverified | In the words of deep-review\'s decider: Accept it and return an empty result. Recommended option: 2. |',
      '',
      '</details>',
      '',
    ].join('\n'));
  });

  it('counts a minor finding as about the code only when the writer gave it that reach, and those with no reach given apart, as their rows say, in each language', () => {
    // SWEEP-1 explained with the reach `kind` gives, or none.
    const minorOf = (language: 'en' | 'ko', kind: 'code' | null): string => {
      const said = writerAnswer();
      const sweep = { ...(said.findings[0] as WrittenFinding), id: 'SWEEP-1', kind, fix: null, ask: null };
      const history = withSettings(run([decisions[0], askDecision('SWEEP-1', false)]), { 'review.language': language }, { 'review.language': 'repository' });
      return section(formOf(history.fold(), { ...said, findings: [said.findings[0]!, sweep] }).body, pullRequestWordTables[language].minorHeading);
    };
    includes(minorOf('en', 'code'), '\nMinor findings: 1. Reach what a user sees: 0. About the code alone: 1. In a comment on their line: 0.');
    includes(minorOf('en', null), '\nMinor findings: 1. Reach what a user sees: 0. About the code alone: 0. Reach not given: 1. In a comment on their line: 0.');
    includes(minorOf('en', null), '| [Finding 2](#finding-2) | parse() reads the null before any guard. | not given |');
    includes(minorOf('ko', 'code'), '\nminor 지적 사항: 1. 사용자가 보는 것에 닿음: 0. 코드에만 관한 것: 1. 해당 줄의 댓글에 있음: 0.');
    includes(minorOf('ko', null), '\nminor 지적 사항: 1. 사용자가 보는 것에 닿음: 0. 코드에만 관한 것: 0. 닿는 곳을 정하지 않음: 1. 해당 줄의 댓글에 있음: 0.');
    includes(minorOf('ko', null), ' | 정하지 않음 | ');
  });

  it('marks a minor row of a fix against a written rule with that decision as data, as the area lines do, and no other fix\'s row (R5 of the review in the writer\'s words)', () => {
    const minorOf = (decided: readonly unknown[]): string => section(formOf(reranked(run(decided), (finding) => (finding.id === 'RIPPLE-1' ? { ...finding, severity: 'minor' } : finding)).fold(), writerAnswer(), []).body, '### The minor findings');
    const against = minorOf(answerableDecisions());
    includes(against, '| [Finding 1](#finding-1) | parse() reads the null before any guard. | not given | CONFIRMED | Guard the null before parse reads it. Decision: fix against a written rule. |');
    includes(against, '| In the words of deep-review\'s decider: Accept it and return an empty result. Recommended option: 2. |');
    const plain = minorOf(answerableDecisions(decisions[0] as Record<string, unknown>));
    includes(plain, '| [Finding 1](#finding-1) | parse() reads the null before any guard. | not given | CONFIRMED | Guard the null before parse reads it. |');
    excludes(plain, 'Decision:');
  });

  it('folds the findings left as is, each with its facts, the reason of the closed list and the decider\'s grounds as recorded words where the writer gave no reason', () => {
    const left = formOf(run(decisions).fold(), { ...writerAnswer(), findings: [writerAnswer().findings[0]!] });
    includes(left.body, '### The findings left as is\n\n<details><summary>The findings left as is</summary>\n\n<a id="finding-2"></a>\n\n**Finding 2**\n\nIn the words of deep-review\'s ranking: extract the helper\n\nSeverity: minor. Verdict: PLAUSIBLE, unverified. Decision: leave as is. Reason: outside the change, and not a regression.\n\n**Why deep-review leaves it.** In the words of deep-review\'s decider: The helper would edit only lines the change does not touch.\n\n</details>');
    excludes(left.body, '### The minor findings');
    const written = formOf(run(decisions).fold(), { ...writerAnswer(), findings: [writerAnswer().findings[0]!], left: [{ id: 'SWEEP-1', title: 'A helper repeats a parse', why: 'It sits outside the change.' }] });
    includes(written.body, '**Finding 2**\n\n**A helper repeats a parse**\n\nSeverity: minor.');
    includes(written.body, '**Why deep-review leaves it.** It sits outside the change.');
    // A finding left as is takes no answer and no fix, so its record carries no notice that they apply its words.
    includes(written.body, '**Why deep-review leaves it.** It sits outside the change.\n\n<details><summary>The decision as deep-review recorded it</summary>\n\nIn the words of deep-review\'s decider:\n- Grounds: The helper would edit only lines the change does not touch.\n\n</details>');
  });

  it('gives what the run did not examine: the writer\'s text, no check, each gap as facts under the label of its kind, and the refuted candidates folded, each with its line and the finder\'s recorded words where the writer gave none', () => {
    assert.equal(section(formOf(run().fold(), { ...writerAnswer(), notExamined: 'One review pass did not run, so a footgun of the change could be missed.' }).body, '### What this review did not examine'), [
      '### What this review did not examine',
      '',
      'One review pass did not run, so a footgun of the change could be missed.',
      '',
      '- Checks run in this review: none.',
      '- A review pass that did not run: `FOOTGUNS`.',
      `- Findings no verifier examined: [Finding 2](#finding-2). Findings with a merged candidate no verifier examined: [Finding 1](${blob(head, 'src/a.ts', '4')}).`,
      '- Candidates the verifiers refuted: 1.',
      '',
      '<details><summary>The refuted candidates</summary>',
      '',
      `- [\`src/a.ts:9\`](${blob(head, 'src/a.ts', '9')}): In the words of the finder: a stale cache entry after logout. Evidence: the report of the run.`,
      '',
      '</details>',
      '',
    ].join('\n'));
  });

  it('links each finding of an unverified gap once and in ascending order, however many of its candidates were merged into it', () => {
    // SWEEP-3 joins SWEEP-2 in RIPPLE-1 (finding 1) and SWEEP-4 joins SWEEP-1 (finding 2), all four in the group no verifier examined.
    const history = rewritten(run(), (kind, payload) => {
      if (kind === 'candidates.recorded' && payload.key === 'sweep') return { ...payload, candidates: [...(payload.candidates as unknown[]), candidate('SWEEP-3', 'SCAN', { line: 7, rawLine: 7 }), candidate('SWEEP-4', 'SCAN', { line: 7, rawLine: 7 })] };
      if (kind === 'verification.planned' && payload.phase === 'sweep-verification') return { ...payload, groups: [{ id: 'g1', candidateIds: ['SWEEP-4', 'SWEEP-2', 'SWEEP-1', 'SWEEP-3'] }] };
      if (kind === 'ranking.recorded') return { ...payload, findings: (payload.findings as { id: string }[]).map((finding) => ({ ...finding, members: finding.id === 'RIPPLE-1' ? ['SWEEP-2', 'SWEEP-3'] : ['SWEEP-4'] })) };
      return undefined;
    });
    includes(section(formOf(history.fold()).body, '### What this review did not examine'), `- Findings no verifier examined: [Finding 2](#finding-2). Findings with a merged candidate no verifier examined: [Finding 1](${blob(head, 'src/a.ts', '4')}), [Finding 2](#finding-2).\n`);
  });

  it('gives the patterns that left paths out, with their count and the layer that set them, as facts', () => {
    const history = rewritten(withSettings(run(), { 'scope.exclude': ['*.lock', 'vendor/**'] }, { 'scope.exclude': 'repository' }), (kind, payload) => (kind === 'scope.captured'
      ? { ...payload, request: { ...(payload.request as object), exclude: ['*.lock', 'vendor/**'] }, excluded: { paths: ['a.lock', 'vendor/x.js', 'vendor/y.js'], count: 3 } }
      : undefined));
    includes(section(formOf(history.fold()).body, '### What this review did not examine'), '\n- Changed paths left out by `scope.exclude`: 3. Patterns: `*.lock`, `vendor/**`. Set by: the repository\'s file.\n');
  });

  it('gives how far to trust the review as tables of the verdicts and of how the findings were checked, the candidates, the notice that a model wrote the sentences, and the parts the writer\'s answer lacks', () => {
    assert.equal(section(body, '### How far to trust this review'), [
      '### How far to trust this review',
      '',
      '| Verdict | Findings | Of them major | Of the major, reproduced by running | Of them unverified |',
      '|---|---|---|---|---|',
      '| CONFIRMED | 1 | 1 | 0 | 0 |',
      '| PLAUSIBLE | 1 | 0 |  | 1 |',
      '',
      '| Checked by | Findings |',
      '|---|---|',
      '| tracing the code | 1 |',
      '| no basis on record | 1 |',
      '',
      'Candidates: 5. Refuted: 1.',
      '',
      'A model wrote the sentences of this review from the verifiers\' evidence, which the report of the run holds, and from deep-review\'s decisions; only that evidence was verified. The tables and the labeled values are deep-review\'s own record, and where a sentence differs from them, the tables and values stand.',
      '',
      'Parts of the writer\'s answer this review lacks: the core of the change, the areas, the refuted candidates, what the review did not examine, [Finding 2](#finding-2).',
      '',
    ].join('\n'));
  });

  it('gives how many of the major CONFIRMED findings were reproduced by running them, in each language (R5 of the review in the writer\'s words)', () => {
    const ranAs = (change: Record<string, unknown>): History => rewritten(run(), (kind, payload) => (kind === 'verdicts.recorded' && payload.phase === 'verification'
      ? { ...payload, verdicts: (payload.verdicts as Record<string, unknown>[]).map((verdict) => (verdict.id === 'RIPPLE-1' ? { ...verdict, basis: 'ran', runs: [{ command: 'node /tmp/x/probe.mjs', printed: ['TypeError: null'], probe: null, at: 3, exitCode: 1 }], ...change } : verdict)) }
      : undefined));
    const ranHistory = ranAs({});
    includes(section(formOf(ranHistory.fold()).body, '### How far to trust this review'), '| CONFIRMED | 1 | 1 | 1 | 0 |\n| PLAUSIBLE | 1 | 0 |  | 1 |');
    // A finding reproduced by running that is not CONFIRMED is no major CONFIRMED one reproduced by running, though the table of how the findings were checked counts it.
    const plausibleRan = section(formOf(ranAs({ verdict: 'PLAUSIBLE' }).fold()).body, '### How far to trust this review');
    includes(plausibleRan, '| CONFIRMED | 0 | 0 | 0 | 0 |\n| PLAUSIBLE | 2 | 1 |  | 1 |');
    includes(plausibleRan, '| running it | 1 |');
    const words = pullRequestWordTables.ko;
    const ko = section(formOf(withSettings(ranHistory, { 'review.language': 'ko' }, { 'review.language': 'repository' }).fold()).body, words.trustHeading);
    includes(ko, `| ${words.verdictColumns.verdict} | ${words.verdictColumns.findings} | ${words.verdictColumns.major} | ${words.verdictColumns.majorRan} | ${words.verdictColumns.unverified} |`);
    includes(ko, '| CONFIRMED | 1 | 1 | 1 | 0 |');
  });

  it('links every piece of code at the reviewed head, or at the merge base for removed lines, and never into the diff', () => {
    const text = [body, ...form.comments.map((comment) => comment.body)].join('\n');
    const links = [...text.matchAll(/\]\((https?:[^)]+)\)/g)].map((match) => match[1]!);
    assert.ok(links.length >= 4, links.join('\n'));
    for (const link of links) assert.match(link, new RegExp(`^https://github\\.com/octo/parse/blob/(?:${head}|${base})/`), link);
    assert.deepEqual(links.filter((link) => link.includes(`/blob/${base}/`)), [blob(base, 'src/gone.ts', '2')], 'only the case on removed lines is at the merge base');
  });

  it('gives the recorded words of the other workers for each part the writer dropped, names each part, and gives a run with no explanation its notice', () => {
    const dropped = run(answerableDecisions(), explanation(worker(60), { dropped: [{ part: 'conclusion', failures: ['x'] }, { part: 'finding', finding: 'RIPPLE-1', failures: ['x'] }], unexplained: ['SWEEP-1'] })).fold();
    const fallback = formOf(dropped, { ...empty, findings: [writerAnswer().findings[1]!] });
    includes(fallback.body, `- **[Finding 1](${blob(head, 'src/a.ts', '4')}).** In the words of deep-review's ranking: null dereference. Verdict: CONFIRMED. Decision: fix against a written rule. In the words of deep-review's decider: Guard the null once, before parse reads it.`);
    includes(section(fallback.body, '### How far to trust this review'), `Parts of the writer's answer this review lacks: the core of the change, the summary, the areas, the refuted candidates, what the review did not examine, [Finding 1](${blob(head, 'src/a.ts', '4')}), [Finding 2](#finding-2).`);
    const none = formOf(runBeforeExplanation().fold(), null);
    includes(none.body, 'deep-review recorded no explanation by its writer for this run, so the review gives the record and the other workers\' own words.');
    excludes(none.body, 'A model wrote the sentences');
    excludes(none.body, 'Parts of the writer\'s answer');
    excludes(none.comments[0]!.body, 'did not explain this finding');
  });

  it('gives the notice that a model wrote the sentences only when the review posts some text of the writer, whatever answer it froze (R7 of the review in the writer\'s words)', () => {
    const trustOf = (state: RunState, answer: WriterAnswer): string => section(formOf(state, answer).body, '### How far to trust this review');
    // A writer that completed its unit has its answer frozen, even with every part dropped.
    const nothingKept = run(answerableDecisions(), explanation(worker(60), { dropped: [{ part: 'conclusion', failures: ['x'] }, { part: 'finding', finding: 'RIPPLE-1', failures: ['x'] }, { part: 'finding', finding: 'SWEEP-1', failures: ['x'] }] })).fold();
    excludes(trustOf(nothingKept, empty), 'A model wrote the sentences');
    // With its areas dropped the summary, which names them, is not shown.
    const summaryOnly = withReportForm(run(answerableDecisions(), explanation(worker(60), { dropped: [{ part: 'areas', failures: ['x'] }, { part: 'refuted', failures: ['x'] }, { part: 'finding', finding: 'RIPPLE-1', failures: ['x'] }, { part: 'finding', finding: 'SWEEP-1', failures: ['x'] }] }))).fold();
    excludes(trustOf(summaryOnly, { ...empty, summary: 'A summary.' }), 'A model wrote the sentences');
    includes(trustOf(nothingKept, { ...empty, summary: 'A summary.' }), 'A model wrote the sentences');
    includes(trustOf(nothingKept, { ...empty, refuted: [{ id: 'RIPPLE-2', claim: 'A cache entry outlives a logout.', why: 'Logout clears the cache first.' }] }), 'A model wrote the sentences');
    includes(trustOf(nothingKept, { ...empty, notExamined: 'Nothing was left out.' }), 'A model wrote the sentences');
  });

  it('says in the notice, in each language, that the tables and labeled values are the record and stand where a sentence differs, not that every count is (R7)', () => {
    const stands = { en: 'where a sentence differs from them, the tables and values stand', ko: '문장이 그와 다를 때는 표와 값이 기준입니다' } as const;
    for (const language of ['en', 'ko'] as const) {
      const words = pullRequestWordTables[language];
      const history = withSettings(run(answerableDecisions(), explanation(worker(60))), { 'review.language': language }, { 'review.language': 'repository' });
      const trust = section(formOf(withReportForm(history).fold(), writerAnswer()).body, words.trustHeading);
      includes(trust, words.modelNotice);
      includes(words.modelNotice, stands[language]);
    }
    excludes(pullRequestWordTables.en.modelNotice, 'Every count');
    excludes(pullRequestWordTables.ko.modelNotice, '모든 수');
  });

  it('names each part of the writer\'s answer that the checks dropped, in each language', () => {
    for (const language of ['en', 'ko'] as const) {
      const words = pullRequestWordTables[language];
      const history = withSettings(run(answerableDecisions(), explanation(worker(60), { dropped: [{ part: 'areas', failures: ['x'] }], unexplained: ['SWEEP-1'] })), { 'review.language': language }, { 'review.language': 'repository' });
      const trust = section(formOf(withReportForm(history).fold(), { ...writerAnswer(), areas: null, refuted: null }).body, words.trustHeading);
      includes(trust, `${words.missingLabel}: ${words.writerParts.core}, ${words.writerParts.summary}, ${words.writerParts.areas}, `);
    }
  });

  it('names the findings answered after the writer wrote', () => {
    const answered = formOf(run().add('answer.recorded', answer('SWEEP-1', 1)).add('answer.recorded', answer('RIPPLE-1', 'reject')).fold());
    includes(answered.body, `Answered after the writer wrote: [Finding 1](${blob(head, 'src/a.ts', '4')}), [Finding 2](#finding-2).`);
    includes(answered.comments[0]!.body, 'Status: rejected, so the fix follows the rule. Answered on: ');
    excludes(answered.body, '--option <k>`');
  });
});

// R6 of the review of a fix run: the review of a run that went on into its fix pass says what followed the review, and names --fix nowhere.
describe('the review of a run continued into its fix pass (R6 of the review of a fix run)', () => {
  /** The form of `state` as publish renders a run that went on into its fix pass. */
  const continued = (state: RunState = run().fold()): PullRequestForm => formOf(state, writerAnswer(), filesWith(), { fixPass: 'continued' });
  /** The body and every comment of a form, as one text. */
  const textOf = (form: PullRequestForm): string => [form.body, ...form.comments.map((comment) => comment.body)].join('\n');
  const { body, comments } = continued();

  it('gives as data that the run went on into its fix pass, with the notice that its edits are not part of the review and reach the branch only when pushed', () => {
    includes(body, '## deep-review\'s review of this pull request\n\nHead: `22222222`. Merge base: `11111111`. Files changed: 1. After the review: the run went on into its fix pass.\n\nThe fix pass ran on the machine of the person who ran the review.');
    includes(section(body, '### Summary'), 'What the fix pass changes reaches this branch only when the person who ran the review pushes it.');
    excludes(body, 'no file changed');
    excludes(body, 'Nothing on this branch changes until');
  });

  it('gives the notice that the fix pass sets out to make a departure as decided and that a rejection sends it back to a fixer', () => {
    includes(comments[0]!.body, 'Once the fix pass of the run has ended, the person who ran the review accepts or rejects this departure on the machine that holds the run; the fix pass sets out to make the fix as decided, and a rejection sends the finding back to a fixer. Command to accept: `deep-review answer --run run-1 --finding 1 --accept`. Command to reject: `deep-review answer --run run-1 --finding 1 --reject`.');
    includes(comments[0]!.body, 'Decision: fix against a written rule.');
  });

  it('gives the notice that the command that answers a question applies the answer once the fix pass has ended', () => {
    includes(body, 'Once the fix pass of the run has ended, the person who ran the review answers on the machine that holds the run, with the command below, which applies the answer. A reply on this pull request is not read yet. Command: `deep-review answer --run run-1 --finding 2 --option <k>`.');
  });

  it('draws the review done and the fix pass started on that machine, and gives the notice that no check ran in the review and where the checks of the fix pass are', () => {
    const how = section(body, '### How the review worked');
    includes(how, '```mermaid\nflowchart TD\n  subgraph RV["review --pr 42, read-only: done"]');
    includes(how, '  W --> X["The fix pass started on the machine that ran the review, and once it ends, its report there holds what it changed"]\n  W --> P["publish cleans the text and posts this review"]\n  P --> A["The person who ran the review answers the questions"]\n```');
    includes(section(body, '### What this review did not examine'), '- No check ran in this review. The fix pass that followed runs the repository\'s checks on the machine that ran it, and once it ends, its report there holds their results.');
  });

  it('takes each of those notices from the table of the run\'s language, and names --fix nowhere, in the body or a comment, in each language', () => {
    for (const [language, words] of Object.entries(pullRequestWordTables)) {
      const text = textOf(continued(withSettings(run(), { 'review.language': language }, { 'review.language': 'repository' }).fold()));
      excludes(text, '--fix');
      for (const part of [words.afterValues.continued, words.continuedNotice, words.nextNotices.continued, words.departureNotices.continued, words.answerNotices.continued, words.diagram.continued, words.noCheckContinued]) includes(text, part);
      for (const readOnly of [words.afterValues['to-come'], words.nextNotices['to-come'], words.departureNotices['to-come'], words.answerNotices['to-come']]) excludes(text, readOnly);
    }
  });
});

describe('the parts of the writer\'s answer and of the verifiers\' notes (R2 to R5, R7 of the review in the writer\'s words)', () => {
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

  it('says how the verifier checked a finding in the writer\'s line, not in the notice of its basis', () => {
    const said = writerAnswer();
    (said.findings[0] as WrittenFinding).checked = 'A probe passed an empty file and parse() threw.';
    const comment = formOf(run().fold(), said).comments[0]!.body;
    includes(comment, '<details><summary>How the verifier checked it</summary>\n\nA probe passed an empty file and parse() threw.\n\n</details>');
  });

  it('gives a refuted candidate the writer\'s claim and why it was refuted', () => {
    const body = formOf(run().fold(), { ...writerAnswer(), refuted: [{ id: 'RIPPLE-2', claim: 'A cache entry outlives a logout.', why: 'Logout clears the cache first.' }] }).body;
    includes(body, 'A cache entry outlives a logout. **Why it was refuted.** Logout clears the cache first.');
    excludes(body, 'Evidence: the report of the run.');
  });

  it('says why a verdict is PLAUSIBLE in the writer\'s words beside the verifier\'s kind as a fact, or the verifier\'s reason and its kind as recorded words', () => {
    const state = withVerdict(run().fold(), 'RIPPLE-1', { verdict: 'PLAUSIBLE', unconfirmed: { kind: 'choice', text: 'which of the two guards to keep' } });
    includes(formOf(state).comments[0]!.body, '**Why it is not CONFIRMED.** Why PLAUSIBLE: a choice that remains. In the words of its verifier: which of the two guards to keep.');
    const said = writerAnswer();
    (said.findings[0] as WrittenFinding).unconfirmed = 'Two guards would each do, and the code does not say which the author means.';
    const written = formOf(state, said).comments[0]!.body;
    includes(written, '**Why it is not CONFIRMED.** Two guards would each do, and the code does not say which the author means. Why PLAUSIBLE: a choice that remains.\n');
    excludes(written, 'which of the two guards to keep');
    const fact = formOf(withVerdict(run().fold(), 'RIPPLE-1', { verdict: 'PLAUSIBLE', unconfirmed: { kind: 'fact', text: 'whether a caller passes null' } }), said).comments[0]!.body;
    includes(fact, 'which the author means. Why PLAUSIBLE: a fact not settled.\n');
    // A verdict recorded before verifiers gave their reason has no kind to show beside the writer's text.
    const before = formOf(withVerdict(run().fold(), 'RIPPLE-1', { verdict: 'PLAUSIBLE', unconfirmed: null }), said).comments[0]!.body;
    includes(before, '**Why it is not CONFIRMED.** Two guards would each do, and the code does not say which the author means.\n');
    excludes(before, 'Why PLAUSIBLE:');
  });

  it('gives a question in the writer\'s words: what it asks, the question, each option\'s meaning, cost and rule in a table, and why deep-review recommends its option, with the decider\'s words folded', () => {
    const said = writerAnswer();
    said.findings[1] = {
      id: 'SWEEP-1', unexplained: false, title: 'An empty input has no defined meaning', problem: 'A caller cannot tell what parse() does with an empty file.', cases: [], diagram: null, checked: null, kind: 'code',
      action: 'deep-review asks whether an empty input is an error, and recommends that it is not.', unconfirmed: null, fix: null,
      ask: { question: 'Is an empty file an error? The repository does not say.', options: [{ number: 1, means: 'parse() throws.', cost: 'Callers must catch it.', rule: 'Empty input is an error.' }, { number: 2, means: 'parse() returns an empty result.', cost: 'An empty file passes unnoticed.', rule: 'Empty input is valid.' }], recommendation: 'An empty file is common, and a throw breaks callers that never expected one.' },
    };
    const full = section(formOf(run().fold(), said).body, '### Finding 2');
    inOrder(full, [
      '**An empty input has no defined meaning**',
      'Severity: minor. Verdict: PLAUSIBLE, unverified. Decision: ask the author. Its line: no place in the repository.',
      '**What goes wrong.** A caller cannot tell what parse() does with an empty file.',
      '**What deep-review asks.** deep-review asks whether an empty input is an error, and recommends that it is not.',
      '**The question.** Is an empty file an error? The repository does not say.',
      '| Option | What it means | What it costs | The rule from then on | Edits the code |\n|---|---|---|---|---|\n| 1 | parse() throws. | Callers must catch it. | Empty input is an error. | no |\n| 2 | parse() returns an empty result. | An empty file passes unnoticed. | Empty input is valid. | yes |',
      'Recommended option: 2. Option that stands until an answer: 1. Edits the code: no. Status: not answered.',
      '**Why deep-review recommends it.** An empty file is common, and a throw breaks callers that never expected one.',
      'Command: `deep-review answer --run run-1 --finding 2 --option <k>`.',
      '<details><summary>The decision as deep-review recorded it</summary>',
      '- Option 1: Keep accepting it. Cost: Callers that pass one now see the change. Rule: Parse rejects an empty input.',
      '- Grounds: Nothing in the repository states which behavior is meant.',
    ]);
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

  it('lists a finding left as is whose verifier named a choice only with the findings left as is, and shows the choice there as the verifier\'s, which deep-review did not settle (R4; PD8, PD7 of the settled choice)', () => {
    const state = withVerdict(run([leftIntended, decisions[1]]).fold(), 'RIPPLE-1', { authorChoice: choice });
    const body = formOf(state).body;
    excludes(section(body, '### What needs a person'), 'Finding 1');
    inOrder(leftOf(body), ['**Finding 1**', 'Reason: intended, as the repository states.', 'Code at the reviewed head: ', `- Choice its verifier left to the author: ${choice} Settled as: not settled by deep-review`]);
  });

  it('gives a finding left as is no text in full, since it asks no person to act (PD7 of the settled choice)', () => {
    const state = withVerdict(run([leftIntended, decisions[1]]).fold(), 'RIPPLE-1', { authorChoice: choice });
    const asked = findingsToExplain(state.review!);
    assert.equal(asked.length, 0);
    const body = formOf(state, { ...writerAnswer(), findings: [] }).body;
    excludes(body, '### Finding 1');
    includes(leftOf(body), '<a id="finding-1"></a>');
  });

  it('gives the notice that nothing needs to change when every finding is left as is, whatever their verifiers named (PD7 of the settled choice)', () => {
    const withChoice = withVerdict(run([leftIntended, decisions[1]]).fold(), 'RIPPLE-1', { authorChoice: choice });
    for (const state of [withChoice, run([leftIntended, decisions[1]]).fold()]) includes(section(formOf(state, { ...writerAnswer(), findings: [] }).body, '### Summary'), 'deep-review asks for no change, so nothing on this branch needs to change.');
  });

  it('shows the choice that a PLAUSIBLE member names beside a finding left as is whose CONFIRMED primary names none (R4 of the settled choice)', () => {
    const folded = run([leftIntended, decisions[1]]).fold();
    const primary = folded.review!.candidates['RIPPLE-1']!.verdict!;
    const state = withVerdict({ ...folded, review: { ...folded.review!, candidates: { ...folded.review!.candidates, 'SWEEP-2': { ...folded.review!.candidates['SWEEP-2']!, verdict: primary } } } }, 'SWEEP-2', { verdict: 'PLAUSIBLE', evidence: 'line 7 reads the value. Not CONFIRMED: one caller.', unconfirmed: { kind: 'choice', text: 'whether an empty file is an error' }, authorChoice: choice });
    assert.equal(primary.authorChoice, null);
    includes(leftOf(formOf(state).body), `Choice its verifier left to the author: ${choice} Settled as: not settled by deep-review`);
  });

  it('shows beside a finding left as is the choice its decision settles, the step in the review\'s words and its source, after the verifier\'s choice, and the steps as facts (R4, PD8 of the settled choice)', () => {
    const state = withDecision(withVerdict(run([leftIntended, decisions[1]]).fold(), 'RIPPLE-1', { authorChoice: choice }), 'RIPPLE-1', { settled: [settled] });
    const left = leftOf(formOf(state).body);
    includes(left, `- Choice its verifier left to the author: ${choice} Settled as: Parse keeps returning null on an empty file. Choices settled by: what the repository states. Source: The documentation of parse says that an empty file gives null.`);
    includes(left, 'Choices settled by: what the repository states.\n');
    const unnamed = withDecision(run([leftIntended, decisions[1]]).fold(), 'RIPPLE-1', { leave: { reason: 'settled', supersededBy: null }, settled: [{ ...settled, for: [], by: 'shape' }] });
    const shape = leftOf(formOf(unnamed).body);
    includes(shape, 'Reason: a choice of shape, settled in favor of the code as it is.');
    includes(shape, '- Settled as: Parse keeps returning null on an empty file. Choices settled by: the shape the code around it already uses, or else the one that adds less.');
    excludes(leftOf(formOf(run([leftIntended, decisions[1]]).fold()).body), 'Settled as');
  });

  it('shows in a fix\'s comment, after what deep-review would do, the steps that settled its choices, and in the folded record the choice beside the verifier\'s (R5, PD8 of the settled choice)', () => {
    const settledFix = withDecision(withVerdict(run().fold(), 'RIPPLE-1', { authorChoice: choice }), 'RIPPLE-1', { settled: [{ ...settled, by: 'intent' }] });
    inOrder(formOf(settledFix).comments[0]!.body, ['**What deep-review would do.**', 'Choices settled by: the stated intent of the change.', '**Against a written rule.**', '<details><summary>The decision as deep-review recorded it</summary>', `- Choice its verifier left to the author: ${choice} Settled as: Parse keeps returning null on an empty file. Choices settled by: the stated intent of the change.`]);
    includes(formOf(withVerdict(run().fold(), 'RIPPLE-1', { authorChoice: choice })).comments[0]!.body, `- Choice its verifier left to the author: ${choice} Settled as: not settled by deep-review`);
    excludes(formOf(run().fold()).comments[0]!.body, 'Settled as');
  });

  /** The state with SWEEP-2, the member of RIPPLE-1, verified CONFIRMED and naming its own choice beside RIPPLE-1's. */
  const otherChoice = 'Whether the helper at line 7 guards the null too, or leaves it to its callers.';
  const withTwoChoices = (state: RunState): RunState => {
    const named = withVerdict(state, 'RIPPLE-1', { authorChoice: choice });
    const primary = named.review!.candidates['RIPPLE-1']!.verdict!;
    return withVerdict({ ...named, review: { ...named.review!, candidates: { ...named.review!.candidates, 'SWEEP-2': { ...named.review!.candidates['SWEEP-2']!, unverified: false, verdict: primary } } } }, 'SWEEP-2', { evidence: 'line 7 reads the null too', authorChoice: otherChoice });
  };
  const helperSettled = { for: ['SWEEP-2'], choice: 'The helper guards the null too.', by: 'scope', source: 'The helper is new in this change.' };

  it('shows each choice of a merged finding beside the settled choice that answers it, an item each, and each it does not settle as not settled (PD9 of the settled choice)', () => {
    const left = leftOf(formOf(withDecision(withTwoChoices(run([leftIntended, decisions[1]]).fold()), 'RIPPLE-1', { settled: [settled, { ...helperSettled, by: 'intent' }] })).body);
    inOrder(left, [`- Choice its verifier left to the author: ${choice} Settled as: Parse keeps returning null on an empty file.`, `- Choice its verifier left to the author: ${otherChoice} Settled as: The helper guards the null too.`]);
    excludes(left, 'not settled by deep-review');
    const partly = formOf(withDecision(withTwoChoices(run().fold()), 'RIPPLE-1', { settled: [helperSettled] })).comments[0]!.body;
    inOrder(partly, [`- Choice its verifier left to the author: ${otherChoice} Settled as: The helper guards the null too. Choices settled by: keeping the fix to the part inside the change.`, `- Choice its verifier left to the author: ${choice} Settled as: not settled by deep-review`]);
  });

  it('gives one settlement of several verifiers\' choices as its item, with each choice an item nested under it, in the record of a fix and beside a finding left as is (PD9 of the settled choice)', () => {
    const both = { ...settled, for: ['RIPPLE-1', 'SWEEP-2'] };
    const nested = [
      '- Settled as: Parse keeps returning null on an empty file. Choices settled by: what the repository states. Source: The documentation of parse says that an empty file gives null.',
      `  - Choice its verifier left to the author: ${choice}`,
      `  - Choice its verifier left to the author: ${otherChoice}`,
    ].join('\n');
    const fix = formOf(withDecision(withTwoChoices(run().fold()), 'RIPPLE-1', { settled: [both] })).comments[0]!.body;
    includes(fix, `- Grounds: Parse reads the null on an empty input, at lines 4 and 7.\n${nested}\n\n</details>`);
    const left = leftOf(formOf(withDecision(withTwoChoices(run([leftIntended, decisions[1]]).fold()), 'RIPPLE-1', { settled: [both] })).body);
    includes(left, `\n\n${nested}\n\n`);
    excludes(left, `${choice} Choice its verifier left to the author`);
  });

  it('keeps, when it leaves out the findings left as is, one whose verifier named a choice that no one settled, a merged member\'s among them, and gives the others their count (R4 of the review that always posts)', () => {
    // Grounds longer than a decider gives, so that the body overflows by the finding the order takes.
    const state = withDecision(withVerdict(run([leftIntended, decisions[1]]).fold(), 'RIPPLE-1', { authorChoice: choice }), 'SWEEP-1', { grounds: 'g'.repeat(maxPostedLength) });
    const form = formOf(state);
    assert.ok(stepsOf(form).includes('left:SWEEP-1'), stepsOf(form).join());
    assert.ok(!stepsOf(form).includes('left:RIPPLE-1'), stepsOf(form).join());
    const left = leftOf(form.body);
    includes(left, `Choice its verifier left to the author: ${choice} Settled as: not settled by deep-review`);
    includes(left, 'Not listed here: 1. To fit the length GitHub takes, these findings left as is are not listed here; the report of the run holds each.');
    excludes(form.body, 'g'.repeat(100));
    const folded = run([leftIntended, decisions[1]]).fold();
    const primary = folded.review!.candidates['RIPPLE-1']!.verdict!;
    const memberNamed = withVerdict({ ...folded, review: { ...folded.review!, candidates: { ...folded.review!.candidates, 'SWEEP-2': { ...folded.review!.candidates['SWEEP-2']!, unverified: false, verdict: primary } } } }, 'SWEEP-2', { authorChoice: otherChoice });
    const member = formOf(withDecision(memberNamed, 'SWEEP-1', { grounds: 'g'.repeat(maxPostedLength) }));
    assert.ok(stepsOf(member).includes('left:SWEEP-1'), stepsOf(member).join());
    includes(leftOf(member.body), `Choice its verifier left to the author: ${otherChoice} Settled as: not settled by deep-review`);
  });

  it('leaves out a finding left as is whose verifier named a choice the decision settled as any other, since it waits on no one (R4, PD8 of the review that always posts)', () => {
    // A settlement longer than a decider gives, so that the body fits only once the finding it settles leaves.
    const state = withDecision(withVerdict(run([leftIntended, decisions[1]]).fold(), 'RIPPLE-1', { authorChoice: choice }), 'RIPPLE-1', { settled: [{ ...settled, choice: 'g'.repeat(maxPostedLength) }] });
    const form = formOf(state);
    assert.deepEqual(stepsOf(form), ['refuted', 'left:SWEEP-1', 'left:RIPPLE-1']);
    excludes(form.body, choice);
  });

  it('names, in a dry run, what it left out of the body in order, with the number of each finding it took a piece from (R9 of the review that always posts)', () => {
    const state = withDecision(withVerdict(run([leftIntended, decisions[1]]).fold(), 'RIPPLE-1', { authorChoice: choice }), 'SWEEP-1', { grounds: 'g'.repeat(maxPostedLength) });
    const form = formOf(state);
    assert.deepEqual(stepsOf(form), ['refuted', 'left:SWEEP-1']);
    const lines = dryRunLines(state, [], form, []);
    assert.ok(lines.includes('Left out of the body to fit: the refuted candidates, then finding 2, left as is.'), lines.join('\n'));
    assert.ok(dryRunLines(run().fold(), [], formOf(run().fold()), []).includes('Left out of the body to fit: nothing.'));
  });
});

describe('the comment of a finding (R5, R7, R8, R10, R14)', () => {
  const comment = formOf(run().fold()).comments[0]!.body;

  it('gives the writer\'s text of the fix paragraph by paragraph, its first under its label, as the writer\'s problem is', () => {
    const said = writerAnswer();
    const fix = said.findings[0] as WrittenFinding;
    said.findings[0] = { ...fix, fix: { ...fix.fix!, text: 'The fix guards the null once.\n\nIt settles where the guard goes by the intent of the change.\n\n- It settles the error by AGENTS.md' } };
    const written = formOf(run().fold(), said).comments[0]!.body;
    includes(written, '**The fix.** The fix guards the null once.\n\nIt settles where the guard goes by the intent of the change.\n\n\\- It settles the error by AGENTS.md\n\n');
    excludes(written, 'The fix guards the null once. It settles');
  });

  it('gives each part of a major fix against a written rule once, in order, and ends with the trace and the marker', () => {
    inOrder(comment, [
      '**Finding 1**\n\n**parse() reads the null before any guard.**\n\nSeverity: major. Verdict: CONFIRMED. Checked by: tracing the code. Decision: fix against a written rule.',
      '**What goes wrong.** A caller that passes an empty file meets a crash.',
      '```mermaid\nsequenceDiagram\n  Caller->>parse: an empty file\n  parse-->>Caller: crash\n```',
      '**What deep-review would do.** Guard the null before parse reads it.',
      '**Against a written rule.** The rule says each caller guards its own input; the fix guards it once in parse() instead, since every caller passes the same file.',
      'Status: stands.',
      'The person who ran the review accepts or rejects this departure on the machine that holds the run; `--fix` makes the fix as decided unless it is rejected first. Command to accept: `deep-review answer --run run-1 --finding 1 --accept`. Command to reject: `deep-review answer --run run-1 --finding 1 --reject`.',
      '<details><summary>The decision as deep-review recorded it</summary>\n\nThese are the words an answer and the fix pass apply.\n\n**The fix.** The fix guards the null once, so every caller is safe.\n\nIn the words of deep-review\'s decider:\n- Approach: Guard the null once, before parse reads it.\n- Rejected: Catch the throw in each caller. Why: Leaves the null in parse.\n- Rule: parse throws on a null input.\n- Source: docs/parse.md.\n- The decider\'s reason: Every caller passes the null on an empty input.\n- Grounds: ',
      '<details><summary>How the verifier checked it</summary>\n\nThe verifier traced the code to the result; the report of the run holds its evidence.\n\n</details>',
      `Code at the reviewed head:\n- [\`src/a.ts:3-4\`](${blob(head, 'src/a.ts', '3-L4')}) An empty file reaches the read on line 4.\n- At the merge base: [\`src/gone.ts:2\`](${blob(base, 'src/gone.ts', '2')}) The removed guard stood here.`,
      '<sub>Finding: `RIPPLE-1`. Run: `run-1`.</sub>',
    ]);
    assert.equal(lastLine(comment), `<!-- ${findingMarker('run-1', 'RIPPLE-1')} -->`, 'the marker of a finding is the last line of its comment');
  });

  it('posts neither the verifier\'s summary, reason, evidence and runs, nor any sentence that code built', () => {
    for (const gone of ['Evidence that', 'same root cause at lines 4 and 7', 'line 4 dereferences null', 'How the verifier established it', 'deep-review would fix this', 'The person who ran this review accepts the departure with']) excludes(comment, gone);
  });

  it('gives a question with no writer\'s text in the decider\'s recorded words: the question, a table of its options as recorded, its facts, the command, and the record folded', () => {
    const asked = formOf(run([askDecision('RIPPLE-1', false), decisions[1]]).fold(), { ...writerAnswer(), findings: [writerAnswer().findings[1]!] }).comments[0]!.body;
    inOrder(asked, [
      'Severity: major. Verdict: CONFIRMED. Checked by: tracing the code. Decision: ask the author.',
      'deep-review\'s writer did not explain this finding, so it is given in the other workers\' own words: look at it yourself.',
      'In the words of the finder: Finding 1 detail',
      '**The question.** In the words of deep-review\'s decider: Should parse accept an empty input?',
      '| Option | In the words of deep-review\'s decider | What it costs | The rule from then on | Edits the code |',
      '| 1 | Keep accepting it. | Callers that pass one now see the change. | Parse rejects an empty input. | no |',
      'Recommended option: 2. Option that stands until an answer: 1. Edits the code: no. Status: not answered.',
      'Command: `deep-review answer --run run-1 --finding 1 --option <k>`.',
      '<details><summary>The decision as deep-review recorded it</summary>',
      '- Grounds: Nothing in the repository states which behavior is meant.',
      '</details>',
      '<details><summary>How the verifier checked it</summary>',
      'Code at the reviewed head',
    ]);
  });

  it('gives a minor fix its facts, problem, action, departure, the folded record and one line of code, and no diagram, case or folded check', () => {
    const minor = formOf(reranked(run(), (finding) => (finding.id === 'RIPPLE-1' ? { ...finding, severity: 'minor' } : finding)).fold()).comments[0]!.body;
    inOrder(minor, [
      'Severity: minor. Verdict: CONFIRMED. Checked by: tracing the code. Decision: fix against a written rule.',
      '**What goes wrong.** A caller that passes an empty file meets a crash.',
      '**What deep-review would do.** Guard the null before parse reads it.',
      '**Against a written rule.**',
      '<details><summary>The decision as deep-review recorded it</summary>',
      `Code at the reviewed head: [\`src/a.ts:4\`](${blob(head, 'src/a.ts', '4')}).\n\n<sub>Finding: \`RIPPLE-1\`. Run: \`run-1\`.</sub>`,
    ]);
    for (const gone of ['How the verifier checked it', 'sequenceDiagram', 'An empty file reaches the read']) excludes(minor, gone);
  });

  it('says why a PLAUSIBLE verdict is not CONFIRMED: a verdict recorded before verifiers gave a reason on its own, or no verifier at all', () => {
    const plausible = formOf(reranked(run(), (finding) => finding, (verdict) => (verdict.id === 'RIPPLE-1' ? { ...verdict, verdict: 'PLAUSIBLE' } : verdict)).fold());
    includes(plausible.comments[0]!.body, 'Severity: major. Verdict: PLAUSIBLE. Checked by: tracing the code.');
    includes(plausible.comments[0]!.body, '**Why it is not CONFIRMED.** This verdict was recorded before verifiers gave their reason on its own; the report of the run holds its evidence.');
    includes(formOf(run().fold()).body, '**Why it is not CONFIRMED.** No verifier examined it, since its verifier failed twice.');
  });

  it('gives how the verifier checked it from the basis of the verdict', () => {
    const ran = formOf(rewritten(run(), (kind, payload) => (kind === 'verdicts.recorded' && payload.phase === 'verification'
      ? { ...payload, verdicts: (payload.verdicts as Record<string, unknown>[]).map((verdict) => (verdict.id === 'RIPPLE-1' ? { ...verdict, basis: 'ran', runs: [{ command: 'node /tmp/x/probe.mjs', printed: ['TypeError: null'], probe: null, at: 3, exitCode: 1 }] } : verdict)) }
      : undefined)).fold()).comments[0]!.body;
    includes(ran, 'Verdict: CONFIRMED. Checked by: running it.');
    includes(ran, '<details><summary>How the verifier checked it</summary>\n\nThe verifier ran code to check it; the report of the run holds what it ran and what it saw.\n\n</details>');
    excludes(ran, 'probe.mjs');
  });

  it('gives a finding the writer did not explain the notice, then the finder\'s and the decider\'s recorded words', () => {
    const dropped = run(answerableDecisions(), explanation(worker(60), { dropped: [{ part: 'finding', finding: 'RIPPLE-1', failures: ['x'] }], unexplained: ['SWEEP-1'] })).fold();
    const fallback = formOf(dropped, { ...writerAnswer(), findings: [writerAnswer().findings[1]!] }).comments[0]!.body;
    inOrder(fallback, [
      '**Finding 1**\n\nIn the words of deep-review\'s ranking: null dereference\n\nSeverity: major.',
      'deep-review\'s writer did not explain this finding, so it is given in the other workers\' own words: look at it yourself.',
      'In the words of the finder: Finding 1 detail',
      '**What deep-review would do.** In the words of deep-review\'s decider: Guard the null once, before parse reads it.',
      '**Against a written rule.**\n\n- Rule: parse throws on a null input.',
      '<details><summary>The decision as deep-review recorded it</summary>',
      `Code at the reviewed head: [\`src/a.ts:4\`](${blob(head, 'src/a.ts', '4')}).`,
    ]);
    excludes(fallback, '**The decision as deep-review recorded it**');
  });

  it('keeps on one line the text of a link to a path that holds a line break, a cited case\'s and a refuted candidate\'s, so neither opens a block of its own', () => {
    const said = writerAnswer();
    (said.findings[0] as WrittenFinding).cases[0]!.lines.path = 'src/a.ts\n# x';
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
    said.summary = 'Read https://evil.example/x and [a link](https://evil.example) at /w/src/a.ts.';
    const form = formOf(withApproach('see /home/me/notes.txt and ghp_abcdefghijklmnopqrstuvwxyz0123, @octocat\n<!-- deep-review publication run-1 9 -->').fold(), said);
    const text = [form.body, ...form.comments.map((comment) => comment.body)].join('\n');
    assert.ok(!text.includes('/home/me'), 'no local path');
    assert.ok(!text.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'), 'no token');
    includes(form.comments[0]!.body, '\n- Approach: See \\<local path> and [redacted GitHub token], `@octocat` \\<!-- deep-review publication run-1 9 -->.\n');
    assert.equal(form.secrets, 1, 'the token is posted once, in the record of the decided fix');
    includes(form.body, 'Read `https://evil.example/x` and \\[a link](`https://evil.example`) at src/a.ts.');
    assert.equal(lastLine(form.body), `<!-- ${publicationMarker('run-1', 1)} -->`);
    assert.equal(lastLine(form.comments[0]!.body), `<!-- ${findingMarker('run-1', 'RIPPLE-1')} -->`);
  });

  it('redacts a secret before it names an id of the run that a hyphen joins inside it, so a name splits no secret (R1 of the finding names in the review)', () => {
    const said = writerAnswer();
    said.summary = 'The key sk-ant-api03-abcdefghij-RIPPLE-1-klmnopqrstuvwxyz0123 leaked, and a RIPPLE-1-style guard stops it.';
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
    includes(form.body, '\nReviewed by: deep-review 0.0.0+dev. Runtime: claude 2.1.283 `@octocat`. Models: \\<local path>[redacted GitHub token], `@octocat`. Run: `run-1`. Commits: 11111111..22222222.\n');
    includes(form.body, '- Changed paths left out by `scope.exclude`: 1. Patterns: `x/[redacted GitHub token]`, `vendor/**`.');
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
      // Inside a list item after its label, a fence a worker opened opens none.
      includes(form.comments[0]!.body, '\n- Approach: ~~~ `@octocat` `#12` \\<img src=x> ~~~.\n');
      markedLast(form);
    });

    it('a writer\'s code block at the start of a paragraph, which stays code on its one line', () => {
      const said = writerAnswer();
      (said.findings[0] as WrittenFinding).problem = '```ts\n@Injectable() class X {} // see #12\n```';
      const form = formOf(run().fold(), said);
      includes(form.comments[0]!.body, '\n\n**What goes wrong.** ```ts @Injectable() class X {} // see #12 ```\n\n');
      markedLast(form);
    });

    it('a fence split at a blank line, whose second paragraph would open an HTML comment that hides the rest of the review', () => {
      const said = writerAnswer();
      said.summary = '~~~\nx\n\n<!--\n~~~';
      (said.findings[0] as WrittenFinding).problem = '~~~\nx\n\n<!--\n~~~';
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


describe('the fit of the review (R2, R6 of the review that always posts)', () => {
  const state = longFindingHistory().fold();
  /** The files of the pull request with lines 4 and 7 of `src/a.ts` added, or, `outside`, line 7 alone, so the fix on line 4 is in full in the body and does not grow its comment. */
  const filesOf = (outside: boolean): PullRequestFile[] => [{ path: 'src/a.ts', status: 'modified', previousPath: null, patch: outside ? '@@ -7,1 +7,1 @@\n-old 7\n+new 7' : '@@ -4,4 +4,4 @@\n-old 4\n+new 4\n line 5\n line 6\n-old 7\n+new 7' }];
  const limit = 60_000;
  /** Each state the padded text of finding 1 reaches: one step of the order more at a time, up to its text. */
  const expected = [[], ['minor-table'], ['minor-table', 'record:RIPPLE-1'], ['minor-table', 'record:RIPPLE-1', 'refuted'], ['minor-table', 'record:RIPPLE-1', 'refuted', 'left:SWEEP-1'], ['minor-table', 'record:RIPPLE-1', 'refuted', 'left:SWEEP-1', 'diagrams'], ['minor-table', 'record:RIPPLE-1', 'refuted', 'left:SWEEP-1', 'diagrams', 'text:RIPPLE-1']];
  const withoutDiagrams = expected.filter((steps) => !steps.includes('diagrams'));
  const markedLast = (form: PullRequestForm): void => {
    assert.equal(lastLine(form.body), `<!-- ${publicationMarker('run-1', 1)} -->`);
    for (const comment of form.comments) assert.equal(lastLine(comment.body), `<!-- ${findingMarker('run-1', comment.finding)} -->`);
  };
  interface Samples { states: string[][]; forms: PullRequestForm[]; boundaries: Boundary[] }
  const sampled = new Map<boolean, Samples>();
  /** Calibrate only padding length; the fixed cap and literal expected states remain independent oracles. */
  const samples = (diagram: boolean): Samples => {
    const known = sampled.get(diagram);
    if (known !== undefined) return known;
    const boundaries = sampleBoundaries((pad) => renderedOf(state, paddedAnswer(pad, diagram), filesOf(true)), limit, diagram ? expected : withoutDiagrams);
    const forms = boundaries.flatMap(({ below, at, above }) => [below, at, above]);
    const states = forms.map(stepsOf).filter((steps, index, all) => index === 0 || JSON.stringify(all[index - 1]) !== JSON.stringify(steps));
    const result = { states, forms, boundaries };
    sampled.set(diagram, result);
    return result;
  };
  const at = (forms: readonly PullRequestForm[], step: string): string => forms.find((form) => stepsOf(form).at(-1) === step)!.body;

  it('leaves out the pieces of a body that does not fit in the order of R2, one step more at a time, and posts each under the limit', () => {
    const { states, forms } = samples(true);
    assert.deepEqual(states, expected);
    assert.equal(maxPostedLength, limit, 'the public posting cap is 60000 characters');
    for (const form of forms) assert.ok(form.body.length <= maxPostedLength, String(form.body.length));
    for (const form of forms) markedLast(form);
  });

  it('puts in each piece\'s place what R2 names, and keeps the core of the change, what needs a person and the areas', () => {
    const { forms } = samples(true);
    for (const form of forms) includes(form.body, '### What this change does\n\ndeep-review has no account of this change, because an engine before the account reviewed it.\n\n### Summary');
    includes(at(forms, 'minor-table'), 'Minor findings: 1. Reach what a user sees: 0. About the code alone: 0. Reach not given: 1. In a comment on their line: 1.\n\nTo fit the length GitHub takes, the table of the minor findings is left out; the report of the run holds them all.');
    const record = at(forms, 'record:RIPPLE-1');
    includes(record, '<details><summary>The fix in full, in the writer\'s words</summary>\n\n**The fix.** The fix guards the null once, so every caller is safe.\n\n</details>\n\nThe decision as deep-review recorded it is left out here to fit the length GitHub takes. Command that prints it: `deep-review report --run run-1 --finding 1`.');
    excludes(record, 'Approach: Guard the null once');
    excludes(record, '<summary>The decision as deep-review recorded it</summary>');
    includes(at(forms, 'refuted'), '- Candidates the verifiers refuted: 1. Not listed here: 1. To fit the length GitHub takes, the refuted candidates are not listed here; the report of the run holds each with its evidence.');
    excludes(at(forms, 'refuted'), '<details><summary>The refuted candidates</summary>');
    includes(at(forms, 'left:SWEEP-1'), '### The findings left as is\n\nNot listed here: 1. To fit the length GitHub takes, these findings left as is are not listed here; the report of the run holds each.');
    includes(at(forms, 'diagrams'), 'To fit the length GitHub takes, the diagrams of the areas are left out; the writer\'s answer on the machine that holds the run keeps them.');
    excludes(at(forms, 'diagrams'), `A["${'d'.repeat(1000)}"]`);
    const text = at(forms, 'text:RIPPLE-1');
    excludes(text, '### Finding 1');
    excludes(text, '(#finding-1)');
    includes(text, '- **Finding 1.** parse() reads the null before any guard. Verdict: CONFIRMED. Decision: fix. Guard the null before parse reads it. Command that prints it: `deep-review report --run run-1 --finding 1`.');
    for (const form of [...forms, ...samples(false).forms]) {
      includes(form.body, '### What needs a person');
      includes(form.body, '### The major findings');
      includes(form.body, '**Parsing an empty input.** What parse() does with an empty file.');
      markedLast(form);
    }
  });

  it('says under its heading what it left out, with the count of each kind and the command that prints a finding, and says nothing of it when nothing was left out (R6, PD10)', () => {
    const { forms } = samples(true);
    const notice = 'This review does not hold all of the run: to fit the length GitHub takes, the parts counted here are left out.';
    excludes(forms[0]!.body, notice);
    inOrder(at(forms, 'minor-table'), ['## deep-review\'s review', 'Merge base:', notice, 'Left out whole: the table of the minor findings. Command that prints a finding: `deep-review report --run run-1 --finding <n>`.', '### What this change does']);
    includes(at(forms, 'record:RIPPLE-1'), 'Left out whole: the table of the minor findings. Findings whose recorded decision is left out: 1. Command');
    includes(at(forms, 'text:RIPPLE-1'), 'Left out whole: the table of the minor findings, the refuted candidates, the diagrams. Findings left as is that are not listed: 1. Findings whose text is left out: 1. Command');
  });

  it('makes and names no step that takes nothing from the body', () => {
    assert.deepEqual(samples(false).states, withoutDiagrams);
  });

  /** The state with the grounds of finding 1's decision padded with `pad` characters, so that its record grows and its text does not. */
  const withGrounds = (pad: number) => ({ ...state, review: { ...state.review!, decisions: state.review!.decisions!.map((decision) => (decision.id === 'RIPPLE-1' ? { ...decision, grounds: `${decision.grounds} ${'g'.repeat(pad)}` } : decision)) } });
  const rippleOf = (form: PullRequestForm): string => form.comments.find((comment) => comment.finding === 'RIPPLE-1')!.body;

  it('posts a comment over the limit without the record of its decision, with the command that prints it, and counts it under the heading (R7)', () => {
    const seed = formOf(withGrounds(1), paddedAnswer(1), filesOf(false));
    const atPad = 1 + limit - rippleOf(seed).length;
    assert.ok(atPad > 1 && atPad <= limit, 'the comment boundary has positive, bounded padding');
    for (const [offset, size] of [[-1, limit - 1], [0, limit]] as const) {
      const form = formOf(withGrounds(atPad + offset), paddedAnswer(1), filesOf(false));
      assert.equal(rippleOf(form).length, size);
      assert.deepEqual(form.leftOut.comments, []);
      markedLast(form);
    }
    const over = formOf(withGrounds(atPad + 1), paddedAnswer(1), filesOf(false));
    const comment = rippleOf(over);
    assert.ok(comment.length <= limit, String(comment.length));
    assert.deepEqual(over.leftOut.comments, [{ finding: 'RIPPLE-1', piece: 'record' }]);
    excludes(comment, 'g'.repeat(100));
    includes(comment, 'The decision as deep-review recorded it is left out here to fit the length GitHub takes. Command that prints it: `deep-review report --run run-1 --finding 1`.');
    includes(comment, '**What goes wrong.** A caller that passes an empty file meets a crash.');
    markedLast(over);
    includes(over.body, 'Comments without their recorded decision: 1.');
    assert.equal(dryRunLines(state, [], over, []).filter((line) => line.startsWith('Left out of the comment')).join('\n'), 'Left out of the comment of finding 1 (RIPPLE-1) to fit: its recorded decision.');
  });

  it('posts a comment whose text alone is over the limit as its facts, the notice and the command, holding no text of a worker, and changes no other comment (R7)', () => {
    const plain = formOf(state, paddedAnswer(1), filesOf(false));
    const over = formOf(state, paddedAnswer(limit), filesOf(false));
    const comment = rippleOf(over);
    assert.deepEqual(over.leftOut.comments, [{ finding: 'RIPPLE-1', piece: 'text' }]);
    assert.equal(comment, [
      '**Finding 1**',
      '',
      'Severity: major. Verdict: CONFIRMED. Checked by: tracing the code. Decision: fix.',
      '',
      'The text of this finding does not fit the length GitHub takes for a comment; the report of the run prints the finding, in the words of the workers that recorded it, and deep-review\'s writer\'s text of it is kept in its answer on the machine of the person who ran the review. Command that prints it: `deep-review report --run run-1 --finding 1`.',
      '',
      `<sub>Finding: \`RIPPLE-1\`. Run: \`run-1\`.</sub>`,
      '',
      `<!-- ${findingMarker('run-1', 'RIPPLE-1')} -->`,
    ].join('\n'));
    for (const other of over.comments.filter((posted) => posted.finding !== 'RIPPLE-1')) assert.equal(other.body, plain.comments.find((posted) => posted.finding === other.finding)!.body);
    includes(over.body, 'Comments with their facts alone: 1.');
    assert.equal(over.body.replace(/This review does not hold all of the run[^\n]*\n\n/, ''), plain.body);
  });
});
