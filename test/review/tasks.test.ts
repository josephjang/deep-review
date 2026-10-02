import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CandidateState } from '../../src/checkpoint/review-fold.ts';
import { deduplicationTask, describeLocation, finderTask, fixerTask, mergeRankTask, repairTask, snapshotIndexPlaceholder, sweepTask, triageTask, verifierTask, type FixerTaskInput } from '../../src/review/tasks.ts';
import { finderAngles } from '../../src/review/vocabulary.ts';

const candidate = (id: string, angle: CandidateState['angle'], change: Partial<CandidateState> = {}): CandidateState => ({
  id,
  angle,
  file: 'src/a.ts',
  line: 4,
  located: true,
  inScope: true,
  rawFile: 'src/a.ts',
  rawLine: 4,
  summary: `${id} summary`,
  detail: `${id} detail`,
  phase: 'finders',
  workerId: '00000000-0000-4000-8000-000000000001',
  duplicateOf: null,
  verdict: null,
  unverified: false,
  ...change,
});
const unlocated = candidate('SWEEP-1', 'DESIGN', { file: null, line: null, located: false, inScope: false, rawFile: 'C:\\x\\b.ts', rawLine: 9, phase: 'sweep' });
const outside = candidate('RIPPLE-3', 'RIPPLE', { file: 'src/caller.ts', line: 12, inScope: false, rawFile: 'C:\\repo\\src\\caller.ts', rawLine: 12 });

describe('describeLocation', () => {
  it('gives the repository location, marked when outside the change, or the finder\'s own with the unlocated mark', () => {
    assert.equal(describeLocation(candidate('SCAN-1', 'SCAN')), 'src/a.ts:4');
    assert.equal(describeLocation(outside), 'src/caller.ts:12 (outside the change: an unchanged file of the repository)', 'the canonical path, not the finder\'s spelling');
    assert.equal(describeLocation(unlocated), 'C:\\x\\b.ts:9 (unlocated: no file of the repository has this path and line)');
  });
});

describe('the task texts', () => {
  it('tell the triage to run SCAN and return one lead per other angle, never a skip', () => {
    const task = triageTask();
    assert.match(task, /Run the `SCAN` angle/);
    assert.match(task, new RegExp(finderAngles.join(', ')));
    assert.match(task, /or null when the diff supports none/);
    assert.match(task, /never a skip/);
    assert.match(task, /the engine assigns one to each candidate/);
  });

  it('give a finder its angle and its lead, or Lead: none', () => {
    assert.match(finderTask('RIPPLE', { angle: 'RIPPLE', lead: 'the callers of parse()' }), /^Angle: RIPPLE\nSCAN lead: the callers of parse\(\)\n/);
    assert.match(finderTask('DESIGN', { angle: 'DESIGN', lead: null }), /^Angle: DESIGN\nLead: none\n/);
    assert.match(finderTask('DESIGN', null), /^Angle: DESIGN\nLead: none\n/);
    assert.match(finderTask('DESIGN', null), /Run the DESIGN angle/);
  });

  it('numbers the deduplication pool from [0] and explains groups, keep and standing alone', () => {
    const task = deduplicationTask([candidate('SCAN-1', 'SCAN'), candidate('RIPPLE-1', 'RIPPLE', { line: 5, rawLine: 5 })]);
    assert.match(task, /2 candidates, numbered \[0\] to \[1\]/);
    assert.match(task, /\[0\] SCAN-1 \(SCAN\) at src\/a\.ts:4\n {4}summary: SCAN-1 summary\n {4}detail: SCAN-1 detail\n\[1\] RIPPLE-1 \(RIPPLE\) at src\/a\.ts:5/);
    assert.match(task, /A candidate in no group stands alone/);
    assert.match(task, /Return `groups` empty when nothing repeats/);
  });

  it('numbers a verifier\'s group and tells it one verdict per index, unlocated included', () => {
    const task = verifierTask('g2', [unlocated]);
    assert.match(task, /^Group g2: 1 candidate, numbered \[0\] to \[0\]/);
    assert.match(task, /\[0\] SWEEP-1 \(DESIGN\) at C:\\x\\b\.ts:9 \(unlocated/);
    assert.match(task, /exactly one verdict per index/);
    assert.match(task, /An answer that misses an index is discarded whole and the group is run again\./);
    assert.match(task, /a candidate marked unlocated still gets a verdict/);
    assert.match(verifierTask('g1', [outside]), /\[0\] RIPPLE-3 \(RIPPLE\) at src\/caller\.ts:12 \(outside the change: an unchanged file of the repository\)\n/);
    assert.match(verifierTask('g1', [candidate('A-1', 'SCAN'), candidate('A-2', 'SCAN')]), /2 candidates, numbered \[0\] to \[1\]/);
  });

  it('gives the sweep the verified and refuted lists and the angles not run', () => {
    const task = sweepTask({
      verified: [{ candidate: candidate('RIPPLE-1', 'RIPPLE'), verdict: 'CONFIRMED', unverified: false }, { candidate: unlocated, verdict: 'PLAUSIBLE', unverified: true }],
      refuted: [{ candidate: candidate('SCAN-2', 'SCAN'), evidence: 'line 4 is a comment' }],
      anglesNotRun: { FOOTGUNS: 'two attempts failed' },
    });
    assert.match(task, /These angles did not run, so their territory is yours to cover: FOOTGUNS \(two attempts failed\)\./);
    assert.match(task, /- RIPPLE-1 \(RIPPLE\) at src\/a\.ts:4: RIPPLE-1 summary \[CONFIRMED\]/);
    assert.match(task, /\[PLAUSIBLE, unverified\]/);
    assert.match(task, /- SCAN-2 \(SCAN\) at src\/a\.ts:4: SCAN-2 summary; refuted because: line 4 is a comment/);
    assert.match(task, /each naming in `angle` the angle/);
    const empty = sweepTask({ verified: [], refuted: [], anglesNotRun: {} });
    assert.match(empty, /Every angle ran\./);
    assert.match(empty, /\(none\)\n\nRefuted candidates[^\n]*\n\(none\)/);
  });

  it('numbers the merge-rank working list with verdicts and evidence and asks for every index once', () => {
    const task = mergeRankTask([
      { candidate: candidate('RIPPLE-1', 'RIPPLE'), verdict: 'CONFIRMED', unverified: false, evidence: 'line 4' },
      { candidate: unlocated, verdict: 'PLAUSIBLE', unverified: true, evidence: null },
    ]);
    assert.match(task, /2 findings, numbered \[0\] to \[1\]/);
    assert.match(task, /\[0\] RIPPLE-1 \(RIPPLE\)[\s\S]*verdict: CONFIRMED\n {4}evidence: line 4/);
    assert.match(task, /verdict: PLAUSIBLE \(unverified\)\n {4}evidence: none; the group's verifier failed twice/);
    assert.match(task, /Every index appears exactly once, as a primary or as a member/);
    assert.match(task, /a `CONVENTIONS` violation takes the severity of the rule it breaks/);
    assert.match(task, /The engine orders the findings itself: by severity, then CONFIRMED before PLAUSIBLE, then the correctness angles and `CONVENTIONS` before `DESIGN`, `DUPLICATION` and `ALTITUDE`, then by primary id\. The order you return them in is not kept\.$/m);
    assert.doesNotMatch(task, /Order most severe first/, 'the worker is not asked for an order the engine discards');
    assert.match(mergeRankTask([{ candidate: candidate('A-1', 'SCAN'), verdict: 'PLAUSIBLE', unverified: false, evidence: 'e' }]), /1 finding, numbered/);
  });
});

describe('the fixer\'s task', () => {
  const snapshot = `node "/engine/main.mjs" snapshot --finding ${snapshotIndexPlaceholder} --into "/scratch/w1/snapshots"`;
  const input: FixerTaskInput = {
    cluster: 'c1',
    batch: 'c1-2',
    secondRound: false,
    findings: [
      { id: 'RIPPLE-1', severity: 'major', verdict: 'CONFIRMED', unverified: false, angle: 'RIPPLE', location: 'src/a.ts:4', summary: 'parse dereferences null', detail: 'other() passes null', evidence: 'line 4 uses text!', reason: 'one root cause', also: ['SWEEP-2 at src/a.ts:7'], firstRound: null },
      { id: 'SWEEP-1', severity: 'minor', verdict: 'PLAUSIBLE', unverified: true, angle: 'SCAN', location: 'lib/b.ts:9 (unlocated: no file of the repository has this path and line)', summary: 's', detail: 'd', evidence: null, reason: 'r', also: [], firstRound: null },
    ],
    earlier: [],
    owned: ['src/a.ts'],
    othersOwned: [{ cluster: 'c2', files: ['src/b.ts'] }, { cluster: 'c3', files: [] }],
    checks: [
      { kind: 'build', command: null, origin: 'none', reason: 'nothing names it' },
      { kind: 'typecheck', command: 'npm run typecheck', origin: 'package', reason: null },
      { kind: 'lint', command: null, origin: 'flag', reason: 'dropped by --no-check' },
      { kind: 'test', command: 'npm run test', origin: 'package', reason: null },
    ],
    snapshotCommand: snapshot,
    mayHoldWork: false,
    unfinished: [],
  };

  it('numbers the batch\'s findings with everything the fixer judges by', () => {
    const task = fixerTask(input);
    assert.match(task, /^Cluster c1, batch c1-2: 2 findings, numbered \[0\] to \[1\], in the order to apply them\.$/m);
    assert.match(task, /^\[0\] RIPPLE-1 \[major\] CONFIRMED \(RIPPLE\) at src\/a\.ts:4\n {4}summary: parse dereferences null\n {4}detail: other\(\) passes null\n {4}evidence: line 4 uses text!\n {4}reason: one root cause\n {4}also at: SWEEP-2 at src\/a\.ts:7$/m);
    assert.match(task, /^\[1\] SWEEP-1 \[minor\] PLAUSIBLE \(unverified\) \(SCAN\) at lib\/b\.ts:9 \(unlocated[^\n]*\n {4}summary: s\n {4}detail: d\n {4}evidence: none; the verifier of its group failed twice\n {4}reason: r$/m);
  });

  it('states the ownership rule with both file lists', () => {
    const task = fixerTask(input);
    assert.match(task, /Files you own while this batch runs, which no other worker edits:\n- src\/a\.ts\n/);
    assert.match(task, /Files other clusters own, which you must not edit; a fix that needs one is `blocked`, naming it in `requiredFiles`:\n- src\/b\.ts \(c2\)\n\n/);
    assert.match(task, /You may edit any other file of the repository, existing or new, when a fix or its tests need it; report every file you edit or create under the finding it served\./);
    assert.match(fixerTask({ ...input, owned: [], othersOwned: [] }), /no other worker edits:\n\(none\)\n[\s\S]*`requiredFiles`:\n\(none\)\n/);
  });

  it('names what the cluster\'s earlier batches did, as work already in the tree, and says nothing of them for a first batch', () => {
    assert.doesNotMatch(fixerTask(input), /Findings of this cluster that earlier batches worked/);
    const task = fixerTask({ ...input, earlier: [{ batch: 'c1-1', id: 'SCAN-1', outcome: 'applied', note: 'guarded the null' }, { batch: 'c1-1', id: 'SCAN-2', outcome: 'not attempted', note: null }] });
    assert.match(task, /^Findings of this cluster that earlier batches worked, one after another before yours; their edits are already in the tree, so build on them and neither redo nor undo them:\n- c1-1 SCAN-1 applied: guarded the null\n- c1-1 SCAN-2 not attempted\n\n/m);
    assert.doesNotMatch(task, /may already hold part of this work/, 'earlier batches are no warning of a half-done batch');
  });

  it('tells a second-round batch what each finding was first blocked on, that the files are now its own, and what the first round did in them (R21)', () => {
    const task = fixerTask({
      ...input,
      cluster: 'c4',
      batch: 'c4-1',
      secondRound: true,
      findings: [{ ...input.findings[0]!, firstRound: { note: 'the fix flips an assertion in t.ts, which c2 owns', requiredFiles: ['t.ts'] } }],
      earlier: [{ batch: 'c2-1', id: 'T-1', outcome: 'applied', note: 'tightened the builder test' }],
      owned: ['src/a.ts', 't.ts'],
    });
    assert.match(task, /^Cluster c4, batch c4-1, in the second round: 1 finding, numbered \[0\] to \[0\]/m);
    assert.match(task, /^ {4}first round: blocked, needing t\.ts: the fix flips an assertion in t\.ts, which c2 owns$/m);
    assert.match(task, /^Each of these was blocked in the first round on files another cluster owned\. Every first-round fixer has finished, and those files are now yours: apply the fix the finding needs there, its tests included\.$/m);
    assert.match(task, /^Findings the first round worked in your files, and this cluster's earlier batches; their edits are already in the tree, so build on them and neither redo nor undo them:\n- c2-1 T-1 applied: tightened the builder test$/m);
    assert.doesNotMatch(fixerTask(input), /first round|second round/, 'a first-round batch says nothing of rounds');
  });

  it('names each check\'s command or why it has none, or that none is available', () => {
    const task = fixerTask(input);
    assert.match(task, /^- build: not available \(nothing names it\)\n- typecheck: npm run typecheck\n- lint: not available \(dropped by --no-check\)\n- test: npm run test$/m);
    const none = fixerTask({ ...input, checks: input.checks.map((check) => ({ ...check, command: null, origin: 'none' as const, reason: 'nothing' })) });
    assert.match(none, /No check is available/);
    assert.doesNotMatch(none, /- build:/);
  });

  it('quotes the snapshot command on a line of its own, and asks for it after each finding', () => {
    const task = fixerTask(input);
    assert.ok(task.includes(`\n\n    ${snapshot}\n\n`), task);
    assert.match(task, /After finishing each finding, and before starting the next, run this from the repository root with that finding's index in place of <index>:/);
  });

  it('describes the answer\'s fields and the rule that every changed owned file is reported, and warns of earlier work only when there may be some', () => {
    const task = fixerTask(input);
    for (const field of ['`status`', '`already-applied`', '`file`', '`line`', '`note`', '`files`', '`message`', '`subject`', '`body`', '`corrections`', '`validation`', '`requiredFiles`', '`drift`', '`tests`', '`suite`']) assert.ok(task.includes(field), field);
    assert.match(task, /at most 72 characters with no trailing period/);
    assert.match(task, /an answer that leaves one out is discarded/);
    assert.match(task, /Write logs and every other temporary file under your scratch directory, never in the repository\.$/);
    assert.doesNotMatch(task, /may already hold part of this work/);
    assert.match(fixerTask({ ...input, mayHoldWork: true }), /The tree may already hold part of this work: an earlier worker on it did not finish\. Verify each finding against the code before applying it/);
    assert.doesNotMatch(fixerTask({ ...input, mayHoldWork: true }), /An earlier attempt left edits/, 'no finding has an attempt\'s recorded edits');
    assert.match(fixerTask({ ...input, mayHoldWork: true, unfinished: ['RIPPLE-1', 'SWEEP-1'] }), /never apply a change on top of itself\. An earlier attempt left edits for RIPPLE-1, SWEEP-1, recorded as that attempt's work; for each of these you report `already-applied`, give the `message` its commit will carry, as for an applied finding\.$/m);
    assert.match(fixerTask(input), /null for a deferred or blocked one, and null for an already-applied one unless this task asks for its message;/);
  });
});

describe('the repair task', () => {
  const failing = {
    kind: 'test' as const,
    command: 'npm run test',
    outcome: 'failed' as const,
    exitCode: 1,
    stdout: { tail: Buffer.from('```\n1 failing\n'), path: '/evidence/out' },
    stderr: { tail: Buffer.alloc(0), path: '/evidence/err' },
  };

  it('numbers the failing checks with their exit, fenced output and logs, and lists the files and what each fixer did', () => {
    const task = repairTask({
      checks: [failing, { ...failing, kind: 'lint', command: 'npm run lint', outcome: 'timeout', exitCode: null }],
      owned: ['src/a.ts', 'test/a.test.ts'],
      answers: [{ batch: 'c1-1', id: 'RIPPLE-1', status: 'applied', note: 'guarded the null' }],
      allChecks: [{ kind: 'test', command: 'npm run test', origin: 'package', reason: null }],
      snapshotCommand: `node "/e/main.mjs" snapshot --finding ${snapshotIndexPlaceholder} --into "/s"`,
      mayHoldWork: true,
      unfinished: ['test'],
    });
    assert.match(task, /^Repair: 2 checks, numbered \[0\] to \[1\], passed before any fixer edited the tree and fail now\./);
    assert.match(task, /^\[0\] test: npm run test\n {4}exited with code 1\n {4}stdout, its last 14 bytes \(the whole is at \/evidence\/out\):\n````text\n```\n1 failing\n````\n {4}stderr: empty \(frozen at \/evidence\/err\)$/m);
    assert.match(task, /^\[1\] lint: npm run lint\n {4}ran past its timeout and was killed$/m);
    assert.match(task, /Files you own: every file the fixers changed\.\n- src\/a\.ts\n- test\/a\.test\.ts/);
    assert.match(task, /^- c1-1 RIPPLE-1 applied: guarded the null$/m);
    assert.match(task, /with that check's index in place of <index>/);
    assert.match(task, /Verify each check against the code/);
    assert.match(task, /The `message` of an applied check describes what the repair changed\./);
    assert.match(task, /An earlier attempt left edits for test, recorded as that attempt's work; for each of these you report `already-applied`, give the `message` its commit will carry, as for an applied check\./);
  });
});
