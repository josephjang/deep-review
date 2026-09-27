import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { LauncherSandbox, until } from '../helpers/launcher.ts';

const launchWorker = resolve(import.meta.dirname, '../helpers/launch-worker.ts');

/** Run a process to its end and return its exit code and output. */
function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('error', fail);
    child.once('close', (code) => done({ code, stdout, stderr }));
  });
}

describe('concurrent launchers', () => {
  let box: LauncherSandbox;
  beforeEach(() => {
    box = new LauncherSandbox();
  });
  afterEach(() => {
    box.close();
  });

  it('land every launch and every finish when four processes finish on one run at once', async () => {
    const marker = join(box.directory, 'go');
    const launchers = Array.from({ length: 4 }, () => run([launchWorker, box.checkpoint.root, box.runId, marker, box.scratchRoot]));
    // Every worker is launched and blocked before any may finish, so the four finishes race.
    await until(() => Object.keys(box.checkpoint.fold(box.runId).workers).length === 4, 'four launches', 30_000);
    writeFileSync(marker, '');
    const results = await Promise.all(launchers);
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const receipts = results.map((result) => JSON.parse(result.stdout) as { workerId: string; outcome: string; error: string | null });
    const workers = box.checkpoint.fold(box.runId).workers;
    assert.equal(Object.keys(workers).length, 4);
    for (const receipt of receipts) {
      assert.equal(receipt.outcome, 'completed', receipt.error ?? '');
      assert.equal(workers[receipt.workerId]?.status, 'finished');
    }
    assert.equal(box.events().length, 9);
  });
});
