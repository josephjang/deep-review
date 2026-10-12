import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TreeRevised } from '../../src/checkpoint/events.ts';
import { emptyFixState, unitRevisions, type FixState } from '../../src/checkpoint/fix-state.ts';

/** A revision of `src/a.ts` by `source` in `phase`; its message and bytes play no part in whose it is. */
const revision = (phase: TreeRevised['phase'], source: TreeRevised['source']): TreeRevised => ({
  phase,
  source,
  change: { findings: [], message: { subject: 's', body: '' } },
  files: [{ path: 'src/a.ts', status: 'modified', before: null, beforeSymlink: false, symlink: false, after: null }],
});

const worker = '00000000-0000-4000-8000-000000000001';
const fixOf = (revisions: readonly TreeRevised[]): FixState => ({ ...emptyFixState(), revisions });

describe('unitRevisions', () => {
  it('holds a unit\'s fixer and attempt revisions, in ledger order', () => {
    const own = [revision('answer', { kind: 'attempt', key: 'pass-1', workerId: worker }), revision('answer', { kind: 'fix', key: 'pass-1', workerId: worker })];
    assert.deepEqual(unitRevisions(fixOf(own), 'answer', 'pass-1'), own);
  });

  it('leaves out another unit\'s, the same key in another phase, and a check\'s', () => {
    const fix = fixOf([
      revision('answer', { kind: 'fix', key: 'pass-2', workerId: worker }),
      revision('fixes', { kind: 'fix', key: 'pass-1', workerId: worker }),
      revision('answer-checks', { kind: 'check', check: 'lint' }),
    ]);
    assert.deepEqual(unitRevisions(fix, 'answer', 'pass-1'), []);
  });

  it('holds none for a run without revisions', () => {
    assert.deepEqual(unitRevisions(emptyFixState(), 'fixes', 'c1-1'), []);
  });
});
