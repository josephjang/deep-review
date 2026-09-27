import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { angleClasses, angles, angleSchema, finderAngles, finderAngleSchema } from '../../src/review/vocabulary.ts';

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
