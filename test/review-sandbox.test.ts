import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { removeEndedTemplates } from './helpers/review-sandbox.ts';

/** A new temporary directory by its real path, removed when the test `t` ends. */
function temporaryDirectory(t: TestContext): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'review-sandbox-helper-')));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** The pid of a process that has ended. */
function endedPid(): number {
  const ended = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(ended.status, 0);
  return ended.pid;
}

describe('removeEndedTemplates', () => {
  it('removes the template a killed process left, read-only objects and all, and keeps those of running processes and every other entry', (t) => {
    const directory = temporaryDirectory(t);
    const left = join(directory, `deep-review-template-${String(endedPid())}-AbC123`);
    mkdirSync(join(left, 'repo', '.git', 'objects', 'ab'), { recursive: true });
    const object = join(left, 'repo', '.git', 'objects', 'ab', 'cdef');
    writeFileSync(object, 'an object');
    // git writes its objects read-only, which a plain delete refuses on Windows.
    chmodSync(object, 0o444);
    // This process's template, the test runner's, one named before templates held a pid, and a sandbox's own directory.
    const kept = [`deep-review-template-${String(process.pid)}-XyZ789`, `deep-review-template-${String(process.ppid)}-Qrs456`, 'deep-review-template-AbC123', 'deep-review-review-AbC123'];
    for (const name of kept) mkdirSync(join(directory, name));
    removeEndedTemplates(directory);
    assert.deepEqual(readdirSync(directory).sort(), kept.sort());
  });

  it('does nothing in a directory with no template', (t) => {
    const directory = temporaryDirectory(t);
    removeEndedTemplates(directory);
    assert.deepEqual(readdirSync(directory), []);
  });
});
