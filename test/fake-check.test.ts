import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { checkFake } from './helpers/fake-check.ts';
import type { FakeHost } from './helpers/fake-host.ts';

/** A new temporary directory by its real path, removed when the test `t` ends. */
function temporaryDirectory(t: TestContext): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'fake-check-')));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** A host that runs the check of `kind` in `directory` under `rules`, with what it writes kept by stream; a grandchild it starts is pid 4242. */
function hostIn(directory: string, kind: string, rules: Readonly<Record<string, unknown>>, environment: NodeJS.ProcessEnv = {}): FakeHost & { readonly written: { stdout: string; stderr: string } } {
  const checks = join(directory, 'checks.json');
  writeFileSync(checks, JSON.stringify(rules));
  const written = { stdout: '', stderr: '' };
  return {
    written,
    args: [kind],
    environment: { FAKE_CHECKS: checks, ...environment },
    cwd: directory,
    pid: 1234,
    id: 'test',
    readStdin: () => '',
    write: (stream, bytes) => {
      written[stream] += Buffer.from(bytes).toString('utf8');
      return Promise.resolve();
    },
    hang: () => Promise.reject(new Error('the check hung')),
    startGrandchild: () => 4242,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

describe('the stand-in check', () => {
  for (const rule of ['nonsense', 7, { other: 1 }]) {
    it(`exits 2 and names the rule on stderr for the unknown rule ${JSON.stringify(rule)}`, async (t) => {
      const host = hostIn(temporaryDirectory(t), 'build', { build: rule });
      assert.equal(await checkFake(host), 2);
      assert.deepEqual(host.written, { stdout: '', stderr: `fake-check: unknown rule ${JSON.stringify(rule)}\n` });
    });
  }

  it('holds the start FAKE_HOLD names with the protocol a worker keeps, writing its count and started.json whole', async (t) => {
    const directory = temporaryDirectory(t);
    const starts = join(directory, 'starts');
    mkdirSync(starts);
    writeFileSync(join(starts, 'release'), '');
    const host = hostIn(directory, 'build', { build: 'pass' }, { FAKE_START_DIR: starts, FAKE_HOLD: 'check build#1' });
    assert.equal(await checkFake(host), 0);
    assert.equal(readFileSync(join(starts, 'starts'), 'utf8'), 'check build\n');
    assert.equal(readFileSync(join(starts, 'held.count'), 'utf8'), '1');
    assert.deepEqual(JSON.parse(readFileSync(join(starts, 'started.json'), 'utf8')), { pid: 1234, grandchild: 4242 });
    assert.deepEqual(readdirSync(starts).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left behind');
  });

  it('records a start FAKE_HOLD does not name without holding', async (t) => {
    const directory = temporaryDirectory(t);
    const starts = join(directory, 'starts');
    mkdirSync(starts);
    const host = hostIn(directory, 'lint', { lint: 'fail' }, { FAKE_START_DIR: starts, FAKE_HOLD: 'check build#1' });
    assert.equal(await checkFake(host), 1);
    assert.equal(readFileSync(join(starts, 'starts'), 'utf8'), 'check lint\n');
    assert.equal(existsSync(join(starts, 'held.count')), false);
    assert.equal(existsSync(join(starts, 'started.json')), false);
  });
});
