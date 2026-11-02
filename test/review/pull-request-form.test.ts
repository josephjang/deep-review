import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import type { PullRequestFile } from '../../src/github/pull-request.ts';
import type { ExplainedFinding, RecordedAnswer } from '../../src/review/explanation.ts';
import { bodyCuts, findingMarker, formRefusalWords, maxPostedLength, placeFindings, publicationMarker, readmeUrl, type FormRefusal, type PullRequestForm } from '../../src/review/pull-request-form.ts';
import { filesWith, formOf, pullRequestRun as run, pullRequestRunBeforeExplanation as runBeforeExplanation, renderedOf, rewritten, withAccount, withSettings, writerAnswer } from '../helpers/pull-request-review.ts';
import { answer, answerableDecisions, askDecision, decisions, explanation, pullRequestFacts, worker } from '../helpers/review-history.ts';

const head = '2'.repeat(40);
const base = '1'.repeat(40);

const lastLine = (text: string): string => text.split('\n').at(-1)!;
const diffAnchor = (path: string, line: number): string => `${pullRequestFacts.url}/files#diff-${createHash('sha256').update(path).digest('hex')}R${String(line)}`;
const includes = (text: string, part: string): void => assert.ok(text.includes(part), `${JSON.stringify(part)} in:\n${text}`);

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

describe('the body and the comments of the review (R9, R10, PD13, PD14)', () => {
  const state = withAccount(run().fold());
  const form = formOf(state);
  const { body } = form;
  const comment = form.comments[0]!.body;

  it('orders the body as R9 says: the conclusion first, the core with the account folded under it, the status line, what to know, the table, the findings in full, the refuted candidates, the legend and the last line', () => {
    const order = [
      '## deep-review\'s review of this pull request (run `run-1`, head `22222222`)',
      '**Before the merge: 1 fix and 1 question**',
      'An empty input still crashes parse()',
      '### What this pull request does',
      '**Parse an empty input**',
      'The parser returns no value for an empty input',
      'Why, in the change\'s own words: An empty file is a valid input, as the commit says.',
      '<details><summary>For a reader new to this change</summary>',
      'deep-review reviewed this pull request at its head `22222222`, and changed no file. It has 2 findings: it would fix 1 (1 against a written rule) and asks 1 question.',
      '### What to know before the merge',
      '### Findings',
      '### Fixes and questions with no line in the diff',
      '<details><summary>Refuted at verification (1)</summary>',
      '<details><summary>The words of this review</summary>',
      'Reviewed by deep-review 0.0.0+dev on claude 2.1.283 with opus and sonnet, run `run-1`, commits 11111111..22222222.',
    ];
    const at = order.map((text) => body.indexOf(text));
    assert.deepEqual(order.filter((_, index) => at[index] === -1), [], body);
    assert.deepEqual([...at].sort((a, b) => a - b), at, 'in the order of R9');
    assert.equal(lastLine(body), `<!-- ${publicationMarker('run-1', 1)} -->`, 'the marker of the publication is the very last line');
    assert.equal(lastLine(comment), `<!-- ${findingMarker('run-1', 'RIPPLE-1')} -->`, 'the marker of a finding is the last line of its comment');
  });

  it('lists the actions in rank order, whatever order the writer gives, each with its number, severity, verdict and a link to where it is read', () => {
    assert.deepEqual(body.split('\n').filter((line) => line.startsWith('- [Finding ')), [
      `- [Finding 1](${diffAnchor('src/a.ts', 4)}), major, CONFIRMED: Guard the null before parse reads it.`,
      '- [Finding 2](#finding-2), minor, PLAUSIBLE, unverified, not explained: Choose whether parse accepts an empty input.',
    ]);
  });

  it('puts a fix on its line, and a question with no line in full in the body, each in full once with who answers it and how', () => {
    assert.deepEqual(form.comments.map(({ finding, path, line }) => ({ finding, path, line })), [{ finding: 'RIPPLE-1', path: 'src/a.ts', line: 4 }]);
    assert.match(comment, /^\*\*1\. parse\(\) reads the null before any guard\.\*\*\n\ndeep-review would fix this against a written rule\. Major, CONFIRMED\.\n/);
    includes(comment, 'This fix goes against a written rule: parse throws on a null input (docs/parse.md). Why deep-review departs from it: every caller passes the null on an empty input.');
    const accept = '`deep-review answer --run run-1 --finding 1 --accept`';
    includes(comment, `The person who ran this review accepts or rejects the departure, on the machine that holds the run: ${accept} keeps the fix and changes the rule, and \`deep-review answer --run run-1 --finding 1 --reject\` follows the rule. A reply on this pull request is not read yet.`);
    assert.ok(!body.includes(accept), 'the departure is in full once, in its comment');
    const ask = '`deep-review answer --run run-1 --finding 2 --option <k>`';
    assert.equal(body.split(ask).length, 2, 'the question is in full once, in the body');
    assert.ok(!comment.includes(ask));
    includes(body, '<a id="finding-2"></a>\n\n#### 2. extract the helper\n\ndeep-review asks a question about this. Minor, PLAUSIBLE, unverified. This finding names no place that the repository holds.');
    includes(body, 'deep-review asks: Should parse accept an empty input?\n\ndeep-review would apply option 2. Until someone answers, the default is option 1, the easiest to take back.\n\n- Option 1: keep accepting it. Cost: callers that pass one now see the change. The rule it makes: parse rejects an empty input.\n- Option 2: accept it and return an empty result.');
    includes(body, `The person who ran this review answers it, on the machine that holds the run, with ${ask}, where \`<k>\` is the number of the option. A reply on this pull request is not read yet.`);
  });

  it('gives the writer\'s explanation of a finding with each case linked at the commit of its side, its diagram fenced, the decision, and the evidence the verifier checked folded under it', () => {
    includes(comment, `A caller that passes an empty file meets a crash.\n\n- An empty file reaches the read on line 4. ([\`src/a.ts:3-4\`](https://github.com/octo/parse/blob/${head}/src/a.ts#L3-L4))`);
    includes(comment, `- The removed guard stood here. ([\`src/gone.ts:2\`](https://github.com/octo/parse/blob/${base}/src/gone.ts#L2))`);
    includes(comment, '```mermaid\nsequenceDiagram\n  Caller->>parse: an empty file\n  parse-->>Caller: crash\n```');
    includes(comment, 'The fix deep-review decided: guard the null once, before parse reads it. Rejected: catch the throw in each caller (leaves the null in parse).\n\nThis fix goes against');
    includes(comment, '\n\ndeep-review would guard the null once, so every caller is safe.\n\nThe person who ran this review');
    includes(comment, '<details><summary>Evidence that the verifier checked</summary>\n\n- Summary: null dereference\n- Reason: same root cause at lines 4 and 7\n- Evidence: line 4 dereferences null\n- How the verifier established it: it traced the lines.\n\n</details>');
  });

  it('fences each diagram longer than any run of backticks in it, so no diagram ends its fence (R19)', () => {
    const said = writerAnswer();
    said.conclusion.diagram = 'flowchart LR\n  A["```js"] --> B["code"]\n```\n# a heading';
    includes(formOf(state, said).body, '````mermaid\nflowchart LR\n  A["```js"] --> B["code"]\n```\n# a heading\n````');
  });

  it('gives the cited runs of a verdict as the verifier\'s own words, the command as code', () => {
    const cited = formOf(withAccount(rewritten(run(), (kind, payload) => (kind === 'verdicts.recorded' && payload.phase === 'verification'
      ? { ...payload, verdicts: (payload.verdicts as Record<string, unknown>[]).map((verdict) => (verdict.id === 'RIPPLE-1' ? { ...verdict, basis: 'ran', runs: [{ command: 'node /tmp/x/probe.mjs', printed: ['TypeError: null'], probe: null, at: 3, exitCode: 1 }] } : verdict)) }
      : undefined)).fold()));
    includes(cited.comments[0]!.body, '- How the verifier established it: it ran code. The run `node <local path>` printed "TypeError: null", exit 1.');
  });

  it('gives a finding the writer did not explain in deep-review\'s own words with the mark, and its evidence as no verifier checked it', () => {
    const block = body.slice(body.indexOf('#### 2.'), body.indexOf('<details><summary>Refuted'));
    includes(block, 'deep-review\'s writer did not explain this finding, so it is given in deep-review\'s own words: look at it yourself. The writer\'s reason: Its evidence names no line of the head.\n\nSWEEP-1 detail\n');
    includes(block, '<details><summary>Evidence that no verifier checked</summary>\n\n- Summary: extract the helper\n- Reason: one improvement\n- Evidence: none; the verifier of this group failed twice');
    assert.ok(!body.includes('elsewhere'), 'the spelling of an unlocated finding is not posted');
  });

  it('gives the table of the findings with each place, each gap, the refuted candidates with their evidence, and the legend', () => {
    includes(body, `| [1](${diffAnchor('src/a.ts', 4)}) | major | CONFIRMED | to fix against a written rule | null dereference | [\`src/a.ts:4\`](${diffAnchor('src/a.ts', 4)}) |`);
    includes(body, '| [2](#finding-2) | minor | PLAUSIBLE, unverified | a question, not explained | extract the helper | no place in the repository |');
    includes(body, '### What to know before the merge\n\nNo check ran: this run only reviewed.\n\nWhat this run did not examine:\n\n- The footguns review pass did not run, and a later pass looked for what it would have found.\n- No verifier examined finding 2');
    includes(body, `<details><summary>Refuted at verification (1)</summary>\n\nThe candidates a verifier refuted, each with the evidence that refuted it.\n\n- RIPPLE-2 (RIPPLE), [\`src/a.ts:9\`](https://github.com/octo/parse/blob/${head}/src/a.ts#L7-L9): a stale cache entry after logout\n  - Evidence: a guard on line 2 clears the entry first\n  - How the verifier established it: it traced the lines.`);
    for (const word of ['CONFIRMED', 'PLAUSIBLE', 'REFUTED', 'critical', 'major', 'minor', 'to fix against a written rule', 'a question', 'unverified', 'not explained']) assert.match(body, new RegExp(`^- ${word}: `, 'm'), word);
    includes(body, `\n\nA model wrote the explanations in this review from the evidence beneath each of them, and only that evidence was verified, except where the mark unverified says that no verifier examined it. [How deep-review works](${readmeUrl})\n\n</details>`);
  });

  it('links a fix outside the diff to its lines at the head, two on each side within its file, on a line of its own, and says the pull request does not change its line or its file', () => {
    const outside = formOf(state, writerAnswer(), filesWith('@@ -1,1 +1,1 @@\n-a\n+b'));
    assert.deepEqual(outside.comments, []);
    includes(outside.body, `<a id="finding-1"></a>\n\n#### 1. parse() reads the null before any guard.\n\nhttps://github.com/octo/parse/blob/${head}/src/a.ts#L2-L6\n\ndeep-review would fix this against a written rule. Major, CONFIRMED. This pull request does not change this line.`);
    includes(outside.body, '- [Finding 1](#finding-1), major, CONFIRMED: ');
    includes(formOf(state, writerAnswer(), []).body, 'Major, CONFIRMED. This pull request does not change this file.');
    includes(formOf(state, writerAnswer(), filesWith(null)).body, 'Major, CONFIRMED. GitHub shows no diff of this file, so this finding has no comment on its line.');
    includes(formOf(state, writerAnswer(), filesWith('@@ -4,1 +4,1 @@\n line 4')).comments[0]!.body, 'Major, CONFIRMED. This pull request does not change this line.');
  });

  it('folds the findings left as is, each with why and its evidence', () => {
    const left = formOf(run(decisions).fold(), { ...writerAnswer(), findings: [writerAnswer().findings[0]!] });
    includes(left.body, '<details><summary>Findings left as is (1)</summary>\n\n<a id="finding-2"></a>\n\n#### 2. extract the helper\n\ndeep-review leaves this as is: outside the change, and not a regression. Minor, PLAUSIBLE, unverified.\n\n- Why: the helper would edit only lines the change does not touch\n- Summary: extract the helper\n- Reason: one improvement\n- Evidence: none; the verifier of this group failed twice\n\n</details>');
    assert.ok(!left.body.includes('### Fixes and questions with no line in the diff'), 'the fix has its line, so no fix or question is in full in the body');
  });

  it('names the findings whose answers the explanation predates, and gives each answer in the engine\'s words', () => {
    const answered = formOf(run().add('answer.recorded', answer('SWEEP-1', 1)).add('answer.recorded', answer('RIPPLE-1', 'reject')).fold());
    includes(answered.body, 'The writer explained this review before the answers to findings 1 and 2 were recorded; deep-review\'s own words give each answer.');
    includes(answered.body, 'The person who ran this review answered it with option 2, on ');
    includes(answered.comments[0]!.body, 'The person who ran this review rejected the departure, so the fix follows the rule, on ');
    assert.ok(!answered.body.includes('--option <k>'));
  });

  it('falls back to the ledger\'s words for each dropped part and names it, and for a run with no explanation', () => {
    const dropped = run(answerableDecisions(), explanation(worker(60), { dropped: [{ part: 'conclusion', failures: ['x'] }, { part: 'account', failures: ['x'] }, { part: 'finding', finding: 'RIPPLE-1', failures: ['x'] }], unexplained: ['SWEEP-1'] })).fold();
    const fallback = formOf(dropped, { conclusion: null, account: null, findings: [writerAnswer().findings[1]!] });
    includes(fallback.body, `- [Finding 1](${diffAnchor('src/a.ts', 4)}), major, CONFIRMED, not explained: deep-review would fix it against a written rule, which a person accepts or rejects: guard the null once, before parse reads it.`);
    includes(fallback.body, '- [Finding 2](#finding-2), minor, PLAUSIBLE, unverified, not explained: deep-review asks: Should parse accept an empty input?');
    includes(fallback.body, 'The writer gave no conclusion that passed deep-review\'s checks, so the actions above are in deep-review\'s own words.\n\nThe writer gave no account of the pull request that passed deep-review\'s checks, so this review has none.\n\nThe writer gave no explanation of finding 1 that passed deep-review\'s checks, so it is given in deep-review\'s own words.');
    assert.ok(!fallback.body.includes('<details><summary>For a reader new to this change</summary>'));
    assert.match(fallback.comments[0]!.body, /^\*\*1\. null dereference\*\*\n\ndeep-review would fix this against a written rule\. Major, CONFIRMED\.\n\ndeep-review's writer did not explain this finding, so it is given in deep-review's own words: look at it yourself\.\n\nRIPPLE-1 detail\n\nThe fix deep-review decided/);
    const none = formOf(runBeforeExplanation().fold(), null);
    includes(none.body, 'deep-review recorded no explanation by its writer for this run, so the review is in deep-review\'s own words.');
    assert.ok(!none.comments[0]!.body.includes('did not explain this finding'), 'a run with no explanation marks no finding');
  });
});

describe('the cleaning of what the review posts (R11)', () => {
  it('cleans every worker\'s and the writer\'s text, counts the secrets where they are posted, and keeps a worker\'s marker off the last line', () => {
    const history = rewritten(run(), (kind, payload) => (kind === 'ranking.recorded'
      ? { ...payload, findings: (payload.findings as Record<string, unknown>[]).map((finding) => (finding.id === 'RIPPLE-1' ? { ...finding, reason: 'see /home/me/notes.txt and ghp_abcdefghijklmnopqrstuvwxyz0123, @octocat\n<!-- deep-review publication run-1 9 -->' } : finding)) }
      : undefined));
    const said = writerAnswer();
    said.conclusion.why = 'Read https://evil.example/x and [a link](https://evil.example) at /w/src/a.ts.';
    const form = formOf(history.fold(), said);
    const text = [form.body, ...form.comments.map((comment) => comment.body)].join('\n');
    assert.ok(!text.includes('/home/me'), 'no local path');
    assert.ok(!text.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'), 'no token');
    includes(form.comments[0]!.body, '- Reason: see \\<local path> and [redacted GitHub token], `@octocat` \\<!-- deep-review publication run-1 9 -->');
    assert.equal(form.secrets, 1, 'the token is posted once, in the evidence of the comment');
    includes(form.body, 'Read `https://evil.example/x` and \\[a link](`https://evil.example`) at src/a.ts.');
    assert.equal(lastLine(form.body), `<!-- ${publicationMarker('run-1', 1)} -->`);
    assert.equal(lastLine(form.comments[0]!.body), `<!-- ${findingMarker('run-1', 'RIPPLE-1')} -->`);
  });

  it('cleans the text of each gap, which quotes patterns and paths as they are', () => {
    const history = rewritten(run(), (kind, payload) => (kind === 'scope.captured'
      ? { ...payload, request: { ...(payload.request as object), exclude: ['**/__snapshots__/**', '@org-team.json'] }, excluded: { paths: ['a/__snapshots__/x.snap'], count: 1 } }
      : undefined));
    includes(formOf(history.fold()).body, '\n- 1 changed path under \\*\\*/\\_\\_snapshots\\_\\_/\\*\\*, `@org-team`.json, which the settings leave out.\n');
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
    includes(form.body, '`x/[redacted GitHub token]`, `vendor/**` left out 1 changed path');
    assert.ok(!form.body.includes(token), 'no token');
    assert.equal(form.secrets - plain.secrets, 3, 'the token in the path of the model, in the excluded pattern, and in the gap that quotes the pattern');
  });

  describe('keeps code that the form puts on one line or splits into paragraphs from turning into live text', () => {
    /** The form of a run whose fix's reason, a worker's words, is `reason`, and whose writer's answer `said` changes. */
    const formWith = (reason: string, say: (said: ReturnType<typeof writerAnswer>) => void = () => undefined): PullRequestForm => {
      const history = rewritten(run(), (kind, payload) => (kind === 'ranking.recorded'
        ? { ...payload, findings: (payload.findings as Record<string, unknown>[]).map((finding) => (finding.id === 'RIPPLE-1' ? { ...finding, reason } : finding)) }
        : undefined));
      const said = writerAnswer();
      say(said);
      return formOf(history.fold(), said);
    };
    /** Each `<!--` that a backslash does not escape, which hides what follows it up to the next `-->`. */
    const commentOpeners = (text: string): number => text.match(/(?<!\\)<!--/g)?.length ?? 0;
    const markedLast = (form: PullRequestForm): void => {
      assert.equal(lastLine(form.body), `<!-- ${publicationMarker('run-1', 1)} -->`);
      assert.equal(commentOpeners(form.body), 1, 'the marker is the body\'s only comment');
      assert.equal(lastLine(form.comments[0]!.body), `<!-- ${findingMarker('run-1', 'RIPPLE-1')} -->`);
      assert.equal(commentOpeners(form.comments[0]!.body), 1, 'the marker is the comment\'s only comment');
    };

    it('a worker\'s fenced block, which the form joins onto one line', () => {
      const form = formWith('~~~\n@octocat #12 <img src=x>\n~~~');
      includes(form.comments[0]!.body, '- Reason: ~~~ `@octocat` `#12` \\<img src=x> ~~~\n');
      markedLast(form);
    });

    it('a worker\'s fence of three backticks that four close', () => {
      const form = formWith('```\n@octocat\n````');
      includes(form.comments[0]!.body, '- Reason: \\`\\`\\` `@octocat` \\`\\`\\`\\`\n');
      markedLast(form);
    });

    it('a writer\'s code block at the start of a paragraph, which stays code on its one line', () => {
      const form = formWith('r', (said) => {
        (said.findings[0] as ExplainedFinding).problem = '```ts\n@Injectable() class X {} // see #12\n```';
      });
      includes(form.comments[0]!.body, '\n\n```ts @Injectable() class X {} // see #12 ```\n\n');
      markedLast(form);
    });

    it('a fence split at a blank line, whose second paragraph would open an HTML comment that hides the rest of the review', () => {
      const form = formWith('~~~\nx\n\n<!--\n~~~', (said) => {
        said.conclusion.why = '~~~\nx\n\n<!--\n~~~';
        (said.findings[0] as ExplainedFinding).problem = '~~~\nx\n\n<!--\n~~~';
      });
      includes(form.body, '\n\n\\~~~ x\n\n\\<!-- ~~~\n\n');
      includes(form.comments[0]!.body, '\n\n\\~~~ x\n\n\\<!-- ~~~\n\n');
      includes(form.comments[0]!.body, '- Reason: ~~~ x \\<!-- ~~~\n');
      markedLast(form);
    });

    it('a diagram whose cleaned places join two runs of backticks into a line that would close a fence chosen before', () => {
      const form = formWith('r', (said) => {
        said.conclusion.diagram = 'flowchart LR\n  A["a"]\n``/w/``\n  B["@octocat"]';
      });
      includes(form.body, '\n\n`````mermaid\nflowchart LR\n  A["a"]\n````\n  B["@octocat"]\n`````\n\n');
      markedLast(form);
    });
  });
});

describe('the fit of the review (R12)', () => {
  /** A run whose fix, RIPPLE-1, has no patch and so is in full in the body, whose refuted candidate's evidence and whose left finding's reason are long. */
  const state = withAccount(rewritten(run(decisions), (kind, payload) => {
    if (kind === 'verdicts.recorded' && payload.phase === 'verification') return { ...payload, verdicts: (payload.verdicts as Record<string, unknown>[]).map((verdict) => (verdict.id === 'RIPPLE-2' ? { ...verdict, evidence: 'e'.repeat(1000) } : verdict)) };
    if (kind === 'ranking.recorded') return { ...payload, findings: (payload.findings as Record<string, unknown>[]).map((finding) => (finding.id === 'SWEEP-1' ? { ...finding, reason: 'r'.repeat(2000) } : finding)) };
    return undefined;
  }).fold());
  const files = filesWith(null);
  /** The writer's answer with an account of long texts and diagrams, or none, and the fix's problem padded with `pad` characters. */
  const answerOf = (pad: number, account = true): RecordedAnswer => {
    const said = writerAnswer();
    said.account.problem = { text: 'p'.repeat(1000), diagram: `flowchart LR\n  A["${'d'.repeat(1000)}"]` };
    const fix = said.findings[0] as ExplainedFinding;
    return { ...said, account: account ? said.account : null, findings: [{ ...fix, problem: `${fix.problem} ${'q'.repeat(pad)}` }] };
  };
  /** Each list of cuts the form makes as the fix's problem grows, in the order they come, and the last form, refused or not. */
  const sweep = (account: boolean): { readonly cuts: string[][]; readonly forms: PullRequestForm[]; readonly last: PullRequestForm | FormRefusal } => {
    const cuts: string[][] = [];
    const forms: PullRequestForm[] = [];
    for (let pad = 0; ; pad += 200) {
      const form = renderedOf(state, answerOf(pad, account), files);
      if (form.kind === 'refused') return { cuts, forms, last: form };
      forms.push(form);
      if (JSON.stringify(cuts.at(-1)) !== JSON.stringify(form.cuts)) cuts.push([...form.cuts]);
    }
  };
  const { cuts, forms, last } = sweep(true);

  it('cuts a body that does not fit in the order of R12, one cut more at a time, and posts each under the limit', () => {
    assert.deepEqual([...bodyCuts], ['account-diagrams', 'account', 'refuted', 'left']);
    assert.deepEqual(cuts, [[], ['account-diagrams'], ['account-diagrams', 'account'], ['account-diagrams', 'account', 'refuted'], ['account-diagrams', 'account', 'refuted', 'left']]);
    for (const form of forms) assert.ok(form.body.length <= maxPostedLength, String(form.body.length));
  });

  it('names each cut where it is made, and that the report of the run holds what a cut leaves out', () => {
    const cutTo = (count: number): string => forms.find((form) => form.cuts.length === count)!.body;
    includes(cutTo(1), '</details>\n\nThe diagrams of this account are left out, so that the review fits the length GitHub takes.');
    includes(cutTo(2), 'deep-review wrote this account of the change as submitted, and no verifier examined it.\n\ndeep-review\'s account for a reader new to this change is left out, so that the review fits the length GitHub takes; the core of the change above stays.');
    assert.ok(!cutTo(2).includes('The diagrams of this account are left out'), 'a cut account names no cut of its diagrams');
    includes(cutTo(3), `To fit the length GitHub takes, each refuted candidate is given by its summary and place; the report of the run holds its evidence.\n\n- RIPPLE-2 (RIPPLE), [\`src/a.ts:9\`](https://github.com/octo/parse/blob/${head}/src/a.ts#L7-L9): a stale cache entry after logout\n\n</details>`);
    includes(cutTo(4), 'To fit the length GitHub takes, the findings left as is are given only by their rows in the table above; the report of the run holds each in full.');
    includes(cutTo(4), '| 2 | minor | PLAUSIBLE, unverified | left as is | extract the helper | no place in the repository |');
    for (const form of forms) includes(form.body, '<details><summary>Evidence that the verifier checked</summary>\n\n- Summary: null dereference\n- Reason: same root cause at lines 4 and 7\n- Evidence: line 4 dereferences null');
  });

  it('makes and names no cut that takes nothing from the body', () => {
    assert.deepEqual(sweep(false).cuts, [[], ['refuted'], ['refuted', 'left']]);
  });

  it('refuses a body that does not fit after every cut, with its size and parts, and never cuts a fix or a question in full', () => {
    assert.equal(last.kind, 'refused');
    const { text, size, limit, parts } = last as FormRefusal;
    assert.deepEqual(text, { kind: 'body' });
    assert.ok(size > maxPostedLength);
    assert.equal(limit, maxPostedLength);
    assert.deepEqual(parts.map((part) => part.part), ['heading', 'conclusion', 'change', 'status', 'before the merge', 'table', 'findings in full', 'left as is', 'refuted', 'legend', 'last line']);
    assert.equal(parts.reduce((sum, part) => sum + part.size, 0) + 2 * (parts.length - 1), size, 'the parts and the blank lines between them make the body');
    assert.match(formRefusalWords(last as FormRefusal), /^the body of the review, after every cut, is \d+ characters, over the 60000 a review posts: heading \d+, conclusion \d+, change \d+/);
  });

  it('refuses a comment over the limit, with its size and parts', () => {
    const refused = renderedOf(state, answerOf(maxPostedLength), filesWith()) as FormRefusal;
    assert.equal(refused.kind, 'refused');
    assert.deepEqual(refused.text, { kind: 'comment', finding: 'RIPPLE-1', path: 'src/a.ts', line: 4 });
    assert.deepEqual(refused.parts.map((part) => part.part), ['explanation', 'decision', 'evidence']);
    assert.match(formRefusalWords(refused), /^the comment of RIPPLE-1 on src\/a\.ts:4 is \d+ characters, over the 60000 a review posts: explanation \d+, decision \d+, evidence \d+$/);
  });

  it('names the patterns that left paths out, with their count and the layer that set them', () => {
    const history = rewritten(withSettings(run(), { 'scope.exclude': ['*.lock', 'vendor/**'] }, { 'scope.exclude': 'repository' }), (kind, payload) => (kind === 'scope.captured'
      ? { ...payload, request: { ...(payload.request as object), exclude: ['*.lock', 'vendor/**'] }, excluded: { paths: ['a.lock', 'vendor/x.js', 'vendor/y.js'], count: 3 } }
      : undefined));
    includes(formOf(history.fold()).body, '### Paths this review left out\n\n`*.lock`, `vendor/**` left out 3 changed paths, which no worker reviewed; the repository\'s file set scope.exclude.');
  });
});
