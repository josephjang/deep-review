import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { passKey, passNumber, passOf, type AnswerPass } from '../../src/checkpoint/answer-state.ts';
import type { ReportWritten } from '../../src/checkpoint/events.ts';

/** An answer pass over `ids`; the report it took the place of plays no part in finding it. */
const pass = (...ids: string[]): AnswerPass => ({ ids, at: '2026-10-12T00:00:00.000Z', reportBefore: {} as ReportWritten, openedAt: { answer: 0, checks: 0 } });

describe('answer pass keys', () => {
  it('reads back the number of every key passKey spells', () => {
    for (const n of [1, 2, 9, 10, 123]) assert.equal(passNumber(passKey(n)), n);
  });

  it('reads no number from a key passKey does not spell', () => {
    for (const key of ['pass-0', 'pass-01', 'pass-', 'pass-1a', 'pass-1.5', 'pass--1', ' pass-1', 'pass-1 ', 'c1-1', 'PASS-1', '']) assert.equal(passNumber(key), null, key);
  });

  it('finds the pass a key names by its number', () => {
    const passes = [pass('A-1'), pass('B-1'), pass('C-1')];
    assert.equal(passOf({ answerPasses: passes }, passKey(1)), passes[0]);
    assert.equal(passOf({ answerPasses: passes }, passKey(3)), passes[2]);
  });

  it('finds no pass for a number past the last pass, or for a key that is no pass key', () => {
    const passes = [pass('A-1')];
    assert.equal(passOf({ answerPasses: passes }, passKey(2)), null);
    assert.equal(passOf({ answerPasses: [] }, passKey(1)), null);
    assert.equal(passOf({ answerPasses: passes }, 'pass-01'), null);
    assert.equal(passOf({ answerPasses: passes }, 'c1-1'), null);
  });
});
