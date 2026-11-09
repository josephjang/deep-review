import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import type { Core, RecordedAnswer } from '../../src/review/explanation.ts';
import { formOf, pullRequestRun as run, withAccount, withSettings, writerAnswer } from '../helpers/pull-request-review.ts';
import { changeReading, decisions, departure, explanation, reference, withCoreForm, withReportForm, worker } from '../helpers/review-history.ts';

const head = '2'.repeat(40);
const base = '1'.repeat(40);
/** The commits of the change the caller reads, two of them, which begin alike. */
const commits = ['abcdef1234567890abcdef1234567890abcdef12', 'abcdef9876543210abcdef9876543210abcdef98'];

const includes = (text: string, part: string): void => assert.ok(text.includes(part), `${JSON.stringify(part)} in:\n${text}`);
const excludes = (text: string, part: string): void => assert.ok(!text.includes(part), `no ${JSON.stringify(part)} in:\n${text}`);
/** The section of the body under a heading, up to the next heading of its level. */
const section = (body: string, heading: string): string => {
  const from = body.indexOf(`${heading}\n`);
  assert.ok(from !== -1, `${heading} in:\n${body}`);
  const end = body.indexOf('\n### ', from + heading.length);
  return body.slice(from, end === -1 ? undefined : end);
};

/** A core of the writer's, with `change` over it. */
const writerCore = (change: Partial<Core> = {}): Core => ({
  title: 'parse() accepts an empty file',
  what: 'parse(), which reads a file into a value, now returns null for an empty file instead of throwing.\n\nIts callers check for the null.',
  why: 'The commit says that an empty file is a valid input.',
  whyFrom: ['abcdef1', 'src/a.ts', 'src/gone.ts'],
  diagram: 'flowchart LR\n  E["empty file"] --> N["null"]',
  ...change,
});
/** The writer's answer of version 3, with the core given. */
const answerWith = (core: Core | null): RecordedAnswer => ({ ...writerAnswer(), areas: null, refuted: null, core, conditions: [] });

/** The state with `src/gone.ts` removed by the change, beside `src/a.ts`. */
const withRemoved = (state: RunState): RunState => ({ ...state, scope: { ...state.scope!, files: [...state.scope!.files, { path: 'src/gone.ts', status: 'deleted', symlink: false, before: { blob: reference('g') }, after: null }] } });
/** The run configured at version 12 whose explanation records `recorded`, with the triage's account given. */
const cored = (recorded: Record<string, unknown> = explanation(worker(60))): RunState => withRemoved(withAccount(withCoreForm(run(undefined, recorded)).fold()));
const bodyOf = (state: RunState, answer: RecordedAnswer | null, change: { readonly commits?: readonly string[] | null } = { commits }): string => formOf(state, answer, undefined, change).body;

// R1, R3, R4, R10, R11, R12, TD4 of the core of the change on the pull request.
describe('the core of the change in the body', () => {
  it('opens the body with the writer\'s core, right after the line on what the run reviewed and before the summary, never cut', () => {
    const body = bodyOf(cored(), answerWith(writerCore()));
    const reviewed = 'and changed no file.\n\n### What this change does\n\n**parse() accepts an empty file**\n\n';
    includes(body, reviewed);
    assert.ok(body.indexOf('### What this change does') < body.indexOf('### Summary'));
    assert.equal(section(body, '### What this change does'), [
      '### What this change does',
      '',
      '**parse() accepts an empty file**',
      '',
      'parse(), which reads a file into a value, now returns null for an empty file instead of throwing.',
      '',
      'Its callers check for the null.',
      '',
      `**Why.** The commit says that an empty file is a valid input. The change says so in [\`abcdef12\`](https://github.com/octo/parse/commit/${commits[0]!}), [\`src/a.ts\`](https://github.com/octo/parse/blob/${head}/src/a.ts) and [\`src/gone.ts\`](https://github.com/octo/parse/blob/${base}/src/gone.ts).`,
      '',
      '```mermaid\nflowchart LR\n  E["empty file"] --> N["null"]\n```',
      '',
      'This is deep-review\'s reading of the change, which a model wrote from its code and its commit messages; no verifier examined it.',
      '',
    ].join('\n'));
  });

  it('says that the change states no reason, and names a commit as code when the caller could not read the commits or the source begins no single commit', () => {
    includes(bodyOf(cored(), answerWith(writerCore({ why: null, whyFrom: [] }))), '\n\nThe change states no reason in its commit messages or its documents.\n\n');
    includes(bodyOf(cored(), answerWith(writerCore()), { commits: null }), 'The change says so in `abcdef1`, [`src/a.ts`]');
    includes(bodyOf(cored(), answerWith(writerCore({ whyFrom: ['abcdef'] }))), 'The change says so in `abcdef`.');
  });

  it('links a commit named in capitals or by a whole SHA-256 id at its full id, as the check of the core takes it', () => {
    const sha256 = `${'c'.repeat(8)}${'0'.repeat(56)}`;
    const body = bodyOf(cored(), answerWith(writerCore({ whyFrom: ['ABCDEF1', sha256] })), { commits: [...commits, sha256] });
    includes(body, `The change says so in [\`abcdef12\`](https://github.com/octo/parse/commit/${commits[0]!}) and [\`cccccccc\`](https://github.com/octo/parse/commit/${sha256}).`);
  });

  it('names a source of the change whose cleaning changes its path as cleaned code with no link, and counts its secret', () => {
    const secret = 'test/fixtures/ghp_abcdefghijklmnopqrstuvwxyz0123.json';
    const state = cored();
    const withSecret: RunState = { ...state, scope: { ...state.scope!, files: [...state.scope!.files, { path: secret, status: 'added', symlink: false, before: null, after: { blob: reference('s') } }] } };
    const plain = formOf(withSecret, answerWith(writerCore({ whyFrom: ['src/a.ts'] })), undefined, { commits });
    const form = formOf(withSecret, answerWith(writerCore({ whyFrom: [secret] })), undefined, { commits });
    includes(form.body, 'The change says so in `test/fixtures/[redacted GitHub token].json`.');
    excludes(form.body, 'ghp_');
    assert.equal(form.secrets - plain.secrets, 1, 'the token in the path of the source');
  });

  it('opens with the triage\'s account, marked as the triage\'s, when the writer\'s core was dropped, and says why in how far to trust it', () => {
    const state = cored(explanation(worker(60), { dropped: [{ part: 'core', failures: ['the core has no title'] }] }));
    const body = bodyOf(state, answerWith(null));
    assert.equal(section(body, '### What this change does'), [
      '### What this change does',
      '',
      `**${changeReading.title}**`,
      '',
      changeReading.what,
      '',
      `**Why, in the change's own words as deep-review's triage gave them.** ${changeReading.why} From \`${changeReading.whyFrom[0]!}\`.`,
      '',
      'This is the account of deep-review\'s triage, the first worker to read the change, written before the review, in its own words; no verifier examined it.',
      '',
    ].join('\n'));
    includes(section(body, '### How far to trust this review'), 'The writer gave no account of the change that passed deep-review\'s checks, so the review opens with the account of deep-review\'s triage.');
    excludes(body, 'answered before deep-review\'s writer gave the core');
  });

  it('opens a run configured before the core with the triage\'s account, links the sources of its reason that are of the change, and says why', () => {
    const state = withRemoved(withAccount(withReportForm(run()).fold()));
    const triage = { ...changeReading, whyFrom: ['abcdef9', 'src/a.ts', 'docs/elsewhere.md'] };
    const body = bodyOf({ ...state, review: { ...state.review!, change: { kind: 'given', reading: triage as never } } }, { ...writerAnswer(), areas: null, refuted: null, core: null, conditions: null });
    includes(body, `From [\`abcdef98\`](https://github.com/octo/parse/commit/${commits[1]!}), [\`src/a.ts\`](https://github.com/octo/parse/blob/${head}/src/a.ts) and \`docs/elsewhere.md\`.`);
    includes(section(body, '### How far to trust this review'), 'This run\'s writer answered before deep-review\'s writer gave the core of the change, so the review opens with the account of deep-review\'s triage.');
    excludes(body, 'A model wrote the explanations from the verifiers\' evidence, which the report of the run holds, and only that evidence was verified. This is');
  });

  it('says that deep-review has no account and why, for a triage that gave none and a run whose triage recorded none', () => {
    const noAccount = (kind: 'none' | 'unrecorded'): string => {
      const state = withCoreForm(run(undefined, explanation(worker(60), { dropped: [{ part: 'core', failures: ['the core has no title'] }] }))).fold();
      return section(bodyOf({ ...state, review: { ...state.review!, change: { kind } } }, answerWith(null)), '### What this change does');
    };
    assert.equal(noAccount('none'), '### What this change does\n\ndeep-review has no account of this change: its triage, the first worker to read the change, gave none.\n');
    assert.equal(noAccount('unrecorded'), '### What this change does\n\ndeep-review has no account of this change, because an engine before the account reviewed it.\n');
  });

  it('says a model wrote the review when it posts the writer\'s core alone', () => {
    const state = cored(explanation(worker(60), { dropped: [{ part: 'conclusion', failures: ['x'] }, { part: 'areas', failures: ['x'] }, { part: 'refuted', failures: ['x'] }, { part: 'finding', finding: 'RIPPLE-1', failures: ['x'] }, { part: 'finding', finding: 'SWEEP-1', failures: ['x'] }] }));
    const only: RecordedAnswer = { conclusion: null, account: null, areas: null, refuted: null, core: writerCore(), conditions: null, findings: [] };
    includes(section(bodyOf(state, only), '### How far to trust this review'), 'A model wrote the explanations');
  });

  it('writes the engine\'s words around the core in Korean, and the triage\'s account as the triage wrote it (R11)', () => {
    const inKorean = (history: Parameters<typeof withCoreForm>[0]): RunState => withRemoved(withAccount(withCoreForm(withSettings(history, { 'review.language': 'ko' }, { 'review.language': 'repository' })).fold()));
    const writer = bodyOf(inKorean(run()), answerWith(writerCore()));
    includes(writer, '### 이 변경이 하는 일\n\n**parse() accepts an empty file**');
    includes(writer, `**이유.** The commit says that an empty file is a valid input. 출처: [\`abcdef12\`](https://github.com/octo/parse/commit/${commits[0]!}), [\`src/a.ts\`]`);
    includes(writer, '이 내용은 모델이 변경의 코드와 커밋 메시지를 읽고 쓴 deep-review의 해석이며, 어떤 검증자도 검토하지 않았습니다.');
    const triage = bodyOf(inKorean(run(undefined, explanation(worker(60), { dropped: [{ part: 'core', failures: ['x'] }] }))), answerWith(null));
    includes(triage, `**deep-review의 분류 작업자(triage)가 옮긴, 변경이 밝힌 이유.** ${changeReading.why} 출처: \`${changeReading.whyFrom[0]!}\`.`);
    includes(triage, '이 내용은 변경을 가장 먼저 읽는 deep-review의 분류 작업자(triage)가 리뷰 전에 자기 말로 쓴 설명이며, 어떤 검증자도 검토하지 않았습니다.');
    includes(triage, '설명 모델이 deep-review의 검사를 통과한 변경 설명을 내지 못해, 리뷰는 deep-review 분류 작업자(triage)의 설명으로 시작합니다.');
  });
});

/** The triage's account with `change` over it. */
const reading = (change: Record<string, unknown> = {}): Record<string, unknown> => ({ ...changeReading, ...change });
/** The state with the triage's account given as `given`. */
const withReading = (state: RunState, given: Record<string, unknown>): RunState => ({ ...state, review: { ...state.review!, change: { kind: 'given', reading: given as never } } });
const needsOf = (body: string): string => section(body, '### What needs a person');
/** The decisions with SWEEP-1, a PLAUSIBLE finding no verifier examined, decided as a fix, against a written rule when `departs`. */
const plausibleFix = (departs = false): unknown[] => [decisions[0], { ...decisions[1], decision: 'fix', fix: { approach: 'extract the helper', rejected: [] }, leave: null, departure: departs ? departure : null }];
const fileAt = (commit: string, path: string): string => `[\`${path}\`](https://github.com/octo/parse/blob/${commit}/${path})`;
const interfaceInTriageWords = `- **It changes a public interface.** In the words of deep-review's triage, which its writer did not explain: parse() can now return null. Files that show it: ${fileAt(head, 'src/a.ts')}.`;

// R6, R7, R8, R12 of the core of the change on the pull request.
describe('the reasons to look in what needs a person', () => {
  it('lists the reasons to look after the questions, the departures and the answer command, which names no flag for them', () => {
    const needs = needsOf(bodyOf(withAccount(run().fold()), writerAnswer()));
    const command = needs.indexOf('The person who ran the review answers with ');
    const also = needs.indexOf('A person should also look at the change for these reasons. Nothing waits for them, and no command answers them:');
    assert.ok(needs.indexOf('**[Question on finding 2]') < command && command < also, needs);
    includes(needs.slice(also), `\n\n${interfaceInTriageWords}`);
    includes(needs, 'and one of `--option <k>`, `--accept` or `--reject`.');
  });

  it('lists the reasons to look alone, with no command, when nothing waits for an answer', () => {
    const needs = needsOf(bodyOf(withAccount(run(decisions).fold()), writerAnswer()));
    assert.equal(needs, `### What needs a person\n\nNothing here waits for an answer: deep-review asks no question, and no fix goes against a written rule. A person should still look at the change for these reasons:\n\n${interfaceInTriageWords}\n`);
  });

  it('gives the writer\'s sentence on a condition, and both sentences, marked, when the writer could not explain it from the code', () => {
    const state = withAccount(withCoreForm(run(decisions)).fold());
    const answered = (conditions: RecordedAnswer['conditions']): string => needsOf(bodyOf(state, { ...answerWith(writerCore()), conditions }));
    includes(answered([{ condition: 'public-interface', explanation: 'parse() is exported, and every caller of the package reads its result', unexplained: null }]), `- **It changes a public interface.** parse() is exported, and every caller of the package reads its result. Files that show it: ${fileAt(head, 'src/a.ts')}.`);
    includes(answered([{ condition: 'public-interface', explanation: null, unexplained: 'parse() is private to its module' }]), `- **It changes a public interface.** deep-review's triage judged so, and its writer could not explain it from the code: parse() is private to its module. The triage's words: parse() can now return null. Files that show it: ${fileAt(head, 'src/a.ts')}.`);
    includes(answered(null), interfaceInTriageWords);
  });

  it('gives a wide effect in the triage\'s words or as its label alone, and links each file at the head but one the change removed, and none that is no path of the repository', () => {
    const state = withRemoved(withReading(run(decisions).fold(), reading({ publicInterface: { holds: false, what: null, files: [] }, wideEffect: { holds: true, what: null, files: ['src/gone.ts', 'src/caller.ts', '/home/me/notes.txt'] } })));
    const needs = needsOf(bodyOf(state, writerAnswer()));
    includes(needs, `\n\n- **It affects many files beyond the ones it changes.** Files that show it: ${fileAt(base, 'src/gone.ts')}, ${fileAt(head, 'src/caller.ts')}, \``);
    excludes(needs, '/home/me');
  });

  it('names the fixes on a PLAUSIBLE verdict in one item, a fix against a written rule among them, each linked by its number', () => {
    const one = needsOf(bodyOf(withAccount(run(plausibleFix()).fold()), writerAnswer()));
    includes(one, '\n- **A fix rests on a PLAUSIBLE verdict:** finding [2](#finding-2). deep-review would change the code on a claim its verifier did not confirm; each finding says why.');
    const departing = needsOf(bodyOf(run(plausibleFix(true)).fold(), writerAnswer()));
    includes(departing, '**[Finding 2](#finding-2) is a fix against a written rule.**');
    includes(departing, '\n- **A fix rests on a PLAUSIBLE verdict:** finding [2](#finding-2).');
  });

  it('says nothing needs a person, with the triage\'s judgment that no condition holds and that no fix rests on a PLAUSIBLE verdict, only when none of the four holds', () => {
    const none = withReading(run(decisions).fold(), reading({ publicInterface: { holds: false, what: null, files: [] } }));
    assert.equal(needsOf(bodyOf(none, writerAnswer())), '### What needs a person\n\nNothing here needs a person: deep-review asks no question, no fix goes against a written rule or rests on a PLAUSIBLE verdict, and in deep-review\'s judgment the change alters no public interface and does not affect many files beyond the ones it changes.\n');
    const inKorean = withReading(withSettings(run(decisions), { 'review.language': 'ko' }, { 'review.language': 'repository' }).fold(), reading({ publicInterface: { holds: false, what: null, files: [] } }));
    includes(bodyOf(inKorean, writerAnswer()), '이 변경은 공개 인터페이스를 바꾸지 않고 바꾼 파일 밖의 많은 파일에 영향을 주지 않습니다.');
  });

  it('says a model wrote the review when it posts the writer\'s sentence on a condition alone', () => {
    const state = withAccount(withCoreForm(run(decisions, explanation(worker(60), { dropped: [{ part: 'core', failures: ['x'] }, { part: 'conclusion', failures: ['x'] }, { part: 'areas', failures: ['x'] }, { part: 'refuted', failures: ['x'] }, { part: 'finding', finding: 'RIPPLE-1', failures: ['x'] }] }))).fold());
    const only: RecordedAnswer = { conclusion: null, account: null, areas: null, refuted: null, core: null, conditions: [{ condition: 'public-interface', explanation: 'parse() is exported', unexplained: null }], findings: [] };
    includes(section(bodyOf(state, only), '### How far to trust this review'), 'A model wrote the explanations');
    includes(section(bodyOf(state, { ...only, conditions: null }), '### How far to trust this review'), 'The writer gave no account of the change');
    excludes(section(bodyOf(state, { ...only, conditions: null }), '### How far to trust this review'), 'A model wrote the explanations');
  });

  it('says in how far to trust the review that the reasons to look are in the triage\'s words when the checks dropped the writer\'s conditions, and only when a condition holds', () => {
    const note = 'The writer gave no sentences on the conditions that passed deep-review\'s checks, so the reasons to look give each condition in the words of deep-review\'s triage.';
    const trustOf = (state: RunState): string => section(bodyOf(state, { ...answerWith(writerCore()), conditions: null }), '### How far to trust this review');
    const held = withAccount(withCoreForm(run(decisions, explanation(worker(60), { dropped: [{ part: 'conditions', failures: ['x'] }] }))).fold());
    includes(needsOf(bodyOf(held, { ...answerWith(writerCore()), conditions: null })), interfaceInTriageWords);
    includes(trustOf(held), note);
    excludes(trustOf(withReading(held, reading({ publicInterface: { holds: false, what: null, files: [] } }))), note);
    excludes(trustOf(withAccount(withCoreForm(run(decisions)).fold())), note);
  });

  it('writes the reasons to look in Korean with no particle after a number', () => {
    const state = withAccount(withSettings(run(plausibleFix()), { 'review.language': 'ko' }, { 'review.language': 'repository' }).fold());
    const needs = needsOf(bodyOf(state, writerAnswer()).replace('### 사람이 해야 할 일', '### What needs a person'));
    includes(needs, '답을 기다리는 것은 없습니다. deep-review가 묻는 질문도, 명문화된 규칙과 다른 수정도 없습니다. 그래도 다음 이유로 사람이 변경을 살펴봐야 합니다.');
    includes(needs, `- **공개 인터페이스를 바꿉니다.** 설명 모델이 설명하지 않아 deep-review 분류 작업자(triage)의 말로 적습니다. parse() can now return null. 이를 보여 주는 파일: ${fileAt(head, 'src/a.ts')}.`);
    includes(needs, '- **PLAUSIBLE 판정에 기대는 수정:** 지적 사항 [2](#finding-2). deep-review는');
  });
});

