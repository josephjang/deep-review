import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { z } from 'zod';
import { workerLaunchedV1 } from '../../src/checkpoint/events.ts';
import { InvalidInvocationError } from '../../src/runtime/errors.ts';
import { continuationFields } from '../../src/runtime/launcher.ts';
import { defaultRuntimes } from '../../src/runtime/runtimes.ts';
import { fakeClaude, freshThread, LauncherSandbox, until } from '../helpers/launcher.ts';

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

  it('continues a Codex session under the provider of the adapter it is given, which the ledger does not record', async () => {
    const provider = { id: 'gateway', baseUrl: 'http://127.0.0.1:9/v1', envKey: 'GATEWAY_KEY', queryParams: { 'api-version': '1' } };
    const chosen = ['model_provider="gateway"', 'model_providers.gateway.name="gateway"', 'model_providers.gateway.base_url="http://127.0.0.1:9/v1"', 'model_providers.gateway.env_key="GATEWAY_KEY"', 'model_providers.gateway.query_params={"api-version"="1"}'];
    const providerArgs = (argv: readonly string[]): string[] => argv.filter((arg) => arg.startsWith('model_provider'));
    const runtimes = defaultRuntimes({ codex: { provider } });
    const first = await box.run(box.codex(), {}, { runtimes });
    assert.equal(first.outcome, 'completed', first.error ?? '');
    assert.deepEqual(providerArgs(box.recorded().argv), chosen);
    const second = await box.run(box.codex({ resume: freshThread }), {}, { runtimes });
    assert.equal(second.outcome, 'completed', second.error ?? '');
    assert.deepEqual(providerArgs(box.recorded().argv), chosen);
    assert.equal(JSON.stringify(box.worker(first.workerId).launch).includes('gateway'), false, 'the provider is the caller\'s choice at each launch, not a kept field');
    // Nothing remembers the provider: a continuation given the default runtimes runs on Codex's built-in one.
    const third = await box.run(box.codex({ resume: freshThread }));
    assert.equal(third.outcome, 'completed', third.error ?? '');
    assert.deepEqual(providerArgs(box.recorded().argv), []);
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

  it('accepts the scratch directory it keeps however the caller spells it', async () => {
    const spelled = `${join(box.directory, 'kept-scratch')}${sep}`;
    const first = await box.run(box.claude({ scratch: spelled }));
    assert.equal(box.worker(first.workerId).launch.scratch, join(box.directory, 'kept-scratch'));
    const second = await box.run(box.claude({ resume: first.runtime.sessionIds[0]!, scratch: spelled }));
    assert.equal(second.outcome, 'completed', second.error ?? '');
    assert.equal(box.worker(second.workerId).launch.scratch, join(box.directory, 'kept-scratch'));
  });

  it('refuses a session whose only worker never started, before launching anything', async () => {
    const missing = join(box.directory, 'missing', 'claude-cli');
    const first = await box.run(box.claude({ executable: missing, executableArgs: [] }), {}, { qualify: () => Promise.resolve('1.0.0') });
    assert.equal(first.process.termination, 'not-started');
    const session = first.runtime.sessionIds[0]!;
    const before = box.events().length;
    await assert.rejects(box.run(box.claude({ resume: session })), (error: unknown) => error instanceof InvalidInvocationError && /ever started/.test(error.message));
    assert.equal(box.events().length, before);
  });

  it('continues a session whose latest worker never started when an earlier one ran', async () => {
    const first = await box.run(box.claude());
    const session = first.runtime.sessionIds[0]!;
    const failed = await box.run(box.claude({ resume: session, executable: join(box.directory, 'missing', 'claude-cli'), executableArgs: [] }), {}, { qualify: () => Promise.resolve('1.0.0') });
    assert.equal(failed.process.termination, 'not-started');
    const third = await box.run(box.claude({ resume: session }));
    assert.equal(third.outcome, 'completed', third.error ?? '');
  });

  /** Record a worker of `session` whose engine stopped while it ran, as a resuming engine does (TD5 of the read-only review). */
  const loseWorkerIn = (session: string, workerId: string, resumes: string | null): void => {
    const template = Object.values(box.checkpoint.fold(box.runId).workers)[0]!.launch;
    const launch = { ...template, workerId, sessionId: session, resumes };
    const lost = { workerId, phase: null, key: null, reason: 'the engine exited while the worker ran' };
    box.checkpoint.append(box.runId, box.checkpoint.fold(box.runId).lastSequence, [{ kind: 'worker.launched', version: 1, payload: launch }, { kind: 'worker.lost', version: 1, payload: lost }]);
  };

  it('refuses to continue a session whose latest worker was lost, since its process may still write to it', async () => {
    const first = await box.run(box.claude());
    const session = first.runtime.sessionIds[0]!;
    loseWorkerIn(session, '00000000-0000-4000-8000-00000000000a', session);
    const before = box.events().length;
    await assert.rejects(box.run(box.claude({ resume: session })), (error: unknown) => error instanceof InvalidInvocationError && /Worker 00000000-0000-4000-8000-00000000000a was lost in session .*: whether its process still runs is unknown/.test(error.message));
    assert.equal(box.events().length, before);
  });

  it('refuses a session whose only worker was lost, which may never have started', async () => {
    await box.run(box.claude());
    const pinned = '11111111-2222-4333-8444-66666666666a';
    loseWorkerIn(pinned, '00000000-0000-4000-8000-00000000000b', null);
    const before = box.events().length;
    await assert.rejects(box.run(box.claude({ resume: pinned })), (error: unknown) => error instanceof InvalidInvocationError && /was lost in session/.test(error.message));
    assert.equal(box.events().length, before);
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
    ['its scratch directory', (session) => ({ resume: session, scratch: join(box.directory, 'other-scratch') }), /must keep its scratch directory: it was .*, the invocation has .*other-scratch/],
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

  it('classifies every launch field, keeping the runtime, model, effort, permissions, schema and scratch directory', () => {
    assert.deepEqual(Object.keys(continuationFields).sort(), Object.keys(workerLaunchedV1.shape).sort());
    const kept = Object.entries(continuationFields).flatMap(([field, rule]) => (rule === 'own' ? [] : [field]));
    assert.deepEqual(kept, ['runtime', 'model', 'effort', 'access', 'shell', 'schema', 'scratch']);
  });

  it('continues a session under another executable of the same runtime, which the launch records', async () => {
    const first = await box.run(box.claude());
    const session = first.runtime.sessionIds[0]!;
    const second = await box.run(box.claude({ resume: session, executableArgs: ['--no-warnings', fakeClaude] }));
    assert.equal(second.outcome, 'completed', second.error ?? '');
    assert.deepEqual(box.worker(second.workerId).launch.executableArgs, ['--no-warnings', fakeClaude]);
  });

  it('refuses a runtime change even when the session id matches', async () => {
    const first = await box.run(box.codex());
    await assert.rejects(box.run(box.claude({ resume: first.runtime.sessionIds[0]! })), /must keep its runtime: it was codex, the invocation has claude/);
  });
});
