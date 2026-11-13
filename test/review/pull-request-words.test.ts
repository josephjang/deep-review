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

/** Each text of a table, by its key, the texts of a record by `key.entry`; `naming`, the one entry of functions, left out. */
function textsOf(table: PullRequestWords): Map<string, string> {
  const texts = new Map<string, string>();
  for (const [key, value] of Object.entries(table)) {
    if (key === 'naming') continue;
    if (typeof value === 'string') texts.set(key, value);
    else for (const [entry, text] of Object.entries(value as Record<string, unknown>)) texts.set(`${key}.${entry}`, text as string);
  }
  return texts;
}

// R20 of the review on the pull request; R9, TD4 of the review in the writer's words.
describe('the tables of the engine\'s words', () => {
  it('give every key in each language, and an entry for each status, reason, layer, basis, step and gap of the vocabulary', () => {
    const english = pullRequestWordTables.en;
    for (const language of pullRequestLanguages) {
      const table = pullRequestWordTables[language];
      assert.deepEqual(Object.keys(table).sort(), Object.keys(english).sort(), language);
      for (const key of Object.keys(english) as (keyof PullRequestWords)[]) {
        if (typeof english[key] === 'object') assert.deepEqual(Object.keys(table[key]).sort(), Object.keys(english[key]).sort(), `${language} ${key}`);
      }
      assert.deepEqual(Object.keys(table.statusValues), [...findingStatuses], language);
      assert.deepEqual(Object.keys(table.leaveReasons), [...leaveReasons], language);
      assert.deepEqual(Object.keys(table.layers), [...layers], language);
      assert.deepEqual(Object.keys(table.settleSteps), [...settleSteps], language);
      for (const record of [table.basisValues, table.basisNotices]) assert.deepEqual(Object.keys(record), [...verdictBases], language);
    }
  });

  it('hold a string in every entry but `naming`, so no entry takes a number or a text and builds a sentence of the run around it (TD4)', () => {
    for (const language of pullRequestLanguages) {
      for (const [key, value] of Object.entries(pullRequestWordTables[language])) {
        if (key === 'naming') continue;
        if (typeof value === 'string') continue;
        assert.equal(typeof value, 'object', `${language} ${key}`);
        for (const [entry, text] of Object.entries(value as Record<string, unknown>)) assert.equal(typeof text, 'string', `${language} ${key}.${entry}`);
      }
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

  it('hold no node text of the diagram that a Mermaid label cannot hold: no quote, semicolon or entity', () => {
    for (const language of pullRequestLanguages) {
      for (const [entry, text] of Object.entries(pullRequestWordTables[language].diagram)) assert.doesNotMatch(text, /["";&]/, `${language} ${entry}`);
    }
  });
});

describe('a review in the language the run recorded (R15)', () => {
  const inLanguage = (language: string) => withSettings(run(), { 'review.language': language }, { 'review.language': 'repository' }).fold();
  const english = formOf(inLanguage('en'));
  const korean = formOf(inLanguage('ko'));
  const textOf = (form: typeof english): string => [form.body, ...form.comments.map((comment) => comment.body)].join('\n');

  it('takes every label and notice of the form from the Korean table', () => {
    const text = textOf(korean);
    const koreanTexts = textsOf(pullRequestWordTables.ko);
    for (const [key, word] of textsOf(pullRequestWordTables.en)) {
      // A word the two tables share, such as a heading's `#` or a severity, is no English of the table's own.
      if (word === koreanTexts.get(key) || word.length < 8) continue;
      assert.ok(!text.includes(word), `the English ${key}, ${JSON.stringify(word)}`);
    }
    assert.match(korean.body, /^## deep-review의 풀 리퀘스트 리뷰$/m);
    assert.match(korean.body, /^Head: `22222222`\. Merge base: `11111111`\. 바뀐 파일: 1\. 리뷰 뒤: 바꾼 파일 없음\.$/m);
    assert.match(korean.body, /^\*\*deep-review가 고치거나 묻는 major 지적 사항\.\*\*$/m, 'the area of an answer with none, in Korean');
    assert.match(korean.body, /^### 지적 사항 2$/m);
    assert.match(korean.comments[0]!.body, /^심각도: major\. 판정: CONFIRMED\. 확인 방법: 코드를 따라가 확인함\. 결정: 명문화된 규칙과 다르게 고침\.$/m);
  });

  it('gives each gap of the brief as facts under the Korean label of its kind, and no English sentence of the brief', () => {
    const gaps = briefOf(inLanguage('ko')).notExamined;
    assert.ok(gaps.length > 0);
    for (const gap of gaps) {
      assert.ok(!korean.body.includes(gap.text), gap.text);
      assert.ok(korean.body.includes(`- ${pullRequestWordTables.ko.gapLabels[gap.facts.kind]}: `), gap.facts.kind);
    }
  });

  it('keeps the verdicts, the severities, the identifiers, the paths and the commands the same in each language', () => {
    const tokens = (form: typeof english): string[] => [...textOf(form).matchAll(/`[^`\n]*deep-review answer[^`\n]*`|\b(?:CONFIRMED|PLAUSIBLE|REFUTED|critical|major|minor|RIPPLE-\d|SWEEP-\d)\b|src\/[a-z]+\.ts(?::\d+(?:-\d+)?)?/g)].map((match) => match[0]);
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
