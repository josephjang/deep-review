import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { NewEvent } from '../../src/checkpoint/checkpoint.ts';
import { heldByOthers } from '../../src/checkpoint/fix-state.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { isPending, lateClaim, settleClaims, settledNothing, type LiveClaims } from '../../src/review/claim-events.ts';
import { markerHash, type LiveClaim } from '../../src/review/claims.ts';
import { baselined, claimed, fixAnswer, type History, worker } from '../helpers/review-history.ts';

// c1 owns src/a.ts and c2 src/b.ts, one batch each, both running; the worktree does not exist, so every path resolves as written.
const twoClusterPlan = {
  routes: [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }],
  clusters: [{ id: 'c1', findingIds: ['RIPPLE-1'], files: ['src/a.ts'] }, { id: 'c2', findingIds: ['SWEEP-1'], files: ['src/b.ts'] }],
  batches: [{ key: 'c1-1', cluster: 'c1', findingIds: ['RIPPLE-1'] }, { key: 'c2-1', cluster: 'c2', findingIds: ['SWEEP-1'] }],
};
const worktree = '/no/such/worktree';
const running = (): History => baselined().start('fixes').add('fixes.planned', twoClusterPlan);
const marker = (path: string, unit: string, cluster: string, generation = 1, claimedAt: string | null = `2026-10-09T01:00:0${String(generation)}.000Z`): LiveClaim => ({ whole: true, hash: markerHash(path, false), generation, path, cluster, unit, claimedAt });
const live = (...markers: LiveClaim[]): LiveClaims => ({ markers, caseInsensitive: false });
const kinds = (events: readonly NewEvent[]): [string, unknown][] => events.map((event) => [event.kind, event.payload]);
const shared = 'test/shared.test.ts';

describe('settleClaims', () => {
  it('records every marker the ledger does not hold, under its own unit, a running sibling\'s included, and folds it (R3, F1)', () => {
    const state = running().fold();
    const settle = settleClaims(state, 'c1-1', live(marker(shared, 'c2-1', 'c2'), marker('docs/a.md', 'c1-1', 'c1')), worktree);
    // One event per claiming unit; which comes first is the markers' order, by name within a generation.
    const byUnit = (events: [string, unknown][]): [string, unknown][] => [...events].sort(([, a], [, b]) => ((a as { key: string }).key < (b as { key: string }).key ? -1 : 1));
    assert.deepEqual(byUnit(kinds(settle.events)), [
      ['files.claimed', { phase: 'fixes', key: 'c1-1', cluster: 'c1', files: [{ path: 'docs/a.md', claimedAt: '2026-10-09T01:00:01.000Z' }] }],
      ['files.claimed', { phase: 'fixes', key: 'c2-1', cluster: 'c2', files: [{ path: shared, claimedAt: '2026-10-09T01:00:01.000Z' }] }],
    ]);
    assert.deepEqual(settle.state.review!.fix!.claims.map((claim) => [claim.path, claim.key]).sort(), [['docs/a.md', 'c1-1'], [shared, 'c2-1']]);
    assert.deepEqual(heldByOthers(settle.state.review!.fix!, 'c1-1').get(shared), { cluster: 'c2', by: 'claim' }, 'the answer is judged against the sibling\'s claim');
    assert.equal(state.review!.fix!.claims.length, 0, 'the fold it was given is left as it was');
  });

  it('records a marker once: not again at the next settle, nor at the claiming unit\'s own', () => {
    const history = running();
    const first = settleClaims(history.fold(), 'c1-1', live(marker(shared, 'c2-1', 'c2')), worktree);
    for (const event of first.events) history.add(event.kind, event.payload, event.version);
    assert.deepEqual(settleClaims(history.fold(), 'c2-1', live(marker(shared, 'c2-1', 'c2')), worktree).events, []);
    assert.deepEqual(settleClaims(history.fold(), 'c1-1', live(marker(shared, 'c2-1', 'c2')), worktree).events, []);
  });

  it('records as lost a marker on an owned file, on a file an unsettled cluster holds, by a cluster that holds it already, and from a unit the plan lacks, and not again (F9)', () => {
    const history = running().add('files.claimed', claimed('c1-1', 'c1', [shared]));
    const markers = live(
      marker('src/a.ts', 'c2-1', 'c2'),
      marker(shared, 'c2-1', 'c2', 2),
      marker('docs/x.md', 'c9-1', 'c9'),
      marker('docs/y.md', 'c1-1', 'c2'),
    );
    const settle = settleClaims(history.fold(), 'c1-1', markers, worktree);
    assert.deepEqual(kinds(settle.events), [
      ['claims.lost', { phase: 'fixes', unit: 'c2-1', cluster: 'c2', files: [{ path: 'src/a.ts', claimedAt: '2026-10-09T01:00:01.000Z', reason: 'owned', holder: 'c1' }, { path: shared, claimedAt: '2026-10-09T01:00:02.000Z', reason: 'held', holder: 'c1' }] }],
      ['claims.lost', { phase: 'fixes', unit: 'c9-1', cluster: 'c9', files: [{ path: 'docs/x.md', claimedAt: '2026-10-09T01:00:01.000Z', reason: 'unplanned', holder: null }] }],
      ['claims.lost', { phase: 'fixes', unit: 'c1-1', cluster: 'c2', files: [{ path: 'docs/y.md', claimedAt: '2026-10-09T01:00:01.000Z', reason: 'unplanned', holder: null }] }],
    ]);
    for (const event of settle.events) history.add(event.kind, event.payload, event.version);
    assert.equal(history.review().fix!.lostClaims.length, 4);
    assert.deepEqual(settleClaims(history.fold(), 'c1-1', markers, worktree).events, [], 'a lost marker is recorded once');
    const again = settleClaims(running().add('files.claimed', claimed('c1-1', 'c1', [shared])).fold(), 'c1-1', live(marker(shared, 'c1-1', 'c1', 2)), worktree);
    assert.deepEqual(kinds(again.events).map(([kind, payload]) => [kind, (payload as { files: { reason: string }[] }).files[0]!.reason]), [['claims.lost', 'held']], 'a second marker of its own cluster');
  });

  it('accepts the next generation of a path whose holder settled, after the holder\'s own marker in the same settle', () => {
    // c1's marker and c1's answer are on the ledger, so c1 has settled; c2 claims the path next.
    const history = running().add('files.claimed', claimed('c1-1', 'c1', [shared], '2026-10-09T01:00:01.000Z')).worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50), { key: 'c1-1', findings: [{ id: 'RIPPLE-1', status: 'applied', file: 'src/a.ts', line: 1, note: 'n', message: { subject: 's', body: '' }, files: [shared], corrections: [], validation: [], requiredFiles: [] }] }));
    const settle = settleClaims(history.fold(), 'c2-1', live(marker(shared, 'c1-1', 'c1', 1), marker(shared, 'c2-1', 'c2', 2)), worktree);
    assert.deepEqual(kinds(settle.events).map(([kind, payload]) => [kind, (payload as { key: string }).key]), [['files.claimed', 'c2-1']]);
  });

  it('leaves a marker not yet whole for the next settle, and holds its path as pending (F13)', () => {
    const settle = settleClaims(running().fold(), 'c1-1', live({ whole: false, hash: markerHash(shared, false), generation: 1 }), worktree);
    assert.deepEqual(settle.events, []);
    assert.equal(isPending(settle, shared), true);
    assert.equal(isPending(settle, 'docs/other.md'), false);
  });

  it('records nothing without a directory to read, comparing paths as the file system does, and nothing for a marker the ledger seeded back', () => {
    const state = running().fold();
    for (const caseInsensitive of [false, true]) assert.deepEqual(settledNothing(state, caseInsensitive), { events: [], state, pending: new Set(), caseInsensitive });
    const seeded = running().add('files.claimed', claimed('c1-1', 'c1', ['docs/late.md'], null)).fold();
    assert.deepEqual(settleClaims(seeded, 'c2-1', live(marker('docs/late.md', 'c1-1', 'c1', 1, null)), worktree).events, []);
  });

  it('compares paths as a file system that folds case does, when it does', () => {
    const history = running().add('files.claimed', claimed('c1-1', 'c1', ['docs/Notes.md']));
    const folded: LiveClaims = { markers: [{ whole: true, hash: markerHash('docs/notes.md', true), generation: 1, path: 'docs/notes.md', cluster: 'c1', unit: 'c1-1', claimedAt: '2026-10-09T01:00:00.000Z' }], caseInsensitive: true };
    assert.deepEqual(settleClaims(history.fold(), 'c2-1', folded, worktree).events, [], 'the recorded claim, spelled otherwise');
  });

  it('records a marker for a file the worktree does not hold in the spelling its holder records, where the file system folds case (TD4)', () => {
    const history = running().add('files.claimed', claimed('c2-1', 'c2', ['docs/New.md']));
    const folded: LiveClaims = { markers: [{ whole: true, hash: markerHash('docs/new.md', true), generation: 1, path: 'docs/new.md', cluster: 'c1', unit: 'c1-1', claimedAt: '2026-10-09T01:00:01.000Z' }], caseInsensitive: true };
    assert.deepEqual(kinds(settleClaims(history.fold(), 'c1-1', folded, worktree).events), [['claims.lost', { phase: 'fixes', unit: 'c1-1', cluster: 'c1', files: [{ path: 'docs/New.md', claimedAt: '2026-10-09T01:00:01.000Z', reason: 'held', holder: 'c2' }] }]]);
  });

  it('keeps an owner by the plan the holder of a path a claim spells otherwise, where the file system folds case', () => {
    // A claim the fold took on its exact spelling while no settle folded case; the plan still owns the file.
    const history = running().add('files.claimed', claimed('c2-1', 'c2', ['SRC/A.ts']));
    const folded: LiveClaims = { markers: [{ whole: true, hash: markerHash('src/A.ts', true), generation: 1, path: 'src/A.ts', cluster: 'c2', unit: 'c2-1', claimedAt: '2026-10-09T01:00:01.000Z' }], caseInsensitive: true };
    assert.deepEqual(kinds(settleClaims(history.fold(), 'c1-1', folded, worktree).events), [['claims.lost', { phase: 'fixes', unit: 'c2-1', cluster: 'c2', files: [{ path: 'src/a.ts', claimedAt: '2026-10-09T01:00:01.000Z', reason: 'owned', holder: 'c1' }] }]]);
    assert.equal(lateClaim(history.fold(), 'c2-1', ['Src/A.ts'], true), null, 'nor is it free for a late claim');
  });

  it('records a marker by the exact path it names where the file system does not fold case, though the worktree holds a file spelled otherwise', () => {
    const directory = mkdtempSync(join(tmpdir(), 'deep-review-claim-events-'));
    try {
      mkdirSync(join(directory, 'src'));
      writeFileSync(join(directory, 'src', 'a.ts'), 'a\n');
      // c2 claims a new src/A.ts beside c1's src/a.ts: on a case-sensitive file system two files, so neither owned by c1 nor c1's.
      const settle = settleClaims(running().fold(), 'c1-1', live(marker('src/A.ts', 'c2-1', 'c2')), directory);
      assert.deepEqual(kinds(settle.events), [['files.claimed', { phase: 'fixes', key: 'c2-1', cluster: 'c2', files: [{ path: 'src/A.ts', claimedAt: '2026-10-09T01:00:01.000Z' }] }]]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('lateClaim', () => {
  const state = (): RunState => running().add('files.claimed', claimed('c2-1', 'c2', [shared])).add('files.claimed', claimed('c1-1', 'c1', ['docs/mine.md'])).fold();

  it('claims for the answering batch\'s cluster, with no time, each named file nobody holds (R6)', () => {
    assert.deepEqual(lateClaim(state(), 'c1-1', ['src/a.ts', 'src/b.ts', shared, 'docs/mine.md', 'docs/new.md', 'docs/a.md'], false), { kind: 'files.claimed', version: 1, payload: { phase: 'fixes', key: 'c1-1', cluster: 'c1', files: [{ path: 'docs/a.md', claimedAt: null }, { path: 'docs/new.md', claimedAt: null }] } });
    assert.equal(lateClaim(state(), 'c1-1', ['src/a.ts', shared], false), null, 'its own file and a sibling\'s claim are no late claim');
  });

  it('claims a file only a settled cluster held', () => {
    const settled = running().add('files.claimed', claimed('c2-1', 'c2', [shared])).worker(51, 'fixer fixes:c2-1').add('fix.recorded', fixAnswer(worker(51), { key: 'c2-1', findings: [{ id: 'SWEEP-1', status: 'deferred', file: 'src/b.ts', line: 1, note: 'n', message: null, files: [], corrections: [], validation: [], requiredFiles: [] }] })).fold();
    assert.deepEqual((lateClaim(settled, 'c1-1', [shared], false)?.payload as { files: unknown[] }).files, [{ path: shared, claimedAt: null }]);
  });
});
