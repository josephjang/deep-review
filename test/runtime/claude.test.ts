import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import type { LaunchPlan } from '../../src/runtime/adapter.ts';
import { claudeAdapter, claudeEnvironment, claudeFlags, claudeTools } from '../../src/runtime/claude.ts';
import { compileOutputSchema, parseInvocation, type Invocation, type InvocationInput } from '../../src/runtime/contract.ts';
import { InheritedOverrideError } from '../../src/runtime/errors.ts';

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
  it('pins the effort and auto memory over every inherited spelling and keeps the rest', () => {
    const environment = claudeEnvironment({ claude_code_effort_level: 'low', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0', HOME: '/h', ANTHROPIC_API_KEY: 'k' }, 'xhigh');
    assert.deepEqual(environment, { HOME: '/h', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_EFFORT_LEVEL: 'xhigh', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  });

  it('refuses an inherited thinking override by the name it was given', () => {
    for (const name of ['MAX_THINKING_TOKENS', 'max_thinking_tokens', 'Claude_Code_Disable_Thinking', 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING']) {
      assert.throws(() => claudeEnvironment({ [name]: '1' }, 'high'), (error: unknown) => error instanceof InheritedOverrideError && error.variable === name, name);
    }
  });

  it('drops an empty thinking override instead of refusing it', () => {
    assert.deepEqual(claudeEnvironment({ MAX_THINKING_TOKENS: '  ', HOME: '/h' }, 'low'), { HOME: '/h', CLAUDE_CODE_EFFORT_LEVEL: 'low', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  });

  it('is what the command runs with', () => {
    assert.throws(() => claudeAdapter.command(invocation(), plan({ environment: { MAX_THINKING_TOKENS: '9000' } })), InheritedOverrideError);
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
  const decode = (stdout: string, change: Partial<InvocationInput> = {}, planChange: Partial<LaunchPlan> = {}): ReturnType<typeof claudeAdapter.decode> =>
    claudeAdapter.decode(invocation(change), plan(planChange), { stdout, stderr: '', finalMessage: null });

  it('reads a successful envelope with its usage and an empty denial list', () => {
    assert.deepEqual(decode(envelope()), {
      sessionIds: [session],
      usage: { usage: { input_tokens: 3 }, modelUsage: { sonnet: {} }, total_cost_usd: 0.01 },
      denials: [],
      answer: { value: { answer: 'ok' } },
      budgetStop: false,
      error: null,
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
        null,
      ],
    }));
    assert.deepEqual(decoded.denials, [
      { tool: 'Bash', detail: 'rm -rf build' },
      { tool: 'Write', detail: '/x/y' },
      { tool: 'WebFetch', detail: 'https://e.invalid' },
      { tool: 'Glob', detail: null },
      { tool: 'unknown tool', detail: 'p'.repeat(300) },
      { tool: 'unknown tool', detail: null },
    ]);
    assert.deepEqual(decoded.answer, { value: { answer: 'ok' } });
    assert.equal(decoded.error, null);
  });

  it('fails an envelope without a denial list, since nothing then proves there were none', () => {
    const decoded = decode(envelope({ permission_denials: undefined }));
    assert.match(decoded.error ?? '', /no permission_denials array/);
    assert.equal(decoded.denials, null);
    assert.equal(decoded.answer, null);
  });

  it('fails an answer from a session other than the pinned one and keeps both ids', () => {
    const other = '99999999-2222-4333-8444-555555555555';
    const decoded = decode(envelope({ session_id: other }));
    assert.match(decoded.error ?? '', new RegExp(`answered from session ${other}, not ${session}`));
    assert.deepEqual(decoded.sessionIds, [session, other]);
    assert.equal(decoded.answer, null);
    assert.match(decode(envelope({ session_id: undefined })).error ?? '', /answered from session null/);
  });

  it('reports a budget stop by terminal reason or subtype, not as a malformed result', () => {
    for (const change of [{ terminal_reason: 'budget_exhausted', subtype: 'error_during_execution' }, { subtype: 'error_max_budget_usd', is_error: true }]) {
      const decoded = decode(envelope({ ...change, result: 'spent', structured_output: undefined }), { budgetUsd: 0.5 });
      assert.equal(decoded.budgetStop, true);
      assert.match(decoded.error ?? '', /stopped at its budget of 0.5 USD: spent/);
      assert.deepEqual(decoded.denials, []);
      assert.equal(decoded.answer, null);
    }
  });

  it('fails an error result, naming its subtype and text', () => {
    const decoded = decode(envelope({ subtype: 'error_during_execution', is_error: true, result: 'boom' }));
    assert.match(decoded.error ?? '', /result\/error_during_execution with is_error true: boom/);
    assert.equal(decoded.budgetStop, false);
  });

  it('fails a success without structured output', () => {
    assert.match(decode(envelope({ structured_output: undefined })).error ?? '', /no structured_output/);
  });

  it('keeps a null structured output as the answer for the schema to judge', () => {
    assert.deepEqual(decode(envelope({ structured_output: null })).answer, { value: null });
  });

  it('keeps the pinned session when there is no envelope or it is not an object', () => {
    for (const [stdout, pattern] of [['', /printed no result envelope/], ['  \n', /printed no result envelope/], ['{"type":', /not JSON/], ['[1]', /not an object/], ['null', /not an object/]] as const) {
      const decoded = decode(stdout);
      assert.match(decoded.error ?? '', pattern);
      assert.deepEqual(decoded.sessionIds, [session]);
      assert.equal(decoded.usage, null);
    }
  });

  it('expects the resumed session on a continuation', () => {
    const resumed = '22222222-2222-4333-8444-555555555555';
    const decoded = decode(envelope({ session_id: resumed }), { resume: resumed }, { sessionId: resumed, resume: resumed });
    assert.equal(decoded.error, null);
    assert.deepEqual(decoded.sessionIds, [resumed]);
  });
});
