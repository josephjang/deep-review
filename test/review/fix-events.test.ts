import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FilesClaimed, FixedFinding, FixRecorded, TreeRevised } from '../../src/checkpoint/events.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { EvidenceStore } from '../../src/evidence/store.ts';
import { foldedWith, type ClaimsAccess } from '../../src/review/claim-events.ts';
import { markerHash, type LiveClaim } from '../../src/review/claims.ts';
import { unsettledFiles } from '../../src/review/drift.ts';
import { attemptRevisionEvents, fixAnswerEvents, revisionMessage, type RevisionContext } from '../../src/review/fix-events.ts';
import { rawMatch } from '../../src/review/tree.ts';
import type { WorkerReceipt } from '../../src/runtime/launcher.ts';
import { fixerAnswer } from '../helpers/fake-runtime.ts';
import { git, remove, repositoryWith } from '../helpers/repository.ts';
import { baselined, claimed, fixAnswer, fixPlan, type History, worker } from '../helpers/review-history.ts';

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

describe('claims spelled otherwise (TD4 of commit series integrity)', () => {
  // c1 owns src/a.ts and c2 src/b.ts, one batch each; c2 deleted the tracked AGENTS.md, which no cluster owns.
  const twoClusterPlan = {
    routes: [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }],
    clusters: [{ id: 'c1', findingIds: ['RIPPLE-1'], files: ['src/a.ts'] }, { id: 'c2', findingIds: ['SWEEP-1'], files: ['src/b.ts'] }],
    batches: [{ key: 'c1-1', cluster: 'c1', findingIds: ['RIPPLE-1'] }, { key: 'c2-1', cluster: 'c2', findingIds: ['SWEEP-1'] }],
  };
  let directory: string;
  let repo: string;
  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-fix-events-')));
    repo = repositoryWith(join(directory, 'repo'), { 'AGENTS.md': '# Rules\n', 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
    remove(repo, 'AGENTS.md');
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** The run with c1-1's worker launched, its scope's head the repository's. */
  const stateOf = (history: History): RunState => {
    const state = history.worker(60, 'fixer fixes:c1-1').fold();
    return { ...state, scope: { ...state.scope!, head: git(repo, 'rev-parse', 'HEAD') } };
  };
  const contextOf = (state: RunState, claims: ClaimsAccess): RevisionContext => ({ state, worktree: repo, evidence: new EvidenceStore(join(directory, 'evidence')), match: rawMatch, claims });
  /** A case-folding claims directory holding these markers, or none to read. */
  const folding = (markers: LiveClaim[] | null): ClaimsAccess => ({ live: () => (markers === null ? null : { markers, caseInsensitive: true }), caseInsensitive: () => true });
  const running = (): History => baselined().start('fixes').add('fixes.planned', twoClusterPlan);
  const receipt = (paths: readonly string[]): WorkerReceipt => ({ workerId: worker(60), output: fixerAnswer([{ files: [...paths], subject: 'fix(a): Apply' }]) }) as unknown as WorkerReceipt;

  for (const [name, markers] of [['with the directory read', []], ['with no directory to read', null]] as const) {
    it(`records an answer naming a sibling's held, deleted file in another case as a violation, in the sibling's spelling, ${name}`, () => {
      const state = stateOf(running().add('files.claimed', claimed('c2-1', 'c2', ['AGENTS.md'])));
      const events = fixAnswerEvents({ phase: 'fixes', key: 'c1-1', role: 'fixer' }, receipt(['src/a.ts', 'agents.md']), contextOf(state, folding(markers === null ? null : [...markers])));
      assert.deepEqual(events.filter((event) => event.kind === 'files.claimed'), [], 'no late claim of a file a sibling holds');
      const recorded = events.find((event) => event.kind === 'fix.recorded')!.payload as FixRecorded;
      assert.deepEqual(recorded.violations, ['AGENTS.md']);
      assert.deepEqual(recorded.findings[0]!.files, ['src/a.ts', 'AGENTS.md']);
      assert.deepEqual(foldedWith(state, events).review!.fix!.answers.fixes['c1-1']!.violations, ['AGENTS.md'], 'the fold holds the violation as the engine judged it');
    });
  }

  it('neither claims late nor records as a violation a named file a sibling\'s marker not yet whole is claiming (F13)', () => {
    const state = stateOf(running());
    const events = fixAnswerEvents({ phase: 'fixes', key: 'c1-1', role: 'fixer' }, receipt(['src/a.ts', 'AGENTS.md']), contextOf(state, folding([{ whole: false, hash: markerHash('AGENTS.md', true), generation: 1 }])));
    assert.deepEqual(events.filter((event) => event.kind === 'files.claimed'), [], 'the sibling\'s claim settles at the next settle');
    assert.deepEqual((events.find((event) => event.kind === 'fix.recorded')!.payload as FixRecorded).violations, []);
  });

  it('refuses an answer blocked on a file its own cluster claimed, on the ledger or only in the directory', () => {
    const blocked = { workerId: worker(60), output: fixerAnswer([{ status: 'blocked', files: ['src/a.ts'], requiredFiles: ['AGENTS.md'] }]) } as unknown as WorkerReceipt;
    const onLedger = stateOf(running().add('files.claimed', claimed('c1-1', 'c1', ['AGENTS.md'])));
    assert.throws(() => fixAnswerEvents({ phase: 'fixes', key: 'c1-1', role: 'fixer' }, blocked, contextOf(onLedger, folding([]))), /blocked on AGENTS\.md, which its own cluster owns or claimed$/);
    const own: LiveClaim = { whole: true, hash: markerHash('AGENTS.md', true), generation: 1, path: 'AGENTS.md', cluster: 'c1', unit: 'c1-1', claimedAt: '2026-10-09T01:00:01.000Z' };
    assert.throws(() => fixAnswerEvents({ phase: 'fixes', key: 'c1-1', role: 'fixer' }, blocked, contextOf(stateOf(running()), folding([own]))), /blocked on AGENTS\.md, which its own cluster owns or claimed$/);
    const sibling = stateOf(running().add('files.claimed', claimed('c2-1', 'c2', ['AGENTS.md'])));
    const recorded = fixAnswerEvents({ phase: 'fixes', key: 'c1-1', role: 'fixer' }, blocked, contextOf(sibling, folding([]))).find((event) => event.kind === 'fix.recorded')!.payload as FixRecorded;
    assert.deepEqual(recorded.findings[0]!.requiredFiles, ['AGENTS.md'], 'a file a sibling claimed is one to block on');
  });

  it('leaves out of a failed attempt\'s revisions a sibling\'s deletion its claim spells otherwise', () => {
    const state = stateOf(running());
    const sibling: LiveClaim = { whole: true, hash: markerHash('agents.md', true), generation: 1, path: 'agents.md', cluster: 'c2', unit: 'c2-1', claimedAt: '2026-10-09T01:00:01.000Z' };
    const attempt = attemptRevisionEvents(contextOf(state, folding([sibling])), 'fixes', 'c1-1', worker(60), 'it died');
    assert.deepEqual(attempt.claims.map((event) => (event.payload as FilesClaimed).files.map((file) => file.path)), [['agents.md']]);
    assert.deepEqual(attempt.revisions.flatMap((event) => (event.payload as TreeRevised).files.map((file) => file.path)), ['src/a.ts'], 'the sibling\'s deletion of AGENTS.md is not this attempt\'s');
  });

  // R5: a sibling's claim keeps its file out of an attempt's revisions for the whole round, since the
  // attempt's snapshots may predate the sibling's edit, which its revision has already recorded (gate run 55ecace9).
  for (const [name, settle] of [
    ['still running', (history: History): History => history],
    ['settled with its answer', (history: History): History => history.worker(61, 'fixer fixes:c2-1').add('fix.recorded', fixAnswer(worker(61), {
      key: 'c2-1',
      findings: [{ ...finding('SWEEP-1', 'applied', 'docs(b): Note the import'), file: 'src/b.ts', files: ['src/b.ts', 'docs/b.md'] }],
    }))],
  ] as const) {
    it(`leaves out of a failed attempt's revisions a file a sibling claimed, the sibling ${name}`, () => {
      // Untracked files, so only the sibling's claim keeps docs/b.md out, not the rule for a tracked leftover; notes.md, which nobody claimed, is still the attempt's.
      writeFileSync(join(repo, 'notes.md'), 'c1\n');
      mkdirSync(join(repo, 'docs'));
      writeFileSync(join(repo, 'docs', 'b.md'), 'b\n');
      const state = stateOf(settle(running().add('files.claimed', claimed('c2-1', 'c2', ['docs/b.md']))));
      const attempt = attemptRevisionEvents(contextOf(state, folding([])), 'fixes', 'c1-1', worker(60), 'it died');
      assert.deepEqual(attempt.revisions.flatMap((event) => (event.payload as TreeRevised).files.map((file) => file.path)), ['notes.md', 'src/a.ts'], 'the sibling\'s docs/b.md is not this attempt\'s');
    });
  }

  it('leaves out of a failed attempt\'s revisions a tracked file outside the change that its cluster did not claim, a tool\'s leftover, and takes it once claimed (PD9)', () => {
    // AGENTS.md is tracked, outside the scope, and deleted on disk, as a build would rewrite dist/.
    const unclaimed = attemptRevisionEvents(contextOf(stateOf(running()), folding([])), 'fixes', 'c1-1', worker(60), 'it died');
    assert.deepEqual(unclaimed.revisions.flatMap((event) => (event.payload as TreeRevised).files.map((file) => file.path)), ['src/a.ts']);
    const claimedByIt = attemptRevisionEvents(contextOf(stateOf(running().add('files.claimed', claimed('c1-1', 'c1', ['AGENTS.md']))), folding([])), 'fixes', 'c1-1', worker(60), 'it died');
    assert.deepEqual(claimedByIt.revisions.flatMap((event) => (event.payload as TreeRevised).files.map((file) => file.path)), ['AGENTS.md', 'src/a.ts']);
  });
});
