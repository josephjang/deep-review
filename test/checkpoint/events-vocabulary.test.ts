import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { angleFailedV1, attemptFailedV1, attemptFailedV2, blockerSchema, candidatesRecordedV1, unitUnattemptedV1, groupUnverifiedV1, phaseStartedV1, phaseStartedV2, recordedTextLengthV1, reviewIdentifiersV1, reviewIdentifiersV2, reviewVocabularyV1, reviewVocabularyV2, workerLostV1, workerLostV2 } from '../../src/checkpoint/events.ts';
import {
  angles,
  candidateIdSchema,
  candidatePhases,
  checkKinds,
  checkOrigins,
  checkOutcomes,
  checkPhases,
  clusterIdSchema,
  deduplicationPhases,
  editingPhases,
  finderAngles,
  fixPhases,
  fixStatuses,
  groupIdSchema,
  maxRecordedTextLength,
  phaseOutcomes,
  phases,
  recordedBlockerCodes,
  repairUnitKey,
  severities,
  suiteResults,
  unitKeySchema,
  validationMethods,
  verdicts,
  verificationPhases,
} from '../../src/review/vocabulary.ts';

// The review events freeze the vocabulary they record. If a test against
// today's vocabulary fails, the vocabulary changed: leave the frozen copies
// as they are, declare a new version of every event that carries the
// changed words, and point the test at that version's lists.
describe('the review vocabulary frozen by the v1 events', () => {
  it('is the vocabulary of the read-only review, word for word and in order, whatever today\'s says', () => {
    assert.deepEqual(reviewVocabularyV1, {
      angles: ['SCAN', 'REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'],
      finderAngles: ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'],
      phases: ['triage', 'finders', 'deduplication', 'verification', 'sweep', 'sweep-deduplication', 'sweep-verification', 'merge-rank', 'report'],
      candidatePhases: ['triage', 'finders', 'sweep'],
      deduplicationPhases: ['deduplication', 'sweep-deduplication'],
      verificationPhases: ['verification', 'sweep-verification'],
      phaseOutcomes: ['completed', 'degraded', 'blocked'],
      recordedBlockerCodes: ['worker-failed', 'budget', 'drift'],
      verdicts: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'],
      severities: ['critical', 'major', 'minor'],
    });
  });

  it('is today\'s vocabulary in every word the fix pass did not widen', () => {
    const { phases: frozenPhases, ...rest } = reviewVocabularyV1;
    assert.deepEqual(rest, { angles, finderAngles, candidatePhases, deduplicationPhases, verificationPhases, phaseOutcomes, recordedBlockerCodes, verdicts, severities });
    assert.deepEqual(frozenPhases, phases.filter((phase) => !(fixPhases as readonly string[]).includes(phase)), 'the fix pass added its five phases and nothing else');
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

// Version 2 of the review events and version 1 of the fix pass's record the
// vocabulary the fix pass widened; the same rule holds them to today's.
describe('the review vocabulary frozen by the v2 events', () => {
  it('is today\'s vocabulary, word for word and in order', () => {
    assert.deepEqual(reviewVocabularyV2, {
      phases,
      checkPhases,
      editingPhases,
      phaseOutcomes,
      recordedBlockerCodes,
      checkKinds,
      checkOrigins,
      checkOutcomes,
      fixStatuses,
      validationMethods,
      suiteResults,
    });
  });

  it('spells a cluster id and the repair\'s key as today\'s vocabulary does', () => {
    assert.deepEqual(z.toJSONSchema(reviewIdentifiersV2.clusterId), z.toJSONSchema(clusterIdSchema));
    assert.ok(reviewIdentifiersV2.repairKey.safeParse(repairUnitKey).success);
  });

  it('caps a recorded reason at the same length as version 1', () => {
    const text = (length: number): string => 'x'.repeat(length);
    const cases: [string, (value: string) => unknown][] = [
      ['attempt.failed@2 reason', (reason) => attemptFailedV2.safeParse({ phase: 'fixes', key: 'c1', workerId: '00000000-0000-4000-8000-000000000001', reason }).success],
      ['unit.unattempted@1 reason', (reason) => unitUnattemptedV1.safeParse({ phase: 'fixes', key: 'c1-1', cause: 'failures', reason }).success],
    ];
    for (const [name, accepts] of cases) {
      assert.equal(accepts(text(recordedTextLengthV1)), true, `${name} holds the cap`);
      assert.equal(accepts(text(recordedTextLengthV1 + 1)), false, `${name} refuses one more`);
    }
  });

  it('refuses a fix phase in every version 1 event that carries a phase, and accepts it in version 2', () => {
    const lost = { workerId: '00000000-0000-4000-8000-000000000001', phase: 'fixes', key: 'c1', reason: 'r' };
    assert.equal(workerLostV1.safeParse(lost).success, false);
    assert.equal(workerLostV2.safeParse(lost).success, true);
    assert.equal(phaseStartedV1.safeParse({ phase: 'repair', attempt: 1 }).success, false);
    assert.equal(phaseStartedV2.safeParse({ phase: 'repair', attempt: 1 }).success, true);
  });
});
