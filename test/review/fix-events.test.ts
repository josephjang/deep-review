import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FilesClaimed, FixedFinding, FixRecorded, FixRecordedV4, TreeRevised } from '../../src/checkpoint/events.ts';
import { documentationItemsOf, ownedFiles } from '../../src/checkpoint/fix-state.ts';
import { applyEvent, type RunState } from '../../src/checkpoint/fold.ts';
import { EvidenceStore } from '../../src/evidence/store.ts';
import { foldedWith, type ClaimsAccess } from '../../src/review/claim-events.ts';
import { markerHash, type LiveClaim } from '../../src/review/claims.ts';
import { planPathOf } from '../../src/review/documents.ts';
import { expectedTreeOf, unsettledFiles } from '../../src/review/drift.ts';
import { attemptRevisionEvents, checkRevision, fixAnswerEvents, revisionMessage, type AnswerContext, type RevisionContext } from '../../src/review/fix-events.ts';
import { prepareCheckManifest, prepareSnapshots, snapshotsDirectoryName, takeSnapshot } from '../../src/review/snapshot.ts';
import type { Unit } from '../../src/review/steps.ts';
import { rawMatch } from '../../src/review/tree.ts';
import type { WorkerReceipt } from '../../src/runtime/launcher.ts';
import { fixerAnswer } from '../helpers/fake-runtime.ts';
import { git, remove, repositoryWith, write } from '../helpers/repository.ts';
import { answer, baselined, checksPhase, claimed, decidedFixRun, decidedOf, documentationAnswered, endCheck, fixAnswer, fixPlan, fixRevision, launch, mergeRanked, noSecondRound, ranOnBase, type History, withBaseChecks, withDocumentationStep, withFixPass, worker } from '../helpers/review-history.ts';

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
    assert.deepEqual(message, { subject: 'fix: Apply A-1, A-2', body: 'fix: One\n\nfix: One, because.\n\nfix: Two\n\nfix: Two, because.' });
  });

  it('gives that subject the conventional type its messages share, else fix, and none when a message has no type (the gate of resumable runs)', () => {
    const subject = (...subjects: string[]): string => revisionMessage({ findings: subjects.map((_, index) => `A-${String(index + 1)}`) }, subjects.map((text, index) => finding(`A-${String(index + 1)}`, 'applied', text))).subject;
    assert.equal(subject('fix(checkpoint): One', 'fix(checkpoint): Two'), 'fix(checkpoint): Apply A-1, A-2', 'one type and one scope');
    assert.equal(subject('refactor(review): One', 'refactor(checkpoint): Two'), 'refactor: Apply A-1, A-2', 'one type, two scopes');
    assert.equal(subject('refactor(review): One', 'fix(review): Two', 'refactor: Three'), 'fix: Apply A-1, A-2, A-3', 'types that differ');
    assert.equal(subject('feat!: One', 'feat: Two'), 'feat: Apply A-1, A-2', 'a breaking mark is not a type of its own');
    assert.equal(subject('fix: One', 'Guard the null in parse'), 'Apply A-1, A-2', 'a repository that writes no conventional commits');
    assert.equal(subject('Fix: One', 'Fix: Two'), 'Apply A-1, A-2', 'a capitalized word before a colon is not a type');
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
  const contextOf = (state: RunState, claims: ClaimsAccess): AnswerContext => ({ state, worktree: repo, evidence: new EvidenceStore(join(directory, 'evidence')), match: rawMatch, claims, log: () => {} });
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
    const attempt = attemptRevisionEvents(contextOf(state, folding([sibling])), 'fixes', 'c1-1', worker(60), 'it died', 'failed');
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
      const attempt = attemptRevisionEvents(contextOf(state, folding([])), 'fixes', 'c1-1', worker(60), 'it died', 'failed');
      assert.deepEqual(attempt.revisions.flatMap((event) => (event.payload as TreeRevised).files.map((file) => file.path)), ['notes.md', 'src/a.ts'], 'the sibling\'s docs/b.md is not this attempt\'s');
    });
  }

  it('records for an attempt lost with its engine only its owned and claimed files, leaving a file git reports changed to the next check of the tree, while a failed attempt takes it (R10 of resumable runs)', () => {
    // notes.md is untracked and claimed by nobody: a person's edit while no engine ran, or a fixer's unclaimed one.
    writeFileSync(join(repo, 'notes.md'), 'a person\'s note\n');
    const state = stateOf(running().add('files.claimed', claimed('c1-1', 'c1', ['AGENTS.md'])));
    const paths = (end: 'failed' | 'lost'): string[] => attemptRevisionEvents(contextOf(state, folding([])), 'fixes', 'c1-1', worker(60), 'it died', end).revisions.flatMap((event) => (event.payload as TreeRevised).files.map((file) => file.path));
    assert.deepEqual(paths('lost'), ['AGENTS.md', 'src/a.ts']);
    assert.deepEqual(paths('failed'), ['AGENTS.md', 'notes.md', 'src/a.ts'], 'an attempt that failed while the engine lived keeps the paths git reports (R5 of commit series integrity)');
  });

  it('leaves out of a failed attempt\'s revisions a tracked file outside the change that its cluster did not claim, a tool\'s leftover, and takes it once claimed (PD9)', () => {
    // AGENTS.md is tracked, outside the scope, and deleted on disk, as a build would rewrite dist/.
    const unclaimed = attemptRevisionEvents(contextOf(stateOf(running()), folding([])), 'fixes', 'c1-1', worker(60), 'it died', 'failed');
    assert.deepEqual(unclaimed.revisions.flatMap((event) => (event.payload as TreeRevised).files.map((file) => file.path)), ['src/a.ts']);
    const claimedByIt = attemptRevisionEvents(contextOf(stateOf(running().add('files.claimed', claimed('c1-1', 'c1', ['AGENTS.md']))), folding([])), 'fixes', 'c1-1', worker(60), 'it died', 'failed');
    assert.deepEqual(claimedByIt.revisions.flatMap((event) => (event.payload as TreeRevised).files.map((file) => file.path)), ['AGENTS.md', 'src/a.ts']);
  });
});

describe('checkRevision (PD9 of commit series integrity)', () => {
  let directory: string;
  let repo: string;
  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-check-revision-')));
    // docs/notes.md and dist/a.js are tracked and outside the scope, whose one file, src/a.ts, differs on disk from what the run expects of it.
    repo = repositoryWith(join(directory, 'repo'), { 'docs/notes.md': 'notes\n', 'dist/a.js': 'a\n', 'src/a.ts': 'a\n' });
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** The run in its checks phase, its first worktree check having listed `strays`, its scope's head the repository's. */
  const contextOf = (strays: readonly string[]): RevisionContext => {
    const state = baselined().fold();
    const [first, ...rest] = state.review!.checks;
    const review = { ...state.review!, checks: [{ ...first!, strays: [...strays] }, ...rest] };
    return { state: { ...state, review, scope: { ...state.scope!, head: git(repo, 'rev-parse', 'HEAD') } }, worktree: repo, evidence: new EvidenceStore(join(directory, 'evidence')), match: rawMatch, claims: { live: () => null, caseInsensitive: () => false } };
  };
  const pathsOf = (event: ReturnType<typeof checkRevision>): string[] => (event === null ? [] : (event.payload as TreeRevised).files.map((file) => file.path));

  it('leaves out a tracked file the user had changed before the run, even when the check rewrites it, and takes a tool\'s rewrite of a clean one', () => {
    // The user's uncommitted work, there before the run's first check listed it as a stray.
    write(repo, 'docs/notes.md', 'notes\nthe user\'s unfinished line\n');
    const manifest = prepareCheckManifest(join(directory, 'manifest'), repo);
    // The check formats the user's file and rebuilds dist/.
    write(repo, 'docs/notes.md', 'notes\n\nthe user\'s unfinished line\n');
    write(repo, 'dist/a.js', 'rebuilt a\n');
    assert.deepEqual(pathsOf(checkRevision(contextOf(['docs/notes.md']), 'checks', 'lint', 'npm run lint', manifest)), ['dist/a.js', 'src/a.ts'], 'the user\'s file is in no check revision');
    // Had the first check found docs/notes.md unchanged, its rewrite would be the check's alone.
    assert.deepEqual(pathsOf(checkRevision(contextOf([]), 'checks', 'lint', 'npm run lint', manifest)), ['dist/a.js', 'docs/notes.md', 'src/a.ts']);
  });
});

describe('the events of an answer pass\'s fixer (R5 of answers)', () => {
  let directory: string;
  let repo: string;
  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-answer-events-')));
    repo = repositoryWith(join(directory, 'repo'), { 'src/a.ts': 'a\n', 'docs/parse.md': 'parse throws on a null input\n' });
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** The decided fix run with RIPPLE-1's departure rejected, its pass open and its fixer launched, its scope's head the repository's. */
  const passing = (): RunState => {
    const state = decidedFixRun().add('answer.recorded', answer('RIPPLE-1', 'reject')).add('answer.pass', { ids: ['RIPPLE-1'] }).start('answer').worker(71, 'fixer answer:pass-1').fold();
    return { ...state, scope: { ...state.scope!, head: git(repo, 'rev-parse', 'HEAD') } };
  };
  const contextOf = (state: RunState): AnswerContext => ({ state, worktree: repo, evidence: new EvidenceStore(join(directory, 'evidence')), match: rawMatch, claims: { live: () => null, caseInsensitive: () => false }, log: () => {} });
  const receipt = (paths: readonly string[]): WorkerReceipt => ({ workerId: worker(71), output: fixerAnswer([{ files: [...paths], subject: 'fix: Follow the rule parse throws on null' }]) }) as unknown as WorkerReceipt;

  it('records the pass\'s answer under its key, claims nothing, judges no violation, and takes a file outside what it owns as named', () => {
    write(repo, 'src/a.ts', 'a, restored\n');
    write(repo, 'docs/parse.md', 'parse throws on a null input, as stated\n');
    const events = fixAnswerEvents({ phase: 'answer', key: 'pass-1', role: 'fixer' }, receipt(['src/a.ts', 'docs/parse.md']), contextOf(passing()));
    assert.deepEqual(events.filter((event) => event.kind === 'files.claimed' || event.kind === 'claims.lost'), [], 'an answer pass claims nothing');
    const recorded = events.find((event) => event.kind === 'fix.recorded')!;
    assert.equal(recorded.version, 2);
    const payload = recorded.payload as FixRecorded;
    assert.equal(payload.phase, 'answer');
    assert.equal(payload.key, 'pass-1');
    assert.deepEqual(payload.findings.map((entry) => [entry.id, entry.files]), [['RIPPLE-1', ['src/a.ts', 'docs/parse.md']]]);
    assert.deepEqual(payload.violations, []);
    const revisions = events.filter((event) => event.kind === 'tree.revised');
    assert.ok(revisions.length > 0);
    for (const event of revisions) {
      assert.equal(event.version, 2);
      const revision = event.payload as TreeRevised;
      assert.equal(revision.phase, 'answer');
      assert.deepEqual(revision.source, { kind: 'fix', key: 'pass-1', workerId: worker(71) });
    }
    assert.deepEqual([...new Set(revisions.flatMap((event) => (event.payload as TreeRevised).files.map((file) => file.path)))].sort(), ['docs/parse.md', 'src/a.ts']);
  });

  it('refuses an answer that leaves out a file it owns whose bytes changed', () => {
    write(repo, 'src/a.ts', 'a, restored\n');
    assert.throws(() => fixAnswerEvents({ phase: 'answer', key: 'pass-1', role: 'fixer' }, receipt([]), contextOf(passing())), /names no finding for the owned or claimed file src\/a\.ts/);
  });

  it('records what an attempt of the pass left as its revision, naming the pass', () => {
    write(repo, 'src/a.ts', 'a, half restored\n');
    const attempt = attemptRevisionEvents(contextOf(passing()), 'answer', 'pass-1', worker(71), 'timeout: the worker ran past its timeout', 'failed');
    assert.deepEqual(attempt.claims, []);
    const revision = attempt.revisions[0]!.payload as TreeRevised;
    assert.equal(revision.phase, 'answer');
    assert.match(revision.change.message.body, /^An attempt of the answer pass pass-1 ended without an answer/);
  });
});

// R5, TD8 and TD9 of the documentation step.
describe('the events of the documentation step', () => {
  let directory: string;
  let repo: string;
  let evidence: EvidenceStore;
  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-documentation-events-')));
    repo = repositoryWith(join(directory, 'repo'), { 'src/a.ts': 'a, fixed\n', 'docs/parse.md': 'parse throws on a null input\n', 'CHANGES.md': '# Changes\n' });
    evidence = new EvidenceStore(join(directory, 'evidence'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const scratch = (): string => join(directory, 'scratch');
  const into = (): string => join(scratch(), snapshotsDirectoryName);
  /** A decided fix run with the step: c1-1's fixer left src/a.ts as the tree holds it and named two documents, one spelled `./` and one outside the repository; the step is planned against the repository and its worker launched with its scratch directory. */
  const documenting = (): RunState => {
    const history = withDocumentationStep(checksPhase(decidedOf(withFixPass(mergeRanked())), 'baseline-checks'), null)
      .start('fixes').add('fixes.planned', fixPlan).worker(50, 'fixer fixes:c1-1')
      .add('fix.recorded', fixAnswer(worker(50), { drift: [{ file: './docs/parse.md', what: 'parse throws on a null' }, { file: '../outside.md', what: 'parse throws' }] }))
      .add('tree.revised', fixRevision(worker(50), evidence.put('a, fixed\n')))
      .add('fixes.replanned', noSecondRound).add('worktree.checked', endCheck('fixes'), 2).finish('fixes')
      .start('documentation');
    history.add('documentation.planned', { items: documentationItemsOf(history.review().fix!, planPathOf(repo)) }).add('worker.launched', { ...launch(worker(55), 'documentation documentation:documentation'), scratch: scratch() });
    const state = history.fold();
    prepareSnapshots(into(), repo, expectedTreeOf(state).keys());
    return { ...state, scope: { ...state.scope!, head: git(repo, 'rev-parse', 'HEAD') } };
  };
  const contextOf = (state: RunState): AnswerContext => ({ state, worktree: repo, evidence, match: rawMatch, claims: { live: () => null, caseInsensitive: () => false }, log: () => {} });
  const unit = { phase: 'documentation', key: 'documentation', role: 'documentation' } as const;
  const receipt = (output: unknown): WorkerReceipt => ({ workerId: worker(55), output }) as unknown as WorkerReceipt;
  /** The state with `events` folded on, as the engine appends them. */
  const folded = (state: RunState, events: readonly { readonly kind: string; readonly version: number; readonly payload: unknown }[]): RunState =>
    events.reduce((current, event) => applyEvent(current, { sequence: current.lastSequence + 1, runId: current.id, kind: event.kind, version: event.version, payload: event.payload, recordedAt: '2026-10-23T00:00:00.000Z', engine: 'test' }), state);

  it('plans the documents by their resolved paths, and owns only those and the paths the fixes revised', () => {
    const state = documenting();
    assert.deepEqual(state.review!.fix!.documentation?.items.map((item) => [item.id, item.file, item.path]), [['doc-1', './docs/parse.md', 'docs/parse.md'], ['doc-2', '../outside.md', null], ['search', null, null]]);
    assert.deepEqual(ownedFiles(state.review!, 'documentation', 'documentation'), ['docs/parse.md', 'src/a.ts']);
  });

  it('records the answer at version 3 by its items, with no violation, and a revision at version 3 for each of its two snapshots', () => {
    const state = documenting();
    write(repo, 'docs/parse.md', 'parse returns 0 on a null input\n');
    takeSnapshot({ worktree: repo, finding: 0, into: into() });
    write(repo, 'CHANGES.md', '# Changes\n\nparse returns 0 on a null input.\n');
    takeSnapshot({ worktree: repo, finding: 2, into: into() });
    const output = fixerAnswer([{ files: ['./docs/parse.md'], subject: 'docs(parse): Say parse returns 0 on a null' }, { status: 'deferred', note: 'outside the repository' }, { files: ['CHANGES.md'], subject: 'docs: Note the null in the changes' }]);
    const events = fixAnswerEvents(unit, receipt(output), contextOf(state));
    const recorded = events.find((event) => event.kind === 'fix.recorded')!;
    assert.equal(recorded.version, 3);
    const payload = recorded.payload as FixRecorded;
    assert.deepEqual([payload.phase, payload.key, payload.violations], ['documentation', 'documentation', []]);
    assert.deepEqual(payload.findings.map((entry) => [entry.id, entry.status, entry.files]), [['doc-1', 'applied', ['docs/parse.md']], ['doc-2', 'deferred', []], ['search', 'applied', ['CHANGES.md']]]);
    const revisions = events.filter((event) => event.kind === 'tree.revised');
    assert.deepEqual(revisions.map((event) => event.version), [3, 3]);
    assert.deepEqual(revisions.map((event) => [(event.payload as TreeRevised).change.findings, (event.payload as TreeRevised).files.map((file) => file.path)]), [[['doc-1'], ['docs/parse.md']], [['doc-2', 'search'], ['CHANGES.md']]], 'the deferred item, which changed nothing, is carried into the next revision, as any finding of a unit is');
    assert.deepEqual(events.filter((event) => event.kind === 'files.claimed'), [], 'the step claims nothing');
    const after = folded(state, events).review!;
    assert.equal(after.fix!.revisions.at(-1)?.phase, 'documentation', 'the fold takes the answer and its revisions');
  });

  it('refuses an answer that leaves out a named document it changed, by the path it resolved to', () => {
    write(repo, 'docs/parse.md', 'parse returns 0 on a null input\n');
    const output = fixerAnswer([{ status: 'already-applied' }, { status: 'deferred' }, { status: 'already-applied' }]);
    assert.throws(() => fixAnswerEvents(unit, receipt(output), contextOf(documenting())), /names no finding for the owned or claimed file docs\/parse\.md/);
  });

  it('refuses a blocked item, with or without required files, since its task offers no `blocked`', () => {
    for (const requiredFiles of [[], ['CHANGES.md']]) {
      const output = fixerAnswer([{ status: 'already-applied' }, { status: 'blocked', requiredFiles, note: 'needs a file' }, { status: 'already-applied' }]);
      assert.throws(() => fixAnswerEvents(unit, receipt(output), contextOf(documenting())), /Finding \[1\] is blocked, a status its task does not offer/, String(requiredFiles));
    }
  });

  it('keeps what a failed attempt and a lost worker left in a named document by its resolved path, naming the step', () => {
    const state = documenting();
    write(repo, 'docs/parse.md', 'parse returns 0 on a null\n');
    for (const end of ['failed', 'lost'] as const) {
      const attempt = attemptRevisionEvents(contextOf(state), 'documentation', 'documentation', worker(55), 'it died', end);
      assert.deepEqual(attempt.claims, [], end);
      assert.deepEqual(attempt.revisions.map((event) => [event.version, (event.payload as TreeRevised).phase, (event.payload as TreeRevised).files.map((file) => file.path)]), [[3, 'documentation', ['docs/parse.md']]], end);
      assert.match((attempt.revisions[0]!.payload as TreeRevised).change.message.body, /^An attempt of the documentation step ended without an answer/, end);
    }
  });
});

describe('the events of the repair', () => {
  let directory: string;
  let repo: string;
  let evidence: EvidenceStore;
  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-repair-events-')));
    repo = repositoryWith(join(directory, 'repo'), { 'src/a.ts': 'a, fixed\n', 'src/b.ts': 'b\n' });
    evidence = new EvidenceStore(join(directory, 'evidence'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** A fix run whose c1-1 left src/a.ts as the tree holds it, whose test fails after the fixes, and whose repair worker is launched. */
  const repairing = (): RunState => {
    const history = baselined()
      .start('fixes').add('fixes.planned', fixPlan).worker(50, 'fixer fixes:c1-1')
      .add('fix.recorded', fixAnswer(worker(50)))
      .add('tree.revised', fixRevision(worker(50), evidence.put('a, fixed\n')))
      .add('fixes.replanned', noSecondRound).add('worktree.checked', endCheck('fixes'), 2).finish('fixes');
    const state = checksPhase(history, 'checks', { test: 'failed' }).start('repair').worker(60, 'fixer repair:repair').fold();
    return { ...state, scope: { ...state.scope!, head: git(repo, 'rev-parse', 'HEAD') } };
  };
  const contextOf = (state: RunState): AnswerContext => ({ state, worktree: repo, evidence, match: rawMatch, claims: { live: () => null, caseInsensitive: () => false }, log: () => {} });
  const unit = { phase: 'repair', key: 'repair', role: 'fixer' } as const;
  const receipt = (output: unknown): WorkerReceipt => ({ workerId: worker(60), output }) as unknown as WorkerReceipt;

  it('records a deferred check, at version 2 in a run without the checks on the base', () => {
    const recorded = fixAnswerEvents(unit, receipt(fixerAnswer([{ status: 'deferred', note: 'every failure was there before' }])), contextOf(repairing())).find((event) => event.kind === 'fix.recorded')!;
    assert.deepEqual((recorded.payload as FixRecorded).findings.map((entry) => [entry.id, entry.status]), [['test', 'deferred']]);
    assert.equal(recorded.version, 2);
    assert.equal('comparisons' in (recorded.payload as object), false);
  });

  it('refuses a blocked check, with no required file or one in the repository it does not own, since its task offers no `blocked`', () => {
    for (const requiredFiles of [[], ['src/b.ts']]) {
      const output = fixerAnswer([{ status: 'blocked', requiredFiles, note: 'needs a file' }]);
      assert.throws(() => fixAnswerEvents(unit, receipt(output), contextOf(repairing())), /Finding \[0\] is blocked, a status its task does not offer/, String(requiredFiles));
    }
  });
});

// R2, TD6 and TD7 of the facts before a merge.
describe('the events of the repair that compares with the base', () => {
  let directory: string;
  let repo: string;
  let evidence: EvidenceStore;
  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-comparison-events-')));
    repo = repositoryWith(join(directory, 'repo'), { 'src/a.ts': 'a, fixed\n' });
    evidence = new EvidenceStore(join(directory, 'evidence'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** A run with the checks on the base through its fixes, where c1-1 left src/a.ts as the tree holds it, with lint and test failing before them. */
  const throughFixes = (): History => {
    const atBaseline = withBaseChecks(withDocumentationStep(checksPhase(decidedOf(withFixPass(mergeRanked())), 'baseline-checks', { lint: 'failed', test: 'failed' }), null));
    return documentationAnswered(atBaseline.start('fixes').add('fixes.planned', fixPlan).worker(50, 'fixer fixes:c1-1')
      .add('fix.recorded', fixAnswer(worker(50))).add('tree.revised', fixRevision(worker(50), evidence.put('a, fixed\n')))
      .add('fixes.replanned', noSecondRound).add('worktree.checked', endCheck('fixes'), 2).finish('fixes'));
  };
  /** The same run with lint and test failing after the fixes too; on the base build passes, lint fails and test passes; its repair worker launched. */
  const comparing = (): RunState => {
    const history = ranOnBase(ranOnBase(ranOnBase(checksPhase(throughFixes(), 'checks', { lint: 'failed', test: 'failed' }).start('base-checks'), 'build', 'passed'), 'lint', 'failed'), 'test', 'passed');
    const state = history.finish('base-checks').start('repair').worker(60, 'fixer repair:repair').fold();
    return { ...state, scope: { ...state.scope!, head: git(repo, 'rev-parse', 'HEAD') } };
  };
  const unit = { phase: 'repair', key: 'repair', role: 'fixer' } as const;
  /** The repair's answer: lint applied in src/a.ts, test deferred, and the comparisons given. */
  const answered = (comparisons: readonly Record<string, unknown>[]): WorkerReceipt => ({
    workerId: worker(60),
    output: { ...(fixerAnswer([{ files: ['src/a.ts'], subject: 'style: Format the guard' }, { status: 'deferred', note: 'every failure was there before the fixes' }]) as object), comparisons },
  }) as unknown as WorkerReceipt;
  const same = { kind: 'lint', reading: 'same', words: 'the same two lint errors as on the base' };
  /** The events of an answer, the lines it logged, and the run with the events folded on, as the engine appends them. */
  const record = (state: RunState, given: WorkerReceipt, of: Unit = unit): { events: ReturnType<typeof fixAnswerEvents>; lines: string[]; after: RunState } => {
    const lines: string[] = [];
    const events = fixAnswerEvents(of, given, { state, worktree: repo, evidence, match: rawMatch, claims: { live: () => null, caseInsensitive: () => false }, log: (line) => lines.push(line) });
    const after = events.reduce((current, event) => applyEvent(current, { sequence: current.lastSequence + 1, runId: current.id, kind: event.kind, version: event.version, payload: event.payload, recordedAt: '2026-10-28T00:00:00.000Z', engine: 'test' }), state);
    return { events, lines, after };
  };
  /** The repair's revisions the run holds, by the findings and paths of each; the worker took no snapshot, so its one revision names both checks. */
  const repairEdits = (state: RunState): [readonly string[], string[]][] => state.review!.fix!.revisions.filter((revision) => revision.phase === 'repair').map((revision) => [revision.change.findings, revision.files.map((file) => file.path)]);

  it('records a valid answer at version 4 with its comparisons, and its edits', () => {
    write(repo, 'src/a.ts', 'a, formatted\n');
    const { events, lines, after } = record(comparing(), answered([same]));
    const recorded = events.find((event) => event.kind === 'fix.recorded')!;
    assert.equal(recorded.version, 4);
    assert.deepEqual((recorded.payload as FixRecordedV4).comparisons, [same]);
    assert.deepEqual(after.review!.fix!.answers.repair.repair?.comparisons, [same]);
    assert.deepEqual(repairEdits(after), [[['lint', 'test'], ['src/a.ts']]]);
    assert.deepEqual(lines, []);
  });

  it('records an answer with no entry for a check that failed on the base, and counts its edits; the kind is left with no comparison', () => {
    write(repo, 'src/a.ts', 'a, formatted\n');
    const { events, lines, after } = record(comparing(), answered([]));
    assert.equal(events.find((event) => event.kind === 'fix.recorded')!.version, 4);
    assert.deepEqual(after.review!.fix!.answers.repair.repair?.comparisons, []);
    assert.deepEqual(repairEdits(after), [[['lint', 'test'], ['src/a.ts']]]);
    assert.deepEqual(lines, []);
  });

  it('drops an entry for a check whose base passed, for one that did not run on the base, and a second one for a kind, each with a line, and records the rest with the edits', () => {
    write(repo, 'src/a.ts', 'a, formatted\n');
    const passedThere = { kind: 'test', reading: 'adds', words: 'test fails on the change only' };
    const notThere = { kind: 'typecheck', reading: 'unknown', words: 'no typecheck ran' };
    const second = { ...same, reading: 'adds', words: 'a third lint error' };
    const { events, lines, after } = record(comparing(), answered([passedThere, same, notThere, second]));
    assert.deepEqual((events.find((event) => event.kind === 'fix.recorded')!.payload as FixRecordedV4).comparisons, [same], 'the first entry of the one kind that failed on the base');
    assert.deepEqual(after.review!.fix!.answers.repair.repair?.comparisons, [same]);
    assert.deepEqual(repairEdits(after), [[['lint', 'test'], ['src/a.ts']]]);
    assert.deepEqual(lines.map((line) => /^dropped .*comparison of the (\w+) check with the base/.exec(line)?.[1]), ['test', 'typecheck', 'lint'], 'one line for each entry dropped, naming its kind');
    assert.match(lines[2]!, /second/);
  });

  it('records a fixer\'s answer in a run with the checks on the base at the version of today, with no comparison', () => {
    const state = withBaseChecks(withDocumentationStep(checksPhase(decidedOf(withFixPass(mergeRanked())), 'baseline-checks', { lint: 'failed' }), null)).start('fixes').add('fixes.planned', fixPlan).worker(50, 'fixer fixes:c1-1').fold();
    const fixer = { workerId: worker(50), output: fixerAnswer([{ files: ['src/a.ts'] }]) } as unknown as WorkerReceipt;
    const recorded = record({ ...state, scope: { ...state.scope!, head: git(repo, 'rev-parse', 'HEAD') } }, fixer, { phase: 'fixes', key: 'c1-1', role: 'fixer' }).events.find((event) => event.kind === 'fix.recorded')!;
    assert.equal(recorded.version, 2);
    assert.equal('comparisons' in (recorded.payload as object), false);
  });
});
