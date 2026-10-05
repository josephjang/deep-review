// A recorded run as a verifier replay reads it, built event by event on the
// synthetic histories of review-history.ts: a first pool whose one group
// was answered on its verifier's second attempt, and a sweep pool whose one
// group went unverified after two launched verifiers failed.
import { found, unlocated, candidate, worker, type History } from './review-history.ts';

/** The label of a verifier's launch for a group. */
export const verifierLabel = (phase: string, group: string): string => `verifier ${phase}:${group}`;

const failedWorker = { outcome: 'failed', output: null, error: 'The answer does not match the output schema' };

/**
 * The run through both verification phases. Group g1 of the first pool
 * holds SCAN-1 and RIPPLE-1: worker 21 fails, worker 22 confirms the first
 * and refutes the second. Group g1 of the sweep pool holds the unlocated
 * design candidate SWEEP-1 and SWEEP-2: workers 32 and 33 both fail, so
 * the group is unverified.
 */
export const twiceVerified = (): History =>
  found()
    .start('deduplication')
    .worker(20, 'deduplication deduplication:deduplication')
    .add('deduplication.recorded', { phase: 'deduplication', workerId: worker(20), groups: [] })
    .finish('deduplication')
    .start('verification')
    .add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['SCAN-1', 'RIPPLE-1'] }] })
    .worker(21, verifierLabel('verification', 'g1'), failedWorker)
    .add('attempt.failed', { phase: 'verification', key: 'g1', workerId: worker(21), reason: 'failed: The answer does not match the output schema' })
    .worker(22, verifierLabel('verification', 'g1'))
    .add('verdicts.recorded', { phase: 'verification', groupId: 'g1', workerId: worker(22), verdicts: [{ id: 'SCAN-1', verdict: 'CONFIRMED', evidence: 'line 3 dereferences null' }, { id: 'RIPPLE-1', verdict: 'REFUTED', evidence: 'the caller checks first' }] })
    .finish('verification')
    .start('sweep')
    .worker(30, 'sweep sweep:sweep')
    .add('candidates.recorded', { phase: 'sweep', key: 'sweep', workerId: worker(30), candidates: [unlocated('SWEEP-1', 'DESIGN'), candidate('SWEEP-2', 'SCAN', { line: 7, rawLine: 7 })], leads: null })
    .finish('sweep')
    .start('sweep-deduplication')
    .worker(31, 'deduplication sweep-deduplication:sweep-deduplication')
    .add('deduplication.recorded', { phase: 'sweep-deduplication', workerId: worker(31), groups: [] })
    .finish('sweep-deduplication')
    .start('sweep-verification')
    .add('verification.planned', { phase: 'sweep-verification', groups: [{ id: 'g1', candidateIds: ['SWEEP-1', 'SWEEP-2'] }] })
    .worker(32, verifierLabel('sweep-verification', 'g1'), failedWorker)
    .add('attempt.failed', { phase: 'sweep-verification', key: 'g1', workerId: worker(32), reason: 'failed' })
    .worker(33, verifierLabel('sweep-verification', 'g1'), failedWorker)
    .add('attempt.failed', { phase: 'sweep-verification', key: 'g1', workerId: worker(33), reason: 'failed again' })
    .add('group.unverified', { phase: 'sweep-verification', groupId: 'g1', reason: '2 attempts did not complete: failed; failed again' })
    .finish('sweep-verification', 'degraded');
