import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { EvidenceStore } from '../../src/evidence/store.ts';
import { findRun, foundVerdictRuns, freezeProbe, isBlankCitedLine, normalized, probeLimitBytes, validationRun, type CitedRun } from '../../src/review/cited-runs.ts';
import { StructuralCheckError } from '../../src/review/errors.ts';
import type { ShellRun } from '../../src/runtime/adapter.ts';

const run = (command: string, output: string | null, exitCode: number | null = 0): ShellRun => ({ command, output, exitCode });
const cited = (printed: readonly string[], probe: string | null = null, command = 'node probe.mjs'): CitedRun => ({ command, printed, probe });

describe('normalized', () => {
  it('reads CR LF and a lone CR as LF, drops terminal colors and links, and trims the spaces that end each line', () => {
    assert.equal(normalized('a  \r\nb\t\rc'), 'a\nb\nc');
    assert.equal(normalized('\u001b[31mFAIL\u001b[0m parse \u001b]8;;file:///a\u0007link\u001b]8;;\u001b\\'), 'FAIL parse link');
  });
});

describe('findRun', () => {
  const record = [
    run('ls', 'probe.mjs\n'),
    run('node probe.mjs', 'start\nTypeError: Cannot read properties of null\n    at parse (src/parse.ts:41)\n', 1),
    run('npm test', null, null),
  ];

  it('finds the run whose output holds each cited line in order, and gives its place from 1 and its exit code', () => {
    assert.deepEqual(findRun(record, cited(['TypeError: Cannot read properties of null', 'at parse (src/parse.ts:41)'])), { at: 2, exitCode: 1 });
    assert.deepEqual(findRun(record, cited(['  probe.mjs  '])), { at: 1, exitCode: 0 }, 'a cited line is trimmed');
  });

  it('finds a line across CR LF and colors the runtime recorded', () => {
    const colored = [run('npx vitest', '\u001b[31m FAIL \u001b[39m test/a.test.ts  \r\n1 failed\r\n', 1)];
    assert.deepEqual(findRun(colored, cited(['FAIL  test/a.test.ts', '1 failed'])), { at: 1, exitCode: 1 });
  });

  it('finds no run for lines out of order, or a line no output holds', () => {
    assert.equal(findRun(record, cited(['at parse (src/parse.ts:41)', 'TypeError: Cannot read properties of null'])), null);
    assert.equal(findRun(record, cited(['TypeError: Cannot read properties of undefined'])), null);
  });

  it('finds a cited line only where it neither starts nor ends inside a word of the output, a fragment of a line still being found', () => {
    assert.equal(findRun([run('npm test', 'tests 12\n10 failed\n', 1)], cited(['0 failed'])), null, '0 failed is not 10 failed');
    assert.equal(findRun([run('npm test', 'passed 3\n', 0)], cited(['pass'])), null, 'pass is not passed');
    assert.deepEqual(findRun([run('npm test', 'tests 2\n0 failed\n', 0)], cited(['0 failed'])), { at: 1, exitCode: 0 });
    assert.deepEqual(findRun([run('npm test', '10 failed, then 0 failed\n', 1)], cited(['0 failed'])), { at: 1, exitCode: 1 }, 'a later place where the line is whole');
    assert.equal(findRun([run('npm test', 'x 0 failed; 10 failed\n', 1)], cited(['0 failed', '0 failed'])), null, 'the second line has no whole place after the first');
    assert.deepEqual(findRun([run('npm test', 'Exit code 1\nerror: (10)\n', 1)], cited(['(10)'])), { at: 1, exitCode: 1 }, 'a line that begins and ends with punctuation');
  });

  it('finds a cited probe only in a run whose command names the probe\'s base name', () => {
    assert.deepEqual(findRun(record, cited(['TypeError'], '/tmp/scratch/probe.mjs')), { at: 2, exitCode: 1 });
    assert.deepEqual(findRun(record, cited(['TypeError'], 'C:\\scratch\\probe.mjs')), { at: 2, exitCode: 1 }, 'a Windows path names its file too');
    assert.equal(findRun(record, cited(['TypeError'], '/tmp/scratch/other.mjs')), null);
  });

  it('finds a cited probe only where the command holds its base name as a whole name, and never for a path with no base name', () => {
    const named = (command: string): ShellRun[] => [run(command, 'hello\n')];
    assert.equal(findRun(named('python data.py'), cited(['hello'], 'a.py')), null, 'a.py is not data.py');
    assert.equal(findRun(named('python a.pyc'), cited(['hello'], 'a.py')), null, 'a.py is not a.pyc');
    assert.deepEqual(findRun(named('python /tmp/s/a.py'), cited(['hello'], 'a.py')), { at: 1, exitCode: 0 });
    assert.deepEqual(findRun(named('bash -lc \'python a.py\''), cited(['hello'], '/tmp/s/a.py')), { at: 1, exitCode: 0 }, 'inside the quotes of the wrapper of Codex');
    assert.deepEqual(findRun(named('a.py'), cited(['hello'], 'a.py')), { at: 1, exitCode: 0 }, 'the whole command');
    for (const probe of ['/', '\\', '']) assert.equal(findRun(named('python a.py'), cited(['hello'], probe)), null, JSON.stringify(probe));
  });

  it('takes the last of two runs that match, the one the worker saw last', () => {
    const rerun = [run('node probe.mjs', 'threw\n', 1), run('node probe.mjs', 'threw\n', 2)];
    assert.deepEqual(findRun(rerun, cited(['threw'], 'probe.mjs')), { at: 2, exitCode: 2 });
  });

  it('never finds a run with no output, such as a call with no result', () => {
    assert.equal(findRun([run('npm test', null, null)], cited(['npm test'])), null);
    assert.equal(findRun([], cited(['anything'])), null);
  });

  it('finds no run for a cited line that is blank as the lookup compares it, such as a terminal reset alone', () => {
    for (const line of ['\u001b[0m', ' \t ', '\u001b]8;;\u0007']) {
      assert.equal(isBlankCitedLine(line), true, JSON.stringify(line));
      assert.equal(findRun(record, cited([line])), null, JSON.stringify(line));
      assert.equal(findRun(record, cited(['TypeError', line])), null, `${JSON.stringify(line)} after a line the output holds`);
    }
    assert.equal(isBlankCitedLine('\u001b[31mFAIL\u001b[0m'), false);
  });
});

describe('validationRun', () => {
  const evidence = { put: (): never => assert.fail('no probe is cited') };

  it('records a run that cites a blank line as not found, and logs the blank line as the reason', () => {
    const reasons: string[] = [];
    const recorded = validationRun([run('ls', 'probe.mjs\n')], cited(['\u001b[0m'], null, 'ls'), null, evidence, (reason) => reasons.push(reason));
    assert.equal(recorded.found, null);
    assert.deepEqual(reasons, ['cites a blank line of what a run printed, which no lookup can find: ls']);
  });
});

describe('foundVerdictRuns', () => {
  const record = [run('node probe.mjs', 'threw\n', 1)];

  it('gives each cited run of each verdict with its place, in the order of the answer', () => {
    assert.deepEqual(foundVerdictRuns([{ index: 1, runs: [] }, { index: 0, runs: [cited(['threw'])] }], record), [[], [{ cited: cited(['threw']), found: { at: 1, exitCode: 1 } }]]);
  });

  it('refuses an answer with a run the record does not hold, naming the verdict and the start of the command', () => {
    const long = `node ${'x'.repeat(300)}`;
    assert.throws(() => foundVerdictRuns([{ index: 2, runs: [cited(['passed'], null, long)] }], record), (error: unknown) => error instanceof StructuralCheckError && error.message === `The verdict for index 2 cites a run that the record of its shell runs does not hold: ${long.slice(0, 200)}`);
  });
});

describe('freezeProbe', () => {
  let root: string;
  let scratch: string;
  let evidence: EvidenceStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'deep-review-probe-'));
    scratch = join(root, 'scratch');
    mkdirSync(scratch);
    evidence = new EvidenceStore(join(root, 'artifacts'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const reason = (path: string): string => {
    const freeze = freezeProbe(scratch, path, evidence);
    assert.equal(freeze.kind, 'refused', path);
    return freeze.kind === 'refused' ? freeze.reason : '';
  };

  it('freezes a file of the scratch directory, named relative or absolute, with its base name', () => {
    writeFileSync(join(scratch, 'probe-1.mjs'), 'console.log(1)\n');
    for (const path of ['probe-1.mjs', join(scratch, 'probe-1.mjs')]) {
      const freeze = freezeProbe(scratch, path, evidence);
      assert.equal(freeze.kind, 'frozen', path);
      if (freeze.kind !== 'frozen') continue;
      assert.equal(freeze.probe.name, 'probe-1.mjs');
      assert.equal(evidence.read(freeze.probe.blob).toString('utf8'), 'console.log(1)\n');
    }
  });

  it('refuses a path that leaves the scratch directory, by .. or by a link', (t) => {
    writeFileSync(join(root, 'secret.txt'), 'key');
    assert.match(reason('../secret.txt'), /is outside the scratch directory/);
    try {
      symlinkSync(join(root, 'secret.txt'), join(scratch, 'probe.mjs'));
    } catch (error) {
      // Windows without Developer Mode denies symlink creation; nothing more to test then.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('symlinks are not permitted here');
      throw error;
    }
    assert.match(reason('probe.mjs'), /is outside the scratch directory/);
  });

  it('refuses a directory, a missing file, a file over 64 KiB, and any probe of a worker with no scratch directory', () => {
    mkdirSync(join(scratch, 'probes'));
    assert.match(reason('probes'), /is not a regular file/);
    assert.match(reason('absent.mjs'), /names no file/);
    writeFileSync(join(scratch, 'big.mjs'), 'x'.repeat(probeLimitBytes + 1));
    assert.match(reason('big.mjs'), /more than the 65536 a probe may/);
    writeFileSync(join(scratch, 'edge.mjs'), 'x'.repeat(probeLimitBytes));
    assert.equal(freezeProbe(scratch, 'edge.mjs', evidence).kind, 'frozen', 'exactly 64 KiB is frozen');
    const none = freezeProbe(null, 'probe.mjs', evidence);
    assert.deepEqual(none, { kind: 'refused', reason: 'the probe probe.mjs cannot be frozen: the worker had no scratch directory' });
  });
});
