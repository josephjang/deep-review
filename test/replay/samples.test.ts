import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { ReplayRefusedError } from '../../src/replay/errors.ts';
import { isReplayable, recordedGroups } from '../../src/replay/recorded.ts';
import { agreementOf, countsOf, disagreements, nextSampleName, outcomeOf, parseResults, recordedResults, recordedSampleName, renderSummary, sampledVerdict, withSample, withSpend, withVerdicts, type ReplayResults, type ReplaySample, type SampledVerdict } from '../../src/replay/samples.ts';
import type { Verdict } from '../../src/review/vocabulary.ts';
import { twiceVerified } from '../helpers/replay-history.ts';
import { worker } from '../helpers/review-history.ts';

const refused = (pattern: RegExp) => (error: unknown): boolean => {
  assert.ok(error instanceof ReplayRefusedError, String(error));
  assert.match(error.message, pattern);
  return true;
};

const state = (): RunState => twiceVerified().fold();
const candidateOf = (id: string) => state().review!.candidates[id]!;
const spend = { workers: 4, seconds: 12.5, costUsd: 1.5 };
/** The hash the synthetic results give every sample's role prompt. */
const rolePromptSha256 = 'a'.repeat(64);

/** The recorded results of the synthetic run: SCAN-1 confirmed and RIPPLE-1 refuted by worker 22, SWEEP-1 (design, unlocated) and SWEEP-2 unverified. */
const recorded = (): ReplayResults => {
  const run = state();
  return recordedResults(run, recordedGroups(run).filter(isReplayable), { spend, rolePromptSha256 });
};

const replaySample = (name: string, runtime = 'claude'): ReplaySample => ({ name, origin: 'replay', runtime, model: 'opus', effort: 'high', roleText: 'recorded', rolePromptSha256, version: null, spend: null });

/** A sample's verdict for a candidate of the synthetic run, by the worker given. */
const given = (id: string, verdict: Verdict, evidence = `${verdict} for ${id}`): [string, SampledVerdict] => [id, sampledVerdict(candidateOf(id), { verdict, unverified: false, evidence }, worker(60))];

/** The recorded results with one replay sample that confirms SCAN-1, finds RIPPLE-1 plausible, confirms the design candidate and leaves SWEEP-2 unjudged. */
const replayed = (): ReplayResults => withVerdicts(withSample(recorded(), replaySample('claude-1')), 'claude-1', new Map([given('SCAN-1', 'CONFIRMED'), given('RIPPLE-1', 'PLAUSIBLE'), given('SWEEP-1', 'CONFIRMED')]));

describe('outcomeOf', () => {
  it('drops a refuted candidate, sends a confirmed one to a fixer whatever its angle, and holds a plausible design one', () => {
    const outcome = (id: string, verdict: Verdict, unverified = false): string => outcomeOf(candidateOf(id), { verdict, unverified, evidence: null });
    assert.equal(outcome('SCAN-1', 'REFUTED'), 'dropped');
    assert.equal(outcome('SWEEP-1', 'REFUTED'), 'dropped');
    assert.equal(outcome('SCAN-1', 'CONFIRMED'), 'fixer');
    assert.equal(outcome('SWEEP-1', 'CONFIRMED'), 'fixer');
    assert.equal(outcome('SCAN-1', 'PLAUSIBLE'), 'fixer');
    assert.equal(outcome('SWEEP-1', 'PLAUSIBLE'), 'held');
    // The unverified mark changes no route, as a run routes it.
    assert.equal(outcome('SWEEP-1', 'PLAUSIBLE', true), 'held');
    assert.equal(outcome('SWEEP-2', 'PLAUSIBLE', true), 'fixer');
  });
});

describe('recordedResults', () => {
  it('starts the results with what the run recorded: its source, the recorded verifiers\' settings, and each candidate\'s verdict', () => {
    const results = recorded();
    assert.deepEqual(results.source, { runId: 'run-1', runtime: 'claude', engine: '0.0.0', head: '2'.repeat(40), mode: 'worktree', worktree: '/w' });
    assert.deepEqual(results.samples, [{ name: recordedSampleName, origin: 'recorded', runtime: 'claude', model: 'opus', effort: 'high', roleText: 'recorded', rolePromptSha256, version: '2.1.283', spend }]);
    assert.deepEqual(results.candidates.map((candidate) => [candidate.id, candidate.angle, candidate.phase, candidate.group, candidate.location]), [
      ['SCAN-1', 'SCAN', 'verification', 'g1', 'src/a.ts:3'],
      ['RIPPLE-1', 'RIPPLE', 'verification', 'g1', 'src/a.ts:4'],
      ['SWEEP-1', 'DESIGN', 'sweep-verification', 'g1', 'C:\\elsewhere\\b.ts:9 (unlocated: no file of the repository has this path and line)'],
      ['SWEEP-2', 'SCAN', 'sweep-verification', 'g1', 'src/a.ts:7'],
    ]);
    assert.deepEqual(results.candidates.map((candidate) => candidate.samples[recordedSampleName]), [
      { verdict: 'CONFIRMED', unverified: false, evidence: 'line 3 dereferences null', outcome: 'fixer', workerId: worker(22) },
      { verdict: 'REFUTED', unverified: false, evidence: 'the caller checks first', outcome: 'dropped', workerId: worker(22) },
      { verdict: 'PLAUSIBLE', unverified: true, evidence: null, outcome: 'held', workerId: null },
      { verdict: 'PLAUSIBLE', unverified: true, evidence: null, outcome: 'fixer', workerId: null },
    ]);
    assert.deepEqual(parseResults(JSON.stringify(results)), results);
  });

  it('gives a candidate the run recorded no verdict for no recorded entry, and refuses a run with no group to replay', () => {
    // The sweep group's verifiers are still out: its candidates carry nothing yet.
    const history = twiceVerified();
    const before = history.events.findIndex((event) => event.kind === 'group.unverified');
    history.events.splice(before);
    const run = history.fold();
    const results = recordedResults(run, recordedGroups(run).filter(isReplayable), { spend, rolePromptSha256 });
    assert.deepEqual(results.candidates.map((candidate) => Object.keys(candidate.samples)), [[recordedSampleName], [recordedSampleName], [], []]);
    assert.throws(() => recordedResults(state(), [], { spend, rolePromptSha256 }), refused(/launched no verifier, so it has no verification to replay$/));
  });
});

describe('the samples of the results', () => {
  it('names a new sample after its runtime and the next number no sample of that runtime has', () => {
    const results = recorded();
    assert.equal(nextSampleName(results, 'claude'), 'claude-1');
    const more = withSample(withSample(withSample(results, replaySample('claude-1')), replaySample('claude-3')), replaySample('codex-1', 'codex'));
    assert.equal(nextSampleName(more, 'claude'), 'claude-4');
    assert.equal(nextSampleName(more, 'codex'), 'codex-2');
    // A runtime whose name another's samples start with shares no numbers with it.
    assert.equal(nextSampleName(withSample(results, replaySample('codex-cli-7', 'codex-cli')), 'codex'), 'codex-1');
  });

  it('adds a sample once, and verdicts and spend only to a sample and candidates it holds', () => {
    const results = withSample(recorded(), replaySample('claude-1'));
    assert.throws(() => withSample(results, replaySample('claude-1')), refused(/already hold a sample named claude-1$/));
    assert.throws(() => withVerdicts(results, 'claude-2', new Map([given('SCAN-1', 'CONFIRMED')])), refused(/hold no sample named claude-2$/));
    assert.throws(() => withVerdicts(results, 'claude-1', new Map([['SCAN-9', given('SCAN-1', 'CONFIRMED')[1]]])), refused(/hold no candidate SCAN-9$/));
    assert.throws(() => withSpend(results, 'claude-2', spend, '2.1.289'), refused(/hold no sample named claude-2$/));

    const judged = withVerdicts(results, 'claude-1', new Map([given('RIPPLE-1', 'PLAUSIBLE')]));
    assert.deepEqual(judged.candidates.map((candidate) => candidate.samples['claude-1']?.verdict), [undefined, 'PLAUSIBLE', undefined, undefined]);
    // The recorded entries, and the results given, are untouched.
    assert.deepEqual(judged.candidates.map((candidate) => candidate.samples[recordedSampleName]), results.candidates.map((candidate) => candidate.samples[recordedSampleName]));
    assert.equal(results.candidates[1]!.samples['claude-1'], undefined);

    const spent = withSpend(judged, 'claude-1', { workers: 1, seconds: 3, costUsd: null }, '2.1.289');
    assert.deepEqual(spent.samples.map((sample) => [sample.name, sample.version, sample.spend?.workers]), [[recordedSampleName, '2.1.283', 4], ['claude-1', '2.1.289', 1]]);
  });

  it('reads results back from their file and refuses what is not a replay\'s results', () => {
    const results = replayed();
    assert.deepEqual(parseResults(JSON.stringify(results, null, 2)), results);
    assert.throws(() => parseResults('{ not json'), refused(/^The results are not JSON: /));
    assert.throws(() => parseResults(JSON.stringify({ ...results, schemaVersion: 2 })), refused(/^The results are not a verifier replay's: /));
    assert.throws(() => parseResults(JSON.stringify({ ...results, samples: [...results.samples, results.samples[0]] })), refused(/sample names are unique/));
    // Results written before a sample's role prompt was hashed read back with none.
    const older = { ...results, samples: results.samples.map(({ rolePromptSha256: _dropped, ...sample }) => sample) };
    assert.deepEqual(parseResults(JSON.stringify(older)).samples.map((sample) => sample.rolePromptSha256), [null, null]);
    assert.throws(() => parseResults(JSON.stringify({ ...results, samples: [{ ...results.samples[0], rolePromptSha256: 'not-a-hash' }] })), refused(/not a verifier replay's/));
    const stray = { ...results, candidates: [{ ...results.candidates[0], samples: { 'codex-1': results.candidates[0]!.samples[recordedSampleName] } }] };
    assert.throws(() => parseResults(JSON.stringify(stray)), refused(/a verdict names the sample codex-1, which the results do not list/));
  });
});

describe('how samples agree', () => {
  it('counts each sample\'s verdicts, unverified candidates and outcomes over the candidates it judged', () => {
    const results = replayed();
    assert.deepEqual(countsOf(results, recordedSampleName), { judged: 4, verdicts: { CONFIRMED: 1, PLAUSIBLE: 2, REFUTED: 1 }, unverified: 2, outcomes: { fixer: 2, held: 1, dropped: 1 } });
    assert.deepEqual(countsOf(results, 'claude-1'), { judged: 3, verdicts: { CONFIRMED: 2, PLAUSIBLE: 1, REFUTED: 0 }, unverified: 0, outcomes: { fixer: 3, held: 0, dropped: 0 } });
    assert.deepEqual(countsOf(results, 'no-such-sample'), { judged: 0, verdicts: { CONFIRMED: 0, PLAUSIBLE: 0, REFUTED: 0 }, unverified: 0, outcomes: { fixer: 0, held: 0, dropped: 0 } });
  });

  it('compares two samples over the candidates both judged, by verdict and by outcome', () => {
    const results = replayed();
    // SWEEP-2 has no claude-1 verdict and is left out. SCAN-1 agrees; RIPPLE-1 goes from dropped to a fixer; SWEEP-1 from held to a fixer.
    assert.deepEqual(agreementOf(results, recordedSampleName, 'claude-1'), {
      compared: 3,
      sameVerdict: 1,
      sameOutcome: 1,
      matrix: { CONFIRMED: { CONFIRMED: 1, PLAUSIBLE: 0, REFUTED: 0 }, PLAUSIBLE: { CONFIRMED: 1, PLAUSIBLE: 0, REFUTED: 0 }, REFUTED: { CONFIRMED: 0, PLAUSIBLE: 1, REFUTED: 0 } },
    });
    // A verdict can change while the outcome stays: a correctness candidate goes to a fixer confirmed or plausible.
    const kept = withVerdicts(withSample(results, replaySample('claude-2')), 'claude-2', new Map([given('SCAN-1', 'PLAUSIBLE')]));
    const agreement = agreementOf(kept, 'claude-1', 'claude-2');
    assert.deepEqual([agreement.compared, agreement.sameVerdict, agreement.sameOutcome], [1, 0, 1]);
    assert.deepEqual(agreementOf(results, recordedSampleName, 'no-such-sample').compared, 0);
  });

  it('lists the candidates two samples gave different verdicts', () => {
    assert.deepEqual(disagreements(replayed()).map((candidate) => candidate.id), ['RIPPLE-1', 'SWEEP-1']);
    assert.deepEqual(disagreements(recorded()), []);
  });
});

describe('renderSummary', () => {
  it('lists the samples, their verdicts, every pair\'s agreement, and each disputed candidate with every sample\'s evidence', () => {
    const results = withSpend(replayed(), 'claude-1', { workers: 2, seconds: 30.5, costUsd: 0.5 }, '2.1.289');
    const summary = renderSummary(results);
    assert.ok(summary.startsWith('# Verifier replay of run run-1\n\nSource: a claude run recorded by engine 0.0.0, mode worktree at head 2222222222222222222222222222222222222222, in /w.\nCandidates: 4 in 2 verification groups.\n'), summary);
    assert.ok(summary.includes('| recorded | claude | opus | high | recorded aaaaaaaa | 2.1.283 | 4 | 12.5 | 1.50 |\n| claude-1 | claude | opus | high | recorded aaaaaaaa | 2.1.289 | 2 | 30.5 | 0.50 |\n'), summary);
    assert.ok(summary.includes('| recorded | 4 of 4 | 1 | 2 | 1 | 2 | 2 | 1 | 1 |\n| claude-1 | 3 of 4 | 2 | 1 | 0 | 0 | 3 | 0 | 0 |\n'), summary);
    assert.ok(summary.includes([
      '### recorded and claude-1',
      '',
      'Same verdict: 1 of 3 (33%). Same outcome: 1 of 3 (33%).',
      '',
      '| recorded \\ claude-1 | CONFIRMED | PLAUSIBLE | REFUTED |',
      '|---|---|---|---|',
      '| CONFIRMED | 1 | 0 | 0 |',
      '| PLAUSIBLE | 1 | 0 | 0 |',
      '| REFUTED | 0 | 1 | 0 |',
    ].join('\n')), summary);
    assert.ok(summary.includes([
      '## Candidates the samples disagree on',
      '',
      '2 of 4 candidates.',
      '',
      '### RIPPLE-1 (RIPPLE) at src/a.ts:4',
      '',
      'RIPPLE-1 summary',
      '',
      '- recorded: REFUTED, dropped: the caller checks first',
      '- claude-1: PLAUSIBLE, to a fixer: PLAUSIBLE for RIPPLE-1',
      '',
      '### SWEEP-1 (DESIGN) at C:\\elsewhere\\b.ts:9 (unlocated: no file of the repository has this path and line)',
      '',
      'SWEEP-1 summary',
      '',
      '- recorded: PLAUSIBLE, held: its verifier failed twice',
      '- claude-1: CONFIRMED, to a fixer: CONFIRMED for SWEEP-1',
      '',
    ].join('\n')), summary);
    assert.ok(summary.endsWith('- claude-1: CONFIRMED, to a fixer: CONFIRMED for SWEEP-1\n'), summary);
  });

  it('says so when there is one sample, when a sample is unfinished, and when no candidate is disputed', () => {
    const alone = renderSummary(recorded());
    assert.ok(alone.includes('## Agreement\n\nOne sample has nothing to agree with.\n'), alone);
    assert.ok(alone.endsWith('## Candidates the samples disagree on\n\nNone: every sample gave every candidate it judged the same verdict.\n'), alone);

    // A sample listed before any of its workers ran: no version, no spend, nothing compared.
    // It is under another role prompt, which the table tells apart by the start of its hash; a sample with no hash shows the choice alone.
    const other = { ...replaySample('codex-1', 'codex'), roleText: 'current' as const, rolePromptSha256: 'b'.repeat(64) };
    const unfinished = renderSummary(withSample(recorded(), other));
    assert.ok(renderSummary(withSample(recorded(), { ...other, rolePromptSha256: null })).includes('| codex-1 | codex | opus | high | current | not launched | unfinished |  |  |'));
    assert.ok(unfinished.includes('| codex-1 | codex | opus | high | current bbbbbbbb | not launched | unfinished |  |  |\n'), unfinished);
    assert.ok(unfinished.includes('| codex-1 | 0 of 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |\n'), unfinished);
    assert.ok(unfinished.includes('### recorded and codex-1\n\nSame verdict: none. Same outcome: none.\n'), unfinished);
  });

  it('keeps a model\'s text from opening a block or a line of its own', () => {
    const results = withVerdicts(withSample(recorded(), replaySample('claude-1')), 'claude-1', new Map([given('SCAN-1', 'REFUTED', 'first line\n## Not a heading\n- not an item')]));
    const hostile = { ...results, candidates: results.candidates.map((candidate) => (candidate.id === 'SCAN-1' ? { ...candidate, summary: '# looks like a heading\nand a second line' } : candidate)) };
    const summary = renderSummary(hostile);
    assert.ok(summary.includes('\n\\# looks like a heading and a second line\n'), summary);
    assert.ok(summary.includes('- claude-1: REFUTED, dropped: first line ## Not a heading - not an item\n'), summary);
  });
});
