import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import {
  angleFailedV1,
  attemptFailedV1,
  attemptFailedV2,
  attemptFailedV3,
  attemptFailedV4,
  blockerSchema,
  blockerSchemaV3,
  candidatesRecordedV1,
  decisionsRecordedV1,
  groupUnverifiedV1,
  phaseFinishedV2,
  phaseFinishedV3,
  phaseFinishedV4,
  phaseStartedV1,
  phaseStartedV2,
  phaseStartedV3,
  phaseStartedV4,
  recordedDecisionSchema,
  recordedTextLengthV1,
  reportWrittenV2,
  reportWrittenV3,
  reportWrittenV4,
  reviewConfiguredV4,
  reviewConfiguredV5,
  reviewIdentifiersV1,
  reviewIdentifiersV2,
  reviewVocabularyV1,
  reviewVocabularyV2,
  reviewVocabularyV3,
  reviewVocabularyV4,
  surveyFailedV1,
  unitUnattemptedV1,
  workerLostV1,
  workerLostV2,
  workerLostV3,
  workerLostV4,
  worktreeCheckedV2,
  worktreeCheckedV3,
  worktreeCheckedV4,
} from '../../src/checkpoint/events.ts';
import { hintRules } from '../../src/review/checks/discover.ts';
import {
  angles,
  candidateIdSchema,
  candidatePhases,
  checkBases,
  checkKinds,
  checkOrigins,
  checkOutcomes,
  checkPhases,
  clusterIdSchema,
  conventionLevels,
  decisionKinds,
  deduplicationPhases,
  editingPhases,
  finderAngles,
  fixPhases,
  fixStatuses,
  groupIdSchema,
  leaveReasons,
  maxRecordedTextLength,
  phaseOutcomes,
  phases,
  recordedBlockerCodes,
  repairUnitKey,
  severities,
  suiteResults,
  unitKeySchema,
  userRulesSettings,
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

  it('is today\'s vocabulary in every word the fix pass and the survey did not widen', () => {
    const { phases: frozenPhases, recordedBlockerCodes: frozenCodes, ...rest } = reviewVocabularyV1;
    assert.deepEqual(rest, { angles, finderAngles, candidatePhases, deduplicationPhases, verificationPhases, phaseOutcomes, verdicts, severities });
    assert.deepEqual(frozenPhases, phases.filter((phase) => !(fixPhases as readonly string[]).includes(phase) && phase !== 'survey' && phase !== 'decision'), 'the fix pass added its five phases, the survey and the decision step one each, and nothing else');
    assert.deepEqual(frozenCodes, recordedBlockerCodes.filter((code) => code !== 'check-unavailable'), 'the survey added its blocker code and nothing else');
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
  it('is the vocabulary of the fix pass, word for word and in order, whatever today\'s says', () => {
    assert.deepEqual(reviewVocabularyV2, {
      phases: [
        'triage', 'finders', 'deduplication', 'verification', 'sweep', 'sweep-deduplication', 'sweep-verification', 'merge-rank',
        'baseline-checks', 'fixes', 'checks', 'repair', 'repair-checks',
        'report',
      ],
      checkPhases: ['baseline-checks', 'checks', 'repair-checks'],
      editingPhases: ['fixes', 'repair'],
      phaseOutcomes: ['completed', 'degraded', 'blocked'],
      recordedBlockerCodes: ['worker-failed', 'budget', 'drift'],
      checkKinds: ['build', 'typecheck', 'lint', 'test'],
      checkOrigins: ['flag', 'taskfile', 'makefile', 'justfile', 'package', 'language', 'none'],
      checkOutcomes: ['passed', 'failed', 'timeout', 'not-started', 'skipped'],
      fixStatuses: ['applied', 'already-applied', 'deferred', 'blocked'],
      validationMethods: ['old-code', 'mutation', 'static', 'existing', 'limited'],
      suiteResults: ['pass', 'fail', 'not-run'],
    });
  });

  it('is today\'s vocabulary in every word the survey did not change, and its rules are the hints\' rules', () => {
    const { phases: frozenPhases, recordedBlockerCodes: frozenCodes, checkOrigins: frozenOrigins, ...rest } = reviewVocabularyV2;
    assert.deepEqual(rest, { checkPhases, editingPhases, phaseOutcomes, checkKinds, checkOutcomes, fixStatuses, validationMethods, suiteResults });
    assert.deepEqual(frozenPhases, phases.filter((phase) => phase !== 'survey' && phase !== 'decision'), 'the survey and the decision step added a phase each, and nothing else');
    assert.deepEqual(frozenCodes, recordedBlockerCodes.filter((code) => code !== 'check-unavailable'));
    // The origins a version 1 plan records are the flag and the manifest rules, which live on as the rules a hint names.
    assert.deepEqual(frozenOrigins, ['flag', ...hintRules]);
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

// Version 3 of the review events and version 1 of the survey's record the
// vocabulary the survey widened; the same rule holds them to today's.
describe('the review vocabulary frozen by the v3 events', () => {
  it('is the vocabulary of the survey, word for word and in order, whatever today\'s says', () => {
    assert.deepEqual(reviewVocabularyV3, {
      phases: [
        'survey',
        'triage', 'finders', 'deduplication', 'verification', 'sweep', 'sweep-deduplication', 'sweep-verification', 'merge-rank',
        'baseline-checks', 'fixes', 'checks', 'repair', 'repair-checks',
        'report',
      ],
      phaseOutcomes: ['completed', 'degraded', 'blocked'],
      recordedBlockerCodes: ['worker-failed', 'budget', 'drift', 'check-unavailable'],
      checkKinds: ['build', 'typecheck', 'lint', 'test'],
      checkOrigins: ['flag', 'survey', 'none'],
      checkBases: ['stated', 'hint'],
      conventionLevels: ['repository', 'user'],
      userRulesSettings: ['ignore', 'apply', 'judge'],
    });
  });

  it('is today\'s vocabulary in every word the decision step did not widen', () => {
    const { phases: frozenPhases, ...rest } = reviewVocabularyV3;
    assert.deepEqual(rest, { phaseOutcomes, recordedBlockerCodes, checkKinds, checkOrigins, checkBases, conventionLevels, userRulesSettings });
    assert.deepEqual(frozenPhases, phases.filter((phase) => phase !== 'decision'), 'the decision step added its phase and nothing else');
  });

  it('caps a recorded reason at the same length as version 1', () => {
    const text = (length: number): string => 'x'.repeat(length);
    const cases: [string, (value: string) => unknown][] = [
      ['attempt.failed@3 reason', (reason) => attemptFailedV3.safeParse({ phase: 'survey', key: 'survey', workerId: '00000000-0000-4000-8000-000000000001', reason }).success],
      ['survey.failed@1 reason', (reason) => surveyFailedV1.safeParse({ reason, conventions: [], userRules: [] }).success],
      ['a version 3 blocker detail', (detail) => blockerSchemaV3.safeParse({ code: 'check-unavailable', detail, action: 'install it' }).success],
    ];
    for (const [name, accepts] of cases) {
      assert.equal(accepts(text(recordedTextLengthV1)), true, `${name} holds the cap`);
      assert.equal(accepts(text(recordedTextLengthV1 + 1)), false, `${name} refuses one more`);
    }
  });

  it('refuses the survey in every version 2 event that carries a phase, and accepts it in version 3', () => {
    const workerId = '00000000-0000-4000-8000-000000000001';
    const check = { attempt: 1, moment: 'start', drifted: false, head: null, files: [], strays: [] };
    const spend = { workers: 1, seconds: 1, costUsd: null, costUnreported: null, inputTokens: null, cachedInputTokens: null, outputTokens: null };
    const report = { report: { sha256: 'a'.repeat(64), bytes: 1 }, statistics: { phases: [{ phase: 'survey', ...spend }], total: spend, budgetApplied: false }, patches: [] };
    const cases: [string, z.ZodType, z.ZodType, unknown][] = [
      ['phase.started', phaseStartedV2, phaseStartedV3, { phase: 'survey', attempt: 1 }],
      ['phase.finished', phaseFinishedV2, phaseFinishedV3, { phase: 'survey', attempt: 1, outcome: 'completed', blocker: null }],
      ['worktree.checked', worktreeCheckedV2, worktreeCheckedV3, { phase: 'survey', ...check }],
      ['attempt.failed', attemptFailedV2, attemptFailedV3, { phase: 'survey', key: 'survey', workerId, reason: 'r' }],
      ['worker.lost', workerLostV2, workerLostV3, { workerId, phase: 'survey', key: 'survey', reason: 'r' }],
      ['report.written', reportWrittenV2, reportWrittenV3, report],
    ];
    for (const [kind, older, newer, payload] of cases) {
      assert.equal(older.safeParse(payload).success, false, `${kind}@2 refuses the survey`);
      assert.equal(newer.safeParse(payload).success, true, `${kind}@3 accepts it`);
    }
  });

  it('records check-unavailable only from version 3 of phase.finished', () => {
    const blocked = { phase: 'survey', attempt: 1, outcome: 'blocked', blocker: { code: 'check-unavailable', detail: 'lint: ruff not found', action: 'install it' } };
    assert.equal(phaseFinishedV2.safeParse({ ...blocked, phase: 'triage' }).success, false);
    assert.equal(phaseFinishedV3.safeParse(blocked).success, true);
  });
});

// Version 4 of the review events and version 1 of the decision step's
// record the vocabulary the decision step widened; the same rule holds
// them to today's.
describe('the review vocabulary frozen by the v4 events', () => {
  const workerId = '00000000-0000-4000-8000-000000000001';

  it('is today\'s vocabulary, word for word and in order', () => {
    assert.deepEqual(reviewVocabularyV4, { phases, decisionKinds, leaveReasons });
  });

  it('caps a recorded reason at the same length as version 1', () => {
    const text = (length: number): string => 'x'.repeat(length);
    const cases: [string, (value: string) => unknown][] = [
      ['attempt.failed@4 reason', (reason) => attemptFailedV4.safeParse({ phase: 'decision', key: 'decision', workerId, reason }).success],
      ['a version 4 blocker detail', (detail) => phaseFinishedV4.safeParse({ phase: 'decision', attempt: 1, outcome: 'blocked', blocker: { code: 'worker-failed', detail, action: 'run it again' } }).success],
    ];
    for (const [name, accepts] of cases) {
      assert.equal(accepts(text(recordedTextLengthV1)), true, `${name} holds the cap`);
      assert.equal(accepts(text(recordedTextLengthV1 + 1)), false, `${name} refuses one more`);
    }
  });

  it('refuses the decision in every version 3 event that carries a phase, and accepts it in version 4', () => {
    const check = { attempt: 1, moment: 'start', drifted: false, head: null, files: [], strays: [] };
    const spend = { workers: 1, seconds: 1, costUsd: null, costUnreported: null, inputTokens: null, cachedInputTokens: null, outputTokens: null };
    const report = { report: { sha256: 'a'.repeat(64), bytes: 1 }, statistics: { phases: [{ phase: 'decision', ...spend }], total: spend, budgetApplied: false }, patches: [] };
    const cases: [string, z.ZodType, z.ZodType, unknown][] = [
      ['phase.started', phaseStartedV3, phaseStartedV4, { phase: 'decision', attempt: 1 }],
      ['phase.finished', phaseFinishedV3, phaseFinishedV4, { phase: 'decision', attempt: 1, outcome: 'completed', blocker: null }],
      ['worktree.checked', worktreeCheckedV3, worktreeCheckedV4, { phase: 'decision', ...check }],
      ['attempt.failed', attemptFailedV3, attemptFailedV4, { phase: 'decision', key: 'decision', workerId, reason: 'r' }],
      ['worker.lost', workerLostV3, workerLostV4, { workerId, phase: 'decision', key: 'decision', reason: 'r' }],
      ['report.written', reportWrittenV3, reportWrittenV4, report],
    ];
    for (const [kind, older, newer, payload] of cases) {
      assert.equal(older.safeParse(payload).success, false, `${kind}@3 refuses the decision`);
      assert.equal(newer.safeParse(payload).success, true, `${kind}@4 accepts it`);
    }
  });

  it('records a review.configured@5 exactly as version 4 records it: the version alone says the run decides', () => {
    assert.equal(reviewConfiguredV5, reviewConfiguredV4);
  });
});

describe('decisions.recorded@1', () => {
  const workerId = '00000000-0000-4000-8000-000000000001';
  const fix = { id: 'SCAN-1', decision: 'fix', grounds: 'one sound way', fix: { approach: 'guard the null', rejected: [] }, leave: null, ask: null, departure: null };
  const ask = {
    id: 'DESIGN-1',
    decision: 'ask',
    grounds: 'nothing states which',
    fix: null,
    leave: null,
    ask: { question: 'which?', options: [{ option: 'keep', cost: 'none', rule: 'keep it', edits: false }, { option: 'change', cost: 'callers', rule: 'change it', edits: true }], recommended: 1, applied: 0, searched: ['docs'] },
    departure: null,
  };
  const leave = { id: 'RIPPLE-1', decision: 'leave', grounds: 'the guard covers it', fix: null, leave: { reason: 'superseded', supersededBy: 'SCAN-1' }, ask: null, departure: null };
  const accepts = (...decisions: unknown[]): boolean => decisionsRecordedV1.safeParse({ workerId, decisions }).success;

  it('records a fix, an ask and a left finding, each with its one part', () => {
    assert.equal(accepts(fix, ask, leave), true);
    assert.equal(accepts({ ...fix, departure: { rule: 'the comment', source: 'a.ts:3', reason: 'its reason is the parse path only' } }), true, 'a fix may depart from a rule');
    assert.equal(accepts({ ...leave, leave: { reason: 'intended', supersededBy: null } }), true);
  });

  it('refuses a decision whose parts do not match it, a departure on anything but a fix, and an empty record', () => {
    assert.equal(accepts({ ...fix, fix: null }), false, 'a fix without its approach');
    assert.equal(accepts({ ...fix, leave: leave.leave }), false, 'a fix that also leaves');
    assert.equal(accepts({ ...ask, ask: null }), false, 'an ask without its question');
    assert.equal(accepts({ ...leave, leave: null }), false, 'a leave without its reason');
    assert.equal(accepts({ ...ask, departure: { rule: 'r', source: 's', reason: 'r' } }), false, 'an ask that departs');
    assert.equal(accepts({ ...leave, departure: { rule: 'r', source: 's', reason: 'r' } }), false, 'a leave that departs');
    assert.equal(accepts({ ...ask, decision: 'defer' }), false, 'a kind the vocabulary does not have');
    assert.equal(accepts(), false, 'no decision at all');
  });

  it('is one variant per decision kind of the frozen vocabulary, so each part is non-null exactly on its own kind', () => {
    assert.deepEqual(recordedDecisionSchema.options.map((variant) => variant.shape.decision.value), [...reviewVocabularyV4.decisionKinds]);
  });

  it('refuses an ask that recommends or applies an option it does not offer, or offers fewer than two', () => {
    assert.equal(accepts({ ...ask, ask: { ...ask.ask, applied: 2 } }), false);
    assert.equal(accepts({ ...ask, ask: { ...ask.ask, recommended: 2 } }), false);
    assert.equal(accepts({ ...ask, ask: { ...ask.ask, options: [ask.ask.options[0]], recommended: 0 } }), false);
    assert.equal(accepts({ ...ask, ask: { ...ask.ask, searched: [] } }), false, 'an ask names where it looked');
  });

  it('names a superseding finding exactly for a superseded one, and decides each finding once', () => {
    assert.equal(accepts(fix, { ...leave, leave: { reason: 'superseded', supersededBy: null } }), false);
    assert.equal(accepts(fix, { ...leave, leave: { reason: 'intended', supersededBy: 'SCAN-1' } }), false);
    assert.equal(accepts(fix, { ...fix, grounds: 'again' }), false, 'one finding twice');
  });

  it('caps each text at the decider\'s output schema\'s cap', () => {
    assert.equal(accepts({ ...fix, grounds: 'x'.repeat(1000) }), true);
    assert.equal(accepts({ ...fix, grounds: 'x'.repeat(1001) }), false);
    assert.equal(accepts({ ...fix, fix: { approach: 'x'.repeat(2001), rejected: [] } }), false);
  });
});
