import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Checkpoint } from '../../src/checkpoint/checkpoint.ts';
import { sha256Hex } from '../../src/evidence/store.ts';
import { ReplayRefusedError } from '../../src/replay/errors.ts';
import { splitRoleText, withoutScratchNote } from '../../src/replay/prompt.ts';
import { promptsDirectoryName, replayCheckpointDirectoryName, replayVerifier, resultsFileName, summaryFileName, type ReplayOptions, type ReplayOutcome } from '../../src/replay/run.ts';
import { agreementOf, parseResults, recordedSampleName } from '../../src/replay/samples.ts';
import { acquireStartLock } from '../../src/review/lock.ts';
import { readPolicy } from '../../src/review/policy.ts';
import { assembleRoles } from '../../src/roles/assemble.ts';
import type { Script } from '../helpers/fake-runtime.ts';
import { baseEnvironment, fakeClaude, fakeCodex } from '../helpers/launcher.ts';
import { git, write } from '../helpers/repository.ts';
import { ReviewSandbox } from '../helpers/review-sandbox.ts';

/** A candidate as a finder returns it. */
const found = (file: string, line: number, summary: string): Record<string, unknown> => ({ file, line, summary, detail: `${summary}: the failure a user would see` });

const noLeads = ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'].map((angle) => ({ angle, lead: null }));

const verdictsOf = (...verdicts: string[]): { output: unknown } => ({ output: { verdicts: verdicts.map((verdict, index) => ({ index, verdict, evidence: `${verdict.toLowerCase()} [${String(index)}]` })) } });

/**
 * The recorded review: two `SCAN` candidates in src/a.ts, which make group
 * g1 in line order, and one `DESIGN` candidate in src/b.ts, group g2. The
 * verifiers confirm the first, refute the second and find the third
 * plausible, so the three recorded outcomes are a fixer, dropped and held.
 */
const reviewScript: Script = {
  triage: { output: { candidates: [found('src/a.ts', 2, 'text is dereferenced when null'), found('src/a.ts', 6, 'other() passes null')], leads: noLeads } },
  'finder-DESIGN': { output: { candidates: [found('src/b.ts', 1, 'b belongs beside parse')] } },
  'verifier:verification:g1': verdictsOf('CONFIRMED', 'REFUTED'),
  'verifier:verification:g2': verdictsOf('PLAUSIBLE'),
};

describe('replayVerifier', () => {
  let box: ReviewSandbox;
  let runId: string;
  let outputs = 0;

  before(async () => {
    box = new ReviewSandbox();
    box.script(reviewScript);
    const outcome = await box.review('claude');
    assert.equal(outcome.kind, 'report', box.logs.join('\n'));
    runId = box.run().id;
  });

  after(() => {
    box.close();
  });

  /** A fresh output directory under the sandbox. */
  const newOutput = (): string => join(box.directory, `replay-${String((outputs += 1))}`);

  /** Replay the recorded run through a fake runtime, with the options given over the usual ones. */
  const replay = (logs: string[], change: Partial<ReplayOptions> & Pick<ReplayOptions, 'output'>, runtime: 'claude' | 'codex' = 'claude'): Promise<ReplayOutcome> =>
    replayVerifier({
      source: box.checkpoint,
      runId,
      tree: box.repo,
      runtime,
      executable: process.execPath,
      executableArgs: [runtime === 'claude' ? fakeClaude : fakeCodex],
      rolesRoot: box.rolesRoot,
      roleText: 'recorded',
      repeat: 1,
      concurrency: 1,
      engine: '0.0.0-test',
      log: (line) => {
        logs.push(line);
      },
      environment: { ...baseEnvironment, FAKE_SCRIPT: box.scriptFile },
      scratchRoot: box.scratchRoot,
      ...change,
    });

  /** The prompts the replay's own checkpoint froze, by launch label, in launch order, each without its scratch note. */
  function replayedPrompts(output: string): { label: string | null; prompt: string; model: string; access: string }[] {
    const checkpoint = Checkpoint.open(join(output, replayCheckpointDirectoryName), { engine: '0.0.0-test' });
    try {
      return checkpoint.listRuns().flatMap((run) => Object.values(run.workers)).map((worker) => ({
        label: worker.launch.label,
        prompt: withoutScratchNote(checkpoint.evidence.read(worker.launch.prompt).toString('utf8'), worker.launch.scratch),
        model: worker.launch.model,
        access: worker.launch.access,
      }));
    } finally {
      checkpoint.close();
    }
  }

  /** The prompt the recorded run sent a group's verifier, without its scratch note. */
  function recordedPrompt(label: string): string {
    const worker = Object.values(box.run().workers).find((candidate) => candidate.launch.label === label);
    assert.ok(worker !== undefined, `the run launched ${label}`);
    return withoutScratchNote(box.checkpoint.evidence.read(worker.launch.prompt).toString('utf8'), worker.launch.scratch);
  }

  it('sends each group the prompt its verifier was sent, and keeps every sample beside the recorded one', async () => {
    box.script({ 'verifier:verification:g1': [verdictsOf('CONFIRMED', 'PLAUSIBLE'), verdictsOf('REFUTED', 'REFUTED')], 'verifier:verification:g2': verdictsOf('CONFIRMED') });
    const output = newOutput();
    const logs: string[] = [];
    const outcome = await replay(logs, { output, repeat: 2 });

    assert.deepEqual(outcome.samples, ['claude-1', 'claude-2']);
    assert.deepEqual(outcome.unreplayable, []);
    assert.deepEqual(outcome.notLaunched, []);
    assert.deepEqual(outcome.unverified, []);
    assert.deepEqual(outcome.unjudged, []);
    assert.deepEqual(outcome.treeChanges, []);
    assert.equal(outcome.spend.workers, 4);

    // The tree and the store are the recorded ones, so the prompts are the recorded bytes.
    const prompts = replayedPrompts(output);
    assert.deepEqual(prompts.map((entry) => entry.label), ['verifier verification:g1', 'verifier verification:g2', 'verifier verification:g1', 'verifier verification:g2']);
    for (const entry of prompts) {
      assert.equal(entry.prompt, recordedPrompt(entry.label!));
      assert.equal(entry.access, 'read-only');
      assert.equal(entry.model, 'opus');
    }

    const results = parseResults(readFileSync(join(output, resultsFileName), 'utf8'));
    assert.deepEqual(results, outcome.results);
    assert.deepEqual(results.samples.map((sample) => [sample.name, sample.origin, sample.runtime, sample.roleText]), [
      [recordedSampleName, 'recorded', 'claude', 'recorded'],
      ['claude-1', 'replay', 'claude', 'recorded'],
      ['claude-2', 'replay', 'claude', 'recorded'],
    ]);
    assert.deepEqual(results.samples.map((sample) => sample.spend?.workers), [2, 2, 2]);
    // Every sample ran under the role prompt the run recorded.
    const recordedRole = sha256Hex(Buffer.from(splitRoleText(recordedPrompt('verifier verification:g1')).roleText, 'utf8'));
    assert.deepEqual(results.samples.map((sample) => sample.rolePromptSha256), [recordedRole, recordedRole, recordedRole]);
    const verdicts = (id: string): (string | undefined)[] => results.samples.map((sample) => results.candidates.find((candidate) => candidate.id === id)?.samples[sample.name]?.verdict);
    const outcomes = (id: string): (string | undefined)[] => results.samples.map((sample) => results.candidates.find((candidate) => candidate.id === id)?.samples[sample.name]?.outcome);
    assert.deepEqual(results.candidates.map((candidate) => [candidate.id, candidate.group, candidate.location]), [['SCAN-1', 'g1', 'src/a.ts:2'], ['SCAN-2', 'g1', 'src/a.ts:6'], ['DESIGN-1', 'g2', 'src/b.ts:1']]);
    assert.deepEqual(verdicts('SCAN-1'), ['CONFIRMED', 'CONFIRMED', 'REFUTED']);
    assert.deepEqual(verdicts('SCAN-2'), ['REFUTED', 'PLAUSIBLE', 'REFUTED']);
    assert.deepEqual(verdicts('DESIGN-1'), ['PLAUSIBLE', 'CONFIRMED', 'CONFIRMED']);
    assert.deepEqual(outcomes('SCAN-2'), ['dropped', 'fixer', 'dropped']);
    assert.deepEqual(outcomes('DESIGN-1'), ['held', 'fixer', 'fixer']);
    assert.deepEqual(agreementOf(results, recordedSampleName, 'claude-1'), {
      compared: 3,
      sameVerdict: 1,
      sameOutcome: 1,
      matrix: { CONFIRMED: { CONFIRMED: 1, PLAUSIBLE: 0, REFUTED: 0 }, PLAUSIBLE: { CONFIRMED: 1, PLAUSIBLE: 0, REFUTED: 0 }, REFUTED: { CONFIRMED: 0, PLAUSIBLE: 1, REFUTED: 0 } },
    });

    const summary = readFileSync(join(output, summaryFileName), 'utf8');
    assert.match(summary, /^### recorded and claude-1\n\nSame verdict: 1 of 3 \(33%\)\. Same outcome: 1 of 3 \(33%\)\.$/m);
    assert.match(summary, /^- claude-2: REFUTED, dropped: refuted \[1\]$/m);
    assert.ok(logs.some((line) => line === 'claude-1 verification:g1: CONFIRMED, PLAUSIBLE'), logs.join('\n'));
  });

  it('adds the samples of a later replay, on another runtime with the policy\'s settings for it, to the results already there', async () => {
    const output = newOutput();
    // With no script the fake verifier finds every candidate PLAUSIBLE.
    box.script({});
    await replay([], { output });
    box.script({ 'verifier:verification:g1': verdictsOf('CONFIRMED', 'CONFIRMED'), 'verifier:verification:g2': verdictsOf('REFUTED') });
    const outcome = await replay([], { output }, 'codex');

    assert.deepEqual(outcome.samples, ['codex-1']);
    assert.deepEqual(outcome.results.samples.map((sample) => sample.name), [recordedSampleName, 'claude-1', 'codex-1']);
    const codex = outcome.results.samples.at(-1)!;
    assert.equal(codex.model, readPolicy(box.rolesRoot).runtimes.codex!.strong);
    assert.equal(codex.spend?.costUsd, null);
    assert.deepEqual(outcome.results.candidates.map((candidate) => [candidate.samples['claude-1']?.verdict, candidate.samples['codex-1']?.verdict]), [['PLAUSIBLE', 'CONFIRMED'], ['PLAUSIBLE', 'CONFIRMED'], ['PLAUSIBLE', 'REFUTED']]);
    // The other runtime's verifiers were sent the recorded prompts too.
    const prompts = replayedPrompts(output);
    assert.equal(prompts.length, 4);
    for (const entry of prompts) assert.equal(entry.prompt, recordedPrompt(entry.label!));
    assert.deepEqual(prompts.map((entry) => entry.model), ['opus', 'opus', codex.model, codex.model]);
  });

  it('gives a group one fresh retry, and records it unverified when both attempts fail', async () => {
    box.script({ 'verifier:verification:g1': [{ malformed: true }, verdictsOf('CONFIRMED', 'CONFIRMED')], 'verifier:verification:g2': { exit: 1 } });
    const logs: string[] = [];
    const outcome = await replay(logs, { output: newOutput() });

    const sample = (id: string) => outcome.results.candidates.find((candidate) => candidate.id === id)!.samples['claude-1'];
    assert.equal(sample('SCAN-1')?.verdict, 'CONFIRMED');
    assert.deepEqual(sample('DESIGN-1'), { verdict: 'PLAUSIBLE', unverified: true, evidence: null, outcome: 'held', workerId: null });
    assert.equal(outcome.spend.workers, 4);
    // One group was judged, so the sample still measures something, but it is not a pass over every candidate, and the outcome says where.
    assert.deepEqual(outcome.unjudged, []);
    assert.deepEqual(outcome.unverified, ['claude-1 verification:g2']);
    assert.ok(logs.some((line) => /^claude-1 verification:g1: attempt 1 of 2 gave no verdicts/.test(line)), logs.join('\n'));
    assert.ok(logs.includes('claude-1 verification:g2: unverified, every candidate carries PLAUSIBLE'), logs.join('\n'));
  });

  it('names a sample in which no verifier answered, which measures nothing', async () => {
    box.script({ verifier: { exit: 1 } });
    const logs: string[] = [];
    const outcome = await replay(logs, { output: newOutput(), repeat: 2, groups: ['verification:g2'] });

    assert.deepEqual(outcome.unjudged, ['claude-1', 'claude-2']);
    assert.deepEqual([...outcome.unverified].sort(), ['claude-1 verification:g2', 'claude-2 verification:g2']);
    assert.deepEqual(outcome.results.candidates.map((candidate) => candidate.samples['claude-1']?.unverified), [undefined, undefined, true]);
    assert.ok(logs.includes('sample claude-1 judged nothing: every group it reached went unverified, so it says nothing of the verifier'), logs.join('\n'));
  });

  it('refuses an answer that misses a candidate, as a review does', async () => {
    box.script({ 'verifier:verification:g1': verdictsOf('CONFIRMED'), 'verifier:verification:g2': verdictsOf('CONFIRMED') });
    const logs: string[] = [];
    const outcome = await replay(logs, { output: newOutput(), groups: ['verification:g1'] });

    assert.deepEqual(outcome.results.candidates.map((candidate) => candidate.samples['claude-1']?.unverified), [true, true, undefined]);
    assert.deepEqual(outcome.unverified, ['claude-1 verification:g1']);
    assert.ok(logs.some((line) => line.includes('structural check: No verdict for index 1 of the 2 candidates in the group')), logs.join('\n'));
  });

  it('stops launching at the budget and says which group passes were not launched', async () => {
    box.script({ verifier: { costUsd: 0.75 } });
    const logs: string[] = [];
    const outcome = await replay(logs, { output: newOutput(), repeat: 2, budgetUsd: 1 });

    // Two workers spend 1.50 USD, which reaches the budget before the third launch.
    assert.equal(outcome.spend.workers, 2);
    assert.equal(outcome.spend.costUsd, 1.5);
    assert.deepEqual(outcome.notLaunched, ['claude-2 verification:g1', 'claude-2 verification:g2']);
    assert.deepEqual(outcome.results.candidates.map((candidate) => Object.keys(candidate.samples)), [[recordedSampleName, 'claude-1'], [recordedSampleName, 'claude-1'], [recordedSampleName, 'claude-1']]);
    assert.deepEqual(outcome.results.samples.map((sample) => sample.spend?.workers), [2, 2, 0]);
  });

  it('replays in a clean checkout elsewhere, with only the repository line of the prompt changed', async () => {
    const tree = join(box.directory, 'elsewhere');
    // The sandbox's repository checks out as committed, whatever this machine's core.autocrlf; so must its clone, or its bytes are not the reviewed ones.
    git(box.directory, 'clone', '-q', '-c', 'core.autocrlf=false', box.repo, tree);
    box.script({});
    const output = newOutput();
    await replay([], { output, tree, groups: ['verification:g1'] });

    const [sent] = replayedPrompts(output);
    const recorded = recordedPrompt('verifier verification:g1');
    assert.notEqual(sent!.prompt, recorded);
    const changed = sent!.prompt.split('\n').filter((line, index) => line !== recorded.split('\n')[index]);
    assert.equal(changed.length, 1);
    assert.match(changed[0]!, /^Repository: .*elsewhere$/);
  });

  it('puts the current verifier prompt in place of the recorded one when asked', async () => {
    const rolesRoot = join(box.directory, 'changed-roles');
    // A copy of the sandbox's roles whose verifier prompt has one more sentence.
    cpSync(box.rolesRoot, rolesRoot, { recursive: true });
    appendFileSync(join(rolesRoot, 'fragments', 'lead-verify.md'), 'Judge as if this sentence were new.\n');
    const current = assembleRoles(rolesRoot).find((role) => role.key === 'verifier')!.prompt;
    box.script({});
    const output = newOutput();
    const outcome = await replay([], { output, rolesRoot, roleText: 'current', groups: ['verification:g2'] });

    assert.equal(outcome.results.samples.at(-1)!.roleText, 'current');
    // The sample names the prompt it ran under, which is not the recorded one.
    assert.equal(outcome.results.samples.at(-1)!.rolePromptSha256, sha256Hex(Buffer.from(current, 'utf8')));
    assert.notEqual(outcome.results.samples.at(-1)!.rolePromptSha256, outcome.results.samples[0]!.rolePromptSha256);
    const [sent] = replayedPrompts(output);
    const recorded = recordedPrompt('verifier verification:g2');
    const task = recorded.slice(recorded.indexOf('\n## Task\n'));
    assert.ok(current.includes('Judge as if this sentence were new.'));
    assert.equal(sent!.prompt, `${current}${task}`);
  });

  it('writes the prompts and launches nothing in a dry run', async () => {
    const output = newOutput();
    const logs: string[] = [];
    const outcome = await replay(logs, { output, dryRun: true });

    assert.deepEqual(outcome.samples, []);
    assert.deepEqual(readdirSync(output), [promptsDirectoryName]);
    assert.deepEqual(readdirSync(join(output, promptsDirectoryName)).sort(), ['verification-g1.md', 'verification-g2.md']);
    assert.equal(readFileSync(join(output, promptsDirectoryName, 'verification-g1.md'), 'utf8'), recordedPrompt('verifier verification:g1'));
    assert.deepEqual(outcome.results.samples.map((sample) => sample.name), [recordedSampleName]);
  });

  it('refuses a tree that is not the one the run reviewed, before anything is written', async () => {
    const output = newOutput();
    write(box.repo, 'src/a.ts', 'export const changed = true;\n');
    write(box.repo, 'stray.txt', 'left behind\n');
    try {
      await assert.rejects(replay([], { output }), (error: unknown) => {
        assert.ok(error instanceof ReplayRefusedError);
        assert.match(error.message, /is not the tree run .* reviewed: src\/a\.ts is modified; stray\.txt is changed or untracked$/);
        return true;
      });
    } finally {
      git(box.repo, 'checkout', '--', 'src/a.ts');
      rmSync(join(box.repo, 'stray.txt'));
    }
    assert.equal(existsSync(output), false);
  });

  it('refuses a replay into an output directory another replay holds, and runs once it is released', async () => {
    const output = newOutput();
    const release = acquireStartLock(join(output, replayCheckpointDirectoryName));
    try {
      await assert.rejects(replay([], { output }), (error: unknown) => {
        assert.ok(error instanceof ReplayRefusedError);
        assert.match(error.message, /^Another replay is writing to .*; wait for it to end, or give this one another output directory$/);
        return true;
      });
      assert.equal(existsSync(join(output, resultsFileName)), false);
    } finally {
      release();
    }
    box.script({});
    const outcome = await replay([], { output, groups: ['verification:g2'] });
    assert.deepEqual(outcome.samples, ['claude-1']);
  });

  it('refuses a group the run does not have, a sample count below one, and results of another run', async () => {
    await assert.rejects(replay([], { output: newOutput(), groups: ['verification:g9'] }), /has no replayable group verification:g9; it has verification:g1, verification:g2$/);
    await assert.rejects(replay([], { output: newOutput(), repeat: 0 }), /takes at least one sample, not 0$/);

    const output = newOutput();
    box.script({});
    const { results } = await replay([], { output, groups: ['verification:g2'] });
    writeFileSync(join(output, resultsFileName), JSON.stringify({ ...results, source: { ...results.source, runId: 'another-run' } }));
    await assert.rejects(replay([], { output }), /holds the replay of run another-run, not of /);
  });

  it('refuses results that hold none of a replayable group\'s candidates, before launching a worker', async () => {
    const output = newOutput();
    box.script({});
    const { results } = await replay([], { output, groups: ['verification:g1'] });
    // As if the results were written from a copy of the run taken before it planned g2.
    writeFileSync(join(output, resultsFileName), JSON.stringify({ ...results, candidates: results.candidates.filter((candidate) => candidate.group !== 'g2') }));
    await assert.rejects(replay([], { output }), (error: unknown) => {
      assert.ok(error instanceof ReplayRefusedError);
      assert.match(error.message, /holds no candidate DESIGN-1 of verification:g2, which run .* can replay now; give this replay another output directory$/);
      return true;
    });
    await assert.rejects(replay([], { output, dryRun: true }), /holds no candidate DESIGN-1 of verification:g2/);
    assert.equal(replayedPrompts(output).length, 1);
    assert.equal(existsSync(join(output, promptsDirectoryName)), false);
  });
});
