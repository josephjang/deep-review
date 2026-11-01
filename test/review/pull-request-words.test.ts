import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { layers } from '../../src/config/settings.ts';
import { briefOf, findingStatuses } from '../../src/review/brief.ts';
import { pullRequestLanguages, pullRequestWords, pullRequestWordTables, type PullRequestWords } from '../../src/review/pull-request-words.ts';
import { leaveReasons, severities, verdictBases, verdicts } from '../../src/review/vocabulary.ts';
import { formOf, pullRequestRun as run, withAccount, withSettings } from '../helpers/pull-request-review.ts';

/** Each text of a table that is no function, by its key, the texts of a record by `key.entry`. */
function textsOf(table: PullRequestWords): Map<string, string> {
  const texts = new Map<string, string>();
  for (const [key, value] of Object.entries(table)) {
    if (typeof value === 'string') texts.set(key, value);
    else if (typeof value === 'object') for (const [entry, text] of Object.entries(value as Record<string, string>)) texts.set(`${key}.${entry}`, text);
  }
  return texts;
}

// R20 of the review on the pull request.
describe('the tables of the engine\'s words', () => {
  it('give every key in each language, and an entry for each verdict, severity, status, reason, layer and basis of the vocabulary', () => {
    const english = pullRequestWordTables.en;
    for (const language of pullRequestLanguages) {
      const table = pullRequestWordTables[language];
      assert.deepEqual(Object.keys(table).sort(), Object.keys(english).sort(), language);
      for (const key of Object.keys(english) as (keyof PullRequestWords)[]) assert.equal(typeof table[key], typeof english[key], `${language} ${key}`);
      assert.deepEqual(Object.keys(table.verdicts), [...verdicts], language);
      assert.deepEqual(Object.keys(table.severities), [...severities], language);
      for (const record of [table.statuses, table.statusSentences, table.statusLegend]) assert.deepEqual(Object.keys(record), [...findingStatuses], language);
      assert.deepEqual(Object.keys(table.leaveReasons), [...leaveReasons], language);
      assert.deepEqual(Object.keys(table.layers), [...layers], language);
      assert.deepEqual(Object.keys(table.basisWords), [...verdictBases], language);
      assert.equal(table.columns.length, 6, language);
    }
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
      for (const [key, text] of textsOf(pullRequestWordTables[language])) assert.doesNotMatch(text, /[\u2013\u2014\u00b7\u2026]/, `${language} ${key}`);
    }
  });
});

describe('a review in the language the run recorded (R20)', () => {
  const inLanguage = (language: string) => withAccount(withSettings(run(), { 'review.language': language }, { 'review.language': 'repository' }).fold());
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
    for (const word of ['Before the merge', 'deep-review would fix this', 'deep-review asks', 'The person who ran this review', 'A reply on this pull request', 'Evidence that', 'How the verifier', 'Reviewed by deep-review', 'Option ', 'Rejected:']) assert.ok(!text.includes(word), word);
    assert.match(korean.body, /^## deep-review의 풀 리퀘스트 리뷰 \(실행 `run-1`, head `22222222`\)$/m);
    assert.match(korean.body, /^\*\*병합 전에 필요한 것: 수정 1건, 질문 1건\*\*$/m);
    assert.match(korean.body, /^deep-review가 이 풀 리퀘스트를 head `22222222`에서 리뷰했으며, 파일은 바꾸지 않았습니다\. 지적 사항은 모두 2건입니다\. 고칠 대상 1건\(그중 명문화된 규칙과 다르게 고칠 것 1건\), 질문 1건\.$/m);
  });

  it('gives each gap of the brief in English', () => {
    const gaps = briefOf(inLanguage('ko')).notExamined;
    assert.ok(gaps.length > 0);
    for (const gap of gaps) assert.ok(korean.body.includes(`- ${gap.text}`), gap.text);
  });

  it('keeps the verdicts, the severities, the identifiers, the paths and the commands the same in each language', () => {
    const tokens = (form: typeof english): string[] => [...textOf(form).matchAll(/`[^`\n]*deep-review answer[^`\n]*`|\b(?:CONFIRMED|PLAUSIBLE|REFUTED|critical|major|minor|RIPPLE-\d|SWEEP-\d)\b|src\/[a-z]+\.ts(?::\d+(?:-\d+)?)?/g)].map((match) => match[0]);
    // The cells of the severity and the verdict, the verdict without its mark, which is in the language of the table.
    const rows = (form: typeof english): string[][] => form.body.split('\n').filter((line) => /^\| \[\d/.test(line)).map((line) => [line.split(' | ')[1]!, line.split(' | ')[2]!.split(', ')[0]!]);
    assert.deepEqual(rows(korean), rows(english));
    assert.deepEqual(rows(korean), [['major', 'CONFIRMED'], ['minor', 'PLAUSIBLE']]);
    assert.deepEqual(new Set(tokens(korean)), new Set(tokens(english)));
    assert.deepEqual(korean.comments.map(({ finding, path, line }) => [finding, path, line]), english.comments.map(({ finding, path, line }) => [finding, path, line]));
  });

  it('keeps the engine\'s words in English for a language with no table', () => {
    const french = formOf(inLanguage('fr'));
    assert.equal(french.body, english.body);
  });
});
