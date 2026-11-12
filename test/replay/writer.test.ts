import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ledgerFileName } from '../../src/checkpoint/ledger.ts';
import { ReplayRefusedError } from '../../src/replay/errors.ts';
import { replayCheckpointDirectoryName } from '../../src/replay/run.ts';
import { replayWriter, textCharacters, writerAnswerFileName, writerFactsFileName, writerPromptFileName, type WriterFacts, type WriterReplayOptions, type WriterReplayOutcome } from '../../src/replay/writer.ts';
import type { WriterOutputV4 } from '../../src/review/schemas.ts';
import { reviewScript } from '../helpers/fix-pass-fixture.ts';
import { baseEnvironment, fakeClaude } from '../helpers/launcher.ts';
import { pullRequestGh, pullRequestSource } from '../helpers/replay-pull-request.ts';
import { reportText, ReviewSandbox } from '../helpers/review-sandbox.ts';

// The replay of the writer (PD9, OQ1 of the review in the writer's words).

/** A writer's answer of version 4 for the recorded run: the condition its triage judged to hold; SCAN-1 and SCAN-2, minor fixes whose PLAUSIBLE verdicts record why, explained; SWEEP-1 left as is; and no text of what the review did not examine, which the checks drop. */
function answerV4(): WriterOutputV4 {
  const fixed = (id: string): WriterOutputV4['findings'][number] => ({
    id,
    explanation: { title: `${id} breaks on a null`, problem: 'A caller that passes null meets a crash.', cases: [], diagram: null, checked: 'Its verifier read the lines.', kind: 'code', action: 'deep-review would guard the null.', unconfirmed: 'No test reaches the null, so the verifier could not see the crash.', fix: { text: 'The fix returns early on a null.', departure: null }, ask: null },
    unexplained: null,
  });
  return {
    core: { title: 'Parse with a guard', what: 'The change adds a guard to the parser.', why: null, whyFrom: [], diagram: null },
    conditions: [{ condition: 'public-interface', explanation: 'The parser is called by every user of the package.', unexplained: null }],
    summary: 'The review found two small fixes and left one finding as is.',
    areas: [],
    findings: [fixed('SCAN-1'), fixed('SCAN-2')],
    left: [{ id: 'SWEEP-1', title: 'A helper sits apart from its caller', why: 'It is outside the change.' }],
    refuted: [],
    notExamined: '',
  };
}

describe('replayWriter', { timeout: 600_000 }, () => {
  let box: ReviewSandbox;
  let runId: string;
  let directories = 0;

  before(async () => {
    box = new ReviewSandbox();
    box.script(reviewScript);
    reportText(await box.review('claude', { scope: pullRequestSource(box, pullRequestGh(box)) }));
    runId = box.run().id;
  });

  after(() => {
    box.close();
  });

  /** A fresh directory under the sandbox, outside its repository. */
  const newDirectory = (name: string): string => join(box.directory, `${name}-${String((directories += 1))}`);
  const read = (output: string, name: string): string => readFileSync(join(output, name), 'utf8');

  /** Replay the recorded run's writer through the fake Claude, with the options given over the usual ones. */
  const replay = (change: Partial<WriterReplayOptions> & Pick<WriterReplayOptions, 'output'>): Promise<WriterReplayOutcome> =>
    replayWriter({
      checkpoint: box.checkpoint.root,
      run: runId,
      tree: box.repo,
      runtime: 'claude',
      executable: process.execPath,
      executableArgs: [fakeClaude],
      rolesRoot: box.rolesRoot,
      engine: '0.0.0-test',
      log: () => {},
      environment: { ...baseEnvironment, FAKE_SCRIPT: box.scriptFile },
      scratchRoot: box.scratchRoot,
      ...change,
    });

  it('builds the task of version 4 from the run as its explanation phase started, and prints it without launching', async () => {
    const ledgerBefore = readFileSync(join(box.checkpoint.root, ledgerFileName));
    const output = newDirectory('print');

    const outcome = await replay({ run: runId.slice(0, 8), output, printTask: true });

    assert.deepEqual(outcome, { runId, facts: null });
    const prompt = read(output, writerPromptFileName);
    assert.match(prompt, /^Role: writer\nUnit: explanation\nPhase: explanation$/m);
    assert.match(prompt, /^Explain these 2 findings, each by its id, with an entry of `findings`: SCAN-1, SCAN-2\.$/m);
    assert.match(prompt, /^Give one entry of `left` for each of these 1 finding left as is, by its id, and for no other: SWEEP-1\.$/m);
    assert.match(prompt, /Return `core`, `conditions`, `summary`, `areas`, `findings`, `left`, `refuted` and `notExamined` as your role prompt defines them\./);
    assert.ok(!existsSync(join(output, replayCheckpointDirectoryName)), 'nothing was launched');
    assert.deepEqual(readFileSync(join(box.checkpoint.root, ledgerFileName)), ledgerBefore, 'the recorded ledger is only read');
  });

  it('launches one writer at version 4, checks its answer as the explanation phase would, and writes its size, time, cost and each part that fails', async () => {
    const answer = answerV4();
    box.script({ writer: { output: answer } });
    const output = newDirectory('answered');

    const outcome = await replay({ output });

    const facts = JSON.parse(read(output, writerFactsFileName)) as WriterFacts;
    assert.deepEqual(outcome.facts, facts);
    assert.deepEqual([facts.version, facts.outcome, facts.error, facts.findings], [4, 'completed', null, { explained: 2, left: 1, ranked: 3 }]);
    assert.equal(facts.answerBytes, Buffer.byteLength(JSON.stringify(answer), 'utf8'));
    assert.equal(facts.answerCharacters, textCharacters(answer));
    assert.deepEqual(facts.failed, [{ part: 'not-examined', failures: ['what the review did not examine is empty'] }]);
    assert.equal(typeof facts.seconds, 'number');
    assert.deepEqual(JSON.parse(read(output, writerAnswerFileName)), answer);
  });

  it('asks the run for its own version when told to, and refuses a version it was neither configured for nor is version 4', async () => {
    const output = newDirectory('own');
    const own = await replay({ output, version: 3, printTask: true });
    assert.equal(own.facts, null);
    assert.match(read(output, writerPromptFileName), /Return `conclusion`, `areas`, `findings`, `refuted`, `core` and `conditions` as your role prompt defines them\./);
    await assert.rejects(replay({ output: newDirectory('older'), version: 2 }), (error: unknown) => error instanceof ReplayRefusedError && /configured for the writer's answer of version 3/.test(error.message));
  });

  it('counts the characters of every text of an answer, and no key', () => {
    assert.equal(textCharacters({ a: 'xy', b: [{ c: 'z' }, null, 3], d: null }), 3);
  });
});
