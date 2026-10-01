import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blockerSchema } from '../../src/checkpoint/events.ts';
import { describeRun } from '../../src/review/status.ts';
import { blockerActions, blockerCodes, recordedBlockerCodes } from '../../src/review/vocabulary.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { triaged } from '../helpers/review-history.ts';

const evidencePath = (reference: { sha256: string; bytes: number }): string => `/evidence/${reference.sha256}`;

// Every way a run stops short of a report names the operator's action (R5
// of the read-only review): each blocker code is held here to having one,
// and each code the ledger records to surviving `status --json` whole.
describe('the blocker codes', () => {
  it('give every code a non-empty action, and no action to a code that does not exist', () => {
    assert.deepEqual(Object.keys(blockerActions).sort(), [...blockerCodes].sort());
    for (const code of blockerCodes) assert.ok(blockerActions[code].trim().length > 0, code);
  });

  it('record a subset of the codes, and the ledger refuses the ones printed but never recorded', () => {
    for (const code of recordedBlockerCodes) assert.ok((blockerCodes as readonly string[]).includes(code), code);
    for (const code of blockerCodes) {
      const recorded = (recordedBlockerCodes as readonly string[]).includes(code);
      assert.equal(blockerSchema.safeParse({ code, detail: 'what happened', action: blockerActions[code] }).success, recorded, code);
    }
  });

  it('tell the operator of a drift where the expected bytes are and what to do with a moved HEAD (R7 of the fix pass)', () => {
    assert.match(blockerActions.drift, /restore the named files to the bytes the run expected, which the detail gives as evidence paths/);
    assert.match(blockerActions.drift, /a file expected absent is removed/);
    assert.match(blockerActions.drift, /reset a moved HEAD to the recorded head/);
  });

  for (const code of recordedBlockerCodes) {
    it(`keep a recorded ${code} blocker, its detail and its action, through status --json`, () => {
      const blocker = { code, detail: `the ${code} detail`, action: blockerActions[code] };
      const state = triaged().start('finders').finish('finders', 'blocked', 1, blocker).fold();
      const described = describeRun(state, claudeAdapter, evidencePath);
      const json = JSON.parse(JSON.stringify(described.json)) as { status: string; blocker: unknown };
      assert.equal(json.status, 'blocked');
      assert.deepEqual(json.blocker, { ...blocker, phase: 'finders' });
      assert.ok(described.lines.includes(`Action: ${blockerActions[code]}`), described.lines.join('\n'));
    });
  }
});
