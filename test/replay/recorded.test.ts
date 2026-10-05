import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ReplayRefusedError } from '../../src/replay/errors.ts';
import { groupKey, isReplayable, recordedGroups } from '../../src/replay/recorded.ts';
import { twiceVerified, verifierLabel } from '../helpers/replay-history.ts';
import { History, swept, verified, worker } from '../helpers/review-history.ts';

describe('recordedGroups', () => {
  it('gives each planned group its candidates in the plan\'s order and the launch whose answer the run recorded', () => {
    const groups = recordedGroups(twiceVerified().fold());
    assert.deepEqual(groups.map(groupKey), ['verification:g1', 'sweep-verification:g1']);
    const [first] = groups;
    assert.deepEqual(first!.candidates.map((candidate) => candidate.id), ['SCAN-1', 'RIPPLE-1']);
    // Worker 21 failed first; the answer on the ledger is worker 22's.
    assert.equal(first!.launch?.workerId, worker(22));
    assert.equal(first!.launch?.label, verifierLabel('verification', 'g1'));
  });

  it('keeps the answering launch when the ledger holds a later launch under the same label', () => {
    const state = verified().worker(52, verifierLabel('verification', 'g1')).fold();
    assert.equal(recordedGroups(state)[0]!.launch?.workerId, worker(21));
  });

  it('gives a group that went unverified its last launch, since every attempt of a group is sent one task', () => {
    const sweep = recordedGroups(twiceVerified().fold())[1]!;
    assert.deepEqual(sweep.candidates.map((candidate) => candidate.id), ['SWEEP-1', 'SWEEP-2']);
    assert.equal(sweep.launch?.workerId, worker(33));
    assert.equal(isReplayable(sweep), true);
  });

  it('keeps a group no verifier was launched for, with no launch, so a replay can name it', () => {
    // The synthetic sweep verification records its two failures without their launches.
    const groups = recordedGroups(swept().fold());
    assert.deepEqual(groups.map((group) => [groupKey(group), group.launch?.workerId ?? null]), [['verification:g1', worker(21)], ['sweep-verification:g1', null]]);
    assert.deepEqual(groups.filter(isReplayable).map(groupKey), ['verification:g1']);
  });

  it('takes only verifier launches of the group\'s own phase and id', () => {
    // A launch of another role under the group's unit, and a verifier of the same group id in the other phase, are not the group's.
    const state = verified()
      .worker(50, 'sweep verification:g1')
      .worker(51, verifierLabel('sweep-verification', 'g1'))
      .fold();
    assert.deepEqual(recordedGroups(state).map((group) => group.launch?.workerId), [worker(21)]);
  });

  it('gives no group for a phase the run never planned, and refuses a run that is not a review', () => {
    assert.deepEqual(recordedGroups(verified().fold()).map(groupKey), ['verification:g1']);
    assert.throws(() => recordedGroups(new History().add('run.created', { worktree: '/w' }).fold()), (error: unknown) => {
      assert.ok(error instanceof ReplayRefusedError);
      assert.match(error.message, /^Run run-1 is not a review, so it has no verification to replay$/);
      return true;
    });
  });
});
