import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { angleFailedV1, attemptFailedV1, blockerSchema, candidatesRecordedV1, groupUnverifiedV1, recordedTextLengthV1, reviewIdentifiersV1, reviewVocabularyV1 } from '../../src/checkpoint/events.ts';
import {
  angles,
  candidateIdSchema,
  candidatePhases,
  deduplicationPhases,
  finderAngles,
  groupIdSchema,
  maxRecordedTextLength,
  phaseOutcomes,
  phases,
  recordedBlockerCodes,
  severities,
  unitKeySchema,
  verdicts,
  verificationPhases,
} from '../../src/review/vocabulary.ts';

// The v1 review events freeze the vocabulary they record. If one of these
// fails, the vocabulary changed: leave reviewVocabularyV1 as it is, declare
// a new version of every event that carries the changed words, and point
// this test at that version's lists.
describe('the review vocabulary frozen by the v1 events', () => {
  it('is today\'s vocabulary, word for word and in order', () => {
    assert.deepEqual(reviewVocabularyV1, {
      angles,
      finderAngles,
      phases,
      candidatePhases,
      deduplicationPhases,
      verificationPhases,
      phaseOutcomes,
      recordedBlockerCodes,
      verdicts,
      severities,
    });
  });

  it('spells candidate ids, group ids and unit keys as today\'s vocabulary does', () => {
    assert.deepEqual(z.toJSONSchema(reviewIdentifiersV1.candidateId), z.toJSONSchema(candidateIdSchema));
    assert.deepEqual(z.toJSONSchema(reviewIdentifiersV1.groupId), z.toJSONSchema(groupIdSchema));
    assert.deepEqual(z.toJSONSchema(reviewIdentifiersV1.unitKey), z.toJSONSchema(unitKeySchema));
  });

  it('caps a recorded reason or detail at the length the engine cuts its text to', () => {
    assert.equal(recordedTextLengthV1, maxRecordedTextLength);
    const text = (length: number): string => 'x'.repeat(length);
    const cases: [string, (value: string) => unknown][] = [
      ['attempt.failed@1 reason', (reason) => attemptFailedV1.safeParse({ phase: 'triage', key: 'SCAN', workerId: '00000000-0000-4000-8000-000000000001', reason }).success],
      ['angle.failed@1 reason', (reason) => angleFailedV1.safeParse({ angle: 'RIPPLE', reason }).success],
      ['group.unverified@1 reason', (reason) => groupUnverifiedV1.safeParse({ phase: 'verification', groupId: 'g1', reason }).success],
      ['a blocker detail', (detail) => blockerSchema.safeParse({ code: 'drift', detail, action: 'restore it' }).success],
    ];
    for (const [name, accepts] of cases) {
      assert.equal(accepts(text(recordedTextLengthV1)), true, `${name} holds the cap`);
      assert.equal(accepts(text(recordedTextLengthV1 + 1)), false, `${name} refuses one more`);
      assert.equal(accepts(''), false, `${name} refuses empty text`);
    }
  });

  it('holds candidates.recorded@1 to the frozen count of finder angles, whatever the vocabulary says', () => {
    const leads = reviewVocabularyV1.finderAngles.map((angle) => ({ angle, lead: null }));
    const triage = { phase: 'triage', key: 'SCAN', workerId: '00000000-0000-4000-8000-000000000001', candidates: [] };
    assert.equal(candidatesRecordedV1.safeParse({ ...triage, leads }).success, true);
    assert.equal(candidatesRecordedV1.safeParse({ ...triage, leads: leads.slice(1) }).success, false, 'one lead short');
    assert.equal(candidatesRecordedV1.safeParse({ ...triage, leads: [...leads.slice(1), leads[1]] }).success, false, 'one angle twice');
    assert.equal(candidatesRecordedV1.safeParse({ ...triage, leads: [...leads, { angle: 'SCAN', lead: null }] }).success, false, 'SCAN is no finder angle');
  });
});
