import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FixedFinding } from '../../src/checkpoint/events.ts';
import { unsettledFiles } from '../../src/review/drift.ts';
import { revisionMessage } from '../../src/review/fix-events.ts';
import { baselined, fixAnswer, fixPlan, worker } from '../helpers/review-history.ts';

const finding = (id: string, status: FixedFinding['status'], subject: string | null = null): FixedFinding => ({
  id, status, file: 'src/a.ts', line: 1, note: `${id} note`, message: subject === null ? null : { subject, body: `${subject}, because.` },
  files: ['src/a.ts'], corrections: [], validation: [], requiredFiles: [],
});

describe('revisionMessage', () => {
  it('is the fixer\'s own message for a revision of one applied finding', () => {
    assert.deepEqual(revisionMessage({ findings: ['A-1'] }, [finding('A-1', 'applied', 'fix: One'), finding('A-2', 'applied', 'fix: Two')]), { subject: 'fix: One', body: 'fix: One, because.' });
  });

  it('names a finding folded into it for want of a snapshot', () => {
    const message = revisionMessage({ findings: ['A-1', 'A-2'] }, [finding('A-1', 'deferred'), finding('A-2', 'applied', 'fix: Two')]);
    assert.equal(message.subject, 'fix: Two');
    assert.equal(message.body, 'fix: Two, because.\n\nThis commit also holds the edits made for A-1, which no snapshot of the fixer\'s set apart.');
  });

  it('holds every applied finding\'s message when it holds several, under a subject that names them', () => {
    const message = revisionMessage({ findings: ['A-1', 'A-2'] }, [finding('A-1', 'applied', 'fix: One'), finding('A-2', 'applied', 'fix: Two')]);
    assert.deepEqual(message, { subject: 'Apply A-1, A-2', body: 'fix: One\n\nfix: One, because.\n\nfix: Two\n\nfix: Two, because.' });
  });

  it('is composed from the notes for a revision that holds no applied finding, such as a deferred finding\'s partial edit', () => {
    assert.deepEqual(revisionMessage({ findings: ['A-1'] }, [finding('A-1', 'deferred')]), { subject: 'Keep the edits made for A-1', body: 'A-1 deferred: A-1 note' });
  });

  it('keeps a composed subject within 72 characters however many findings it names', () => {
    const ids = Array.from({ length: 20 }, (_, index) => `FOOTGUNS-${String(index + 1)}`);
    const message = revisionMessage({ findings: ids }, ids.map((id) => finding(id, 'deferred')));
    assert.ok(message.subject.length <= 72, message.subject);
    assert.match(message.subject, /\[truncated\]$/);
  });
});

describe('unsettledFiles', () => {
  it('is the files of every unit of an editing phase with no answer that has not failed, and nothing for a reading phase', () => {
    const running = baselined().start('fixes').add('fixes.planned', fixPlan);
    assert.deepEqual([...unsettledFiles(running.fold(), 'fixes')], ['src/a.ts']);
    assert.deepEqual([...unsettledFiles(running.fold(), 'baseline-checks')], []);
    const answered = baselined().start('fixes').add('fixes.planned', fixPlan).worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50)));
    assert.deepEqual([...unsettledFiles(answered.fold(), 'fixes')], [], 'an answered unit\'s files are revised and compared');
    const failed = baselined().start('fixes').add('fixes.planned', fixPlan).add('unit.unattempted', { phase: 'fixes', key: 'c1-1', cause: 'failures', reason: 'r' });
    assert.deepEqual([...unsettledFiles(failed.fold(), 'fixes')], [], 'a failed unit\'s edits are revised with its failure and compared');
  });
});
