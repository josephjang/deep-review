import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CandidateState } from '../../src/checkpoint/review-fold.ts';
import { planFixes, routeOf } from '../../src/review/fixes.ts';
import type { ReportFinding } from '../../src/review/state.ts';
import { angles, type Angle, type Verdict } from '../../src/review/vocabulary.ts';

/** A candidate located at `file`, or unlocated when `file` is null with `raw` as the finder spelled it. */
function candidate(id: string, angle: Angle, file: string | null, raw = file ?? 'nowhere.ts'): CandidateState {
  return {
    id, angle, file, line: file === null ? null : 3, located: file !== null, inScope: file !== null && !file.startsWith('lib/'),
    rawFile: raw, rawLine: 3, summary: `${id} summary`, detail: `${id} detail`,
    phase: 'finders', workerId: '00000000-0000-4000-8000-000000000001', duplicateOf: null, verdict: null, unverified: false,
  };
}

/** A ranked finding with its primary, members and merged verdict. */
function finding(primary: CandidateState, verdict: Verdict = 'CONFIRMED', members: CandidateState[] = [], unverified = false): ReportFinding {
  return {
    finding: { id: primary.id, members: members.map((member) => member.id), severity: 'major', summary: `${primary.id} summary`, reason: 'reason' },
    primary,
    members,
    resolution: { verdict, unverified, evidence: unverified ? null : 'evidence' },
  };
}

describe('routeOf', () => {
  it('sends every CONFIRMED finding to a fixer, whatever its angle', () => {
    for (const angle of angles) assert.equal(routeOf(finding(candidate('X-1', angle, 'a.ts'), 'CONFIRMED')), 'fixer', angle);
  });

  it('sends a PLAUSIBLE finding of a correctness, cost or CONVENTIONS angle to a fixer, and holds a PLAUSIBLE design finding for the author', () => {
    const held = ['DESIGN', 'DUPLICATION', 'ALTITUDE'];
    for (const angle of angles) assert.equal(routeOf(finding(candidate('X-1', angle, 'a.ts'), 'PLAUSIBLE')), held.includes(angle) ? 'held' : 'fixer', angle);
  });

  it('routes an unverified finding as its verdict and angle say, the mark changing nothing', () => {
    assert.equal(routeOf(finding(candidate('X-1', 'FOOTGUNS', 'a.ts'), 'PLAUSIBLE', [], true)), 'fixer');
    assert.equal(routeOf(finding(candidate('X-1', 'ALTITUDE', 'a.ts'), 'PLAUSIBLE', [], true)), 'held');
  });

  it('routes by the primary\'s angle, not a member\'s', () => {
    assert.equal(routeOf(finding(candidate('DESIGN-1', 'DESIGN', 'a.ts'), 'PLAUSIBLE', [candidate('RIPPLE-1', 'RIPPLE', 'a.ts')])), 'held');
    assert.equal(routeOf(finding(candidate('RIPPLE-1', 'RIPPLE', 'a.ts'), 'PLAUSIBLE', [candidate('DESIGN-1', 'DESIGN', 'a.ts')])), 'fixer');
  });
});

describe('planFixes', () => {
  it('plans nothing for no finding', () => {
    assert.deepEqual(planFixes([]), { routes: [], clusters: [] });
  });

  it('routes every ranked finding once, in rank order, and clusters only the fixer-routed ones, one per file', () => {
    const plan = planFixes([
      finding(candidate('SCAN-1', 'SCAN', 'src/a.ts')),
      finding(candidate('DESIGN-1', 'DESIGN', 'src/a.ts'), 'PLAUSIBLE'),
      finding(candidate('RIPPLE-1', 'RIPPLE', 'src/b.ts')),
      finding(candidate('RIPPLE-2', 'RIPPLE', 'src/a.ts'), 'PLAUSIBLE'),
    ]);
    assert.deepEqual(plan.routes, [{ id: 'SCAN-1', route: 'fixer' }, { id: 'DESIGN-1', route: 'held' }, { id: 'RIPPLE-1', route: 'fixer' }, { id: 'RIPPLE-2', route: 'fixer' }]);
    assert.deepEqual(plan.clusters, [
      { id: 'c1', findingIds: ['SCAN-1', 'RIPPLE-2'], files: ['src/a.ts'] },
      { id: 'c2', findingIds: ['RIPPLE-1'], files: ['src/b.ts'] },
    ]);
  });

  it('keeps a merged finding whole: its two files join one cluster, pulling in every finding of both', () => {
    const plan = planFixes([
      finding(candidate('SCAN-1', 'SCAN', 'src/a.ts')),
      finding(candidate('RIPPLE-1', 'RIPPLE', 'src/b.ts')),
      finding(candidate('FOOTGUNS-1', 'FOOTGUNS', 'src/c.ts')),
      // Ranked last, it merges the first two clusters; the result keeps the first one's place.
      finding(candidate('REMOVALS-1', 'REMOVALS', 'src/b.ts'), 'CONFIRMED', [candidate('SWEEP-1', 'SCAN', 'src/a.ts')]),
    ]);
    assert.deepEqual(plan.clusters, [
      { id: 'c1', findingIds: ['SCAN-1', 'RIPPLE-1', 'REMOVALS-1'], files: ['src/a.ts', 'src/b.ts'] },
      { id: 'c2', findingIds: ['FOOTGUNS-1'], files: ['src/c.ts'] },
    ]);
  });

  it('merges transitively, so no file is ever owned by two clusters', () => {
    const plan = planFixes([
      finding(candidate('A-1', 'SCAN', 'a.ts'), 'CONFIRMED', [candidate('A-2', 'SCAN', 'b.ts')]),
      finding(candidate('B-1', 'SCAN', 'c.ts'), 'CONFIRMED', [candidate('B-2', 'SCAN', 'd.ts')]),
      finding(candidate('C-1', 'SCAN', 'b.ts'), 'CONFIRMED', [candidate('C-2', 'SCAN', 'c.ts')]),
    ]);
    assert.deepEqual(plan.clusters, [{ id: 'c1', findingIds: ['A-1', 'B-1', 'C-1'], files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }]);
    const owned = plan.clusters.flatMap((cluster) => cluster.files);
    assert.equal(new Set(owned).size, owned.length);
  });

  it('owns a located file outside the change as it owns a changed one', () => {
    assert.deepEqual(planFixes([finding(candidate('RIPPLE-1', 'RIPPLE', 'lib/caller.ts'))]).clusters, [{ id: 'c1', findingIds: ['RIPPLE-1'], files: ['lib/caller.ts'] }]);
  });

  it('clusters an unlocated finding alone by its spelling, owning nothing, apart from a located file of the same name', () => {
    const plan = planFixes([
      finding(candidate('SCAN-1', 'SCAN', 'src/a.ts')),
      finding(candidate('SWEEP-1', 'SCAN', null, 'src/a.ts')),
    ]);
    assert.deepEqual(plan.clusters, [
      { id: 'c1', findingIds: ['SCAN-1'], files: ['src/a.ts'] },
      { id: 'c2', findingIds: ['SWEEP-1'], files: [] },
    ]);
  });

  it('folds two spellings of one unlocated path, in case, slashes or an absolute prefix, into one cluster', () => {
    const plan = planFixes([
      finding(candidate('SCAN-1', 'SCAN', null, 'Src\\Gone.ts')),
      finding(candidate('RIPPLE-1', 'RIPPLE', null, './src/gone.ts')),
      finding(candidate('REMOVALS-1', 'REMOVALS', null, 'C:\\repo\\src\\gone.ts')),
      finding(candidate('FOOTGUNS-1', 'FOOTGUNS', null, 'other/place.ts')),
    ]);
    assert.deepEqual(plan.clusters, [
      { id: 'c1', findingIds: ['SCAN-1', 'RIPPLE-1', 'REMOVALS-1'], files: [] },
      { id: 'c2', findingIds: ['FOOTGUNS-1'], files: [] },
    ]);
  });

  it('lets an unlocated member join its finding\'s cluster without owning anything', () => {
    const plan = planFixes([finding(candidate('SCAN-1', 'SCAN', 'src/a.ts'), 'CONFIRMED', [candidate('SWEEP-1', 'SCAN', null, 'elsewhere.ts')])]);
    assert.deepEqual(plan.clusters, [{ id: 'c1', findingIds: ['SCAN-1'], files: ['src/a.ts'] }]);
  });

  it('never lets a held finding\'s file join a cluster, nor its members', () => {
    const plan = planFixes([
      finding(candidate('DESIGN-1', 'DESIGN', 'src/a.ts'), 'PLAUSIBLE', [candidate('ALTITUDE-1', 'ALTITUDE', 'src/b.ts')]),
      finding(candidate('SCAN-1', 'SCAN', 'src/a.ts')),
      finding(candidate('RIPPLE-1', 'RIPPLE', 'src/b.ts')),
    ]);
    assert.deepEqual(plan.clusters, [
      { id: 'c1', findingIds: ['SCAN-1'], files: ['src/a.ts'] },
      { id: 'c2', findingIds: ['RIPPLE-1'], files: ['src/b.ts'] },
    ]);
  });
});
