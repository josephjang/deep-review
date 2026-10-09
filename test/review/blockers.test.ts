import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blockerSchemaV5 } from '../../src/checkpoint/events.ts';
import { describeRun } from '../../src/review/status.ts';
import { blockerActions, blockerCodes, recordedBlockerCodes, surveyWorkerFailedAction } from '../../src/review/vocabulary.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { baselined, surveyConfiguredFix, triaged, type History } from '../helpers/review-history.ts';

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
      assert.equal(blockerSchemaV5.safeParse({ code, detail: 'what happened', action: blockerActions[code] }).success, recorded, code);
    }
  });

  it('tell the operator of a drift where the expected bytes are and what to do with a moved HEAD (R7 of the fix pass)', () => {
    assert.match(blockerActions.drift, /restore the named files to the bytes the run expected, which the detail gives as evidence paths/);
    assert.match(blockerActions.drift, /a file expected absent is removed/);
    assert.match(blockerActions.drift, /reset a moved HEAD to the recorded head/);
  });

  it('tell the operator of a check this machine cannot run how to settle it, and of a fix run\'s failed survey how to go on without it (R9, R15 of the repository survey)', () => {
    assert.match(blockerActions['check-unavailable'], /install the missing tool and run the command again/);
    assert.match(blockerActions['check-unavailable'], /--no-check <kind> to go without that check/);
    assert.match(blockerActions['check-unavailable'], /--check <kind>=<command> to name one that runs/);
    assert.match(surveyWorkerFailedAction, /surveys the repository afresh/);
    assert.match(surveyWorkerFailedAction, /--check <kind>=<command> or --no-check <kind> for each of build, typecheck, lint and test/);
  });

  it('tell the operator of a lost claims directory that the next run seeds it and retries the units that ran without it (R12 of commit series integrity)', () => {
    assert.match(blockerActions['claims-lost'], /run the command again, which seeds the claims directory from the ledger and gives the units that ran without it fresh attempts/);
  });

  for (const code of recordedBlockerCodes) {
    it(`keep a recorded ${code} blocker, its detail and its action, through status --json`, () => {
      const blocker = { code, detail: `the ${code} detail`, action: blockerActions[code] };
      // Only the survey blocks on a check that cannot run, and only the fixes phase, at version 5, on a lost claims directory; every other code is held in a phase of the review.
      const phase = code === 'check-unavailable' ? 'survey' : code === 'claims-lost' ? 'fixes' : 'finders';
      const started: History = code === 'check-unavailable' ? surveyConfiguredFix().start(phase) : code === 'claims-lost' ? baselined().start(phase) : triaged().start(phase);
      const state = (code === 'claims-lost' ? started.add('phase.finished', { phase, attempt: 1, outcome: 'blocked', blocker }, 5) : started.finish(phase, 'blocked', 1, blocker)).fold();
      const described = describeRun(state, claudeAdapter, evidencePath);
      const json = JSON.parse(JSON.stringify(described.json)) as { status: string; blocker: unknown };
      assert.equal(json.status, 'blocked');
      assert.deepEqual(json.blocker, { ...blocker, phase });
      assert.ok(described.lines.includes(`Action: ${blockerActions[code]}`), described.lines.join('\n'));
    });
  }
});
