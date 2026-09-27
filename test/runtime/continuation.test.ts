import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { z } from 'zod';
import { InvalidInvocationError } from '../../src/runtime/errors.ts';
import { freshThread, LauncherSandbox, until } from '../helpers/launcher.ts';

describe('continuing a session (R9)', () => {
  let box: LauncherSandbox;
  beforeEach(() => {
    box = new LauncherSandbox();
  });
  afterEach(() => {
    box.close();
  });

  it('continues a Claude Code session with --resume as a new worker naming the session', async () => {
    const first = await box.run(box.claude({ budgetUsd: 1 }));
    const session = first.runtime.sessionIds[0]!;
    const firstLaunch = box.worker(first.workerId).launch;
    const second = await box.run(box.claude({ resume: session, prompt: 'You were refused Bash; answer without it.', budgetUsd: 0.25, timeoutMs: 10_000 }));
    assert.equal(second.outcome, 'completed', second.error ?? '');
    assert.notEqual(second.workerId, first.workerId);
    assert.deepEqual(second.runtime.sessionIds, [session]);

    const launch = box.worker(second.workerId).launch;
    assert.equal(launch.resumes, session);
    assert.equal(launch.sessionId, session);
    assert.equal(launch.scratch, firstLaunch.scratch, 'a continuation keeps the scratch directory, and what the worker left there');
    assert.deepEqual(launch.schema, firstLaunch.schema);
    assert.equal(launch.budgetUsd, 0.25, 'a continuation is a new process with its own budget');

    const argv = box.recorded().argv;
    assert.equal(argv[argv.indexOf('--resume') + 1], session);
    assert.equal(argv.includes('--session-id'), false);
    assert.ok(box.recorded().stdin.startsWith('You were refused Bash; answer without it.'));
  });

  it('continues a Codex session with exec resume, knowing the session before launch', async () => {
    const first = await box.run(box.codex({ access: 'edit' }));
    assert.deepEqual(first.runtime.sessionIds, [freshThread]);
    const second = await box.run(box.codex({ access: 'edit', resume: freshThread }));
    assert.equal(second.outcome, 'completed', second.error ?? '');
    const launch = box.worker(second.workerId).launch;
    assert.equal(launch.sessionId, freshThread);
    assert.equal(launch.resumes, freshThread);
    assert.equal(launch.scratch, box.worker(first.workerId).launch.scratch);
    const argv = box.recorded().argv;
    assert.deepEqual(argv.slice(argv.indexOf('exec'), argv.indexOf('exec') + 2), ['exec', 'resume']);
    assert.deepEqual(argv.slice(-2), [freshThread, '-']);
  });

  it('continues the latest worker of a session, not the first', async () => {
    const first = await box.run(box.claude());
    const session = first.runtime.sessionIds[0]!;
    await box.run(box.claude({ resume: session }));
    const third = await box.run(box.claude({ resume: session }));
    assert.equal(third.outcome, 'completed');
    assert.equal(Object.keys(box.checkpoint.fold(box.runId).workers).length, 3);
  });

  it('fails a Codex continuation that reports another thread', async () => {
    const first = await box.run(box.codex());
    const receipt = await box.run(box.codex({ resume: freshThread }), { FAKE_STDOUT: JSON.stringify({ type: 'thread.started', thread_id: 'another-thread' }) });
    assert.equal(first.outcome, 'completed');
    assert.equal(receipt.outcome, 'failed');
    assert.match(receipt.error ?? '', /ran thread another-thread, not the continued session/);
    // The continued session first, as the launcher records it for every worker, then the thread Codex reported.
    assert.deepEqual(receipt.runtime.sessionIds, [freshThread, 'another-thread']);
  });

  it('refuses a session no worker of the run ran', async () => {
    await assert.rejects(box.run(box.claude({ resume: '11111111-2222-4333-8444-555555555555' })), (error: unknown) => error instanceof InvalidInvocationError && /nothing to continue/.test(error.message));
    assert.ok(box.untouched());
  });

  const changes: [string, (session: string) => Parameters<LauncherSandbox['claude']>[0], RegExp][] = [
    ['its access', (session) => ({ resume: session, access: 'edit' }), /must keep its access: it was read-only, the invocation has edit/],
    ['its shell', (session) => ({ resume: session, shell: false }), /must keep its shell/],
    ['its model', (session) => ({ resume: session, model: 'other-model' }), /must keep its model/],
    ['its effort', (session) => ({ resume: session, effort: 'low' }), /must keep its effort/],
    ['its schema', (session) => ({ resume: session, outputSchema: z.strictObject({ answer: z.string(), extra: z.number() }) }), /must keep its output schema digest/],
    ['its scratch directory', (session) => ({ resume: session, scratch: join(box.directory, 'other-scratch') }), /keeps its scratch directory/],
  ];
  for (const [what, change, pattern] of changes) {
    it(`refuses a continuation that changes ${what}`, async () => {
      const first = await box.run(box.claude());
      const before = box.events().length;
      await assert.rejects(box.run(box.claude(change(first.runtime.sessionIds[0]!))), (error: unknown) => error instanceof InvalidInvocationError && pattern.test(error.message));
      assert.equal(box.events().length, before);
    });
  }

  it('refuses to continue a session while a worker is still running in it', async () => {
    const marker = join(box.directory, 'go');
    const first = await box.run(box.claude());
    const session = first.runtime.sessionIds[0]!;
    const pending = box.run(box.claude({ resume: session }), { FAKE_WAIT_FOR: marker });
    await until(() => box.events().filter(([kind]) => kind === 'worker.launched').length === 2, 'the continuation to launch');
    await assert.rejects(box.run(box.claude({ resume: session })), /is still running in session/);
    writeFileSync(marker, '');
    assert.equal((await pending).outcome, 'completed');
  });

  it('refuses a runtime change even when the session id matches', async () => {
    const first = await box.run(box.codex());
    await assert.rejects(box.run(box.claude({ resume: first.runtime.sessionIds[0]! })), /must keep its runtime: it was codex, the invocation has claude/);
  });
});
