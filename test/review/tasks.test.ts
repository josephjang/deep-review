import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CandidateState } from '../../src/checkpoint/review-fold.ts';
import { deduplicationTask, describeLocation, finderTask, mergeRankTask, sweepTask, triageTask, verifierTask } from '../../src/review/tasks.ts';
import { finderAngles } from '../../src/review/vocabulary.ts';

const candidate = (id: string, angle: CandidateState['angle'], change: Partial<CandidateState> = {}): CandidateState => ({
  id,
  angle,
  file: 'src/a.ts',
  line: 4,
  located: true,
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
const unlocated = candidate('SWEEP-1', 'DESIGN', { file: null, line: null, located: false, rawFile: 'C:\\x\\b.ts', rawLine: 9, phase: 'sweep' });

describe('describeLocation', () => {
  it('gives the scope location, or the finder\'s own with the unlocated mark', () => {
    assert.equal(describeLocation(candidate('SCAN-1', 'SCAN')), 'src/a.ts:4');
    assert.equal(describeLocation(unlocated), 'C:\\x\\b.ts:9 (unlocated: not a changed file and line of the scope; read it if it exists)');
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
    assert.match(task, /An answer that misses an index is discarded whole and the group is run again./);
    assert.match(task, /a candidate marked unlocated still gets a verdict/);
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
