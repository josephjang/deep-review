import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ScopeState } from '../../src/checkpoint/events.ts';
import { chunk, maxGroupSize, planGroups, type Groupable } from '../../src/review/grouping.ts';
import { normalizeLocations } from '../../src/review/locations.ts';

const located = (id: string, file: string, line: number): Groupable => ({ id, file, line, rawFile: file, rawLine: line });
const unlocated = (id: string, rawFile: string, rawLine: number): Groupable => ({ id, file: null, line: null, rawFile, rawLine });

describe('chunk', () => {
  const upTo = (length: number): number[] => Array.from({ length }, (_, i) => i);

  it('leaves a list within the size whole and splits a longer one into consecutive chunks', () => {
    assert.deepEqual(chunk([1, 2, 3]), [[1, 2, 3]]);
    assert.deepEqual(chunk(upTo(8)), [upTo(8)]);
    assert.deepEqual(chunk(upTo(16)).map((part) => part.length), [8, 8]);
    assert.deepEqual(chunk(upTo(10)).map((part) => part.length), [5, 5]);
    assert.deepEqual(chunk([1]), [[1]], 'a group of one stays one');
    assert.deepEqual(chunk([]), []);
    assert.equal(maxGroupSize, 8);
  });

  it('never gives a chunk more than the size, and balances the chunks so none holds one candidate when the group had more', () => {
    assert.deepEqual(chunk(upTo(9)), [upTo(5), [5, 6, 7, 8]]);
    assert.deepEqual(chunk(upTo(17)).map((part) => part.length), [6, 6, 5]);
    assert.deepEqual(chunk(upTo(25)).map((part) => part.length), [7, 6, 6, 6]);
  });

  it('keeps every chunk within the size, as few chunks as that allows, their sizes one apart, in the order given', () => {
    for (let length = 0; length <= 100; length += 1) {
      const parts = chunk(upTo(length));
      const sizes = parts.map((part) => part.length);
      assert.deepEqual(parts.flat(), upTo(length), `order kept for ${String(length)}`);
      assert.equal(parts.length, Math.ceil(length / maxGroupSize), `chunk count for ${String(length)}`);
      assert.ok(sizes.every((size) => size >= 1 && size <= maxGroupSize), `sizes ${sizes.join(',')} for ${String(length)}`);
      assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `balanced sizes ${sizes.join(',')} for ${String(length)}`);
      if (length > 1) assert.ok(sizes.every((size) => size > 1), `no single candidate alone for ${String(length)}`);
    }
  });

  it('honours a size other than the default', () => {
    assert.deepEqual(chunk(upTo(7), 3), [[0, 1, 2], [3, 4], [5, 6]]);
    assert.deepEqual(chunk(upTo(3), 1), [[0], [1], [2]]);
  });

  it('refuses a size that is not a positive integer rather than looping or dropping items', () => {
    for (const size of [0, -1, 2.5, Number.NaN]) assert.throws(() => chunk(upTo(3), size), RangeError, String(size));
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
    const plan = planGroups([unlocated('SWEEP-2', 'C:\\x\\b.ts', 3), located('SCAN-1', 'a.ts', 1), unlocated('SWEEP-1', 'a.ts', 7), unlocated('SWEEP-3', 'C:\\x\\b.ts', 1)]);
    assert.deepEqual(plan, [
      { id: 'g1', candidateIds: ['SCAN-1'] },
      { id: 'g2', candidateIds: ['SWEEP-1'] },
      { id: 'g3', candidateIds: ['SWEEP-3', 'SWEEP-2'] },
    ]);
  });

  it('groups every spelling of one unlocated path together: backslashes, a leading ./, repeated slashes and case', () => {
    const plan = planGroups([
      unlocated('RIPPLE-2', 'src\\runtime\\launcher.ts', 30),
      unlocated('FOOTGUNS-4', './src/runtime/launcher.ts', 10),
      unlocated('SCAN-1', 'src//runtime/launcher.ts', 20),
      unlocated('SCAN-2', 'SRC/Runtime/Launcher.ts', 40),
    ]);
    assert.deepEqual(plan, [{ id: 'g1', candidateIds: ['FOOTGUNS-4', 'SCAN-1', 'RIPPLE-2', 'SCAN-2'] }]);
  });

  it('groups an absolute spelling of an unlocated path with the longest relative spelling it ends with', () => {
    const plan = planGroups([
      unlocated('RIPPLE-2', 'C:\\repo\\src\\runtime\\launcher.ts', 30),
      unlocated('FOOTGUNS-4', 'src/runtime/launcher.ts', 10),
      unlocated('SCAN-1', '/home/me/repo/src/runtime/launcher.ts', 20),
      unlocated('SCAN-2', 'launcher.ts', 5),
      unlocated('SCAN-3', 'runtime/launcher.ts', 6),
    ]);
    assert.deepEqual(plan, [
      { id: 'g1', candidateIds: ['SCAN-2'] },
      { id: 'g2', candidateIds: ['SCAN-3'] },
      { id: 'g3', candidateIds: ['FOOTGUNS-4', 'SCAN-1', 'RIPPLE-2'] },
    ]);
  });

  it('keeps an absolute spelling alone when no relative spelling of it was given, and ends a match at a segment', () => {
    const plan = planGroups([unlocated('SCAN-1', '/repo/xa.ts', 1), unlocated('SCAN-2', 'a.ts', 1), unlocated('SCAN-3', '/repo/b.ts', 1)]);
    assert.deepEqual(plan, [
      { id: 'g1', candidateIds: ['SCAN-3'] },
      { id: 'g2', candidateIds: ['SCAN-1'] },
      { id: 'g3', candidateIds: ['SCAN-2'] },
    ]);
  });

  it('plans the same groups whatever order the spellings arrived in', () => {
    const candidates = [unlocated('A-1', 'C:\\r\\src\\a.ts', 1), unlocated('A-2', 'src/a.ts', 2), unlocated('A-3', 'a.ts', 3), unlocated('A-4', '/r/SRC/a.ts', 4)];
    assert.deepEqual(planGroups([...candidates].reverse()), planGroups(candidates));
  });

  it('splits a file with more than eight candidates into balanced chunks of neighbouring lines, none over eight', () => {
    const many = Array.from({ length: 17 }, (_, index) => located(`SCAN-${String(index + 1)}`, 'big.ts', 17 - index));
    const plan = planGroups([...many, located('RIPPLE-1', 'small.ts', 1)]);
    assert.deepEqual(plan.map((group) => [group.id, group.candidateIds.length]), [['g1', 6], ['g2', 6], ['g3', 5], ['g4', 1]]);
    assert.deepEqual(plan[0]?.candidateIds, ['SCAN-17', 'SCAN-16', 'SCAN-15', 'SCAN-14', 'SCAN-13', 'SCAN-12']);
    assert.deepEqual(plan[2]?.candidateIds, ['SCAN-5', 'SCAN-4', 'SCAN-3', 'SCAN-2', 'SCAN-1']);
    assert.deepEqual(plan[3]?.candidateIds, ['RIPPLE-1']);
  });

  it('gives a file of nine candidates two verifiers, not one of nine', () => {
    const nine = Array.from({ length: 9 }, (_, index) => located(`SCAN-${String(index + 1)}`, 'a.ts', index + 1));
    assert.deepEqual(planGroups(nine).map((group) => group.candidateIds.length), [5, 4]);
  });

  it('gives the absolute and relative spellings of an unchanged file one group, under its canonical path', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'deep-review-grouping-'));
    try {
      mkdirSync(join(worktree, 'src'));
      writeFileSync(join(worktree, 'src', 'changed.ts'), 'one\n');
      writeFileSync(join(worktree, 'src', 'caller.ts'), 'one\ntwo\nthree\n');
      const blob = { blob: { sha256: 'a'.repeat(64), bytes: 1 } };
      const scope: ScopeState = { mode: 'worktree', request: { paths: [] }, base: '1'.repeat(40), head: '2'.repeat(40), files: [{ path: 'src/changed.ts', status: 'modified', symlink: false, before: blob, after: blob }], patch: blob.blob };
      const raw = [
        { id: 'RIPPLE-1', file: join(worktree, 'src', 'caller.ts'), line: 3 },
        { id: 'WRAPPERS-1', file: 'src/caller.ts', line: 1 },
        { id: 'SCAN-1', file: '.\\SRC\\Caller.ts', line: 2 },
        { id: 'SCAN-2', file: 'src/changed.ts', line: 1 },
      ];
      const locations = normalizeLocations(scope, worktree, raw);
      const plan = planGroups(raw.map((candidate, index) => ({ id: candidate.id, file: locations[index]!.file, line: locations[index]!.line, rawFile: candidate.file, rawLine: candidate.line })));
      assert.deepEqual(locations.map((location) => location.file), ['src/caller.ts', 'src/caller.ts', 'src/caller.ts', 'src/changed.ts']);
      assert.deepEqual(plan, [{ id: 'g1', candidateIds: ['WRAPPERS-1', 'SCAN-1', 'RIPPLE-1'] }, { id: 'g2', candidateIds: ['SCAN-2'] }]);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('plans nothing for an empty working list', () => {
    assert.deepEqual(planGroups([]), []);
  });
});
