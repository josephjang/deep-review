import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { layers } from '../../src/config/settings.ts';
import { briefOf, findingStatuses } from '../../src/review/brief.ts';
import { pullRequestLanguages, pullRequestWords, pullRequestWordTables, type PullRequestWords } from '../../src/review/pull-request-words.ts';
import { leaveReasons, settleSteps, verdictBases } from '../../src/review/vocabulary.ts';
import { fragmentsDirectoryName, repositoryRolesRoot } from '../../src/roles/assemble.ts';
import { formOf, pullRequestRun as run, withSettings } from '../helpers/pull-request-review.ts';

/** Each text of a table that is no function, by its key, the texts of a record by `key.entry`. */
function textsOf(table: PullRequestWords): Map<string, string> {
  const texts = new Map<string, string>();
  for (const [key, value] of Object.entries(table)) {
    if (typeof value === 'string') texts.set(key, value);
    else if (typeof value === 'object') for (const [entry, text] of Object.entries(value as Record<string, string>)) texts.set(`${key}.${entry}`, text);
  }
  return texts;
}

// R20 of the review on the pull request, R15 of the review that reads as a report.
describe('the tables of the engine\'s words', () => {
  it('give every key in each language, and an entry for each status, reason, layer and basis of the vocabulary', () => {
    const english = pullRequestWordTables.en;
    for (const language of pullRequestLanguages) {
      const table = pullRequestWordTables[language];
      assert.deepEqual(Object.keys(table).sort(), Object.keys(english).sort(), language);
      for (const key of Object.keys(english) as (keyof PullRequestWords)[]) assert.equal(typeof table[key], typeof english[key], `${language} ${key}`);
      assert.deepEqual(Object.keys(table.statusSentences), [...findingStatuses], language);
      assert.deepEqual(Object.keys(table.leaveReasons), [...leaveReasons], language);
      assert.deepEqual(Object.keys(table.layers), [...layers], language);
      for (const record of [table.basisWords, table.basisSentences]) assert.deepEqual(Object.keys(record), [...verdictBases], language);
      assert.equal(table.minorColumns.length, 4, language);
    }
  });

  it('say why a PLAUSIBLE verdict was not confirmed, as two facts: a fact not settled, or a choice that remains, and that an older verdict was recorded before verifiers gave one on its own (R7)', () => {
    const { whyPlausible } = pullRequestWordTables.en;
    // The verifier gives its reason as a whole sentence, so it starts with a capital and follows a colon.
    assert.equal(whyPlausible({ kind: 'fact', text: 'Whether two requests can interleave was not run here.' }), 'Why PLAUSIBLE: one fact is not settled: Whether two requests can interleave was not run here.');
    assert.equal(whyPlausible({ kind: 'choice', text: 'which module owns the type.' }), 'Why PLAUSIBLE: the defect is there, and a choice remains: which module owns the type.');
    assert.equal(whyPlausible(null), 'Why PLAUSIBLE: this verdict was recorded before verifiers gave their reason on its own; the report of the run holds its evidence.');
    for (const language of pullRequestLanguages) assert.doesNotMatch(pullRequestWordTables[language].whyPlausible(null), /gave no reason|이유를 밝히지 않았/, language);
  });

  it('say that nothing on the branch needs to change when no finding is fixed or asked about, since a finding left as is needs no person whatever its verifier named (R1; R4, D3 of the settled choice)', () => {
    const { en, ko } = pullRequestWordTables;
    const fix = '`deep-review review --pr 42 --fix`';
    assert.equal(en.summaryNext({ fixes: 0, questions: 0, left: 2 }, fix), 'deep-review leaves 2 findings as is, so nothing on this branch needs to change.');
    assert.equal(en.summaryNext({ fixes: 0, questions: 0, left: 1 }, fix), 'deep-review leaves 1 finding as is, so nothing on this branch needs to change.');
    assert.equal(ko.summaryNext({ fixes: 0, questions: 0, left: 2 }, fix), 'deep-review의 결정은 그대로 둘 것 2건입니다. 이 브랜치에서 바꿀 것은 없습니다.');
    for (const language of pullRequestLanguages) assert.doesNotMatch(pullRequestWordTables[language].summaryNext({ fixes: 0, questions: 0, left: 2 }, fix), /What needs a person|사람이 해야 할 일/, language);
  });

  it('name each step that settles a choice in both languages, and show a settled choice, or the verifier\'s choice that deep-review did not settle, as one paragraph (R4, R5, D2 of the settled choice)', () => {
    const { en, ko } = pullRequestWordTables;
    for (const language of pullRequestLanguages) assert.deepEqual(Object.keys(pullRequestWordTables[language].settleSteps), [...settleSteps], language);
    const settled = { choice: 'An empty input gives an empty result.', step: en.settleSteps.intent, source: 'The change says so.' };
    assert.equal(en.choice({ verifier: null, settled }), '**The choice.** deep-review settles a choice: An empty input gives an empty result. What settles it: the stated intent of the change. The change says so.');
    assert.equal(en.choice({ verifier: 'Throw or return null.', settled }), '**The choice.** Its verifier left this choice to the author: Throw or return null. deep-review settles it: An empty input gives an empty result. What settles it: the stated intent of the change. The change says so.');
    assert.equal(en.choice({ verifier: 'Throw or return null.', settled: null }), '**The choice.** Its verifier left this choice to the author: Throw or return null. deep-review did not settle it.');
    assert.equal(ko.choice({ verifier: 'Throw or return null.', settled: null }), '**선택.** 검증자는 작성자가 정할 선택을 남겼습니다: Throw or return null. deep-review는 이 선택을 정하지 않았습니다.');
    assert.equal(ko.choice({ verifier: null, settled: { ...settled, step: ko.settleSteps.shape } }), '**선택.** deep-review가 정한 선택: An empty input gives an empty result. 정한 근거: 주변 코드가 이미 쓰는 형태, 없으면 덜 더하는 형태. The change says so.');
  });

  it('word a cut that keeps some findings left as is apart from one that takes them all (D9 of the settled choice)', () => {
    const { en, ko } = pullRequestWordTables;
    assert.equal(en.leftOthersCut(1), 'To fit the length GitHub takes, the other finding left as is is not listed here; the report of the run holds it.');
    assert.equal(en.leftOthersCut(3), 'To fit the length GitHub takes, the other 3 findings left as is are not listed here; the report of the run holds each.');
    assert.equal(ko.leftOthersCut(3), 'GitHub가 받는 길이에 맞추느라 그대로 둔 나머지 지적 사항 3건은 여기에 적지 않았습니다. 실행 보고서에 모두 있습니다.');
    for (const language of pullRequestLanguages) assert.notEqual(pullRequestWordTables[language].leftOthersCut(2), pullRequestWordTables[language].leftCut(2), language);
  });

  it('name the option recommended and the one that stands as two facts, and one option once (R8)', () => {
    const { standing } = pullRequestWordTables.en;
    assert.equal(standing(2, 1, false, null), 'deep-review recommends option 2. Until someone answers, option 1 stands, the easiest to take back: the code stays as it is.');
    assert.equal(standing(1, 1, true, 'Reject it.'), 'deep-review recommends option 1: Reject it. It also stands until someone answers: `--fix` applies it.');
  });

  it('take English for a language with no table, and a table by the primary subtag of a tag', () => {
    assert.equal(pullRequestWords('en'), pullRequestWordTables.en);
    assert.equal(pullRequestWords('fr'), pullRequestWordTables.en);
    assert.equal(pullRequestWords('pt-BR'), pullRequestWordTables.en);
    assert.equal(pullRequestWords('ko'), pullRequestWordTables.ko);
    assert.equal(pullRequestWords('ko-KR'), pullRequestWordTables.ko);
    assert.equal(pullRequestWords('KO'), pullRequestWordTables.ko);
  });

  it('hold no character people rarely type: no long dash, middle dot or ellipsis', () => {
    for (const language of pullRequestLanguages) {
      for (const [key, text] of textsOf(pullRequestWordTables[language])) assert.doesNotMatch(text, /[–—·…]/, `${language} ${key}`);
      assert.doesNotMatch(pullRequestWordTables[language].howDiagram(42), /[–—·…]/, language);
    }
  });
});

describe('a review in the language the run recorded (R15)', () => {
  const inLanguage = (language: string) => withSettings(run(), { 'review.language': language }, { 'review.language': 'repository' }).fold();
  const english = formOf(inLanguage('en'));
  const korean = formOf(inLanguage('ko'));
  const textOf = (form: typeof english): string => [form.body, ...form.comments.map((comment) => comment.body)].join('\n');

  it('takes every sentence of the form from the Korean table', () => {
    const text = textOf(korean);
    for (const [key, sentence] of textsOf(pullRequestWordTables.en)) {
      // A word the two tables share, such as a heading's `#`, is no sentence of English.
      if (sentence === textsOf(pullRequestWordTables.ko).get(key)) continue;
      assert.ok(!text.includes(sentence), `the English ${key}, ${JSON.stringify(sentence)}`);
    }
    const englishWords = ['What goes wrong', 'What deep-review would do', 'deep-review would', 'The fix as decided', 'How the verifier checked it', 'Code at the reviewed head', 'Question on finding', 'against a written rule', 'The review keeps', 'Here 5 candidates', 'Why PLAUSIBLE', 'The person who ran', 'A reply on this pull request', 'Reviewed by deep-review', 'Rejected:', 'Refuted:', 'of run `run-1`', 'major findings', 'minor finding', 'Finding 2'];
    for (const word of englishWords) assert.ok(!text.includes(word), word);
    assert.match(korean.body, /^## deep-review의 풀 리퀘스트 리뷰$/m);
    assert.match(korean.body, /^deep-review가 이 풀 리퀘스트를 head `22222222`에서 리뷰했습니다\. merge base `11111111`부터 바뀐 파일 1개를 보았으며, 파일은 하나도 바꾸지 않았습니다\.$/m);
    assert.match(korean.body, /^\*\*deep-review가 고치거나 묻는 major 지적 사항\.\*\*$/m, 'the area of an older run, in Korean');
    assert.match(korean.body, /^### 지적 사항 2: extract the helper$/m);
    assert.match(korean.comments[0]!.body, /^심각도 Major\. CONFIRMED, 코드를 따라가 확인함\. deep-review가 명문화된 규칙과 다르게 고치려 합니다\.$/m);
  });

  it('gives each gap of the brief in English, and says so in Korean', () => {
    const gaps = briefOf(inLanguage('ko')).notExamined;
    assert.ok(gaps.length > 0);
    for (const gap of gaps) assert.ok(korean.body.includes(`- ${gap.text} (실행 기록의 원문 그대로 영어로 적습니다)`), gap.text);
  });

  it('keeps the verdicts, the severities, the identifiers, the paths and the commands the same in each language', () => {
    const tokens = (form: typeof english): string[] => [...textOf(form).matchAll(/`[^`\n]*deep-review answer[^`\n]*`|\b(?:CONFIRMED|PLAUSIBLE|REFUTED|critical|major|minor|RIPPLE-\d|SWEEP-\d)\b|src\/[a-z]+\.ts(?::\d+(?:-\d+)?)?/g)].map((match) => match[0]);
    // The verdict cell of each row of the minor table, without its mark, which is in the language of the table.
    const rows = (form: typeof english): string[] => form.body.split('\n').filter((line) => /^\| \d/.test(line)).map((line) => line.split(' | ')[2]!.split(', ')[0]!);
    assert.deepEqual(rows(korean), rows(english));
    assert.deepEqual(rows(korean), ['PLAUSIBLE']);
    assert.deepEqual(new Set(tokens(korean)), new Set(tokens(english)));
    assert.deepEqual(korean.comments.map(({ finding, path, line }) => [finding, path, line]), english.comments.map(({ finding, path, line }) => [finding, path, line]));
  });

  it('keeps the engine\'s words in English for a language with no table', () => {
    const french = formOf(inLanguage('fr'));
    assert.equal(french.body, english.body);
  });

  it('define the three values a severity is read from, each one the rubric defines, in its order, in every language (finding 23 of the review of the severity rubric)', () => {
    const list = readFileSync(join(repositoryRolesRoot(), fragmentsDirectoryName, 'phase4-list.md'), 'utf8');
    const values = [...list.matchAll(/^- `([a-z-]+)`: /gm)].map((match) => match[1]);
    assert.equal(values.length, 10, 'the rubric defines ten values');
    for (const language of pullRequestLanguages) {
      assert.deepEqual([...pullRequestWordTables[language].severityValues.matchAll(/`([a-z-]+)`/g)].map((match) => match[1]), values, language);
    }
  });
});
