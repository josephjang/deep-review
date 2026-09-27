import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { z } from 'zod';
import { Checkpoint } from '../../src/checkpoint/checkpoint.ts';
import { RunClosedError, UnknownRunError } from '../../src/checkpoint/errors.ts';
import { locateCheckpoint } from '../../src/checkpoint/locate.ts';
import { collectArtifactReferences } from '../../src/evidence/references.ts';
import type { RuntimeAdapter } from '../../src/runtime/adapter.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { codexAdapter } from '../../src/runtime/codex.ts';
import { InheritedOverrideError, InvalidInvocationError, UnknownRuntimeError, UnsupportedCapabilityError } from '../../src/runtime/errors.ts';
import { maxDecodeBytes, runWorker, type WorkerReceipt } from '../../src/runtime/launcher.ts';
import { RuntimeRegistry } from '../../src/runtime/registry.ts';
import { baseEnvironment, freshThread, isAlive, LauncherSandbox, until } from '../helpers/launcher.ts';
import { createRepository } from '../helpers/repository.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
      const receipt = await box.run(box.claude({ timeoutMs: 1500 }), { FAKE_HANG: pidFile });
      assert.equal(receipt.outcome, 'timeout');
      assert.equal(receipt.process.termination, 'killed');
      assert.match(receipt.error ?? '', /timeout of 1500 ms/);
      assert.deepEqual(receipt.runtime.sessionIds, [box.worker(receipt.workerId).launch.sessionId]);
      const grandchild = Number(readFileSync(pidFile, 'utf8'));
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

    it('kills the worker and its process tree at the timeout', async () => {
      const pidFile = join(box.directory, 'grandchild.pid');
      const receipt = await box.run(box.codex({ timeoutMs: 1500 }), { FAKE_HANG: pidFile });
      assert.equal(receipt.outcome, 'timeout');
      assert.equal(receipt.process.termination, 'killed');
      assert.deepEqual(receipt.runtime.sessionIds, []);
      assert.equal(receipt.evidence.finalMessage, null);
      const grandchild = Number(readFileSync(pidFile, 'utf8'));
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

    it('refuses to decode a stream above 16 MiB and still freezes it', async () => {
      const receipt = await box.run(box.codex(), { FAKE_HUGE: String(maxDecodeBytes + 1) });
      assert.equal(receipt.outcome, 'failed');
      assert.match(receipt.error ?? '', new RegExp(`stdout is ${String(maxDecodeBytes + 1)} bytes, above the ${String(maxDecodeBytes)}`));
      assert.equal(receipt.evidence.stdout.bytes, maxDecodeBytes + 1);
      box.checkpoint.evidence.verify(receipt.evidence.stdout);
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
      assert.equal(recorded.environment.TMPDIR, scratch.replaceAll('\\', '/'));
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
          return path === '' || (!path.startsWith('..') && !isAbsolute(path));
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
  });

  describe('environment (R8)', () => {
    it('pins the temporary directory and the build servers over every inherited spelling', async () => {
      const receipt = await box.run(box.claude(), { tmp: '/inherited', Temp: '/inherited', msbuilddisablenodereuse: '0', USESHAREDCOMPILATION: 'true', usesharedcompilation: 'true' });
      const scratch = box.scratchOf(receipt.workerId);
      const seen = box.recorded().environment;
      const spellings = (name: string): string[] => Object.keys(seen).filter((key) => key.toUpperCase() === name.toUpperCase());
      assert.deepEqual(spellings('TMP'), ['TMP']);
      assert.deepEqual(spellings('TEMP'), ['TEMP']);
      assert.equal(seen.TMP, scratch);
      assert.deepEqual(spellings('MSBUILDDISABLENODEREUSE'), ['MSBUILDDISABLENODEREUSE']);
      assert.equal(seen.MSBUILDDISABLENODEREUSE, '1');
      assert.equal(seen.DOTNET_CLI_USE_MSBUILD_SERVER, '0');
      assert.deepEqual(spellings('UseSharedCompilation'), ['UseSharedCompilation']);
      assert.equal(seen.UseSharedCompilation, 'false');
      assert.equal(seen.UseRazorBuildServer, 'false');
      assert.equal(seen.CLAUDE_CODE_EFFORT_LEVEL, 'high');
      assert.equal(seen.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    });

    it('refuses an inherited thinking override by name before writing anything', async () => {
      await assert.rejects(box.run(box.claude(), { Max_Thinking_Tokens: '1024' }), (error: unknown) => error instanceof InheritedOverrideError && error.variable === 'Max_Thinking_Tokens');
      assert.ok(box.untouched());
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
      capabilities: { assignsSessionId: true, budgetCap: false, denialEvidence: false, withholdShell: true, readOnlyScratch: true, effortLevels: ['low'], resume: false },
      qualification: { version: { args: ['--version'], pattern: /^v(\d+\.\d+\.\d+)$/ }, help: [{ args: ['--help'], flags: ['--eval'] }] },
      command: (_invocation, plan) => ({
        args: ['--eval', `const fs = process.getBuiltinModule('node:fs'); process.stdout.write(JSON.stringify({ session: ${JSON.stringify(plan.sessionId)}, answer: fs.readFileSync(0, 'utf8').split('\\n')[0] }))`],
        environment: plan.environment,
      }),
      decode: (_invocation, plan, outputs) => {
        try {
          const parsed = JSON.parse(outputs.stdout) as { session: string; answer: string };
          return { sessionIds: [parsed.session], usage: null, denials: null, answer: { value: { answer: parsed.answer } }, budgetStop: false, error: null };
        } catch (error) {
          return { sessionIds: plan.sessionId === null ? [] : [plan.sessionId], usage: null, denials: null, answer: null, budgetStop: false, error: (error as Error).message };
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
    });

    it('launches nothing when the run closes between the checks and the launch, and leaves no process files', async () => {
      const closeRun = (): Promise<string> => {
        box.checkpoint.append(box.runId, box.checkpoint.fold(box.runId).lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'closed meanwhile' } }]);
        return Promise.resolve('2.1.283');
      };
      await assert.rejects(box.run(box.claude(), {}, { qualify: closeRun }), RunClosedError);
      assert.deepEqual(box.events().map(([kind]) => kind), ['run.created', 'run.abandoned']);
      assert.deepEqual(readdirSync(join(box.checkpoint.root, 'io')), []);
      assert.equal(existsSync(box.recordFile), false, 'the fake never ran');
    });

    it('refuses a worktree that is gone', async () => {
      const other = box.checkpoint.createRun({ worktree: join(box.directory, 'gone') });
      await assert.rejects(runWorker(box.checkpoint, other.id, box.claude(), { environment: baseEnvironment }), /is not a directory/);
    });
  });
});
