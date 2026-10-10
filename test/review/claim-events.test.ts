import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { NewEvent } from '../../src/checkpoint/checkpoint.ts';
import { claimsLostV1, filesClaimedV1, maxClaimFilesPerEvent, type FilesClaimed } from '../../src/checkpoint/events.ts';
import { claimRefusal, exactPath, heldByOthers } from '../../src/checkpoint/fix-state.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { foldedWith, heldOf, isPending, lateClaim, settleClaims, settledNothing, type LiveClaims } from '../../src/review/claim-events.ts';
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
const filesOf = (event: NewEvent): FilesClaimed['files'] => (event.payload as FilesClaimed).files;

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
    assert.deepEqual(heldByOthers(settle.state.review!.fix!, 'c1-1', exactPath).get(shared), { cluster: 'c2', by: 'claim' }, 'the answer is judged against the sibling\'s claim');
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
    assert.deepEqual(lateClaim(settledNothing(history.fold(), true), 'c2-1', ['Src/A.ts']), [], 'nor is it free for a late claim');
  });

  it('splits a unit\'s claims, and its lost markers, of more files than an event holds into consecutive events the ledger takes', () => {
    const paths = Array.from({ length: maxClaimFilesPerEvent + 1 }, (_, index) => `docs/f${String(index)}.md`);
    const settle = settleClaims(running().fold(), 'c1-1', live(...paths.map((path) => marker(path, 'c1-1', 'c1')), ...paths.map((path) => marker(path, 'c9-1', 'c9'))), worktree);
    assert.deepEqual(settle.events.map((event) => [event.kind, (event.payload as { files: unknown[] }).files.length]), [['claims.lost', maxClaimFilesPerEvent], ['claims.lost', 1], ['files.claimed', maxClaimFilesPerEvent], ['files.claimed', 1]]);
    for (const event of settle.events) assert.equal((event.kind === 'files.claimed' ? filesClaimedV1 : claimsLostV1).safeParse(event.payload).success, true, event.kind);
    assert.deepEqual(settle.state.review!.fix!.claims.map((claim) => claim.path).sort(), [...paths].sort(), 'every claim is folded');
    assert.equal(settle.state.review!.fix!.lostClaims.length, paths.length, 'and every lost marker');
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
    assert.deepEqual(lateClaim(settledNothing(state(), false), 'c1-1', ['src/a.ts', 'src/b.ts', shared, 'docs/mine.md', 'docs/new.md', 'docs/a.md']), [{ kind: 'files.claimed', version: 1, payload: { phase: 'fixes', key: 'c1-1', cluster: 'c1', files: [{ path: 'docs/a.md', claimedAt: null }, { path: 'docs/new.md', claimedAt: null }] } }]);
    assert.deepEqual(lateClaim(settledNothing(state(), false), 'c1-1', ['src/a.ts', shared]), [], 'its own file and a sibling\'s claim are no late claim');
  });

  it('claims a file only a settled cluster held', () => {
    const settled = running().add('files.claimed', claimed('c2-1', 'c2', [shared])).worker(51, 'fixer fixes:c2-1').add('fix.recorded', fixAnswer(worker(51), { key: 'c2-1', findings: [{ id: 'SWEEP-1', status: 'deferred', file: 'src/b.ts', line: 1, note: 'n', message: null, files: [], corrections: [], validation: [], requiredFiles: [] }] })).fold();
    assert.deepEqual(lateClaim(settledNothing(settled, false), 'c1-1', [shared]).map(filesOf), [[{ path: shared, claimedAt: null }]]);
  });

  it('leaves out a named file a sibling\'s marker not yet whole is claiming, which its next settle records (F13)', () => {
    const settle = settleClaims(running().fold(), 'c1-1', live({ whole: false, hash: markerHash('docs/x.md', false), generation: 1 }), worktree);
    assert.deepEqual(lateClaim(settle, 'c1-1', ['docs/x.md', 'docs/new.md']).map(filesOf), [[{ path: 'docs/new.md', claimedAt: null }]]);
    assert.deepEqual(lateClaim(settle, 'c1-1', ['docs/x.md']), []);
  });

  it('leaves out a named file a claim cannot record, such as a POSIX a:b.txt, so the event it makes is one the ledger takes', () => {
    const long = `docs/${'x'.repeat(1000)}.md`;
    const late = lateClaim(settledNothing(state(), false), 'c1-1', ['a:b.txt', long, 'docs/new.md']);
    assert.deepEqual(late.map(filesOf), [[{ path: 'docs/new.md', claimedAt: null }]]);
    assert.equal(filesClaimedV1.safeParse(late[0]!.payload).success, true);
    assert.deepEqual(lateClaim(settledNothing(state(), false), 'c1-1', ['a:b.txt', long]), []);
  });

  it('splits a late claim of more files than an event holds into consecutive events in path order, each one the ledger takes, which fold to every file', () => {
    const named = Array.from({ length: maxClaimFilesPerEvent + 1 }, (_, index) => `docs/f${String(index).padStart(4, '0')}.md`);
    const late = lateClaim(settledNothing(state(), false), 'c1-1', [...named].reverse());
    assert.deepEqual(late.map((event) => filesOf(event).map((file) => file.path)), [named.slice(0, maxClaimFilesPerEvent), named.slice(maxClaimFilesPerEvent)]);
    for (const event of late) assert.equal(filesClaimedV1.safeParse(event.payload).success, true);
    const claims = foldedWith(state(), late).review!.fix!.claims.filter((claim) => claim.claimedAt === null);
    assert.deepEqual(claims.map((claim) => [claim.key, claim.cluster, claim.path]), named.map((path) => ['c1-1', 'c1', path]));
  });

  it('refuses a key the fix plan has no batch for', () => {
    assert.throws(() => lateClaim(settledNothing(state(), false), 'c9-1', ['docs/new.md']), /The fix plan has no batch c9-1/);
  });
});

describe('heldOf', () => {
  it('tells the claim command the round\'s owned files, each batch\'s cluster and the clusters settled now (R2, TD2)', () => {
    const settled = running().worker(51, 'fixer fixes:c2-1').add('fix.recorded', fixAnswer(worker(51), { key: 'c2-1', findings: [{ id: 'SWEEP-1', status: 'deferred', file: 'src/b.ts', line: 1, note: 'n', message: null, files: [], corrections: [], validation: [], requiredFiles: [] }] })).fold();
    assert.deepEqual(heldOf(settled.review!.fix!, 1, worktree, true), {
      worktree,
      clusters: { c1: ['src/a.ts'], c2: ['src/b.ts'] },
      units: { 'c1-1': 'c1', 'c2-1': 'c2' },
      settled: ['c2'],
      caseInsensitive: true,
    });
    assert.deepEqual(heldOf(running().fold().review!.fix!, 1, worktree, false).settled, [], 'no cluster has settled before its batch answers');
  });

  it('refuses a round not yet planned, whose units cannot have launched', () => {
    assert.throws(() => heldOf(running().fold().review!.fix!, 2, worktree, false), /no round 2/);
  });
});

describe('claimRefusal', () => {
  it('refuses a path a cluster owns, one its own cluster holds already or another unsettled one holds, and frees one only a settled cluster held (R3, PD3)', () => {
    const settled = new Set(['c3']);
    assert.equal(claimRefusal(undefined, 'c1', settled), null);
    assert.equal(claimRefusal({ cluster: 'c2', by: 'plan' }, 'c1', settled), 'owned');
    assert.equal(claimRefusal({ cluster: 'c3', by: 'plan' }, 'c1', settled), 'owned', 'a settled owner still owns its file');
    assert.equal(claimRefusal({ cluster: 'c1', by: 'claim' }, 'c1', settled), 'held');
    assert.equal(claimRefusal({ cluster: 'c2', by: 'claim' }, 'c1', settled), 'held');
    assert.equal(claimRefusal({ cluster: 'c3', by: 'claim' }, 'c1', settled), null);
    assert.equal(claimRefusal({ cluster: 'c3', by: 'claim' }, 'c3', settled), 'held', 'a settled cluster holds its own claim still');
  });
});
