import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunk, maxGroupSize, planGroups, type Groupable } from '../../src/review/grouping.ts';

const located = (id: string, file: string, line: number): Groupable => ({ id, file, line, rawFile: file, rawLine: line });
const unlocated = (id: string, rawFile: string, rawLine: number): Groupable => ({ id, file: null, line: null, rawFile, rawLine });

describe('chunk', () => {
  it('leaves a list within the size whole and splits a longer one into consecutive chunks', () => {
    assert.deepEqual(chunk([1, 2, 3]), [[1, 2, 3]]);
    assert.deepEqual(chunk(Array.from({ length: 8 }, (_, i) => i)), [[0, 1, 2, 3, 4, 5, 6, 7]]);
    assert.deepEqual(chunk(Array.from({ length: 16 }, (_, i) => i)).map((part) => part.length), [8, 8]);
    assert.deepEqual(chunk(Array.from({ length: 10 }, (_, i) => i)).map((part) => part.length), [8, 2]);
  });

  it('absorbs a remainder of one into the chunk before it, so no chunk holds one candidate when the group had more', () => {
    assert.deepEqual(chunk(Array.from({ length: 9 }, (_, i) => i)).map((part) => part.length), [9]);
    assert.deepEqual(chunk(Array.from({ length: 17 }, (_, i) => i)).map((part) => part.length), [8, 9]);
    assert.deepEqual(chunk(Array.from({ length: 17 }, (_, i) => i))[1], [8, 9, 10, 11, 12, 13, 14, 15, 16]);
    assert.deepEqual(chunk([1]), [[1]], 'a group of one stays one');
    assert.deepEqual(chunk([]), []);
    assert.equal(maxGroupSize, 8);
  });
});

describe('planGroups', () => {
  it('groups by file in file order, sorts each group by line, and numbers the groups from g1', () => {
    const plan = planGroups([located('SCAN-1', 'src/b.ts', 9), located('RIPPLE-1', 'src/a.ts', 20), located('SCAN-2', 'src/a.ts', 4), located('DESIGN-1', 'src/b.ts', 2)]);
    assert.deepEqual(plan, [
      { id: 'g1', candidateIds: ['SCAN-2', 'RIPPLE-1'] },
      { id: 'g2', candidateIds: ['DESIGN-1', 'SCAN-1'] },
    ]);
  });

  it('orders two candidates on one line by id, so the plan is the same whatever order they arrived in', () => {
    const forward = planGroups([located('SCAN-1', 'a.ts', 1), located('DESIGN-1', 'a.ts', 1)]);
    const backward = planGroups([located('DESIGN-1', 'a.ts', 1), located('SCAN-1', 'a.ts', 1)]);
    assert.deepEqual(forward, backward);
    assert.deepEqual(forward[0]?.candidateIds, ['DESIGN-1', 'SCAN-1']);
  });

  it('groups unlocated candidates by their own file spelling, after the located ones, apart from a located file of the same name', () => {
    const plan = planGroups([unlocated('SWEEP-2', 'C:\\x\\a.ts', 3), located('SCAN-1', 'a.ts', 1), unlocated('SWEEP-1', 'a.ts', 7), unlocated('SWEEP-3', 'C:\\x\\a.ts', 1)]);
    assert.deepEqual(plan, [
      { id: 'g1', candidateIds: ['SCAN-1'] },
      { id: 'g2', candidateIds: ['SWEEP-3', 'SWEEP-2'] },
      { id: 'g3', candidateIds: ['SWEEP-1'] },
    ]);
  });

  it('splits a file with more than eight candidates into chunks of neighbouring lines, absorbing a remainder of one', () => {
    const many = Array.from({ length: 17 }, (_, index) => located(`SCAN-${String(index + 1)}`, 'big.ts', 17 - index));
    const plan = planGroups([...many, located('RIPPLE-1', 'small.ts', 1)]);
    assert.deepEqual(plan.map((group) => [group.id, group.candidateIds.length]), [['g1', 8], ['g2', 9], ['g3', 1]]);
    assert.deepEqual(plan[0]?.candidateIds, ['SCAN-17', 'SCAN-16', 'SCAN-15', 'SCAN-14', 'SCAN-13', 'SCAN-12', 'SCAN-11', 'SCAN-10']);
    assert.deepEqual(plan[2]?.candidateIds, ['RIPPLE-1']);
  });

  it('plans nothing for an empty working list', () => {
    assert.deepEqual(planGroups([]), []);
  });
});
