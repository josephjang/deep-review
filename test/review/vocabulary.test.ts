import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { angleClasses, angles, angleSchema, candidateIdPrefix, candidatePhases, checkKinds, checkPhases, clusterIdSchema, decisionCounts, decisionCountWords, decisionKinds, deduplicationPhases, editingPhases, finderAngles, finderAngleSchema, fixPhases, isCheckPhase, isEditingPhase, isFinderRole, leaveReasons, phases, reviewRoles, roleOfAngle, singleUnitKey, triageUnitKey, verificationPhases } from '../../src/review/vocabulary.ts';

describe('the angles', () => {
  it('are SCAN, run by the triage, then the nine finder angles in launch order', () => {
    assert.deepEqual(angles, ['SCAN', 'REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS']);
    assert.deepEqual(angles.slice(1), [...finderAngles]);
    assert.equal(new Set(angles).size, angles.length, 'no angle is listed twice');
    assert.ok(angleSchema.safeParse('SCAN').success);
    assert.ok(!finderAngleSchema.safeParse('SCAN').success, 'the triage angle is not a finder angle');
    assert.ok(!angleSchema.safeParse('SWEEP').success, 'SWEEP is an id prefix, not an angle');
  });

  it('each have exactly one class: the design class is DESIGN, DUPLICATION and ALTITUDE, every other angle is correctness', () => {
    assert.deepEqual(Object.keys(angleClasses).sort(), [...angles].sort());
    assert.deepEqual(angles.filter((angle) => angleClasses[angle] === 'design'), ['DESIGN', 'DUPLICATION', 'ALTITUDE']);
    assert.deepEqual(angles.filter((angle) => angleClasses[angle] === 'correctness'), ['SCAN', 'REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'CONVENTIONS']);
  });
});

describe('roleOfAngle', () => {
  it('is the triage for SCAN and finder-<angle> for every finder angle', () => {
    assert.equal(roleOfAngle('SCAN'), 'triage');
    assert.deepEqual(finderAngles.map(roleOfAngle), finderAngles.map((angle) => `finder-${angle}`));
  });
});

describe('the review roles', () => {
  it('are the surveyor, the triage, the nine finders in launch order, then the roles of the later phases, the decider and the fix pass\'s fixer, each once', () => {
    assert.deepEqual(reviewRoles, ['surveyor', 'triage', ...finderAngles.map((angle) => `finder-${angle}`), 'deduplication', 'verifier', 'sweep', 'merge-rank', 'decider', 'fixer']);
    assert.equal(new Set(reviewRoles).size, reviewRoles.length, 'no role is listed twice');
  });

  it('name the nine finders, and only them, as finder roles', () => {
    assert.deepEqual(reviewRoles.filter(isFinderRole), finderAngles.map((angle) => `finder-${angle}`));
    assert.deepEqual(reviewRoles.filter((role) => !isFinderRole(role)), ['surveyor', 'triage', 'deduplication', 'verifier', 'sweep', 'merge-rank', 'decider', 'fixer']);
  });
});

describe('singleUnitKey', () => {
  it('is SCAN for the triage and the phase name for every other phase with one worker', () => {
    assert.equal(singleUnitKey('triage'), triageUnitKey);
    assert.equal(triageUnitKey, 'SCAN');
    for (const phase of ['survey', 'sweep', 'deduplication', 'sweep-deduplication', 'merge-rank', 'decision'] as const) assert.equal(singleUnitKey(phase), phase);
  });
});

describe('candidateIdPrefix', () => {
  it('is SCAN for the triage, the angle for a finder and SWEEP for the sweep', () => {
    assert.equal(candidateIdPrefix('triage', triageUnitKey), 'SCAN');
    for (const angle of finderAngles) assert.equal(candidateIdPrefix('finders', angle), angle);
    assert.equal(candidateIdPrefix('sweep', 'sweep'), 'SWEEP');
  });
});

describe('the decisions', () => {
  it('make a finding one of fix, leave and ask, and leave one for one of three reasons', () => {
    assert.deepEqual(decisionKinds, ['fix', 'leave', 'ask']);
    assert.deepEqual(leaveReasons, ['outside-change-not-regression', 'superseded', 'intended']);
  });

  it('count each kind once, a kind none was decided as zero, in the one phrase the log, status and the report share', () => {
    const counts = decisionCounts([{ decision: 'ask' }, { decision: 'fix' }, { decision: 'ask' }]);
    assert.deepEqual(counts, { fix: 1, leave: 0, ask: 2 });
    assert.equal(decisionCountWords(counts), '1 to fix, 0 to leave, 2 to ask the author');
    assert.equal(decisionCountWords(decisionCounts([])), '0 to fix, 0 to leave, 0 to ask the author');
  });
});

describe('the phases', () => {
  it('are the survey, the read-only phases, the decision, the five of the fix pass, then the report', () => {
    assert.deepEqual(phases, ['survey', 'triage', 'finders', 'deduplication', 'verification', 'sweep', 'sweep-deduplication', 'sweep-verification', 'merge-rank', 'decision', 'baseline-checks', 'fixes', 'checks', 'repair', 'repair-checks', 'report']);
    assert.deepEqual(fixPhases, phases.slice(10, 15));
  });

  it('put the decision after merge and rank and before the fix pass, in no group of phases: it runs no check, edits nothing, and records no candidate, deduplication or verdict', () => {
    assert.equal(phases.indexOf('decision'), phases.indexOf('merge-rank') + 1);
    assert.equal(phases.indexOf('decision'), phases.indexOf('baseline-checks') - 1);
    for (const group of [fixPhases, checkPhases, editingPhases, candidatePhases, deduplicationPhases, verificationPhases]) assert.ok(!(group as readonly string[]).includes('decision'), group.join(', '));
  });

  it('split the fix pass into the phases that run checks and the phases that edit', () => {
    assert.deepEqual([...checkPhases, ...editingPhases].sort(), [...fixPhases].sort());
    assert.deepEqual(phases.filter(isCheckPhase), ['baseline-checks', 'checks', 'repair-checks']);
    assert.deepEqual(phases.filter(isEditingPhase), ['fixes', 'repair']);
  });

  it('spell a cluster id c and a number from 1, and run the check kinds build first', () => {
    for (const id of ['c1', 'c12']) assert.ok(clusterIdSchema.safeParse(id).success, id);
    for (const id of ['c0', 'c', 'C1', 'g1', 'c01']) assert.ok(!clusterIdSchema.safeParse(id).success, id);
    assert.deepEqual(checkKinds, ['build', 'typecheck', 'lint', 'test']);
  });
});
