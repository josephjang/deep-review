import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import {
  angleFailedV1,
  answerPassV1,
  answerRecordedV1,
  answerSchemaV1,
  attemptFailedV1,
  attemptFailedV2,
  attemptFailedV3,
  attemptFailedV4,
  attemptFailedV5,
  attemptFailedV6,
  attemptFailedV7,
  attemptFailedV8,
  blockerSchema,
  blockerSchemaV3,
  blockerSchemaV5,
  claimsLostV1,
  candidatesRecordedV1,
  checkRanV1,
  checkRanV2,
  checkRanV3,
  checkStartedV1,
  commitsCreatedV1,
  commitsDroppedV1,
  commitsPreparedV1,
  decisionsRecordedV1,
  documentationPlannedV1,
  filesClaimedV1,
  fixPinnedV1,
  fixRecordedV1,
  fixRecordedV2,
  fixRecordedV3,
  fixReopenedV1,
  fixReopenedV2,
  groupUnverifiedV1,
  phaseFinishedV2,
  phaseFinishedV3,
  phaseFinishedV4,
  phaseFinishedV5,
  phaseFinishedV6,
  phaseFinishedV7,
  phaseStartedV1,
  phaseStartedV2,
  phaseStartedV3,
  phaseStartedV4,
  phaseStartedV5,
  phaseStartedV6,
  recordedDecisionSchema,
  recordedTextLengthV1,
  reportWrittenV2,
  reportWrittenV3,
  reportWrittenV4,
  reportWrittenV5,
  reportWrittenV6,
  reviewConfiguredV4,
  reviewConfiguredV5,
  reviewConfiguredV6,
  reviewConfiguredV7,
  reviewIdentifiersV1,
  reviewIdentifiersV2,
  reviewVocabularyV1,
  reviewVocabularyV2,
  reviewVocabularyV3,
  reviewVocabularyV4,
  reviewVocabularyV5,
  reviewVocabularyV6,
  reviewVocabularyV7,
  reviewVocabularyV8,
  surveyFailedV1,
  treeRestoredV1,
  treeRevisedV1,
  treeRevisedV2,
  treeRevisedV3,
  unitUnattemptedV1,
  unitUnattemptedV2,
  workerLostV1,
  workerLostV2,
  workerLostV3,
  workerLostV4,
  workerLostV5,
  workerLostV6,
  worktreeCheckedV2,
  worktreeCheckedV3,
  worktreeCheckedV4,
  worktreeCheckedV5,
  worktreeCheckedV6,
  worktreeCheckedV7,
} from '../../src/checkpoint/events.ts';
import { hintRules } from '../../src/review/checks/discover.ts';
import { normalizeClaimPath } from '../../src/review/claims.ts';
import {
  angles,
  answerKinds,
  answerPhases,
  attemptFaults,
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
  lostClaimReasons,
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
  worktreeMoments,
} from '../../src/review/vocabulary.ts';

// The review events freeze the vocabulary they record. If a test against
// today's vocabulary fails, the vocabulary changed: leave the frozen copies
// as they are, declare a new version of every event that carries the
// changed words, and point the test at that version's lists.

/** Today's phases less the documentation step's, which version 8 added and every earlier version lacks. */
const phasesBeforeDocumentation = phases.filter((phase) => phase !== 'documentation');
/** Today's editing phases less the documentation step's. */
const editingBeforeDocumentation = editingPhases.filter((phase) => phase !== 'documentation');
/** Today's phases less the documentation step's and the answer pass's two, which version 6 added and every earlier version lacks. */
const phasesBeforeAnswers = phasesBeforeDocumentation.filter((phase) => !(answerPhases as readonly string[]).includes(phase));
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
    assert.deepEqual(frozenPhases, phasesBeforeAnswers.filter((phase) => !(fixPhases as readonly string[]).includes(phase) && phase !== 'survey' && phase !== 'decision'), 'the fix pass added its five phases, the survey, the decision step and the documentation step one each, the answers two, and nothing else');
    assert.deepEqual(frozenCodes, recordedBlockerCodes.filter((code) => code !== 'check-unavailable' && code !== 'claims-lost'), 'the survey and the claims added a blocker code each and nothing else');
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

  it('is today\'s vocabulary in every word the survey, the answers and the documentation step did not change, and its rules are the hints\' rules', () => {
    const { phases: frozenPhases, recordedBlockerCodes: frozenCodes, checkOrigins: frozenOrigins, checkPhases: frozenCheckPhases, editingPhases: frozenEditingPhases, checkOutcomes: frozenOutcomes, ...rest } = reviewVocabularyV2;
    assert.deepEqual(rest, { phaseOutcomes, checkKinds, fixStatuses, validationMethods, suiteResults });
    assert.deepEqual(frozenOutcomes, checkOutcomes.filter((outcome) => outcome !== 'cut'), 'resumable runs added the outcome cut and nothing else');
    assert.deepEqual(frozenPhases, phasesBeforeAnswers.filter((phase) => phase !== 'survey' && phase !== 'decision'), 'the survey, the decision step and the documentation step added a phase each, the answers two, and nothing else');
    assert.deepEqual(frozenCheckPhases, checkPhases.filter((phase) => phase !== 'answer-checks'), 'the answers added their check phase and nothing else');
    assert.deepEqual(frozenEditingPhases, editingBeforeDocumentation.filter((phase) => phase !== 'answer'), 'the documentation step and the answers added an editing phase each, and nothing else');
    assert.deepEqual(frozenCodes, recordedBlockerCodes.filter((code) => code !== 'check-unavailable' && code !== 'claims-lost'));
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

  it('is today\'s vocabulary in every word the decision step, the claims and the documentation step did not widen', () => {
    const { phases: frozenPhases, recordedBlockerCodes: frozenCodes, ...rest } = reviewVocabularyV3;
    assert.deepEqual(rest, { phaseOutcomes, checkKinds, checkOrigins, checkBases, conventionLevels, userRulesSettings });
    assert.deepEqual(frozenPhases, phasesBeforeAnswers.filter((phase) => phase !== 'decision'), 'the decision step and the documentation step added a phase each, the answers two, and nothing else');
    assert.deepEqual(frozenCodes, recordedBlockerCodes.filter((code) => code !== 'claims-lost'), 'the claims added their blocker code and nothing else');
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

  it('is today\'s vocabulary in every word the answers and the documentation step did not widen', () => {
    assert.deepEqual(reviewVocabularyV4, { phases: phasesBeforeAnswers, decisionKinds, leaveReasons });
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

// Version 5 of phase.finished and attempt.failed, and version 1 of the
// claims' events, record the vocabulary commit series integrity widened;
// the same rule holds them to today's.
describe('the review vocabulary frozen by the v5 events', () => {
  const workerId = '00000000-0000-4000-8000-000000000001';

  it('is today\'s vocabulary, word for word and in order', () => {
    assert.deepEqual(reviewVocabularyV5, { recordedBlockerCodes, attemptFaults: attemptFaults.filter((fault) => fault !== 'cut' && fault !== 'limit'), lostClaimReasons });
  });

  it('records claims-lost only from version 5 of phase.finished, and only there', () => {
    const blocked = { phase: 'fixes', attempt: 1, outcome: 'blocked', blocker: { code: 'claims-lost', detail: 'the claims directory /s was removed while the run was editing', action: 'run the command again' } };
    assert.equal(blockerSchemaV3.safeParse(blocked.blocker).success, false);
    assert.equal(blockerSchemaV5.safeParse(blocked.blocker).success, true);
    assert.equal(phaseFinishedV4.safeParse(blocked).success, false);
    assert.equal(phaseFinishedV5.safeParse(blocked).success, true);
    assert.equal(phaseFinishedV5.safeParse({ ...blocked, outcome: 'completed' }).success, false, 'a blocker exactly when blocked');
  });

  it('requires a fault on attempt.failed@5, the unit\'s or the environment\'s, and caps its reason as version 1 does', () => {
    const failure = { phase: 'fixes', key: 'c1-1', workerId, reason: 'the claims directory was removed while the unit ran' };
    assert.equal(attemptFailedV5.safeParse(failure).success, false, 'no fault');
    for (const fault of reviewVocabularyV5.attemptFaults) assert.equal(attemptFailedV5.safeParse({ ...failure, fault }).success, true, fault);
    for (const fault of ['cut', 'limit']) assert.equal(attemptFailedV6.safeParse({ ...failure, fault }).success, false, `${fault} is version 7's`);
    assert.equal(attemptFailedV5.safeParse({ ...failure, fault: 'engine' }).success, false);
    assert.equal(attemptFailedV4.safeParse({ ...failure, fault: 'unit' }).success, false, 'version 4 has no fault');
    assert.equal(attemptFailedV5.safeParse({ ...failure, fault: 'unit', reason: 'x'.repeat(recordedTextLengthV1) }).success, true);
    assert.equal(attemptFailedV5.safeParse({ ...failure, fault: 'unit', reason: 'x'.repeat(recordedTextLengthV1 + 1) }).success, false);
  });

  it('leaves the version 4 vocabulary as the decision step froze it', () => {
    assert.deepEqual(reviewVocabularyV4, { phases: phasesBeforeAnswers, decisionKinds, leaveReasons });
  });
});

// Version 6 of the review events and version 1 of the answers' events
// record the vocabulary the answers widened; the same rule holds them to
// today's.
describe('the review vocabulary frozen by the v6 events', () => {
  const workerId = '00000000-0000-4000-8000-000000000001';

  it('is today\'s vocabulary in every word the documentation step did not widen', () => {
    assert.deepEqual(reviewVocabularyV6, { phases: phasesBeforeDocumentation, editingPhases: editingBeforeDocumentation, checkPhases, answerKinds });
  });

  it('refuses the answer pass\'s phases in the last version of every event that carries a phase, and accepts them in the new one', () => {
    const check = { attempt: 1, moment: 'start', drifted: false, head: null, files: [], strays: [] };
    const spend = { workers: 1, seconds: 1, costUsd: null, costUnreported: null, inputTokens: null, cachedInputTokens: null, outputTokens: null };
    const report = { report: { sha256: 'a'.repeat(64), bytes: 1 }, statistics: { phases: [{ phase: 'answer', ...spend }, { phase: 'answer-checks', ...spend }], total: spend, budgetApplied: false }, patches: [] };
    const answered = { phase: 'answer', key: 'pass-1', workerId, findings: [], drift: [], tests: [], suite: { result: 'not-run', command: '', failures: '' }, violations: [] };
    const revision = { phase: 'answer', source: { kind: 'fix', key: 'pass-1', workerId }, change: { findings: ['SCAN-1'], message: { subject: 'fix: Apply the answer', body: '' } }, files: [{ path: 'a.ts', status: 'modified', before: { blob: { sha256: 'd'.repeat(64), bytes: 1 } }, beforeSymlink: false, symlink: false, after: { blob: { sha256: 'e'.repeat(64), bytes: 1 } } }] };
    const ran = { phase: 'answer-checks', attempt: 1, kind: 'test', command: 'npm test', outcome: 'passed', exitCode: 0, signal: null, termination: 'exited', startedAt: '2026-10-12T00:00:00.000Z', endedAt: '2026-10-12T00:00:01.000Z', stdout: { sha256: 'b'.repeat(64), bytes: 1 }, stderr: { sha256: 'c'.repeat(64), bytes: 1 }, error: null };
    const cases: [string, z.ZodType, z.ZodType, unknown][] = [
      ['phase.started', phaseStartedV4, phaseStartedV5, { phase: 'answer', attempt: 1 }],
      ['phase.finished', phaseFinishedV5, phaseFinishedV6, { phase: 'answer-checks', attempt: 1, outcome: 'completed', blocker: null }],
      ['worktree.checked', worktreeCheckedV4, worktreeCheckedV5, { phase: 'answer', ...check }],
      ['attempt.failed', attemptFailedV5, attemptFailedV6, { phase: 'answer', key: 'pass-1', workerId, reason: 'r', fault: 'unit' }],
      ['worker.lost', workerLostV4, workerLostV5, { workerId, phase: 'answer', key: 'pass-1', reason: 'r' }],
      ['report.written', reportWrittenV4, reportWrittenV5, report],
      ['tree.revised', treeRevisedV1, treeRevisedV2, revision],
      ['fix.recorded', fixRecordedV1, fixRecordedV2, answered],
      ['check.ran', checkRanV1, checkRanV2, ran],
    ];
    for (const [kind, older, newer, payload] of cases) {
      assert.equal(older.safeParse(payload).success, false, `${kind}'s last version refuses an answer phase`);
      assert.equal(newer.safeParse(payload).success, true, `${kind}'s new version accepts it`);
    }
  });

  it('holds the new versions to the rules of the old: a blocker exactly when blocked, a skipped check with no process, a revision\'s findings by its source', () => {
    assert.equal(phaseFinishedV6.safeParse({ phase: 'answer', attempt: 1, outcome: 'completed', blocker: { code: 'budget', detail: 'd', action: 'a' } }).success, false);
    assert.equal(checkRanV2.safeParse({ phase: 'answer-checks', attempt: 1, kind: 'test', command: 'npm test', outcome: 'skipped', exitCode: null, signal: null, termination: 'exited', startedAt: '2026-10-12T00:00:00.000Z', endedAt: '2026-10-12T00:00:00.000Z', stdout: null, stderr: null, error: 'build failed' }).success, false);
    assert.equal(treeRevisedV2.safeParse({ phase: 'answer', source: { kind: 'fix', key: 'pass-1', workerId }, change: { findings: [], message: { subject: 's', body: '' } }, files: [{ path: 'a.ts', status: 'deleted', before: { blob: { sha256: 'd'.repeat(64), bytes: 1 } }, beforeSymlink: false, symlink: false, after: null }] }).success, false, 'a fix revision names a finding');
    assert.equal(fixRecordedV2.safeParse({ phase: 'answer-checks', key: 'pass-1', workerId, findings: [], drift: [], tests: [], suite: { result: 'not-run', command: '', failures: '' }, violations: [] }).success, false, 'no fixer runs in a check phase');
  });
});

describe('answer.recorded@1 and answer.pass@1', () => {
  const recorded = (change: Record<string, unknown> = {}): boolean => answerRecordedV1.safeParse({ id: 'DESIGN-1', answer: { kind: 'option', option: 1 }, note: null, ...change }).success;

  it('records an option by its index from 0, an acceptance and a rejection, each with a note or none', () => {
    assert.equal(recorded(), true);
    assert.equal(recorded({ answer: { kind: 'option', option: 0 }, note: 'the second caller needs it' }), true);
    assert.equal(recorded({ answer: { kind: 'accept' } }), true);
    assert.equal(recorded({ answer: { kind: 'reject' } }), true);
  });

  it('is one variant per answer kind of the frozen vocabulary, and refuses a fourth', () => {
    assert.deepEqual(answerSchemaV1.options.map((variant) => variant.shape.kind.value), [...reviewVocabularyV6.answerKinds]);
    assert.equal(recorded({ answer: { kind: 'defer' } }), false);
    assert.equal(recorded({ answer: { kind: 'free', text: 'something else' } }), false, 'no free-text answer (PD8)');
  });

  it('refuses an option that is no index, an acceptance or a rejection that names an option, and a stray field', () => {
    assert.equal(recorded({ answer: { kind: 'option', option: -1 } }), false);
    assert.equal(recorded({ answer: { kind: 'option', option: 1.5 } }), false);
    assert.equal(recorded({ answer: { kind: 'option' } }), false);
    assert.equal(recorded({ answer: { kind: 'accept', option: 0 } }), false);
    assert.equal(recorded({ answer: { kind: 'reject', option: 0 } }), false);
    assert.equal(recorded({ by: 'someone' }), false, 'no by on the answer');
  });

  it('refuses an id that is not a candidate id, an empty note and a note past 2000 characters', () => {
    assert.equal(recorded({ id: 'design-1' }), false);
    assert.equal(recorded({ note: '' }), false);
    assert.equal(recorded({ note: 'x'.repeat(2000) }), true);
    assert.equal(recorded({ note: 'x'.repeat(2001) }), false);
  });

  it('opens a pass over one finding or more, each once', () => {
    assert.equal(answerPassV1.safeParse({ ids: ['DESIGN-1'] }).success, true);
    assert.equal(answerPassV1.safeParse({ ids: ['DESIGN-1', 'SCAN-1'] }).success, true);
    assert.equal(answerPassV1.safeParse({ ids: [] }).success, false);
    assert.equal(answerPassV1.safeParse({ ids: ['DESIGN-1', 'DESIGN-1'] }).success, false);
    assert.equal(answerPassV1.safeParse({ ids: ['DESIGN-1'], extra: true }).success, false);
  });
});

describe('files.claimed@1', () => {
  const claim = (files: unknown[], change: Record<string, unknown> = {}): boolean => filesClaimedV1.safeParse({ phase: 'fixes', key: 'c1-1', cluster: 'c1', files, ...change }).success;

  it('records a batch\'s claims, each with its time or none for a late claim', () => {
    assert.equal(claim([{ path: 'test/a.test.ts', claimedAt: '2026-10-09T01:00:00.000Z' }, { path: 'docs/late.md', claimedAt: null }]), true);
  });

  it('refuses no file, more than 2000, one path twice, another phase, and a key or cluster not spelled as the plan spells them', () => {
    assert.equal(claim([]), false);
    assert.equal(claim(Array.from({ length: 2000 }, (_, index) => ({ path: `f${String(index)}`, claimedAt: null }))), true);
    assert.equal(claim(Array.from({ length: 2001 }, (_, index) => ({ path: `f${String(index)}`, claimedAt: null }))), false);
    assert.equal(claim([{ path: 'a', claimedAt: null }, { path: 'a', claimedAt: '2026-10-09T01:00:00.000Z' }]), false);
    assert.equal(claim([{ path: 'a', claimedAt: null }], { phase: 'repair' }), false);
    assert.equal(claim([{ path: 'a', claimedAt: null }], { key: 'repair' }), false);
    assert.equal(claim([{ path: 'a', claimedAt: null }], { cluster: 'C1' }), false);
    assert.equal(claim([{ path: 'a', claimedAt: 'yesterday' }]), false);
  });

  it('refuses a path that is not repository relative, leaves the tree or names .git', () => {
    for (const path of ['', '/etc/passwd', 'C:/x', '../x', 'a/../b', 'a//b', './a', 'a/', '.git/config', 'a/.GIT/b', 'a\\b']) assert.equal(claim([{ path, claimedAt: null }]), false, JSON.stringify(path));
  });

  // The claim command's rule is live and this schema is frozen, so they are
  // two copies: if this fails, the command changed, and a claim it now makes
  // needs a new version of the event rather than an edit of this one.
  it('records exactly the paths the claim command writes, as it spells them', () => {
    const commandWrites = (path: string): string | undefined => {
      try {
        return normalizeClaimPath(path);
      } catch {
        return undefined;
      }
    };
    const paths = [
      'a', 'src/a.ts', '.gitignore', 'a/.github/x', 'a/..b', '...', 'a.git/b', `${'x/'.repeat(499)}xx`, 'x'.repeat(1000), 'x'.repeat(1001),
      '', '.', './', '/a', '/', 'C:/x', 'c:x', 'C:\\x', '\\\\server\\share', 'a\\b', '.\\a', 'a/\\b', './a', 'a/./b', 'a/.',
      '..', '../x', 'a/../b', 'a/..', 'a//b', 'a/', '.git', '.git/config', 'a/.GIT/b', 'a/.Git', 'a\0b',
    ];
    for (const path of paths) {
      const written = commandWrites(path);
      // The schema takes a path just when the command takes it and writes it unchanged.
      assert.equal(claim([{ path, claimedAt: null }]), written === path, JSON.stringify(path));
      // A path the command refuses is refused in the spelling the command would have written.
      if (written === undefined) {
        const spelled = path.replaceAll('\\', '/').split('/').filter((part) => part !== '.').join('/');
        assert.equal(claim([{ path: spelled, claimedAt: null }]), false, JSON.stringify(spelled));
      }
    }
  });
});

describe('claims.lost@1', () => {
  const lost = (file: Record<string, unknown>, change: Record<string, unknown> = {}): boolean => claimsLostV1.safeParse({ phase: 'fixes', unit: 'c2-1', cluster: 'c2', files: [{ path: 'src/a.ts', claimedAt: null, ...file }], ...change }).success;

  it('names the holder exactly for a marker of a unit the plan has', () => {
    assert.equal(lost({ reason: 'owned', holder: 'c1' }), true);
    assert.equal(lost({ reason: 'held', holder: 'c1' }), true);
    assert.equal(lost({ reason: 'unplanned', holder: null }, { unit: 'not a key', cluster: 'anything' }), true, 'the marker\'s own strings');
    assert.equal(lost({ reason: 'unplanned', holder: 'c1' }), false);
    assert.equal(lost({ reason: 'owned', holder: null }), false);
    assert.equal(lost({ reason: 'stale', holder: null }), false);
  });

  it('refuses no file and another phase', () => {
    assert.equal(claimsLostV1.safeParse({ phase: 'fixes', unit: 'c2-1', cluster: 'c2', files: [] }).success, false);
    assert.equal(lost({ reason: 'owned', holder: 'c1' }, { phase: 'repair' }), false);
  });
});

describe('fix.pinned@1', () => {
  const flag = (kind: string, command: string | null = `npm run ${kind}`): Record<string, unknown> => (command === null ? { kind, command: null, origin: 'flag', reason: 'dropped by --no-check', source: null } : { kind, command, origin: 'flag', reason: null, source: null });
  const plan = checkKinds.map((kind) => flag(kind));
  const pinned = (change: Record<string, unknown> = {}): boolean => fixPinnedV1.safeParse({ checks: { timeoutMs: 600_000 }, fixes: { batchSize: 4 }, plannedChecks: null, ...change }).success;

  it('records the timeout and the batch size, with no plan or a plan of the flags\' four kinds in the order they run', () => {
    assert.equal(pinned(), true);
    assert.equal(pinned({ plannedChecks: plan }), true);
    assert.equal(pinned({ plannedChecks: [flag('build'), flag('typecheck', null), flag('lint', null), flag('test')] }), true, 'a kind dropped by --no-check');
  });

  it('refuses a plan with a kind missing, a kind twice, the kinds out of order, or a check the survey or nobody decided', () => {
    assert.equal(pinned({ plannedChecks: plan.slice(1) }), false, 'missing');
    assert.equal(pinned({ plannedChecks: [plan[0], plan[0], plan[2], plan[3]] }), false, 'twice');
    assert.equal(pinned({ plannedChecks: [plan[1], plan[0], plan[2], plan[3]] }), false, 'out of order');
    assert.equal(pinned({ plannedChecks: [{ kind: 'build', command: 'npm run build', origin: 'survey', reason: null, source: { path: 'ci.yml', quote: 'run: npm run build', basis: 'stated' } }, ...plan.slice(1)] }), false, 'the survey\'s');
    assert.equal(pinned({ plannedChecks: [{ kind: 'build', command: null, origin: 'none', reason: 'no build', source: null }, ...plan.slice(1)] }), false, 'nobody\'s');
  });

  it('holds the timeout and the batch size to review.configured@2\'s bounds, and requires both', () => {
    assert.equal(pinned({ checks: { timeoutMs: 0 } }), false);
    assert.equal(pinned({ fixes: { batchSize: 21 } }), false);
    assert.equal(pinned({ fixes: { batchSize: 0 } }), false);
    assert.equal(pinned({ checks: null }), false);
    assert.equal(pinned({ fixes: null }), false);
    assert.equal(pinned({ extra: true }), false);
  });
});

// Version 7 of attempt.failed, version 6 of worktree.checked, version 3 of
// check.ran and the new kinds of resumable runs record the vocabulary that
// resumable runs widened; the same rule holds them to today's.
describe('the review vocabulary frozen by the v7 events', () => {
  const workerId = '00000000-0000-4000-8000-000000000001';
  const blob = (fill: string): { blob: { sha256: string; bytes: number } } => ({ blob: { sha256: fill.repeat(64), bytes: 1 } });
  const ran = (change: Record<string, unknown> = {}): Record<string, unknown> => ({ phase: 'checks', attempt: 2, kind: 'test', command: 'npm test', outcome: 'passed', exitCode: 0, signal: null, termination: 'exited', startedAt: '2026-10-19T00:00:00.000Z', endedAt: '2026-10-19T00:00:01.000Z', stdout: blob('b').blob, stderr: blob('c').blob, error: null, replaces: null, ...change });

  it('is today\'s vocabulary, word for word and in order', () => {
    assert.deepEqual(reviewVocabularyV7, { checkOutcomes, attemptFaults, worktreeMoments });
  });

  it('refuses the new words in the last version of each event that carries them, and accepts them in the new one', () => {
    const cut = ran({ outcome: 'cut', exitCode: 143 });
    const cutV2 = Object.fromEntries(Object.entries(cut).filter(([key]) => key !== 'replaces'));
    assert.equal(checkRanV2.safeParse(cutV2).success, false, 'check.ran@2 refuses a cut run');
    assert.equal(checkRanV3.safeParse(cut).success, true);
    const failure = { phase: 'fixes', key: 'c1-1', workerId, reason: 'r' };
    for (const fault of ['cut', 'limit']) {
      assert.equal(attemptFailedV6.safeParse({ ...failure, fault }).success, false, `attempt.failed@6 refuses ${fault}`);
      assert.equal(attemptFailedV7.safeParse({ ...failure, fault }).success, true, fault);
    }
    assert.equal(attemptFailedV7.safeParse({ ...failure, fault: 'environment' }).success, true, 'the fault environment stays');
    const restored = { phase: 'checks', attempt: 2, moment: 'restored', drifted: false, head: null, files: [], strays: [] };
    assert.equal(worktreeCheckedV5.safeParse(restored).success, false);
    assert.equal(worktreeCheckedV6.safeParse(restored).success, true);
  });

  it('holds check.ran@3 to the rules of the old versions, a cut run to its exit, and what it replaces to an attempt and an outcome', () => {
    assert.equal(checkRanV3.safeParse(ran({ outcome: 'cut', termination: 'killed', exitCode: null, signal: 'SIGKILL' })).success, false, 'a cut check exited');
    assert.equal(checkRanV3.safeParse(ran({ outcome: 'cut', exitCode: null, signal: null })).success, true, 'a guard with no result leaves no code');
    assert.equal(checkRanV3.safeParse(ran({ outcome: 'passed', exitCode: 1 })).success, false, 'a passed check exited 0');
    assert.equal(checkRanV3.safeParse(ran({ replaces: { attempt: 1, outcome: 'failed' } })).success, true);
    assert.equal(checkRanV3.safeParse(ran({ replaces: { attempt: 0, outcome: 'failed' } })).success, false);
    assert.equal(checkRanV3.safeParse(ran({ replaces: { attempt: 1, outcome: 'gone' } })).success, false);
    const noReplaces = Object.fromEntries(Object.entries(ran()).filter(([key]) => key !== 'replaces'));
    assert.equal(checkRanV3.safeParse(noReplaces).success, false, 'version 3 names what it replaces, null for nothing');
  });

  it('records a check\'s start, a write back once per path, and a reopened fix pass once per unit', () => {
    assert.equal(checkStartedV1.safeParse({ phase: 'baseline-checks', attempt: 1, kind: 'build', command: 'npm run build' }).success, true);
    assert.equal(checkStartedV1.safeParse({ phase: 'fixes', attempt: 1, kind: 'build', command: 'npm run build' }).success, false, 'no check runs in an editing phase');
    const file = { path: 'src/a.ts', before: blob('1'), beforeSymlink: false, expected: blob('2'), expectedSymlink: false };
    const restored = { phase: 'checks', attempt: 2, check: { kind: 'lint', attempt: 1 }, files: [file] };
    assert.equal(treeRestoredV1.safeParse(restored).success, true);
    assert.equal(treeRestoredV1.safeParse({ ...restored, files: [] }).success, true, 'a write back that found nothing differing');
    assert.equal(treeRestoredV1.safeParse({ ...restored, files: [{ ...file, before: null, expected: null }] }).success, true, 'a file absent before and expected absent');
    assert.equal(treeRestoredV1.safeParse({ ...restored, files: [file, file] }).success, false, 'one path twice');
    assert.equal(fixReopenedV1.safeParse({ units: [{ phase: 'fixes', key: 'c1-2' }, { phase: 'repair', key: 'repair' }] }).success, true);
    assert.equal(fixReopenedV1.safeParse({ units: [] }).success, false, 'at least one unit');
    assert.equal(fixReopenedV1.safeParse({ units: [{ phase: 'fixes', key: 'c1-2' }, { phase: 'fixes', key: 'c1-2' }] }).success, false, 'one unit twice');
    assert.equal(fixReopenedV1.safeParse({ units: [{ phase: 'answer', key: 'pass-1' }] }).success, false, 'only the fixes and the repair stop at the budget');
  });

  it('prepares a series of commits in the shape it is created in, and drops one by its two heads', () => {
    const series = { commits: [{ sha: 'a'.repeat(40), revision: 0, subject: 'fix: Guard the null' }], from: 'b'.repeat(40), to: 'a'.repeat(40) };
    assert.equal(commitsPreparedV1.safeParse(series).success, true);
    assert.deepEqual(z.toJSONSchema(commitsPreparedV1), z.toJSONSchema(commitsCreatedV1));
    assert.equal(commitsDroppedV1.safeParse({ from: series.from, to: series.to }).success, true);
    assert.equal(commitsDroppedV1.safeParse({ from: series.from }).success, false);
  });
});

// Version 8 of the review events and version 1 of the documentation
// step's record the vocabulary the documentation step widened; the same
// rule holds them to today's.
describe('the review vocabulary frozen by the v8 events', () => {
  const workerId = '00000000-0000-4000-8000-000000000001';
  const blob = (fill: string): { blob: { sha256: string; bytes: number } } => ({ blob: { sha256: fill.repeat(64), bytes: 1 } });

  it('is today\'s vocabulary, word for word and in order', () => {
    assert.deepEqual(reviewVocabularyV8, { phases, editingPhases });
  });

  it('refuses the documentation phase in the last version of each of the ten kinds that carry a phase, and accepts it in the new one', () => {
    const check = { attempt: 1, moment: 'end', drifted: false, head: null, files: [], strays: [] };
    const spend = { workers: 1, seconds: 1, costUsd: null, costUnreported: null, inputTokens: null, cachedInputTokens: null, outputTokens: null };
    const report = { report: blob('a').blob, statistics: { phases: [{ phase: 'documentation', ...spend }], total: spend, budgetApplied: false }, patches: [] };
    const answered = { phase: 'documentation', key: 'documentation', workerId, findings: [], drift: [], tests: [], suite: { result: 'not-run', command: '', failures: '' }, violations: [] };
    const revision = { phase: 'documentation', source: { kind: 'fix', key: 'documentation', workerId }, change: { findings: ['doc-1'], message: { subject: 'docs: Bring the testing guide in line', body: '' } }, files: [{ path: 'docs/testing.md', status: 'modified', before: blob('d'), beforeSymlink: false, symlink: false, after: blob('e') }] };
    const cases: [string, z.ZodType, z.ZodType, unknown][] = [
      ['phase.started', phaseStartedV5, phaseStartedV6, { phase: 'documentation', attempt: 1 }],
      ['phase.finished', phaseFinishedV6, phaseFinishedV7, { phase: 'documentation', attempt: 1, outcome: 'degraded', blocker: null }],
      ['worktree.checked', worktreeCheckedV6, worktreeCheckedV7, { phase: 'documentation', ...check }],
      ['attempt.failed', attemptFailedV7, attemptFailedV8, { phase: 'documentation', key: 'documentation', workerId, reason: 'r', fault: 'unit' }],
      ['worker.lost', workerLostV5, workerLostV6, { workerId, phase: 'documentation', key: 'documentation', reason: 'r' }],
      ['report.written', reportWrittenV5, reportWrittenV6, report],
      ['tree.revised', treeRevisedV2, treeRevisedV3, revision],
      ['fix.recorded', fixRecordedV2, fixRecordedV3, answered],
      ['unit.unattempted', unitUnattemptedV1, unitUnattemptedV2, { phase: 'documentation', key: 'documentation', cause: 'budget', reason: 'spent' }],
      ['fix.reopened', fixReopenedV1, fixReopenedV2, { units: [{ phase: 'documentation', key: 'documentation' }] }],
    ];
    for (const [kind, older, newer, payload] of cases) {
      assert.equal(older.safeParse(payload).success, false, `${kind}'s last version refuses the documentation phase`);
      assert.equal(newer.safeParse(payload).success, true, `${kind}'s new version accepts it`);
    }
  });

  it('holds the new versions to the rules of the old: a blocker exactly when blocked, a revision\'s items by its source, a fault, no fixer in a check phase, each unit reopened once', () => {
    assert.equal(phaseFinishedV7.safeParse({ phase: 'documentation', attempt: 1, outcome: 'completed', blocker: { code: 'budget', detail: 'd', action: 'a' } }).success, false);
    assert.equal(treeRevisedV3.safeParse({ phase: 'documentation', source: { kind: 'fix', key: 'documentation', workerId }, change: { findings: [], message: { subject: 's', body: '' } }, files: [{ path: 'a.md', status: 'deleted', before: blob('d'), beforeSymlink: false, symlink: false, after: null }] }).success, false, 'a fix revision names an item');
    assert.equal(attemptFailedV8.safeParse({ phase: 'documentation', key: 'documentation', workerId, reason: 'r', fault: 'cut' }).success, true, 'the faults of version 7 stay');
    assert.equal(attemptFailedV8.safeParse({ phase: 'documentation', key: 'documentation', workerId, reason: 'r' }).success, false, 'a fault is named');
    assert.equal(worktreeCheckedV7.safeParse({ phase: 'checks', attempt: 2, moment: 'restored', drifted: false, head: null, files: [], strays: [] }).success, true, 'the moment restored stays');
    assert.equal(fixRecordedV3.safeParse({ phase: 'checks', key: 'checks', workerId, findings: [], drift: [], tests: [], suite: { result: 'not-run', command: '', failures: '' }, violations: [] }).success, false, 'no fixer runs in a check phase');
    assert.equal(unitUnattemptedV2.safeParse({ phase: 'checks', key: 'checks', cause: 'budget', reason: 'spent' }).success, false, 'no unit of a check phase is settled');
    assert.equal(fixReopenedV2.safeParse({ units: [{ phase: 'documentation', key: 'documentation' }, { phase: 'documentation', key: 'documentation' }] }).success, false, 'one unit twice');
    assert.equal(fixReopenedV2.safeParse({ units: [{ phase: 'answer', key: 'pass-1' }] }).success, false, 'the answer pass does not stop at the budget');
    assert.equal(fixReopenedV2.safeParse({ units: [] }).success, false, 'at least one unit');
  });

  it('records a review.configured@7 exactly as version 6 records it: the version alone says the run has the documentation step (TD4)', () => {
    assert.equal(reviewConfiguredV7, reviewConfiguredV6);
  });
});

describe('documentation.planned@1', () => {
  const line = (key: string, file: string, what: string): Record<string, unknown> => ({ key, file, what });
  const testing = { id: 'doc-1', file: './docs/testing.md', path: 'docs/testing.md', drift: [line('c1-1', './docs/testing.md', 'the echo no longer removes the bytes')] };
  const outside = { id: 'doc-2', file: '../outside.md', path: null, drift: [line('c2-1', '../outside.md', 'the bytes are kept'), line('c2-1', '../outside.md', 'the bytes are kept')] };
  const search = { id: 'search', file: null, path: null, drift: [] };
  const plans = (...items: unknown[]): boolean => documentationPlannedV1.safeParse({ items }).success;

  it('records the documents in order, a refused path as none, two equal lines as two, and the search last', () => {
    assert.equal(plans(testing, outside, search), true);
    assert.equal(plans(search), true, 'a run whose fixes reported no line has the search alone');
  });

  it('refuses ids out of order, a search that is not last or names a file, a path or a line, and a document with no file or no line', () => {
    assert.equal(plans({ ...outside, id: 'doc-1' }, { ...testing, id: 'doc-2' }, search), true, 'the order is the plan\'s');
    assert.equal(plans({ ...testing, id: 'doc-2' }, search), false, 'doc-1 comes first');
    assert.equal(plans(testing, { ...outside, id: 'doc-3' }, search), false, 'no number is skipped');
    assert.equal(plans(testing), false, 'the search is last');
    assert.equal(plans(search, { ...testing, id: 'doc-2' }), false, 'the search is not first');
    assert.equal(plans(testing, search, search), false, 'one search');
    assert.equal(plans(testing, { ...search, file: 'docs/a.md' }), false);
    assert.equal(plans(testing, { ...search, path: 'docs/a.md' }), false);
    assert.equal(plans(testing, { ...search, drift: testing.drift }), false);
    assert.equal(plans({ ...testing, file: null }, search), false);
    assert.equal(plans({ ...testing, drift: [] }, search), false);
    assert.equal(plans({ ...testing, id: 'doc-01' }, search), false);
    assert.equal(plans(), false, 'no item at all');
  });

  it('refuses two items with one path, and a path a claim could not record', () => {
    assert.equal(plans(testing, { ...outside, path: 'docs/testing.md' }, search), false);
    for (const path of ['/etc/passwd', '../x.md', './docs/testing.md', 'docs\\testing.md', '.git/config', 'a//b']) assert.equal(plans({ ...testing, path }, search), false, path);
  });
});
