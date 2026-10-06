import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ReplayRefusedError } from '../../src/replay/errors.ts';
import { labeledOutcome, parseLabels, renderScores, scoreOf, type Label, type Labels } from '../../src/replay/labels.ts';
import { isReplayable, recordedGroups } from '../../src/replay/recorded.ts';
import { recordedResults, recordedSampleName, sampledVerdict, withSample, withVerdicts, type ReplayResults, type ReplaySample, type SampledVerdict } from '../../src/replay/samples.ts';
import type { Verdict } from '../../src/review/vocabulary.ts';
import { twiceVerified } from '../helpers/replay-history.ts';
import { worker } from '../helpers/review-history.ts';

const refused = (pattern: RegExp) => (error: unknown): boolean => {
  assert.ok(error instanceof ReplayRefusedError, String(error));
  assert.match(error.message, pattern);
  return true;
};

/**
 * The synthetic run's results with one replay sample. Recorded: SCAN-1
 * confirmed (to a fixer), RIPPLE-1 refuted (dropped), the design candidate
 * SWEEP-1 unverified (held), SWEEP-2 unverified (to a fixer). claude-1:
 * SCAN-1 confirmed, RIPPLE-1 plausible and SWEEP-1 confirmed (all to a
 * fixer), SWEEP-2 not judged.
 */
function results(): ReplayResults {
  const run = twiceVerified().fold();
  const recorded = recordedResults(run, recordedGroups(run).filter(isReplayable), { spend: { workers: 4, seconds: 10, costUsd: 1 }, rolePromptSha256: 'a'.repeat(64) });
  return withVerdicts(withSample(recorded, replaySample('claude-1')), 'claude-1', new Map([given('SCAN-1', 'CONFIRMED'), given('RIPPLE-1', 'PLAUSIBLE'), given('SWEEP-1', 'CONFIRMED')]));
}

/** A replay sample's verdict for a candidate of the synthetic run, from a verifier that answered. */
const given = (id: string, verdict: Verdict): [string, SampledVerdict] => [id, sampledVerdict(twiceVerified().fold().review!.candidates[id]!, { verdict, unverified: false, evidence: `${verdict} for ${id}` }, worker(60))];
const replaySample = (name: string): ReplaySample => ({ name, origin: 'replay', runtime: 'claude', model: 'opus', effort: 'high', roleText: 'recorded', rolePromptSha256: 'a'.repeat(64), version: '2.1.289', spend: null });

/** The results with a second replay sample, claude-2, that gives every candidate the verdict the run recorded, each from a verifier that answered. */
const judgedAgain = (): ReplayResults => withVerdicts(withSample(results(), replaySample('claude-2')), 'claude-2', new Map([given('SCAN-1', 'CONFIRMED'), given('RIPPLE-1', 'REFUTED'), given('SWEEP-1', 'PLAUSIBLE'), given('SWEEP-2', 'PLAUSIBLE')]));

const label = (id: string, real: Label['real'], disposition: Label['disposition'] = null): Label => ({ id, real, disposition, basis: `read the code for ${id}` });

/** SCAN-1 is real and the author's call, RIPPLE-1 and the design candidate SWEEP-1 are real and to apply, SWEEP-2 is not real. */
const labels = (change: Partial<Labels> = {}): Labels => ({
  schemaVersion: 1,
  runId: 'run-1',
  labels: [label('SCAN-1', 'yes', 'ask'), label('RIPPLE-1', 'yes', 'apply'), label('SWEEP-1', 'yes', 'apply'), label('SWEEP-2', 'no')],
  ...change,
});

describe('parseLabels', () => {
  it('reads a labels file back and refuses what is not one', () => {
    assert.deepEqual(parseLabels(JSON.stringify(labels(), null, 2)), labels());
    assert.throws(() => parseLabels('[ not json'), refused(/^The labels are not JSON: /));
    assert.throws(() => parseLabels(JSON.stringify({ ...labels(), schemaVersion: 2 })), refused(/^The labels are not a replay's labels: /));
    assert.throws(() => parseLabels(JSON.stringify(labels({ labels: [{ ...label('SCAN-1', 'yes'), basis: '' }] }))), refused(/not a replay's labels/));
  });

  it('holds a disposition to the real candidates, and each candidate to one label', () => {
    assert.throws(() => parseLabels(JSON.stringify(labels({ labels: [label('SCAN-1', 'yes')] }))), refused(/a disposition is given exactly when the candidate is real/));
    assert.throws(() => parseLabels(JSON.stringify(labels({ labels: [label('SCAN-1', 'no', 'apply')] }))), refused(/a disposition is given exactly when the candidate is real/));
    assert.throws(() => parseLabels(JSON.stringify(labels({ labels: [label('SCAN-1', 'unsure', 'ask')] }))), refused(/a disposition is given exactly when the candidate is real/));
    assert.throws(() => parseLabels(JSON.stringify(labels({ labels: [label('SCAN-1', 'no'), label('SCAN-1', 'unsure')] }))), refused(/each candidate is labeled once/));
  });
});

describe('labeledOutcome', () => {
  it('drops what is not real, fixes or holds what is real by its disposition, and asks nothing of an unsure label', () => {
    assert.equal(labeledOutcome(label('SCAN-1', 'no')), 'dropped');
    assert.equal(labeledOutcome(label('SCAN-1', 'yes', 'apply')), 'fixer');
    assert.equal(labeledOutcome(label('SCAN-1', 'yes', 'ask')), 'held');
    assert.equal(labeledOutcome(label('SCAN-1', 'unsure')), null);
  });
});

describe('scoreOf', () => {
  it('counts where a sample\'s outcome is not the labeled one, by the kind of miss', () => {
    // claude-2 misses all four: SCAN-1 fixed unasked, RIPPLE-1 dropped though real, SWEEP-1 held though to apply, SWEEP-2 kept though not real.
    assert.deepEqual(scoreOf(judgedAgain(), labels(), 'claude-2'), { scored: 4, unreal: 1, keptUnreal: 1, real: 3, droppedReal: 1, fixedUnasked: 1, heldNeedlessly: 1, rightOutcome: 0 });
    // claude-1 did not judge SWEEP-2, fixes RIPPLE-1 and SWEEP-1 as labeled, and still fixes SCAN-1 unasked.
    assert.deepEqual(scoreOf(results(), labels(), 'claude-1'), { scored: 3, unreal: 0, keptUnreal: 0, real: 3, droppedReal: 0, fixedUnasked: 1, heldNeedlessly: 0, rightOutcome: 2 });
    assert.deepEqual(scoreOf(results(), labels(), 'no-such-sample'), { scored: 0, unreal: 0, keptUnreal: 0, real: 0, droppedReal: 0, fixedUnasked: 0, heldNeedlessly: 0, rightOutcome: 0 });
  });

  it('leaves out a candidate whose verifier failed twice, since the PLAUSIBLE it carries is no verdict', () => {
    // Recorded gives claude-2's verdicts, but SWEEP-1 and SWEEP-2 unverified: neither is held though to apply nor kept though not real.
    assert.deepEqual(scoreOf(results(), labels(), recordedSampleName), { scored: 2, unreal: 0, keptUnreal: 0, real: 2, droppedReal: 1, fixedUnasked: 1, heldNeedlessly: 0, rightOutcome: 0 });
    assert.deepEqual(scoreOf(results(), labels(), recordedSampleName, 'design'), { scored: 0, unreal: 0, keptUnreal: 0, real: 0, droppedReal: 0, fixedUnasked: 0, heldNeedlessly: 0, rightOutcome: 0 });
  });

  it('scores one class of angle when asked, and leaves a candidate labeled unsure out', () => {
    assert.deepEqual(scoreOf(judgedAgain(), labels(), 'claude-2', 'design'), { scored: 1, unreal: 0, keptUnreal: 0, real: 1, droppedReal: 0, fixedUnasked: 0, heldNeedlessly: 1, rightOutcome: 0 });
    assert.deepEqual(scoreOf(judgedAgain(), labels(), 'claude-2', 'correctness'), { scored: 3, unreal: 1, keptUnreal: 1, real: 2, droppedReal: 1, fixedUnasked: 1, heldNeedlessly: 0, rightOutcome: 0 });
    const unsure = labels({ labels: [label('SCAN-1', 'unsure'), label('SWEEP-2', 'no')] });
    assert.deepEqual(scoreOf(judgedAgain(), unsure, 'claude-2'), { scored: 1, unreal: 1, keptUnreal: 1, real: 0, droppedReal: 0, fixedUnasked: 0, heldNeedlessly: 0, rightOutcome: 0 });
  });

  it('counts a refuted candidate that is not real, and a held one that is the author\'s call, as the labeled outcome', () => {
    const right = labels({ labels: [label('RIPPLE-1', 'no'), label('SWEEP-1', 'yes', 'ask')] });
    assert.deepEqual(scoreOf(judgedAgain(), right, 'claude-2'), { scored: 2, unreal: 1, keptUnreal: 0, real: 1, droppedReal: 0, fixedUnasked: 0, heldNeedlessly: 0, rightOutcome: 2 });
  });

  it('refuses labels of another run, and a label for a candidate the results do not hold', () => {
    assert.throws(() => scoreOf(results(), labels({ runId: 'run-2' }), recordedSampleName), refused(/^The labels name the candidates of run run-2, not of run-1$/));
    assert.throws(() => scoreOf(results(), labels({ labels: [label('SCAN-9', 'no')] }), recordedSampleName), refused(/^The labels name SCAN-9, which the results do not hold$/));
  });
});

describe('renderScores', () => {
  it('says how many candidates are labeled, scores every sample over all of them and per class of angle, and marks the misses under each label', () => {
    const all = labels({ labels: [...labels().labels.slice(0, 3), label('SWEEP-2', 'unsure')] });
    const scores = renderScores(results(), all);
    assert.ok(scores.startsWith('# Samples against the labels of run run-1\n\nLabeled: 4 of 4 candidates; 3 real, 0 not real, 1 unsure and not scored.\n'), scores);
    assert.ok(scores.includes('## Every labeled candidate\n\n| Sample | Scored | Kept though not real | Dropped though real | To a fixer though the author should be asked | Held though it should be applied | Labeled outcome |\n|---|---|---|---|---|---|---|\n| recorded | 2 | 0 of 0 | 1 of 2 | 1 | 0 | 0 of 2 |\n| claude-1 | 3 | 0 of 0 | 0 of 3 | 1 | 0 | 2 of 3 |\n'), scores);
    assert.ok(scores.includes('## The correctness angles\n'), scores);
    assert.ok(scores.includes('## The design angles\n\n| Sample | Scored |'), scores);
    // The recorded verifier of the design candidate failed twice, so the recorded sample scores nothing there.
    assert.ok(scores.includes('| recorded | 0 | 0 of 0 | 0 of 0 | 0 | 0 | 0 of 0 |\n| claude-1 | 1 | 0 of 0 | 0 of 1 | 0 | 0 | 1 of 1 |\n'), scores);
    assert.ok(scores.includes('### SCAN-1 (SCAN): real, ask the author\n\nread the code for SCAN-1\n\n- recorded: CONFIRMED, to a fixer (not the labeled outcome)\n- claude-1: CONFIRMED, to a fixer (not the labeled outcome)\n'), scores);
    assert.ok(scores.includes('### RIPPLE-1 (RIPPLE): real, apply\n\nread the code for RIPPLE-1\n\n- recorded: REFUTED, dropped (not the labeled outcome)\n- claude-1: PLAUSIBLE, to a fixer\n'), scores);
    // An unverified verdict is listed as one, never as a miss.
    assert.ok(scores.includes('### SWEEP-1 (DESIGN): real, apply\n\nread the code for SWEEP-1\n\n- recorded: PLAUSIBLE, held: its verifier failed twice, not scored\n- claude-1: CONFIRMED, to a fixer\n'), scores);
    // An unsure label marks no sample, and a sample that did not judge the candidate is not listed.
    assert.ok(scores.endsWith('### SWEEP-2 (SCAN): unsure\n\nread the code for SWEEP-2\n\n- recorded: PLAUSIBLE, to a fixer: its verifier failed twice, not scored\n'), scores);
  });

  it('leaves out the table of a class of angle no labeled candidate is in, and keeps a basis on one line', () => {
    const one = labels({ labels: [{ ...label('SWEEP-2', 'no'), basis: 'first line\n## not a heading' }] });
    const scores = renderScores(results(), one);
    assert.equal(scores.includes('## The design angles'), false);
    assert.ok(scores.includes('### SWEEP-2 (SCAN): not real\n\nfirst line ## not a heading\n'), scores);
  });
});
