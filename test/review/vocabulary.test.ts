import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { angleClasses, angles, angleSchema, candidateIdPrefix, finderAngles, finderAngleSchema, isFinderRole, reviewRoles, roleOfAngle, singleUnitKey, triageUnitKey } from '../../src/review/vocabulary.ts';

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
  it('are the triage, the nine finders in launch order, then the roles of the later phases, each once', () => {
    assert.deepEqual(reviewRoles, ['triage', ...finderAngles.map((angle) => `finder-${angle}`), 'deduplication', 'verifier', 'sweep', 'merge-rank']);
    assert.equal(new Set(reviewRoles).size, reviewRoles.length, 'no role is listed twice');
  });

  it('name the nine finders, and only them, as finder roles', () => {
    assert.deepEqual(reviewRoles.filter(isFinderRole), finderAngles.map((angle) => `finder-${angle}`));
    assert.deepEqual(reviewRoles.filter((role) => !isFinderRole(role)), ['triage', 'deduplication', 'verifier', 'sweep', 'merge-rank']);
  });
});

describe('singleUnitKey', () => {
  it('is SCAN for the triage and the phase name for every other phase with one worker', () => {
    assert.equal(singleUnitKey('triage'), triageUnitKey);
    assert.equal(triageUnitKey, 'SCAN');
    for (const phase of ['sweep', 'deduplication', 'sweep-deduplication', 'merge-rank'] as const) assert.equal(singleUnitKey(phase), phase);
  });
});

describe('candidateIdPrefix', () => {
  it('is SCAN for the triage, the angle for a finder and SWEEP for the sweep', () => {
    assert.equal(candidateIdPrefix('triage', triageUnitKey), 'SCAN');
    for (const angle of finderAngles) assert.equal(candidateIdPrefix('finders', angle), angle);
    assert.equal(candidateIdPrefix('sweep', 'sweep'), 'SWEEP');
  });
});
