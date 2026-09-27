import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { z } from 'zod';
import { maxDecodeBytes, outputLines, type Decoded, type LaunchPlan } from '../../src/runtime/adapter.ts';
import { claudeAdapter, claudeEnvironment, claudeFlags, claudeSessionMarkers, claudeTools, thinkingOverrides, truncateDetail } from '../../src/runtime/claude.ts';
import { compileOutputSchema, parseInvocation, type Invocation, type InvocationInput } from '../../src/runtime/contract.ts';
import { InheritedOverrideError } from '../../src/runtime/errors.ts';
import { LauncherSandbox } from '../helpers/launcher.ts';
import { textOutputs } from '../helpers/outputs.ts';

const session = '11111111-2222-4333-8444-555555555555';
const schema = z.strictObject({ answer: z.string() });
const compiled = compileOutputSchema(schema);
const settings = JSON.stringify({ autoMemoryEnabled: false, claudeMdExcludes: ['**'] });

const invocation = (change: Partial<InvocationInput> = {}): Invocation =>
  parseInvocation({
    runtime: 'claude',
    executable: resolve('/bin/claude'),
    model: 'sonnet',
    effort: 'high',
    access: 'read-only',
    shell: true,
    prompt: 'p',
    outputSchema: schema,
    timeoutMs: 60_000,
    ...change,
  });

const plan = (change: Partial<LaunchPlan> = {}): LaunchPlan => ({
  sessionId: session,
  resume: null,
  scratch: resolve('/checkpoint/scratch/w'),
  schema: compiled,
  schemaFile: resolve('/checkpoint/io/w/schema.json'),
  finalMessageFile: resolve('/checkpoint/io/w/final-message'),
  platform: 'linux',
  environment: {},
  ...change,
});

const tail = (tools: string): string[] => [
  '--tools', tools,
  '--allowedTools', tools,
  '--permission-mode', 'dontAsk',
  '--disable-slash-commands',
  '--strict-mcp-config',
  '--setting-sources', '',
  '--settings', settings,
  '--json-schema', compiled.text,
];

describe('claudeTools', () => {
  it('maps the two permission axes to tool names', () => {
    assert.deepEqual(claudeTools('read-only', false), ['Read', 'Glob', 'Grep']);
    assert.deepEqual(claudeTools('read-only', true), ['Read', 'Glob', 'Grep', 'Bash']);
    assert.deepEqual(claudeTools('edit', false), ['Read', 'Glob', 'Grep', 'Edit', 'Write']);
    assert.deepEqual(claudeTools('edit', true), ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write']);
  });
});

describe('claude command', () => {
  it('builds a read-only worker with a shell and a scratch directory', () => {
    assert.deepEqual(claudeAdapter.command(invocation(), plan()).args, [
      '--print', '--output-format', 'json', '--model', 'sonnet', '--effort', 'high',
      '--session-id', session,
      '--add-dir', resolve('/checkpoint/scratch/w'),
      ...tail('Read,Glob,Grep,Bash'),
    ]);
  });

  it('builds an editor with a budget and no shell', () => {
    assert.deepEqual(claudeAdapter.command(invocation({ access: 'edit', shell: false, budgetUsd: 2.5, effort: 'max' }), plan()).args, [
      '--print', '--output-format', 'json', '--model', 'sonnet', '--effort', 'max',
      '--session-id', session,
      '--add-dir', resolve('/checkpoint/scratch/w'),
      '--max-budget-usd', '2.5',
      ...tail('Read,Glob,Grep,Edit,Write'),
    ]);
  });

  it('leaves out the scratch directory when the worker has none', () => {
    const args = claudeAdapter.command(invocation(), plan({ scratch: null })).args;
    assert.equal(args.includes('--add-dir'), false);
  });

  it('continues a session with --resume and the same permission and schema flags', () => {
    const fresh = claudeAdapter.command(invocation(), plan()).args;
    const continued = claudeAdapter.command(invocation({ resume: session }), plan({ resume: session })).args;
    assert.deepEqual(continued.slice(0, 9), ['--print', '--output-format', 'json', '--model', 'sonnet', '--effort', 'high', '--resume', session]);
    assert.equal(continued.includes('--session-id'), false);
    assert.deepEqual(continued.slice(9), fresh.slice(9));
  });

  it('refuses to build a command without a session id', () => {
    assert.throws(() => claudeAdapter.command(invocation(), plan({ sessionId: null })), /session id before launch/);
  });

  it('uses no flag the preflight does not check', () => {
    const variants = [
      claudeAdapter.command(invocation({ access: 'edit', budgetUsd: 1 }), plan()),
      claudeAdapter.command(invocation({ resume: session }), plan({ resume: session })),
    ];
    const used = new Set(variants.flatMap((command) => command.args.filter((arg) => arg.startsWith('--'))));
    assert.deepEqual([...used].sort(), [...claudeFlags].sort());
    assert.deepEqual(claudeAdapter.qualification.help, [{ args: ['--help'], flags: claudeFlags }]);
  });
});

describe('claudeEnvironment', () => {
  it('pins the effort and auto memory over every inherited spelling on Windows and keeps the rest', () => {
    const environment = claudeEnvironment({ claude_code_effort_level: 'low', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0', HOME: '/h', ANTHROPIC_API_KEY: 'k' }, 'xhigh', 'win32');
    assert.deepEqual(environment, { HOME: '/h', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_EFFORT_LEVEL: 'xhigh', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  });

  it('pins the exact names on POSIX, where a variable spelled otherwise is another variable', () => {
    const environment = claudeEnvironment({ claude_code_effort_level: 'low', CLAUDE_CODE_EFFORT_LEVEL: 'max', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0', HOME: '/h' }, 'xhigh', 'linux');
    assert.deepEqual(environment, { claude_code_effort_level: 'low', HOME: '/h', CLAUDE_CODE_EFFORT_LEVEL: 'xhigh', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  });

  it('refuses an inherited thinking override on Windows by any spelling, naming the one it was given', () => {
    for (const name of ['MAX_THINKING_TOKENS', 'max_thinking_tokens', 'Claude_Code_Disable_Thinking', 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING', ...thinkingOverrides]) {
      assert.throws(() => claudeEnvironment({ [name]: '1' }, 'high', 'win32'), (error: unknown) => error instanceof InheritedOverrideError && error.variable === name, name);
    }
  });

  it('refuses an inherited thinking override on POSIX by its exact name only, since Claude Code reads no other', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      for (const name of thinkingOverrides) {
        assert.throws(() => claudeEnvironment({ [name]: '1' }, 'high', platform), (error: unknown) => error instanceof InheritedOverrideError && error.variable === name, name);
      }
      const variants = { max_thinking_tokens: '1', Claude_Code_Disable_Thinking: '1', HOME: '/h' };
      assert.deepEqual(claudeEnvironment(variants, 'high', platform), { ...variants, CLAUDE_CODE_EFFORT_LEVEL: 'high', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    }
  });

  it('drops an empty thinking override instead of refusing it', () => {
    for (const platform of ['win32', 'linux'] as const) {
      assert.deepEqual(claudeEnvironment({ MAX_THINKING_TOKENS: '  ', HOME: '/h' }, 'low', platform), { HOME: '/h', CLAUDE_CODE_EFFORT_LEVEL: 'low', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    }
  });

  it('drops every spelling of an enclosing Claude Code session\'s markers on Windows and keeps the provider and credentials', () => {
    const markers = Object.fromEntries(claudeSessionMarkers.map((name, index) => [index % 2 === 0 ? name : name.toLowerCase(), '1']));
    const kept = { HOME: '/h', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://gateway.invalid', CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'p' };
    assert.deepEqual(claudeEnvironment({ ...markers, ...kept }, 'high', 'win32'), { ...kept, CLAUDE_CODE_EFFORT_LEVEL: 'high', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  });

  it('drops the exact session markers on POSIX and keeps a variable that only differs in case', () => {
    const markers = Object.fromEntries(claudeSessionMarkers.map((name) => [name, '1']));
    const kept = { HOME: '/h', claudecode: 'mine', ANTHROPIC_API_KEY: 'k' };
    assert.deepEqual(claudeEnvironment({ ...markers, ...kept }, 'high', 'linux'), { ...kept, CLAUDE_CODE_EFFORT_LEVEL: 'high', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  });

  it('is what the command runs with, on the plan\'s platform', () => {
    assert.throws(() => claudeAdapter.command(invocation(), plan({ environment: { MAX_THINKING_TOKENS: '9000' } })), InheritedOverrideError);
    assert.throws(() => claudeAdapter.command(invocation(), plan({ platform: 'win32', environment: { Max_Thinking_Tokens: '9000' } })), InheritedOverrideError);
    assert.equal(claudeAdapter.command(invocation(), plan({ platform: 'linux', environment: { Max_Thinking_Tokens: '9000' } })).environment.Max_Thinking_Tokens, '9000');
    assert.equal(claudeAdapter.command(invocation({ effort: 'low' }), plan({ environment: { A: 'b' } })).environment.CLAUDE_CODE_EFFORT_LEVEL, 'low');
  });
});

describe('claude decode', () => {
  const envelope = (change: Record<string, unknown> = {}): string =>
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: session,
      structured_output: { answer: 'ok' },
      permission_denials: [],
      usage: { input_tokens: 3 },
      modelUsage: { sonnet: {} },
      total_cost_usd: 0.01,
      ...change,
    });
  const decode = (stdout: string, change: Partial<InvocationInput> = {}, planChange: Partial<LaunchPlan> = {}): Decoded =>
    claudeAdapter.decode(invocation(change), plan(planChange), textOutputs(stdout));
  /** The error of a failed result; an answer or a budget stop fails the assertion. */
  const failure = (decoded: Decoded): string => {
    assert.equal(decoded.result.kind, 'failed');
    return decoded.result.kind === 'failed' ? decoded.result.error : '';
  };

  it('reads a successful envelope with its usage and an empty denial list', () => {
    assert.deepEqual(decode(envelope()), {
      sessionIds: [session],
      usage: { usage: { input_tokens: 3 }, modelUsage: { sonnet: {} }, total_cost_usd: 0.01 },
      denials: [],
      result: { kind: 'answer', value: { answer: 'ok' } },
    });
  });

  it('lists denials by tool and detail without changing the answer', () => {
    const decoded = decode(envelope({
      permission_denials: [
        { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } },
        { tool_name: 'Write', tool_input: { file_path: '/x/y' } },
        { tool_name: 'WebFetch', tool_input: { url: 'https://e.invalid' } },
        { tool_name: 'Glob', tool_input: {} },
        { tool_input: { path: 'p'.repeat(400) } },
        { tool_name: 'Read', tool_input: { file_path: `${'q'.repeat(299)}\u{1F600}` } },
        null,
        ['Bash', { command: 'ls' }],
        { tool_name: 'Bash', tool_input: ['ls'] },
        'Bash',
      ],
    }));
    assert.deepEqual(decoded.denials, [
      { tool: 'Bash', detail: 'rm -rf build' },
      { tool: 'Write', detail: '/x/y' },
      { tool: 'WebFetch', detail: 'https://e.invalid' },
      { tool: 'Glob', detail: null },
      { tool: 'unknown tool', detail: 'p'.repeat(300) },
      { tool: 'Read', detail: 'q'.repeat(299) },
      { tool: 'unknown tool', detail: null },
      // An entry or input that is an array or a bare value has no named members to read.
      { tool: 'unknown tool', detail: null },
      { tool: 'Bash', detail: null },
      { tool: 'unknown tool', detail: null },
    ]);
    assert.deepEqual(decoded.result, { kind: 'answer', value: { answer: 'ok' } });
  });

  it('fails an envelope without a denial list, since nothing then proves there were none', () => {
    const decoded = decode(envelope({ permission_denials: undefined }));
    assert.match(failure(decoded), /no permission_denials array/);
    assert.equal(decoded.denials, null);
  });

  it('fails an answer from a session other than the pinned one and reports the id it observed', () => {
    const other = '99999999-2222-4333-8444-555555555555';
    const decoded = decode(envelope({ session_id: other }));
    assert.match(failure(decoded), new RegExp(`answered from session ${other}, not ${session}`));
    // The pinned id is the launcher's to add; the decoder names only what the envelope said.
    assert.deepEqual(decoded.sessionIds, [other]);
    const unnamed = decode(envelope({ session_id: undefined }));
    assert.match(failure(unnamed), /answered from session null/);
    assert.deepEqual(unnamed.sessionIds, []);
  });

  it('reports a budget stop by terminal reason or subtype, not as a malformed result', () => {
    for (const change of [{ terminal_reason: 'budget_exhausted', subtype: 'error_during_execution' }, { subtype: 'error_max_budget_usd', is_error: true }]) {
      const decoded = decode(envelope({ ...change, result: 'spent', structured_output: undefined }), { budgetUsd: 0.5 });
      assert.equal(decoded.result.kind, 'budget');
      assert.match(decoded.result.kind === 'budget' ? decoded.result.error : '', /stopped at its budget of 0.5 USD: spent/);
      assert.deepEqual(decoded.denials, []);
      assert.deepEqual(decoded.sessionIds, [session]);
    }
  });

  it('fails an error result, naming its subtype and text', () => {
    const decoded = decode(envelope({ subtype: 'error_during_execution', is_error: true, result: 'boom' }));
    assert.match(failure(decoded), /result\/error_during_execution with is_error true: boom/);
  });

  it('fails a success without structured output', () => {
    assert.match(failure(decode(envelope({ structured_output: undefined }))), /no structured_output/);
  });

  it('keeps a null structured output as the answer for the schema to judge', () => {
    assert.deepEqual(decode(envelope({ structured_output: null })).result, { kind: 'answer', value: null });
  });

  it('reports no session, usage or denials when there is no envelope or it is not an object', () => {
    for (const [stdout, pattern] of [['', /printed no result envelope/], ['  \n', /printed no result envelope/], ['{"type":', /not JSON/], ['[1]', /not an object/], ['null', /not an object/], ['"text"', /not an object/]] as const) {
      const decoded = decode(stdout);
      assert.match(failure(decoded), pattern);
      assert.deepEqual(decoded.sessionIds, []);
      assert.equal(decoded.usage, null);
      assert.equal(decoded.denials, null);
    }
  });

  it('fails a stdout above the decode cap by name, since the envelope is read whole, even when its lines hold one', () => {
    // The launcher hands over no text above the cap; a complete envelope in the lines is not read.
    const outputs = { stdout: null, stdoutLines: outputLines(Buffer.from(envelope())), stderr: '', finalMessage: null };
    const decoded = claudeAdapter.decode(invocation(), plan(), outputs);
    assert.equal(failure(decoded), `Claude Code printed more than the ${String(maxDecodeBytes)} bytes of stdout the launcher decodes as one result envelope; it is frozen as evidence`);
    assert.deepEqual(decoded.sessionIds, []);
    assert.equal(decoded.usage, null);
    assert.equal(decoded.denials, null);
  });

  it('expects the resumed session on a continuation', () => {
    const resumed = '22222222-2222-4333-8444-555555555555';
    const decoded = decode(envelope({ session_id: resumed }), { resume: resumed }, { sessionId: resumed, resume: resumed });
    assert.equal(decoded.result.kind, 'answer');
    assert.deepEqual(decoded.sessionIds, [resumed]);
  });
});

describe('Claude Code worker through the launcher', () => {
  let box: LauncherSandbox;
  beforeEach(() => {
    box = new LauncherSandbox();
  });
  afterEach(() => {
    box.close();
  });

  it('starts the worker without the markers of the Claude Code session the engine runs in', async () => {
    const seen = join(box.directory, 'claude-env.json');
    const markers = Object.fromEntries(claudeSessionMarkers.map((name) => [name, 'parent']));
    const receipt = await box.run(box.claude({ effort: 'low' }), { ...markers, CLAUDE_CODE_USE_BEDROCK: '1', FAKE_CLAUDE_ENV: seen });
    assert.equal(receipt.outcome, 'completed');
    assert.deepEqual(JSON.parse(readFileSync(seen, 'utf8')), { CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_EFFORT_LEVEL: 'low', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  });
});

describe('truncateDetail', () => {
  it('keeps a detail at or under the limit as it is', () => {
    assert.equal(truncateDetail(''), '');
    assert.equal(truncateDetail('a'.repeat(300)), 'a'.repeat(300));
    assert.equal(truncateDetail(`${'a'.repeat(298)}\u{1F600}`), `${'a'.repeat(298)}\u{1F600}`);
  });

  it('cuts before a surrogate pair the limit would split', () => {
    const cut = truncateDetail(`${'a'.repeat(299)}\u{1F600}tail`);
    assert.equal(cut, 'a'.repeat(299));
    assert.ok(cut.isWellFormed());
    assert.equal(truncateDetail(`${'a'.repeat(298)}\u{1F600}tail`), `${'a'.repeat(298)}\u{1F600}`);
  });

  it('replaces a lone surrogate the runtime sent', () => {
    assert.equal(truncateDetail('a\uD83Db'), 'a�b');
    assert.equal(truncateDetail(`${'a'.repeat(299)}\uDE00`), `${'a'.repeat(299)}�`);
  });
});
