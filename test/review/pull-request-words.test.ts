import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { layers } from '../../src/config/settings.ts';
import { findingStatuses } from '../../src/review/brief.ts';
import { pullRequestLanguages, pullRequestWords, pullRequestWordTables, type PullRequestWords } from '../../src/review/pull-request-words.ts';
import { leaveReasons, severities, verdictBases, verdicts } from '../../src/review/vocabulary.ts';

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
