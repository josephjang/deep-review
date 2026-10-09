import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { z } from 'zod';
import { Checkpoint } from '../../src/checkpoint/checkpoint.ts';
import { RunClosedError, UnknownRunError } from '../../src/checkpoint/errors.ts';
import { locateCheckpoint } from '../../src/checkpoint/locate.ts';
import { collectArtifactReferences } from '../../src/evidence/references.ts';
import { emptyUsageSummary, maxDecodeBytes, maxLineBytes, type RuntimeAdapter } from '../../src/runtime/adapter.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { codexAdapter } from '../../src/runtime/codex.ts';
import { InheritedOverrideError, InvalidInvocationError, UnknownRuntimeError, UnsupportedCapabilityError } from '../../src/runtime/errors.ts';
import { sha256Hex } from '../../src/evidence/store.ts';
import { parseInvocation } from '../../src/runtime/contract.ts';
import { runWorker, withPinnedSession, withUnrecordableSessions, workerVerdict, type Verdict, type WorkerReceipt } from '../../src/runtime/launcher.ts';
import { notStarted, type ProcessResult } from '../../src/runtime/process.ts';
import { RuntimeRegistry } from '../../src/runtime/registry.ts';
import { answerSchema, baseEnvironment, fixedIds, freshThread, hermeticEnvironment, isAlive, LauncherSandbox, until, waitForPid } from '../helpers/launcher.ts';
import { createRepository } from '../helpers/repository.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The timeout of a worker that hangs: time enough for the fake to start Node,
 * write its record and its grandchild's pid before the kill, even on a loaded
 * runner, so the test never races the fake's startup.
 */
const hangTimeoutMs = 4000;

/** A schema whose check throws instead of rejecting, as a careless refinement can: `safeParse` itself throws. */
const throwingSchema = answerSchema.refine((value) => JSON.parse(value.answer) !== null);

describe('runWorker', () => {
  let box: LauncherSandbox;
  beforeEach(() => {
    box = new LauncherSandbox();
  });
  afterEach(() => {
    box.close();
  });

  /** Every reference on both of the worker's events resolves to verified evidence (R6). */
  const assertEvidence = (receipt: WorkerReceipt): void => {
    const worker = box.worker(receipt.workerId);
    assert.equal(worker.status, 'finished');
    const references = collectArtifactReferences([worker.launch, worker.status === 'finished' ? worker.finish : null]);
    assert.ok(references.length >= 4);
    for (const reference of references) box.checkpoint.evidence.verify(reference);
    const read = (reference: { sha256: string; bytes: number }): string => box.checkpoint.evidence.read(reference).toString('utf8');
    assert.equal(read(receipt.evidence.prompt), read(worker.launch.prompt));
    assert.equal(read(receipt.evidence.schema), read(worker.launch.schema));
  };

  describe('Claude Code', () => {
    it('completes: records both events, freezes every byte exchanged, and returns the validated answer', async () => {
      const stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: '{session}', structured_output: { answer: 'fine' }, permission_denials: [], usage: { input_tokens: 5 }, total_cost_usd: 0.002 });
      const receipt = await box.run(box.claude({ label: 'finder', budgetUsd: 1 }), { FAKE_STDOUT: stdout, FAKE_STDERR: 'a warning\n' });
      assert.equal(receipt.outcome, 'completed');
      assert.equal(receipt.error, null);
      assert.deepEqual(receipt.output, { answer: 'fine' });
      assert.deepEqual(receipt.denials, []);
      assert.equal(receipt.process.termination, 'exited');
      assert.equal(receipt.process.exitCode, 0);
      assert.ok(Date.parse(receipt.process.startedAt) <= Date.parse(receipt.process.endedAt));
      assert.deepEqual(receipt.runtime.usage, { usage: { input_tokens: 5 }, modelUsage: null, total_cost_usd: 0.002 });
      assert.equal(receipt.runtime.name, 'claude');
      assert.equal(receipt.runtime.version, '2.1.283');

      const worker = box.worker(receipt.workerId);
      assert.match(receipt.workerId, uuid);
      assert.match(worker.launch.sessionId ?? '', uuid);
      assert.deepEqual(receipt.runtime.sessionIds, [worker.launch.sessionId]);
      assert.equal(worker.launch.label, 'finder');
      assert.equal(worker.launch.budgetUsd, 1);
      assert.equal(worker.launch.executable, process.execPath);
      assert.equal(worker.launch.version, '2.1.283');
      assert.equal(worker.status === 'finished' && worker.finish.usage, JSON.stringify(receipt.runtime.usage));
      assert.deepEqual(box.events().map(([kind]) => kind), ['run.created', 'worker.launched', 'worker.finished']);

      // The bytes frozen are the bytes exchanged.
      assertEvidence(receipt);
      const recorded = box.recorded();
      const read = (reference: { sha256: string; bytes: number } | null): string => (reference === null ? '' : box.checkpoint.evidence.read(reference).toString('utf8'));
      assert.equal(read(receipt.evidence.prompt), recorded.stdin);
      assert.equal(read(receipt.evidence.schema), recorded.argv[recorded.argv.indexOf('--json-schema') + 1]);
      assert.equal(read(receipt.evidence.stdout), stdout.replace('{session}', worker.launch.sessionId!));
      assert.equal(read(receipt.evidence.stderr), 'a warning\n');
      assert.deepEqual(JSON.parse(read(receipt.evidence.output)), { answer: 'fine' });
      assert.equal(receipt.evidence.finalMessage, null);
      assert.equal(recorded.cwd, box.repo);
      assert.equal(recorded.argv[recorded.argv.indexOf('--session-id') + 1], worker.launch.sessionId);
      assert.equal(existsSync(join(box.checkpoint.root, 'io', receipt.workerId)), false, 'process files are removed once frozen');
    });

    it('reports a budget stop as budget, not as a failure', async () => {
      const stdout = JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, session_id: '{session}', permission_denials: [] });
      const receipt = await box.run(box.claude({ budgetUsd: 0.5 }), { FAKE_STDOUT: stdout, FAKE_EXIT: '1' });
      assert.equal(receipt.outcome, 'budget');
      assert.match(receipt.error ?? '', /budget of 0.5 USD/);
      assert.equal(receipt.output, null);
      assert.equal(receipt.evidence.output, null);
      assert.equal(receipt.process.exitCode, 1);
    });

    it('kills the worker and its process tree at the timeout, and still names the session', async () => {
      const pidFile = join(box.directory, 'grandchild.pid');
      const pending = box.run(box.claude({ timeoutMs: hangTimeoutMs }), { FAKE_HANG: pidFile });
      const grandchild = await waitForPid(pidFile);
      const receipt = await pending;
      assert.equal(receipt.outcome, 'timeout');
      assert.equal(receipt.process.termination, 'killed');
      assert.match(receipt.error ?? '', new RegExp(`timeout of ${String(hangTimeoutMs)} ms`));
      assert.deepEqual(receipt.runtime.sessionIds, [box.worker(receipt.workerId).launch.sessionId]);
      await until(() => !isAlive(grandchild), `grandchild ${String(grandchild)} to die`, 10_000);
      assertEvidence(receipt);
    });

    const failures: [string, Record<string, string>, RegExp][] = [
      ['a nonzero exit with a valid envelope', { FAKE_EXIT: '3' }, /exited with code 3/],
      ['no envelope and a nonzero exit', { FAKE_STDOUT: '', FAKE_STDERR: 'boom', FAKE_EXIT: '3' }, /printed no result envelope/],
      ['output that is not JSON', { FAKE_STDOUT: 'Error: something' }, /not JSON/],
      ['an answer the schema rejects', { FAKE_OUTPUT: '{"answer":42}' }, /does not match the output schema/],
      ['an envelope without a denial list', { FAKE_STDOUT: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: '{session}', structured_output: { answer: 'ok' } }) }, /no permission_denials array/],
      ['an answer from another session', { FAKE_STDOUT: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'other-session', structured_output: { answer: 'ok' }, permission_denials: [] }) }, /answered from session other-session/],
    ];
    for (const [name, fake, pattern] of failures) {
      it(`fails ${name}, with the reason, and still finishes the worker`, async () => {
        const receipt = await box.run(box.claude(), fake);
        assert.equal(receipt.outcome, 'failed');
        assert.match(receipt.error ?? '', pattern);
        assert.equal(receipt.output, null);
        assert.equal(receipt.evidence.output, null);
        assertEvidence(receipt);
      });
    }

    it('records the pinned session first and then the one an answer from another session named', async () => {
      const stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'other-session', structured_output: { answer: 'ok' }, permission_denials: [] });
      const receipt = await box.run(box.claude(), { FAKE_STDOUT: stdout });
      assert.equal(receipt.outcome, 'failed');
      const worker = box.worker(receipt.workerId);
      assert.deepEqual(receipt.runtime.sessionIds, [worker.launch.sessionId, 'other-session']);
      assert.deepEqual(worker.status === 'finished' && worker.finish.sessionIds, receipt.runtime.sessionIds);
    });

    it('says so when the kill at the timeout reached only the root of the tree', { skip: process.platform !== 'win32' && 'only a Windows tree kill can be made to fail from here' }, async () => {
      // taskkill is found under SystemRoot; with none there the tree kill fails and only the root is ended.
      const pidFile = join(box.directory, 'grandchild.pid');
      const systemRoot = process.env.SystemRoot;
      process.env.SystemRoot = join(box.directory, 'no-windows');
      let grandchild: number | undefined;
      try {
        const pending = box.run(box.claude({ timeoutMs: hangTimeoutMs }), { FAKE_HANG: pidFile });
        grandchild = await waitForPid(pidFile);
        const receipt = await pending;
        assert.equal(receipt.outcome, 'timeout');
        assert.equal(receipt.process.termination, 'killed');
        assert.match(receipt.error ?? '', new RegExp(`timeout of ${String(hangTimeoutMs)} ms and was killed, but only its root: taskkill could not end the process tree: .+; descendants may still run$`));
        assert.equal(isAlive(grandchild), true, 'the descendant the kill could not reach is still running');
        const worker = box.worker(receipt.workerId);
        assert.equal(worker.status === 'finished' && worker.finish.error, receipt.error);
      } finally {
        process.env.SystemRoot = systemRoot;
        if (grandchild !== undefined && isAlive(grandchild)) process.kill(grandchild);
      }
    });

    it('lists denials without changing a completed outcome', async () => {
      const receipt = await box.run(box.claude(), { FAKE_DENIALS: JSON.stringify([{ tool_name: 'Bash', tool_input: { command: 'touch x' } }]) });
      assert.equal(receipt.outcome, 'completed');
      assert.deepEqual(receipt.denials, [{ tool: 'Bash', detail: 'touch x' }]);
      const worker = box.worker(receipt.workerId);
      assert.deepEqual(worker.status === 'finished' && worker.finish.denials, [{ tool: 'Bash', detail: 'touch x' }]);
    });
  });

  describe('Codex', () => {
    it('completes: observes the session from the stream and has no denial evidence', async () => {
      const receipt = await box.run(box.codex());
      assert.equal(receipt.outcome, 'completed', receipt.error ?? '');
      assert.deepEqual(receipt.output, { answer: 'ok' });
      assert.deepEqual(receipt.runtime.sessionIds, [freshThread]);
      assert.equal(receipt.denials, null);
      assert.equal(receipt.runtime.version, '0.147.0');
      assert.deepEqual(receipt.runtime.usage, { input_tokens: 11, cached_input_tokens: 0, output_tokens: 4 });
      const worker = box.worker(receipt.workerId);
      assert.equal(worker.launch.sessionId, null, 'Codex chooses its own session id');
      assert.equal(worker.status === 'finished' && worker.finish.denials, null);
      assertEvidence(receipt);
      const recorded = box.recorded();
      assert.equal(box.checkpoint.evidence.read(receipt.evidence.finalMessage!).toString('utf8'), '{"answer":"ok"}');
      assert.equal(box.checkpoint.evidence.read(receipt.evidence.prompt).toString('utf8'), recorded.stdin);
      // The schema file Codex was pointed at held the frozen schema; it is gone now, like every process file.
      const schemaFile = recorded.argv[recorded.argv.indexOf('--output-schema') + 1]!;
      assert.equal(existsSync(schemaFile), false);
      assert.ok(schemaFile.startsWith(join(box.checkpoint.root, 'io', receipt.workerId)));
    });

    it('keeps a command that exited nonzero', async () => {
      const stream = [
        { type: 'thread.started', thread_id: '{session}' },
        { type: 'item.started', item: { id: 'c', type: 'command_execution', status: 'in_progress' } },
        { type: 'item.completed', item: { id: 'c', type: 'command_execution', exit_code: 1, status: 'failed' } },
        { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: '{"answer":"ok"}' } },
        { type: 'turn.completed', usage: {} },
      ].map((event) => JSON.stringify(event)).join('\n');
      const receipt = await box.run(box.codex(), { FAKE_STDOUT: stream });
      assert.equal(receipt.outcome, 'completed', receipt.error ?? '');
    });

    it('judges a stream longer than the decode cap by its answer, reading it one line at a time', async () => {
      // One command printed at least as much as the cap on stdout; every event of the turn is still read.
      const receipt = await box.run(box.codex(), { FAKE_COMMAND_OUTPUT: String(maxDecodeBytes) });
      assert.equal(receipt.outcome, 'completed', receipt.error ?? '');
      assert.deepEqual(receipt.output, { answer: 'ok' });
      assert.deepEqual(receipt.runtime.sessionIds, [freshThread]);
      assert.deepEqual(receipt.runtime.usage, { input_tokens: 11, cached_input_tokens: 0, output_tokens: 4 });
      assert.ok(receipt.evidence.stdout.bytes > maxDecodeBytes);
      assertEvidence(receipt);
    });

    it('kills the worker and its process tree at the timeout', async () => {
      const pidFile = join(box.directory, 'grandchild.pid');
      const pending = box.run(box.codex({ timeoutMs: hangTimeoutMs }), { FAKE_HANG: pidFile });
      const grandchild = await waitForPid(pidFile);
      const receipt = await pending;
      assert.equal(receipt.outcome, 'timeout');
      assert.equal(receipt.process.termination, 'killed');
      assert.deepEqual(receipt.runtime.sessionIds, []);
      assert.equal(receipt.evidence.finalMessage, null);
      await until(() => !isAlive(grandchild), `grandchild ${String(grandchild)} to die`, 10_000);
    });

    const failures: [string, Record<string, string>, RegExp][] = [
      ['a nonzero exit', { FAKE_EXIT: '2' }, /exited with code 2/],
      ['a stream that is not JSON', { FAKE_STDOUT: 'garbage\n' }, /not JSON/],
      ['a final message that disagrees with the stream', { FAKE_FINAL: '{"answer":"other"}' }, /not its last agent message/],
      ['no final message file', { FAKE_FINAL: '' }, /no final message file/],
      ['an answer the schema rejects', { FAKE_OUTPUT: '{"answer":1}' }, /does not match the output schema/],
      ['a sandbox that could not run its commands', { FAKE_STDERR: '2026-09-27T00:00:00Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { refused }\r\n' }, /refused to run 1 command\(s\) in its sandbox.*CreateProcess \{ refused \}$/],
      ['an MCP tool call', { FAKE_STDOUT: [{ type: 'thread.started', thread_id: '{session}' }, { type: 'item.completed', item: { id: 'x', type: 'mcp_tool_call' } }, { type: 'turn.completed' }].map((event) => JSON.stringify(event)).join('\n') }, /used mcp_tool_call/],
    ];
    for (const [name, fake, pattern] of failures) {
      it(`fails ${name}`, async () => {
        const receipt = await box.run(box.codex(), fake);
        assert.equal(receipt.outcome, 'failed');
        assert.match(receipt.error ?? '', pattern);
        assert.equal(receipt.denials, null);
        assertEvidence(receipt);
      });
    }

    it('decodes a stream above the decode cap line by line, judging its filler as a malformed line, and still freezes it', async () => {
      const receipt = await box.run(box.codex(), { FAKE_HUGE: String(maxDecodeBytes + 1) });
      assert.equal(receipt.outcome, 'failed');
      assert.match(receipt.error ?? '', /^Codex printed line 1 that is not JSON/);
      assert.equal(receipt.evidence.stdout.bytes, maxDecodeBytes + 1);
      box.checkpoint.evidence.verify(receipt.evidence.stdout);
    });

    it('still records the thread of a stream with a line too long to decode, so the session can be continued', async () => {
      const started = `${JSON.stringify({ type: 'thread.started', thread_id: '{session}' })}\n`;
      const receipt = await box.run(box.codex(), { FAKE_STDOUT: started, FAKE_HUGE: String(maxLineBytes + 1) });
      assert.equal(receipt.outcome, 'failed');
      assert.equal(receipt.error, `Codex printed line 2 that is longer than the ${String(maxLineBytes)} bytes the launcher decodes as one line`);
      assert.equal(receipt.evidence.stdout.bytes, Buffer.byteLength(started.replace('{session}', freshThread)) + maxLineBytes + 1);
      assert.deepEqual(receipt.runtime.sessionIds, [freshThread]);
      const worker = box.worker(receipt.workerId);
      assert.deepEqual(worker.status === 'finished' && worker.finish.sessionIds, [freshThread]);
      const continued = await box.run(box.codex({ resume: freshThread }));
      assert.equal(continued.outcome, 'completed', continued.error ?? '');
    });

    it('refuses to decode a stderr above 16 MiB, freezes it, and keeps the session', async () => {
      const receipt = await box.run(box.codex(), { FAKE_HUGE: String(maxDecodeBytes + 1), FAKE_HUGE_STREAM: 'stderr' });
      assert.equal(receipt.outcome, 'failed');
      assert.match(receipt.error ?? '', new RegExp(`stderr is ${String(maxDecodeBytes + 1)} bytes`));
      assert.equal(receipt.output, null);
      assert.equal(receipt.evidence.stderr.bytes, maxDecodeBytes + 1);
      assert.deepEqual(receipt.runtime.sessionIds, [freshThread]);
      assertEvidence(receipt);
    });

    it('names session ids the ledger cannot hold and records no answer', async () => {
      const receipt = await box.run(box.codex(), { FAKE_THREAD: 'not a session id' });
      assert.equal(receipt.outcome, 'failed');
      assert.match(receipt.error ?? '', /The answer is not recorded because the runtime reported session ids the ledger cannot hold: \["not a session id"\]/);
      assert.equal(receipt.output, null);
      assert.equal(receipt.evidence.output, null);
      assert.deepEqual(receipt.runtime.sessionIds, []);
      assertEvidence(receipt);
    });
  });

  describe('a failure of the launcher itself', () => {
    it('keeps the outputs it froze and the session it decoded', async () => {
      const receipt = await box.run(box.codex({ outputSchema: throwingSchema }));
      assert.equal(receipt.outcome, 'failed');
      assert.match(receipt.error ?? '', /^The launcher could not settle the worker's outputs: /);
      assert.deepEqual(receipt.runtime.sessionIds, [freshThread], 'a fresh Codex thread is known only from the stream');
      const read = (reference: { sha256: string; bytes: number }): string => box.checkpoint.evidence.read(reference).toString('utf8');
      assert.match(read(receipt.evidence.stdout), /"thread\.started"/, 'the stdout recorded is what the worker printed');
      assert.equal(read(receipt.evidence.finalMessage!), '{"answer":"ok"}');
      assert.equal(receipt.evidence.output, null);
      assertEvidence(receipt);
      assert.equal(existsSync(join(box.checkpoint.root, 'io', receipt.workerId)), false, 'every process file was frozen');
    });

    it('still finishes the worker when the evidence store fails, keeping the unfrozen process files', async () => {
      const marker = join(box.directory, 'go');
      const pending = box.run(box.claude(), { FAKE_WAIT_FOR: marker });
      await until(() => existsSync(box.recordFile), 'the fake to start');
      const evidence = box.checkpoint.evidence;
      evidence.put = () => {
        throw new Error('no space left on device');
      };
      let receipt: WorkerReceipt;
      try {
        writeFileSync(marker, '');
        receipt = await pending;
      } finally {
        Reflect.deleteProperty(evidence, 'put');
      }
      const io = join(box.checkpoint.root, 'io', receipt.workerId);
      assert.equal(receipt.outcome, 'failed');
      assert.equal(receipt.process.termination, 'exited');
      assert.ok(receipt.error?.startsWith(`The launcher could not freeze the worker's outputs, whose process files are kept in ${io}: no space left on device`), receipt.error ?? '');
      const empty = { sha256: sha256Hex(Buffer.alloc(0)), bytes: 0 };
      assert.deepEqual(receipt.evidence.stdout, empty);
      assert.deepEqual(receipt.evidence.stderr, empty);
      const worker = box.worker(receipt.workerId);
      assert.equal(worker.status, 'finished', 'the launch is closed');
      assert.deepEqual(receipt.runtime.sessionIds, [worker.launch.sessionId]);
      assert.match(readFileSync(join(io, 'stdout'), 'utf8'), /"structured_output"/, 'the only copy of stdout is kept');
      assertEvidence(receipt);
    });
  });

  describe('capabilities (R2)', () => {
    const refusals: [string, () => Parameters<typeof runWorker>[2], string][] = [
      ['a Codex budget', () => box.codex({ budgetUsd: 1 }), 'budgetCap'],
      ['a Codex worker without a shell', () => box.codex({ shell: false }), 'withholdShell'],
      ['Codex at max effort', () => box.codex({ effort: 'max' }), 'effortLevels'],
      ['a scratch directory for a read-only Codex worker', () => box.codex({ scratch: join(box.directory, 'elsewhere') }), 'readOnlyScratch'],
    ];
    for (const [name, invocation, capability] of refusals) {
      it(`refuses ${name} by name before writing anything`, async () => {
        await assert.rejects(box.run(invocation()), (error: unknown) => error instanceof UnsupportedCapabilityError && error.runtime === 'codex' && error.capability === capability);
        assert.ok(box.untouched());
      });
    }

    it('refuses a continuation on a runtime that cannot resume', async () => {
      const registry = new RuntimeRegistry([{ ...codexAdapter, name: 'codex-without-resume', capabilities: { ...codexAdapter.capabilities, resume: false } }]);
      await assert.rejects(
        box.run(box.codex({ runtime: 'codex-without-resume', resume: freshThread }), {}, { runtimes: registry }),
        (error: unknown) => error instanceof UnsupportedCapabilityError && error.capability === 'resume',
      );
      assert.ok(box.untouched());
    });

    it('lets Claude Code do all of it', async () => {
      const receipt = await box.run(box.claude({ budgetUsd: 1, shell: false, effort: 'max', scratch: join(box.directory, 'elsewhere') }));
      assert.equal(receipt.outcome, 'completed', receipt.error ?? '');
    });
  });

  describe('launch record (R3, R4)', () => {
    it('is on the ledger with its session id while the process is still running', async () => {
      const marker = join(box.directory, 'go');
      const pending = box.run(box.claude(), { FAKE_WAIT_FOR: marker });
      await until(() => existsSync(box.recordFile), 'the fake to start');
      const launched = box.events().filter(([kind]) => kind === 'worker.launched');
      assert.equal(launched.length, 1);
      const workerId = launched[0]![1].workerId as string;
      const worker = box.worker(workerId);
      assert.equal(worker.status, 'running');
      const argv = box.recorded().argv;
      assert.equal(argv[argv.indexOf('--session-id') + 1], worker.launch.sessionId);
      writeFileSync(marker, '');
      const receipt = await pending;
      assert.equal(receipt.workerId, workerId);
      assert.equal(box.worker(workerId).status, 'finished');
    });

    it('records a spawn failure as a finished worker that never started', async () => {
      const missing = join(box.directory, 'missing', 'claude-cli');
      const receipt = await box.run(box.claude({ executable: missing, executableArgs: [] }), {}, { qualify: () => Promise.resolve('1.0.0') });
      assert.equal(receipt.outcome, 'failed');
      assert.equal(receipt.process.termination, 'not-started');
      assert.equal(receipt.process.exitCode, null);
      assert.match(receipt.error ?? '', /did not start/);
      assert.deepEqual(box.events().map(([kind]) => kind), ['run.created', 'worker.launched', 'worker.finished']);
      assert.deepEqual(receipt.runtime.sessionIds, [box.worker(receipt.workerId).launch.sessionId]);
      assertEvidence(receipt);
    });

    it('refuses an executable whose help lacks a flag the adapter uses, naming it', async () => {
      await assert.rejects(box.run(box.claude(), { FAKE_HELP_OMIT: '--json-schema' }), /lacks flags the adapter uses: --json-schema \(in --help\)/);
      await assert.rejects(box.run(box.codex(), { FAKE_HELP_OMIT: '--output-last-message' }), /--output-last-message \(in exec --help\), --output-last-message \(in exec resume --help\)/);
      assert.ok(box.untouched());
    });

    it('refuses an executable that does not identify as the runtime, and one that does not run', async () => {
      await assert.rejects(box.run(box.claude(), { FAKE_VERSION: 'codex-cli 0.147.0' }), /does not identify itself as claude/);
      await assert.rejects(box.run(box.claude({ executable: join(box.directory, 'missing'), executableArgs: [] })), /preflight could not run/);
      assert.ok(box.untouched());
    });

    it('preflights with the limits it is given, and the preflight\'s own without them', async () => {
      await assert.rejects(box.run(box.claude(), {}, { preflightOptions: { maxOutputBytes: 8 } }), /--version: it printed more than 8 bytes$/);
      assert.ok(box.untouched());
      assert.equal((await box.run(box.claude())).outcome, 'completed');
    });

    it('records the version it observed, with no version list', async () => {
      const receipt = await box.run(box.claude(), { FAKE_VERSION: '9.8.7 (Claude Code)' });
      assert.equal(receipt.runtime.version, '9.8.7');
      assert.equal(box.worker(receipt.workerId).launch.version, '9.8.7');
    });
  });

  describe('scratch directory (R7)', () => {
    it('gives a Claude worker one under the scratch root, names it in the prompt, and points the temporary directory at it', async () => {
      const receipt = await box.run(box.claude());
      const scratch = box.scratchOf(receipt.workerId);
      assert.equal(box.worker(receipt.workerId).launch.scratch, scratch);
      assert.ok(existsSync(scratch));
      const recorded = box.recorded();
      assert.ok(recorded.stdin.startsWith('Answer ok.\n\n'));
      assert.ok(recorded.stdin.includes(`Your scratch directory is ${scratch}.`));
      assert.equal(recorded.environment.TEMP, scratch);
      assert.equal(recorded.environment.TMP, scratch);
      assert.equal(recorded.environment.TMPDIR, process.platform === 'win32' ? scratch.replaceAll('\\', '/') : scratch);
      assert.equal(recorded.argv[recorded.argv.indexOf('--add-dir') + 1], scratch);
    });

    it('gives a read-only Codex worker none, and says so', async () => {
      const receipt = await box.run(box.codex());
      assert.equal(box.worker(receipt.workerId).launch.scratch, null);
      assert.equal(existsSync(box.scratchRoot), false);
      const recorded = box.recorded();
      assert.ok(recorded.stdin.includes('No scratch directory is available to you'));
      assert.equal(recorded.argv.some((arg) => arg.includes('writable_roots')), false);
    });

    it('gives a Codex editor one it may write to', async () => {
      const receipt = await box.run(box.codex({ access: 'edit' }));
      const scratch = box.scratchOf(receipt.workerId);
      assert.ok(box.recorded().argv.includes(`sandbox_workspace_write.writable_roots=[${JSON.stringify(scratch)}]`));
      assert.equal(box.recorded().environment.TEMP, scratch);
    });

    it('gives a Codex editor its shared directory beside its scratch, as given and resolved (R2 of commit series integrity)', async () => {
      const claims = join(box.directory, 'claims', 'round-1');
      const receipt = await box.run(box.codex({ access: 'edit', shared: claims }));
      const scratch = box.scratchOf(receipt.workerId);
      assert.ok(box.recorded().argv.includes(`sandbox_workspace_write.writable_roots=[${JSON.stringify(scratch)},${JSON.stringify(claims)}]`));
    });

    it('keeps the default scratch directory out of the git directory, where a Codex editor could not write to it', async () => {
      // The production layout: a main worktree whose checkpoint lives in its .git directory.
      // Codex's workspace-write sandbox makes .git read-only and refuses every command of a
      // worker given a writable root beneath it.
      const repo = createRepository(join(box.directory, 'main-worktree'));
      const location = locateCheckpoint(repo);
      const checkpoint = Checkpoint.open(location.root, { engine: '0.0.0-test' });
      let scratch: string | null = null;
      try {
        const run = checkpoint.createRun({ worktree: location.worktree });
        const receipt = await runWorker(checkpoint, run.id, box.codex({ access: 'edit' }), { environment: baseEnvironment });
        scratch = checkpoint.fold(run.id).workers[receipt.workerId]!.launch.scratch;
        assert.ok(scratch !== null);
        const inside = (parent: string, child: string): boolean => {
          const path = relative(parent, child);
          return path === '' || !(path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path));
        };
        assert.equal(inside(location.commonDir, scratch), false, `${scratch} is inside ${location.commonDir}`);
        assert.equal(inside(location.worktree, scratch), false, `${scratch} is inside ${location.worktree}`);
        assert.ok(existsSync(scratch));
      } finally {
        checkpoint.close();
        // The default root is the system's temporary directory; leave nothing of this checkpoint there.
        if (scratch !== null) rmSync(join(scratch, '..'), { recursive: true, force: true });
      }
    });

    it('uses a scratch directory the caller gives, and refuses one inside the reviewed tree or the checkpoint', async () => {
      const chosen = join(box.directory, 'shared-scratch');
      const receipt = await box.run(box.claude({ scratch: chosen }));
      assert.equal(box.worker(receipt.workerId).launch.scratch, chosen);
      assert.ok(existsSync(chosen));
      await assert.rejects(box.run(box.claude({ scratch: join(box.repo, 'tmp') })), (error: unknown) => error instanceof InvalidInvocationError && /inside the reviewed tree/.test(error.message));
      await assert.rejects(box.run(box.claude({ scratch: box.repo })), /inside the reviewed tree/);
      await assert.rejects(box.run(box.claude({ scratch: join(box.checkpoint.root, 'scratch') })), (error: unknown) => error instanceof InvalidInvocationError && /inside the checkpoint/.test(error.message));
      assert.equal(existsSync(join(box.repo, 'tmp')), false);
    });

    it('refuses a shared directory to a read-only worker, and one inside the reviewed tree or the checkpoint, launching nothing (R2 of commit series integrity)', async () => {
      const claims = join(box.directory, 'claims', 'round-1');
      await assert.rejects(box.run(box.claude({ shared: claims })), (error: unknown) => error instanceof InvalidInvocationError && /A read-only worker writes nowhere, so it is given no shared directory/.test(error.message));
      await assert.rejects(box.run(box.claude({ access: 'edit', shared: join(box.repo, 'claims') })), (error: unknown) => error instanceof InvalidInvocationError && /The shared directory .* is inside the reviewed tree/.test(error.message));
      await assert.rejects(box.run(box.claude({ access: 'edit', shared: join(box.checkpoint.root, 'claims') })), (error: unknown) => error instanceof InvalidInvocationError && /The shared directory .* is inside the checkpoint/.test(error.message));
      assert.deepEqual(Object.keys(box.checkpoint.fold(box.runId).workers), [], 'no worker launched');
    });

    it('judges containment by whole path segments, so a directory named ..tmp is inside', async () => {
      await assert.rejects(box.run(box.claude({ scratch: join(box.repo, '..tmp') })), /inside the reviewed tree/);
      await assert.rejects(box.run(box.claude({ scratch: join(box.checkpoint.root, '..scratch') })), /inside the checkpoint/);
      assert.equal(existsSync(join(box.repo, '..tmp')), false);
      // Beside the reviewed tree, not in it.
      const sibling = join(box.directory, '..tmp');
      const receipt = await box.run(box.claude({ scratch: sibling }));
      assert.equal(box.worker(receipt.workerId).launch.scratch, sibling);
    });

    it('refuses a scratch directory reached through a link into the reviewed tree or the checkpoint', async () => {
      // A junction needs no privilege on Windows; elsewhere the type is ignored and this is a symlink.
      const intoRepo = join(box.directory, 'repo-alias');
      const intoCheckpoint = join(box.directory, 'checkpoint-alias');
      symlinkSync(box.repo, intoRepo, 'junction');
      symlinkSync(box.checkpoint.root, intoCheckpoint, 'junction');
      await assert.rejects(box.run(box.claude({ scratch: join(intoRepo, 'tmp', 'deeper') })), /inside the reviewed tree/);
      await assert.rejects(box.run(box.claude({ scratch: intoRepo })), /inside the reviewed tree/);
      await assert.rejects(box.run(box.claude({ scratch: join(intoCheckpoint, 'scratch') })), /inside the checkpoint/);
      assert.equal(existsSync(join(box.repo, 'tmp')), false);
    });
  });

  describe('environment (R8)', () => {
    it('pins the temporary directory and the build servers, over every inherited spelling on Windows and the exact name elsewhere', async () => {
      const receipt = await box.run(box.claude(), { tmp: '/inherited', Temp: '/inherited', msbuilddisablenodereuse: '0', USESHAREDCOMPILATION: 'true', usesharedcompilation: 'true' });
      const scratch = box.scratchOf(receipt.workerId);
      const seen = box.recorded().environment;
      const spellings = (name: string): string[] => Object.keys(seen).filter((key) => key.toUpperCase() === name.toUpperCase()).sort();
      // On POSIX a name differing only in case is another variable, which the worker's programs never read for the pinned one.
      const expected = (pinned: string, variants: string[]): string[] => (process.platform === 'win32' ? [pinned] : [pinned, ...variants]).sort();
      assert.deepEqual(spellings('TMP'), expected('TMP', ['tmp']));
      assert.deepEqual(spellings('TEMP'), expected('TEMP', ['Temp']));
      assert.equal(seen.TMP, scratch);
      assert.deepEqual(spellings('MSBUILDDISABLENODEREUSE'), expected('MSBUILDDISABLENODEREUSE', ['msbuilddisablenodereuse']));
      assert.equal(seen.MSBUILDDISABLENODEREUSE, '1');
      assert.equal(seen.DOTNET_CLI_USE_MSBUILD_SERVER, '0');
      assert.deepEqual(spellings('UseSharedCompilation'), expected('UseSharedCompilation', ['USESHAREDCOMPILATION', 'usesharedcompilation']));
      assert.equal(seen.UseSharedCompilation, 'false');
      if (process.platform !== 'win32') assert.equal(seen.tmp, '/inherited');
      assert.equal(seen.UseRazorBuildServer, 'false');
      assert.equal(seen.CLAUDE_CODE_EFFORT_LEVEL, 'high');
      assert.equal(seen.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    });

    it('refuses an inherited thinking override by name before writing anything', async () => {
      await assert.rejects(box.run(box.claude(), { MAX_THINKING_TOKENS: '1024' }), (error: unknown) => error instanceof InheritedOverrideError && error.variable === 'MAX_THINKING_TOKENS');
      assert.ok(box.untouched());
    });

    it('refuses a thinking override spelled in another case only on Windows, where the worker would read it', async () => {
      const pending = box.run(box.claude(), { Max_Thinking_Tokens: '1024' });
      if (process.platform === 'win32') {
        await assert.rejects(pending, (error: unknown) => error instanceof InheritedOverrideError && error.variable === 'Max_Thinking_Tokens');
        assert.ok(box.untouched());
      } else {
        assert.equal((await pending).outcome, 'completed');
      }
    });

    it('pins the build servers for Codex too', async () => {
      await box.run(box.codex(), { MSBuildDisableNodeReuse: '0' });
      assert.equal(box.recorded().environment.MSBUILDDISABLENODEREUSE, '1');
    });
  });

  describe('a third runtime (R10)', () => {
    // Node itself behind an adapter nothing else knows: it echoes the first line of its prompt.
    const echo: RuntimeAdapter = {
      name: 'node-echo',
      capabilities: { assignsSessionId: true, budgetCap: false, denialEvidence: false, withholdShell: true, readOnlyScratch: true, effortLevels: ['low'], resume: false, costInUsd: false },
      qualification: { version: { args: ['--version'], pattern: /^v(\d+\.\d+\.\d+)$/ }, help: [{ args: ['--help'], flags: ['--eval'] }] },
      summarizeUsage: () => emptyUsageSummary,
      command: (_invocation, plan) => ({
        args: ['--eval', `const fs = process.getBuiltinModule('node:fs'); process.stdout.write(JSON.stringify({ session: ${JSON.stringify(plan.sessionId)}, answer: fs.readFileSync(0, 'utf8').split('\\n')[0] }))`],
        environment: plan.environment,
      }),
      decode: (_invocation, _plan, outputs) => {
        if (outputs.stdout === null) return { sessionIds: [], usage: null, denials: null, result: { kind: 'failed', error: 'stdout is too long to read whole' } };
        try {
          const parsed = JSON.parse(outputs.stdout) as { session: string; answer: string };
          return { sessionIds: [parsed.session], usage: null, denials: null, result: { kind: 'answer', value: { answer: parsed.answer } } };
        } catch (error) {
          return { sessionIds: [], usage: null, denials: null, result: { kind: 'failed', error: (error as Error).message } };
        }
      },
    };

    it('runs through the launcher unchanged once registered', async () => {
      const runtimes = new RuntimeRegistry([claudeAdapter, codexAdapter, echo]);
      const receipt = await box.run({ ...box.claude(), runtime: 'node-echo', executableArgs: [], effort: 'low', prompt: 'echoed' }, {}, { runtimes });
      assert.equal(receipt.outcome, 'completed', receipt.error ?? '');
      assert.deepEqual(receipt.output, { answer: 'echoed' });
      assert.equal(receipt.runtime.version, process.versions.node);
      assert.deepEqual(receipt.runtime.sessionIds, [box.worker(receipt.workerId).launch.sessionId]);
      assertEvidence(receipt);
    });

    it('records the pinned session for an adapter that reports none', async () => {
      const silent: RuntimeAdapter = { ...echo, name: 'node-silent', decode: (invocation, plan, outputs) => ({ ...echo.decode(invocation, plan, outputs), sessionIds: [] }) };
      const receipt = await box.run({ ...box.claude(), runtime: 'node-silent', executableArgs: [], effort: 'low', prompt: 'echoed' }, {}, { runtimes: new RuntimeRegistry([silent]) });
      assert.equal(receipt.outcome, 'completed', receipt.error ?? '');
      const worker = box.worker(receipt.workerId);
      assert.match(worker.launch.sessionId ?? '', uuid);
      assert.deepEqual(receipt.runtime.sessionIds, [worker.launch.sessionId]);
      assert.deepEqual(worker.status === 'finished' && worker.finish.sessionIds, [worker.launch.sessionId]);
    });

    it('fails a worker whose adapter throws from decode, naming the pinned session', async () => {
      const throwing: RuntimeAdapter = {
        ...claudeAdapter,
        name: 'claude-throwing',
        decode: () => {
          throw new Error('unexpected shape');
        },
      };
      const receipt = await box.run(box.claude({ runtime: 'claude-throwing' }), {}, { runtimes: new RuntimeRegistry([throwing]) });
      assert.equal(receipt.outcome, 'failed');
      assert.equal(receipt.error, "The claude-throwing adapter could not decode the worker's outputs: unexpected shape");
      assert.deepEqual(receipt.runtime.sessionIds, [box.worker(receipt.workerId).launch.sessionId]);
      assert.equal(receipt.denials, null);
      assertEvidence(receipt);
    });

    it('cuts a long error without splitting a character in two', async () => {
      const prefix = "The claude-throwing adapter could not decode the worker's outputs: ";
      const kept = 'a'.repeat(4000 - 1 - prefix.length);
      const throwing: RuntimeAdapter = {
        ...claudeAdapter,
        name: 'claude-throwing',
        decode: () => {
          // The emoji is two UTF-16 code units, the first of them the 4000th unit of the error.
          throw new Error(`${kept}\u{1F600}${'b'.repeat(100)}`);
        },
      };
      const receipt = await box.run(box.claude({ runtime: 'claude-throwing' }), {}, { runtimes: new RuntimeRegistry([throwing]) });
      assert.equal(receipt.error, `${prefix}${kept} [truncated]`);
      assert.ok(receipt.error.isWellFormed());
      const worker = box.worker(receipt.workerId);
      assert.equal(worker.status === 'finished' && worker.finish.error, receipt.error);
    });

    it('records no denials for a runtime whose capabilities say it has no evidence of them, whatever its decoder returns', async () => {
      const blind: RuntimeAdapter = { ...claudeAdapter, name: 'claude-blind', capabilities: { ...claudeAdapter.capabilities, denialEvidence: false } };
      const receipt = await box.run(box.claude({ runtime: 'claude-blind' }), { FAKE_DENIALS: JSON.stringify([{ tool_name: 'Bash', tool_input: { command: 'touch x' } }]) }, { runtimes: new RuntimeRegistry([blind]) });
      assert.equal(receipt.outcome, 'completed', receipt.error ?? '');
      assert.equal(receipt.denials, null);
      const worker = box.worker(receipt.workerId);
      assert.equal(worker.status === 'finished' && worker.finish.denials, null);
    });

    it('refuses to decode a Claude Code stdout above the decode cap, freezes it, and keeps the pinned session', async () => {
      const receipt = await box.run(box.claude(), { FAKE_HUGE: String(maxDecodeBytes + 1) });
      assert.equal(receipt.outcome, 'failed');
      assert.equal(receipt.error, `Claude Code printed more than the ${String(maxDecodeBytes)} bytes of stdout the launcher decodes as one result envelope; it is frozen as evidence`);
      assert.equal(receipt.evidence.stdout.bytes, maxDecodeBytes + 1);
      assert.deepEqual(receipt.runtime.sessionIds, [box.worker(receipt.workerId).launch.sessionId]);
      assertEvidence(receipt);
    });

    it('refuses to decode a final message above 16 MiB, freezes it, and keeps the session', async () => {
      const writer: RuntimeAdapter = {
        ...echo,
        name: 'node-final',
        command: (_invocation, plan) => ({
          args: [
            '--eval',
            `const fs = process.getBuiltinModule('node:fs'); fs.writeFileSync(${JSON.stringify(plan.finalMessageFile)}, 'x'.repeat(${String(maxDecodeBytes + 1)})); process.stdout.write(JSON.stringify({ session: ${JSON.stringify(plan.sessionId)}, answer: 'big' }))`,
          ],
          environment: plan.environment,
        }),
      };
      const receipt = await box.run({ ...box.claude(), runtime: 'node-final', executableArgs: [], effort: 'low' }, {}, { runtimes: new RuntimeRegistry([writer]) });
      assert.equal(receipt.outcome, 'failed');
      assert.match(receipt.error ?? '', new RegExp(`final message is ${String(maxDecodeBytes + 1)} bytes`));
      assert.equal(receipt.evidence.finalMessage?.bytes, maxDecodeBytes + 1);
      assert.deepEqual(receipt.runtime.sessionIds, [box.worker(receipt.workerId).launch.sessionId]);
      assertEvidence(receipt);
    });

    it('is unknown until registered', async () => {
      await assert.rejects(box.run({ ...box.claude(), runtime: 'node-echo' }), (error: unknown) => error instanceof UnknownRuntimeError && error.runtime === 'node-echo');
      assert.ok(box.untouched());
    });
  });

  describe('the run', () => {
    it('refuses a closed run and an unknown one', async () => {
      box.checkpoint.append(box.runId, 1, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'test' } }]);
      await assert.rejects(box.run(box.claude()), RunClosedError);
      await assert.rejects(runWorker(box.checkpoint, 'no-such-run', box.claude(), { environment: baseEnvironment }), UnknownRunError);
    });

    it('refuses a malformed invocation and a schema no runtime can take', async () => {
      await assert.rejects(box.run(box.claude({ timeoutMs: 10 })), InvalidInvocationError);
      await assert.rejects(box.run(box.claude({ outputSchema: z.array(z.string()) })), /object at its root/);
      await assert.rejects(box.run(box.codex({ outputSchema: z.strictObject({ answer: z.string(), note: z.string().optional() }) })), /leaves note optional/);
      assert.ok(box.untouched());
    });

    it('cannot finish a worker whose run was abandoned while it ran, and leaves its launch open', async () => {
      const marker = join(box.directory, 'go');
      const pending = box.run(box.claude(), { FAKE_WAIT_FOR: marker });
      await until(() => existsSync(box.recordFile), 'the fake to start');
      const state = box.checkpoint.fold(box.runId);
      box.checkpoint.append(box.runId, state.lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'operator stopped' } }]);
      writeFileSync(marker, '');
      await assert.rejects(pending, RunClosedError);
      assert.deepEqual(box.events().map(([kind]) => kind), ['run.created', 'worker.launched', 'run.abandoned']);
      assert.deepEqual(readdirSync(join(box.checkpoint.root, 'io')), [], 'the process files are frozen, so they go even without a finish');
    });

    it('launches nothing when the run closes between the checks and the launch, and leaves no process files', async () => {
      const closeRun = (): Promise<string> => {
        box.checkpoint.append(box.runId, box.checkpoint.fold(box.runId).lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'closed meanwhile' } }]);
        return Promise.resolve('2.1.283');
      };
      const workerId = '0b5c1a2e-3f4d-4a5b-8c6d-7e8f9a0b1c2d';
      await assert.rejects(box.run(box.claude(), {}, { qualify: closeRun, ids: fixedIds(workerId, '1c6d2b3f-4a5e-4b6c-9d7e-8f9a0b1c2d3e') }), RunClosedError);
      assert.deepEqual(box.events().map(([kind]) => kind), ['run.created', 'run.abandoned']);
      assert.deepEqual(readdirSync(join(box.checkpoint.root, 'io')), []);
      assert.equal(existsSync(box.scratchOf(workerId)), false, 'the scratch directory made for the worker is gone');
      assert.equal(existsSync(box.recordFile), false, 'the fake never ran');
    });

    it("launches nothing when its process files cannot be written, and leaves another worker's directory alone", async () => {
      const workerId = '2d7e3c4a-5b6f-4c7d-8e8f-9a0b1c2d3e4f';
      const occupied = join(box.checkpoint.root, 'io', workerId);
      mkdirSync(occupied, { recursive: true });
      writeFileSync(join(occupied, 'stdout'), 'not yours');
      await assert.rejects(box.run(box.claude(), {}, { ids: fixedIds(workerId, '3e8f4d5b-6c7a-4d8e-9f9a-0b1c2d3e4f5a') }), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST');
      assert.deepEqual(box.events().map(([kind]) => kind), ['run.created']);
      assert.equal(readFileSync(join(occupied, 'stdout'), 'utf8'), 'not yours');
      assert.equal(existsSync(box.scratchOf(workerId)), false);
      assert.equal(existsSync(box.recordFile), false, 'the fake never ran');
    });

    it('refuses a worktree that is gone', async () => {
      const other = box.checkpoint.createRun({ worktree: join(box.directory, 'gone') });
      await assert.rejects(runWorker(box.checkpoint, other.id, box.claude(), { environment: baseEnvironment }), /is not a directory/);
    });
  });

  describe('the platform a worker is built for', () => {
    /** The `windows.sandbox` settings on the command line the fake last recorded. */
    const windowsSandboxArgs = (): string[] => box.recorded().argv.filter((arg) => arg.startsWith('windows.sandbox='));

    it('builds the command for the platform it is given, whatever the host', async () => {
      await box.run(box.codex(), {}, { platform: 'linux' });
      assert.deepEqual(windowsSandboxArgs(), [], 'no Windows sandbox off Windows');
      await box.run(box.codex(), {}, { platform: 'win32' });
      assert.deepEqual(windowsSandboxArgs(), ['windows.sandbox="unelevated"'], "the adapter's default on Windows");
    });

    it('builds the environment for the platform it is given, whatever the host', async () => {
      // A backslash in the name, so the Windows spelling differs from the path on every host.
      const scratch = join(box.directory, 'given\\scratch');
      await box.run(box.claude({ scratch }), {}, { platform: 'linux' });
      assert.equal(box.recorded().environment.TMPDIR, scratch, 'a backslash is an ordinary character off Windows');
      await box.run(box.claude({ scratch }), {}, { platform: 'win32' });
      assert.equal(box.recorded().environment.TMPDIR, scratch.replaceAll('\\', '/'), "Git Bash's spelling on Windows");
    });
  });

  describe('the options a run pinned', () => {
    /** The `windows.sandbox` settings on the command line the fake last recorded. */
    const windowsSandboxArgs = (): string[] => box.recorded().argv.filter((arg) => arg.startsWith('windows.sandbox='));
    /** Each launch's runtime and the `runtimeOptions` its plan carried, in order. */
    let handed: [string, unknown][];
    const spying = (adapter: RuntimeAdapter, name = adapter.name): RuntimeAdapter => ({
      ...adapter,
      name,
      command: (invocation, plan) => {
        handed.push([name, plan.runtimeOptions]);
        return adapter.command(invocation, plan);
      },
    });
    beforeEach(() => {
      handed = [];
    });

    it('hands each adapter its own entry, by name, and null when there is none', async () => {
      const runtimes = new RuntimeRegistry([spying(claudeAdapter), spying(codexAdapter)]);
      const pinned = { codex: { windowsSandbox: 'elevated' } } as const;
      await box.run(box.codex(), {}, { runtimes, pinned, platform: 'win32' });
      await box.run(box.claude(), {}, { runtimes, pinned, platform: 'win32' });
      await box.run(box.codex(), {}, { runtimes, platform: 'win32' });
      assert.deepEqual(handed, [['codex', { windowsSandbox: 'elevated' }], ['claude', null], ['codex', null]]);
    });

    it('launches a Codex worker under the pinned sandbox over the one its adapter was built with', async () => {
      // The engine's default Codex adapter is built unelevated.
      await box.run(box.codex(), {}, { pinned: { codex: { windowsSandbox: 'elevated' } }, platform: 'win32' });
      assert.deepEqual(windowsSandboxArgs(), ['windows.sandbox="elevated"']);
      await box.run(box.codex(), {}, { pinned: {}, platform: 'win32' });
      assert.deepEqual(windowsSandboxArgs(), ['windows.sandbox="unelevated"'], 'the adapter\'s own when the run pins none');
    });

    it('hands nothing an object inherits to a runtime named after it', async () => {
      const runtimes = new RuntimeRegistry([spying(claudeAdapter, 'constructor')]);
      await box.run(box.claude({ runtime: 'constructor' }), {}, { runtimes, pinned: {} });
      assert.deepEqual(handed, [['constructor', null]]);
    });

    it('launches nothing when the adapter refuses its pinned entry', async () => {
      const pinned = { codex: { windowsSandbox: 'sandboxed' } } as unknown as { codex: { windowsSandbox: 'none' } };
      await assert.rejects(box.run(box.codex(), {}, { pinned, platform: 'win32' }), /Unknown pinned Codex Windows sandbox "sandboxed"/);
      assert.ok(box.untouched(), 'nothing recorded, frozen or created');
    });
  });
});

describe('workerVerdict', () => {
  const invocation = parseInvocation({
    runtime: 'claude',
    executable: process.execPath,
    model: 'fake-model',
    effort: 'high',
    access: 'read-only',
    shell: true,
    prompt: 'p',
    outputSchema: answerSchema,
    timeoutMs: 5000,
  });
  const at = '2026-09-27T00:00:00.000Z';
  const exited = (exitCode: number | null, signal: string | null = null): ProcessResult => ({ termination: 'exited', exitCode, signal, startedAt: at, endedAt: at });
  const killed = (treeKillError: string | null): ProcessResult => ({ termination: 'killed', exitCode: null, signal: 'SIGKILL', treeKillError, startedAt: at, endedAt: at });
  const answer = { kind: 'answer', value: { answer: 'ok' } } as const;

  it('says the whole tree was killed at the timeout when it was', () => {
    assert.deepEqual(workerVerdict(invocation, killed(null), answer), {
      outcome: 'timeout',
      error: 'The worker ran past its timeout of 5000 ms and was killed with its process tree',
      output: null,
    });
  });

  it('says only the root was killed at the timeout, and why, when the tree kill failed', () => {
    assert.deepEqual(workerVerdict(invocation, killed('taskkill could not end the process tree: it exited with code 1: Access is denied.'), answer), {
      outcome: 'timeout',
      error: 'The worker ran past its timeout of 5000 ms and was killed, but only its root: taskkill could not end the process tree: it exited with code 1: Access is denied.; descendants may still run',
      output: null,
    });
  });

  it('fails a worker that never started, whatever was decoded', () => {
    assert.deepEqual(workerVerdict(invocation, notStarted('spawn ENOENT', at, at), answer), { outcome: 'failed', error: 'The worker did not start: spawn ENOENT', output: null });
  });

  it('reports a budget stop as budget even when the exit was not clean', () => {
    assert.deepEqual(workerVerdict(invocation, exited(1), { kind: 'budget', error: 'spent' }), { outcome: 'budget', error: 'spent', output: null });
  });

  it('fails with the runtime\'s own reason before the exit code', () => {
    assert.deepEqual(workerVerdict(invocation, exited(2), { kind: 'failed', error: 'no envelope' }), { outcome: 'failed', error: 'no envelope', output: null });
    assert.deepEqual(workerVerdict(invocation, exited(0), { kind: 'failed', error: 'no envelope' }), { outcome: 'failed', error: 'no envelope', output: null });
  });

  it('fails an answer from a process that did not exit cleanly', () => {
    assert.deepEqual(workerVerdict(invocation, exited(3), answer), { outcome: 'failed', error: 'The worker exited with code 3', output: null });
    assert.deepEqual(workerVerdict(invocation, exited(null, 'SIGTERM'), answer), { outcome: 'failed', error: 'The worker was ended by signal SIGTERM', output: null });
  });

  it('completes with the validated answer, and fails one the schema rejects', () => {
    assert.deepEqual(workerVerdict(invocation, exited(0), answer), { outcome: 'completed', error: null, output: { answer: 'ok' } });
    const rejected = workerVerdict(invocation, exited(0), { kind: 'answer', value: { answer: 42 } });
    assert.equal(rejected.outcome, 'failed');
    assert.match(rejected.error ?? '', /^The answer does not match the output schema: /);
  });
});

describe('withUnrecordableSessions', () => {
  const note = 'the runtime reported session ids the ledger cannot hold: ["not a session id"]';

  it('leaves a verdict alone when every session id can be recorded', () => {
    const completed: Verdict = { outcome: 'completed', error: null, output: { answer: 'ok' } };
    assert.equal(withUnrecordableSessions(completed, []), completed);
  });

  it('records no answer when a session id cannot be recorded', () => {
    assert.deepEqual(withUnrecordableSessions({ outcome: 'completed', error: null, output: { answer: 'ok' } }, ['not a session id']), {
      outcome: 'failed',
      error: `The answer is not recorded because ${note}`,
      output: null,
    });
  });

  it('keeps any other outcome and adds the ids to its reason', () => {
    assert.deepEqual(withUnrecordableSessions({ outcome: 'timeout', error: 'ran past its timeout', output: null }, ['not a session id']), {
      outcome: 'timeout',
      error: `ran past its timeout; ${note}`,
      output: null,
    });
    assert.deepEqual(withUnrecordableSessions({ outcome: 'budget', error: 'spent', output: null }, ['not a session id']), { outcome: 'budget', error: `spent; ${note}`, output: null });
  });

  it('cuts a long list of ids to 500 characters', () => {
    const ids = Array.from({ length: 100 }, (_, index) => `bad id ${String(index)}`);
    const { error } = withUnrecordableSessions({ outcome: 'failed', error: 'no envelope', output: null }, ids);
    assert.equal(error, `no envelope; the runtime reported session ids the ledger cannot hold: ${JSON.stringify(ids).slice(0, 500)}`);
  });
});

describe('withPinnedSession', () => {
  it('puts the pinned session first and names every session once', () => {
    assert.deepEqual(withPinnedSession(null, []), []);
    assert.deepEqual(withPinnedSession('pinned', []), ['pinned']);
    assert.deepEqual(withPinnedSession('pinned', ['pinned']), ['pinned']);
    assert.deepEqual(withPinnedSession('pinned', ['other', 'pinned', 'other']), ['pinned', 'other']);
    assert.deepEqual(withPinnedSession(null, ['a', 'a', 'b']), ['a', 'b']);
  });
});

describe('hermeticEnvironment', () => {
  it('drops every CLAUDE variable the shell or an enclosing session sets, any spelling, so the Claude fake records only what the test gives it', () => {
    const shell = { CLAUDE_PLUGIN_ROOT: '/plugin', CLAUDE_JOB_DIR: '/job', claude_config_dir: '/config', CLAUDECODE: '1', PATH: '/bin' };
    for (const platform of ['win32', 'linux'] as const) assert.deepEqual(hermeticEnvironment(shell, platform), { PATH: '/bin' }, platform);
  });

  it('still drops the fakes\' steering and the thinking overrides, and keeps everything else', () => {
    const shell = { FAKE_OUTPUT: '{}', fake_hang: '1', MAX_THINKING_TOKENS: '1024', HOME: '/home', ANTHROPIC_BASE_URL: 'https://gateway.invalid' };
    assert.deepEqual(hermeticEnvironment(shell, 'linux'), { HOME: '/home', ANTHROPIC_BASE_URL: 'https://gateway.invalid' });
    assert.deepEqual(hermeticEnvironment({}, 'linux'), {});
  });

  it('leaves no CLAUDE variable of this process in the base environment', () => {
    assert.deepEqual(Object.keys(baseEnvironment).filter((name) => name.toUpperCase().startsWith('CLAUDE')), []);
  });
});
