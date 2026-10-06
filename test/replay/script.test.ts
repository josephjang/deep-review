import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { locateCheckpoint } from '../../src/checkpoint/locate.ts';
import { resultsFileName } from '../../src/replay/run.ts';
import { parseResults, recordedSampleName } from '../../src/replay/samples.ts';
import type { Script } from '../helpers/fake-runtime.ts';
import { baseEnvironment, fakeClaude } from '../helpers/launcher.ts';
import { ReviewSandbox } from '../helpers/review-sandbox.ts';

const replayScript = resolve(import.meta.dirname, '../../scripts/replay-verifier.ts');

const verdictsOf = (...verdicts: string[]): { output: unknown } => ({ output: { verdicts: verdicts.map((verdict, index) => ({ index, verdict, evidence: `${verdict.toLowerCase()} [${String(index)}]` })) } });

/** The recorded review: two `SCAN` candidates in src/a.ts, group g1, and one `DESIGN` candidate in src/b.ts, group g2. */
const reviewScript: Script = {
  triage: {
    output: {
      candidates: [
        { file: 'src/a.ts', line: 2, summary: 'text is dereferenced when null', detail: 'text is dereferenced when null: the failure a user would see' },
        { file: 'src/a.ts', line: 6, summary: 'other() passes null', detail: 'other() passes null: the failure a user would see' },
      ],
      leads: ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'].map((angle) => ({ angle, lead: null })),
    },
  },
  'finder-DESIGN': { output: { candidates: [{ file: 'src/b.ts', line: 1, summary: 'b belongs beside parse', detail: 'b belongs beside parse: the failure a user would see' }] } },
  'verifier:verification:g1': verdictsOf('CONFIRMED', 'REFUTED'),
  'verifier:verification:g2': verdictsOf('PLAUSIBLE'),
};

describe('scripts/replay-verifier.ts', () => {
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

  /** Run the script on the recorded run through the fake Claude Code, launched as node with its entry script as an npm install is, into a fresh output directory. */
  function replay(...more: string[]): { output: string; result: SpawnSyncReturns<string> } {
    const output = join(box.directory, `script-${String((outputs += 1))}`);
    const scratch = join(box.directory, 'script-scratch');
    const flags = ['--checkpoint', locateCheckpoint(box.repo).root, '--run', runId, '--tree', box.repo, '--output', output, '--runtime', 'claude', '--executable', process.execPath, '--executable-arg', fakeClaude, '--roles', box.rolesRoot, ...more];
    const result = spawnSync(process.execPath, [replayScript, ...flags], { encoding: 'utf8', env: { ...baseEnvironment, FAKE_SCRIPT: box.scriptFile, TEMP: scratch, TMP: scratch, TMPDIR: scratch } });
    return { output, result };
  }

  it('launches the executable with each --executable-arg before the runtime\'s own arguments', () => {
    box.script({ 'verifier:verification:g1': verdictsOf('CONFIRMED', 'REFUTED') });
    const { output, result } = replay('--group', 'verification:g1');

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const results = parseResults(readFileSync(join(output, resultsFileName), 'utf8'));
    assert.deepEqual(results.samples.map((sample) => sample.name), [recordedSampleName, 'claude-1']);
    assert.deepEqual(results.candidates.map((candidate) => candidate.samples['claude-1']?.verdict), ['CONFIRMED', 'REFUTED', undefined]);
  });
});
