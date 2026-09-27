import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { candidatesRecordedV1, reviewIdentifiersV1, reviewVocabularyV1 } from '../../src/checkpoint/events.ts';
import {
  angles,
  candidateIdSchema,
  candidatePhases,
  deduplicationPhases,
  finderAngles,
  groupIdSchema,
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

  it('holds candidates.recorded@1 to the frozen count of finder angles, whatever the vocabulary says', () => {
    const leads = reviewVocabularyV1.finderAngles.map((angle) => ({ angle, lead: null }));
    const triage = { phase: 'triage', key: 'SCAN', workerId: '00000000-0000-4000-8000-000000000001', candidates: [] };
    assert.equal(candidatesRecordedV1.safeParse({ ...triage, leads }).success, true);
    assert.equal(candidatesRecordedV1.safeParse({ ...triage, leads: leads.slice(1) }).success, false, 'one lead short');
    assert.equal(candidatesRecordedV1.safeParse({ ...triage, leads: [...leads.slice(1), leads[1]] }).success, false, 'one angle twice');
    assert.equal(candidatesRecordedV1.safeParse({ ...triage, leads: [...leads, { angle: 'SCAN', lead: null }] }).success, false, 'SCAN is no finder angle');
  });
});
