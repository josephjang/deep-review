import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { heldOf } from '../../src/review/claim-events.ts';
import { claimsDirectories, type ClaimsDirectories } from '../../src/review/claims-directories.ts';
import { claimFile, claimsDirectoryFor, heldFileName, markerHash, readHeld } from '../../src/review/claims.ts';
import { baselined, claimed, type History } from '../helpers/review-history.ts';

// c1 owns src/a.ts and c2 src/b.ts, one batch each, both running.
const twoClusterPlan = {
  routes: [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }],
  clusters: [{ id: 'c1', findingIds: ['RIPPLE-1'], files: ['src/a.ts'] }, { id: 'c2', findingIds: ['SWEEP-1'], files: ['src/b.ts'] }],
  batches: [{ key: 'c1-1', cluster: 'c1', findingIds: ['RIPPLE-1'] }, { key: 'c2-1', cluster: 'c2', findingIds: ['SWEEP-1'] }],
};
const worktree = '/no/such/worktree';
const running = (): History => baselined().start('fixes').add('fixes.planned', twoClusterPlan);

/** The claims directories of a run in a fresh scratch, with the lines they log; the scratch is removed after `body`. */
function withDirectories(state: RunState, body: (directories: ClaimsDirectories, round: string, logged: string[]) => void): void {
  const scratchBase = mkdtempSync(join(tmpdir(), 'deep-review-claims-directories-'));
  const logged: string[] = [];
  try {
    const directories = claimsDirectories({ scratchBase, runId: state.id, worktree, state: () => state, caseInsensitive: () => false, command: (key, directory) => `claim ${key} ${directory}`, log: (line) => logged.push(line) });
    body(directories, claimsDirectoryFor(scratchBase, state.id, 1), logged);
  } finally {
    rmSync(scratchBase, { recursive: true, force: true });
  }
}

describe('claimsDirectories', () => {
  it('reads no claims, and loses nothing, from a directory this engine has not prepared, as a resumed engine\'s before its first launch (R3)', () => {
    withDirectories(running().fold(), (directories, round, logged) => {
      assert.equal(directories.claims.directoryOf('c1-1'), round);
      assert.equal(directories.claims.command('c1-1', round), `claim c1-1 ${round}`);
      assert.equal(directories.claims.live('c1-1'), null);
      assert.equal(directories.lost(), null);
      assert.deepEqual(logged, []);
    });
  });

  it('prepares the round\'s directory with what the claim command is told and the ledger\'s claims seeded back (R2, R3, TD2)', () => {
    const state = running().add('files.claimed', claimed('c2-1', 'c2', ['docs/b.md'], '2026-10-09T01:00:01.000Z')).fold();
    withDirectories(state, (directories, round) => {
      assert.equal(directories.prepare('c1-1'), true);
      assert.deepEqual(readHeld(round), heldOf(state.review!.fix!, 1, worktree, false));
      assert.deepEqual(directories.claims.live('c1-1'), { markers: [{ whole: true, hash: markerHash('docs/b.md', false), generation: 1, path: 'docs/b.md', cluster: 'c2', unit: 'c2-1', claimedAt: '2026-10-09T01:00:01.000Z' }], caseInsensitive: false });
      assert.equal(directories.prepare('c2-1'), true, 'a directory it prepared and still finds is prepared again');
    });
  });

  it('loses a directory it prepared and finds removed or emptied in place once, and it stays lost, whether a read or a launch finds it (R12)', () => {
    for (const removal of ['removed', 'emptied'] as const) {
      for (const finder of ['read', 'launch'] as const) {
        withDirectories(running().fold(), (directories, round, logged) => {
          assert.equal(directories.prepare('c1-1'), true);
          assert.equal(claimFile(round, 'docs/a.md', 'c1-1').kind, 'claimed');
          // A temporary file cleaner may take the directory, or only the files in it, the markers with held.json.
          if (removal === 'removed') rmSync(round, { recursive: true, force: true });
          else for (const name of readdirSync(round)) rmSync(join(round, name));
          if (finder === 'read') assert.equal(directories.claims.live('c1-1'), null, `${removal} ${finder}`);
          else assert.equal(directories.prepare('c1-1'), false, `${removal} ${finder}`);
          assert.equal(directories.lost(), round, `${removal} ${finder}`);
          assert.equal(directories.prepare('c2-1'), false, 'no launch prepares it again');
          assert.equal(existsSync(join(round, heldFileName)), false, 'nor is it written again');
          assert.equal(directories.claims.live('c2-1'), null);
          assert.equal(directories.lost(), round);
          assert.deepEqual(logged, [`phase fixes: the claims directory ${round} is gone; no more launches, the running units will be recorded as failed attempts`], 'the loss is said once');
        });
      }
    }
  });

  it('records a settle from one reading of its directory, which a removal after it does not change', () => {
    withDirectories(running().fold(), (directories, round) => {
      assert.equal(directories.prepare('c1-1'), true);
      assert.equal(claimFile(round, 'docs/a.md', 'c1-1').kind, 'claimed');
      const reading = directories.settleReading('c1-1');
      rmSync(round, { recursive: true, force: true });
      assert.deepEqual(reading.live('c1-1')?.markers.map((marker) => marker.whole && marker.path), ['docs/a.md'], 'the reading taken before the removal');
      assert.equal(directories.lost(), null, 'the reading found the directory');
      assert.equal(reading.live('c2-1'), null, 'another unit\'s directory is read afresh');
      assert.equal(directories.lost(), round);
    });
  });
});
