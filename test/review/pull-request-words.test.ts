import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { layers } from '../../src/config/settings.ts';
import { briefOf, findingStatuses } from '../../src/review/brief.ts';
import { pullRequestLanguages, pullRequestWords, pullRequestWordTables, type PullRequestWords } from '../../src/review/pull-request-words.ts';
import { leaveReasons, verdictBases } from '../../src/review/vocabulary.ts';
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

  it('say why a PLAUSIBLE verdict was not confirmed, as two facts: a fact not settled, or a choice that remains, and that the verifier gave no reason (R7)', () => {
    const { whyPlausible } = pullRequestWordTables.en;
    // The verifier gives its reason as a whole sentence, so it starts with a capital and follows a colon.
    assert.equal(whyPlausible({ kind: 'fact', text: 'Whether two requests can interleave was not run here.' }), 'Why PLAUSIBLE: one fact is not settled: Whether two requests can interleave was not run here.');
    assert.equal(whyPlausible({ kind: 'choice', text: 'which module owns the type.' }), 'Why PLAUSIBLE: the defect is there, and a choice remains: which module owns the type.');
    assert.equal(whyPlausible(null), 'Why PLAUSIBLE: the verifier gave no reason.');
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
    assert.match(korean.comments[0]!.body, /^심각도 major\. CONFIRMED, 코드를 따라가 확인함\. deep-review가 명문화된 규칙과 다르게 고치려 합니다\.$/m);
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
});
