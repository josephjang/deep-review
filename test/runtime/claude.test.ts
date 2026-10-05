import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { z } from 'zod';
import { maxDecodeBytes, outputLines, type Decoded, type LaunchPlan } from '../../src/runtime/adapter.ts';
import {
  claudeAdapter,
  claudeCommand,
  claudeCredentialSettings,
  claudeEnvironment,
  claudeFlags,
  claudeSessionMarkers,
  claudeTools,
  createClaudeAdapter,
  posixArgumentLimit,
  refuseOversizedCommandLine,
  thinkingOverrides,
  truncateDetail,
  windowsArgumentLength,
  windowsCommandLineLimit,
  type ClaudeSettings,
} from '../../src/runtime/claude.ts';
import { compileOutputSchema, parseInvocation, type Invocation, type InvocationInput } from '../../src/runtime/contract.ts';
import { launcherPins } from '../../src/runtime/environment.ts';
import { InheritedOverrideError, InvalidInvocationError } from '../../src/runtime/errors.ts';
import { defaultRuntimes } from '../../src/runtime/runtimes.ts';
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

describe('Claude settings option', () => {
  const settingsOf = (args: readonly string[]): unknown => JSON.parse(args[args.indexOf('--settings') + 1]!);
  const credentials = { apiKeyHelper: '/k', env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' } };

  it('keeps the --settings value byte for byte when built without options', () => {
    for (const adapter of [createClaudeAdapter(), createClaudeAdapter({}), createClaudeAdapter({ settings: {} }), defaultRuntimes().get('claude')]) {
      const args = adapter.command(invocation(), plan()).args;
      assert.equal(args[args.indexOf('--settings') + 1], '{"autoMemoryEnabled":false,"claudeMdExcludes":["**"]}');
      assert.deepEqual(args, claudeAdapter.command(invocation(), plan()).args);
    }
  });

  it('merges the settings into --settings for a fresh worker and a continuation, and changes nothing else', () => {
    const adapter = createClaudeAdapter({ settings: credentials });
    const expected = { apiKeyHelper: '/k', env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' }, autoMemoryEnabled: false, claudeMdExcludes: ['**'] };
    for (const [change, planChange] of [[{}, {}], [{ resume: session }, { resume: session }]] as const) {
      const args = adapter.command(invocation(change), plan(planChange)).args;
      assert.deepEqual(settingsOf(args), expected);
      const without = claudeAdapter.command(invocation(change), plan(planChange)).args;
      const at = args.indexOf('--settings') + 1;
      assert.deepEqual([...args.slice(0, at), ...args.slice(at + 1)], [...without.slice(0, at), ...without.slice(at + 1)]);
    }
  });

  it('takes every credential helper Claude Code has', () => {
    const every = Object.fromEntries(claudeCredentialSettings.map((key) => [key, `/bin/${key}`]));
    assert.deepEqual(claudeCredentialSettings, ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'proxyAuthHelper']);
    assert.deepEqual(settingsOf(createClaudeAdapter({ settings: every }).command(invocation(), plan()).args), { ...every, autoMemoryEnabled: false, claudeMdExcludes: ['**'] });
  });

  it('lets the keys that switch sources off win over a settings key of the same name', () => {
    const overlapping = { autoMemoryEnabled: true, claudeMdExcludes: [] } as unknown as ClaudeSettings;
    const merged = settingsOf(claudeCommand(invocation(), plan(), overlapping).args);
    assert.deepEqual(merged, { autoMemoryEnabled: false, claudeMdExcludes: ['**'] });
  });

  it('refuses a setting that is not a credential helper or env, naming it', () => {
    for (const key of ['hooks', 'permissions', 'enabledPlugins', 'otelHeadersHelper', 'autoMemoryEnabled', 'claudeMdExcludes', 'model']) {
      assert.throws(
        () => createClaudeAdapter({ settings: { [key]: 'x' } as never }),
        new RegExp(`Claude settings have unknown key "${key}"; a Claude adapter takes only apiKeyHelper, awsAuthRefresh, awsCredentialExport, gcpAuthRefresh, proxyAuthHelper, env`),
        key,
      );
    }
  });

  it('refuses options and settings of the wrong shape', () => {
    assert.throws(() => createClaudeAdapter({ setting: {} } as never), /Unknown Claude option "setting"; use settings/);
    assert.throws(() => createClaudeAdapter(null as never), /Claude options must be an object/);
    assert.throws(() => createClaudeAdapter({ settings: [] as never }), /Claude settings must be an object/);
    for (const value of ['', '  ', 3, '\uD800']) {
      assert.throws(() => createClaudeAdapter({ settings: { apiKeyHelper: value as string } }), /apiKeyHelper must be a non-empty string/, String(value));
    }
    assert.throws(() => createClaudeAdapter({ settings: { env: ['A=1'] as never } }), /env must be an object of strings/);
    assert.throws(() => createClaudeAdapter({ settings: { env: { A: 1 } as never } }), /env value of A is not a string/);
    assert.throws(() => createClaudeAdapter({ settings: { env: { A: 'a\0b' } } }), /env value of A is not a string/);
    for (const name of ['', 'A=B', 'A\0B']) {
      assert.throws(() => createClaudeAdapter({ settings: { env: { [name]: '1' } } }), /env has a name .* no environment can hold/, JSON.stringify(name));
    }
  });

  it('keeps the settings it was built with when the caller changes its object later', () => {
    const env: Record<string, string> = { ANTHROPIC_BASE_URL: 'https://a.example' };
    const given = { apiKeyHelper: '/k', env };
    const adapter = createClaudeAdapter({ settings: given });
    given.apiKeyHelper = '/other';
    env.ANTHROPIC_BASE_URL = 'https://b.example';
    env.MAX_THINKING_TOKENS = '1';
    assert.deepEqual(settingsOf(adapter.command(invocation(), plan()).args), { apiKeyHelper: '/k', env: { ANTHROPIC_BASE_URL: 'https://a.example' }, autoMemoryEnabled: false, claudeMdExcludes: ['**'] });
  });

  const reserved = [...thinkingOverrides, 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', ...claudeSessionMarkers, ...launcherPins];

  it('refuses a settings env name the engine pins or drops by its exact name on every platform', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      for (const name of reserved) {
        const adapter = createClaudeAdapter({ settings: { env: { HOME: '/h', [name]: '1' } } });
        assert.throws(() => adapter.command(invocation(), plan({ platform })), new RegExp(`Claude settings env sets ${name}, which the engine decides for every worker`), `${platform} ${name}`);
      }
    }
  });

  it('refuses any spelling of a reserved name on Windows and leaves another spelling alone on POSIX', () => {
    for (const name of reserved) {
      const spelled = name === name.toLowerCase() ? name.toUpperCase() : name.toLowerCase();
      const adapter = createClaudeAdapter({ settings: { env: { [spelled]: '1' } } });
      assert.throws(() => adapter.command(invocation(), plan({ platform: 'win32' })), new RegExp(`env sets ${spelled},`), spelled);
      for (const platform of ['linux', 'darwin'] as const) {
        assert.deepEqual(settingsOf(adapter.command(invocation(), plan({ platform })).args), { env: { [spelled]: '1' }, autoMemoryEnabled: false, claudeMdExcludes: ['**'] }, spelled);
      }
    }
  });

  it('counts the settings toward the command-line limit and names them as the remedy', () => {
    const large = createClaudeAdapter({ settings: { apiKeyHelper: 'k'.repeat(posixArgumentLimit) } });
    assert.throws(
      () => large.command(invocation(), plan({ platform: 'linux' })),
      (error: unknown) => error instanceof InvalidInvocationError && /the value of --settings is \d+ bytes.*the adapter's settings are passed on the command line/.test(error.message),
    );
    const wide = createClaudeAdapter({ settings: { apiKeyHelper: 'k'.repeat(windowsCommandLineLimit) } });
    assert.throws(() => wide.command(invocation(), plan({ platform: 'win32' })), /Windows allows; the compiled output schema and the adapter's settings/);
    assert.doesNotThrow(() => createClaudeAdapter({ settings: { apiKeyHelper: 'k'.repeat(1000) } }).command(invocation(), plan({ platform: 'win32' })));
  });

  it('is chosen through the default runtimes, beside the Codex options', () => {
    const runtimes = defaultRuntimes({ claude: { settings: credentials }, codex: { windowsSandbox: 'elevated' } });
    assert.deepEqual(settingsOf(runtimes.get('claude').command(invocation(), plan()).args), { ...credentials, autoMemoryEnabled: false, claudeMdExcludes: ['**'] });
    assert.ok(runtimes.get('codex').command({ ...invocation(), runtime: 'codex', effort: 'high' }, plan({ platform: 'win32' })).args.includes('windows.sandbox="elevated"'));
    assert.throws(() => defaultRuntimes({ claude: { settings: { hooks: {} } as never } }), /unknown key "hooks"/);
  });

  it('ignores the options a plan pins, since a run pins nothing for Claude Code', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const own = claudeAdapter.command(invocation(), plan({ platform }));
      for (const runtimeOptions of [null, { windowsSandbox: 'elevated' }, 'anything']) assert.deepEqual(claudeAdapter.command(invocation(), plan({ platform, runtimeOptions })), own, platform);
    }
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

/** A schema whose compiled text is past every platform's limit for one argument. */
const hugeSchema = z.strictObject(Object.fromEntries(Array.from({ length: 3000 }, (_, index) => [`field_${index}_${'x'.repeat(40)}`, z.string()])));

describe('Claude Code command-line limit', () => {
  it('measures an argument as libuv quotes it for Windows', () => {
    assert.equal(windowsArgumentLength(''), 2);
    assert.equal(windowsArgumentLength('abc'), 3);
    assert.equal(windowsArgumentLength('a\\b'), 3, 'a backslash alone needs no quoting');
    assert.equal(windowsArgumentLength('a b'), 5);
    assert.equal(windowsArgumentLength('a\tb'), 5);
    assert.equal(windowsArgumentLength('a"b'), 6);
    assert.equal(windowsArgumentLength('a\\b c'), 7, 'a backslash before an ordinary character stays single');
    assert.equal(windowsArgumentLength('a b\\'), 7, 'a trailing backslash is doubled before the closing quote');
    assert.equal(windowsArgumentLength('a\\"b'), 8, 'a backslash before a quote is doubled and the quote escaped');
    assert.equal(windowsArgumentLength('{"a":"b"}'), 15);
  });

  it('agrees with Windows at the exact limit', { skip: process.platform !== 'win32' }, () => {
    // Quotes, spaces and backslash runs before a quote and at the end, so every quoting rule counts.
    const pattern = ' {"a\\\\":"b c\\"} \\\\';
    const argvAt = (length: number): string[] => {
      const fixed = [process.execPath, '-e', '0', pattern].reduce((total, argument) => total + windowsArgumentLength(argument), 3);
      return [process.execPath, '-e', '0', 'a'.repeat(length - fixed) + pattern];
    };
    const spawned = (argv: readonly string[]): string => {
      const [executable = '', ...rest] = argv;
      const result = spawnSync(executable, rest, { windowsHide: true });
      return result.error === undefined ? `exit ${String(result.status)}` : ((result.error as NodeJS.ErrnoException).code ?? 'error');
    };
    const atLimit = argvAt(windowsCommandLineLimit);
    const overLimit = argvAt(windowsCommandLineLimit + 1);
    assert.equal(spawned(atLimit), 'exit 0');
    assert.equal(spawned(overLimit), 'ENAMETOOLONG');
    assert.doesNotThrow(() => {
      refuseOversizedCommandLine('win32', atLimit);
    });
    assert.throws(() => {
      refuseOversizedCommandLine('win32', overLimit);
    }, InvalidInvocationError);
  });

  it('holds a POSIX argument to its byte length, not its character count', () => {
    assert.doesNotThrow(() => {
      refuseOversizedCommandLine('linux', ['/bin/claude', '--json-schema', 'a'.repeat(posixArgumentLimit)]);
    });
    assert.throws(
      () => {
        refuseOversizedCommandLine('darwin', ['/bin/claude', '--json-schema', 'a'.repeat(posixArgumentLimit + 1)]);
      },
      (error: unknown) => error instanceof InvalidInvocationError && /the value of --json-schema is 131072 bytes, over the 131071/.test(error.message),
    );
    const accented = 'é'.repeat(Math.ceil((posixArgumentLimit + 1) / 2));
    assert.ok(accented.length < posixArgumentLimit);
    assert.throws(() => {
      refuseOversizedCommandLine('linux', ['/bin/claude', '--json-schema', accented]);
    }, InvalidInvocationError);
  });

  it('refuses a schema too large for a Windows command line and accepts it elsewhere', () => {
    const large = z.strictObject(Object.fromEntries(Array.from({ length: 800 }, (_, index) => [`field_${index}_${'x'.repeat(20)}`, z.string()])));
    const text = compileOutputSchema(large).text;
    const largePlan = (platform: NodeJS.Platform): LaunchPlan => plan({ platform, schema: compileOutputSchema(large) });
    assert.ok(text.length > windowsCommandLineLimit);
    assert.ok(Buffer.byteLength(text, 'utf8') <= posixArgumentLimit);
    assert.throws(() => claudeAdapter.command(invocation({ outputSchema: large }), largePlan('win32')), /over the 32766 Windows allows; the compiled output schema/);
    assert.equal(claudeAdapter.command(invocation({ outputSchema: large }), largePlan('linux')).args.at(-1), text);
    assert.doesNotThrow(() => claudeAdapter.command(invocation(), plan({ platform: 'win32' })));
  });

  it('counts the executable and its own arguments toward the Windows limit', () => {
    const args = claudeAdapter.command(invocation(), plan({ platform: 'win32' })).args;
    const used = args.reduce((total, argument) => total + windowsArgumentLength(argument), args.length);
    const room = windowsCommandLineLimit - used - windowsArgumentLength(resolve('/bin/claude'));
    // One more argument filling the room left, less its separating space, fits; one character more does not.
    assert.doesNotThrow(() => claudeAdapter.command(invocation({ executableArgs: ['a'.repeat(room - 1)] }), plan({ platform: 'win32' })));
    assert.throws(() => claudeAdapter.command(invocation({ executableArgs: ['a'.repeat(room)] }), plan({ platform: 'win32' })), InvalidInvocationError);
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

  it('refuses an oversized command line before anything is recorded or run', async () => {
    await assert.rejects(box.run(box.claude({ outputSchema: hugeSchema })), InvalidInvocationError);
    assert.ok(box.untouched());
  });

  it('hands the adapter settings to the worker it starts, fresh and continued', async () => {
    const settings = { apiKeyHelper: '/bin/key', env: { ANTHROPIC_BASE_URL: 'https://gateway.invalid' } };
    const runtimes = defaultRuntimes({ claude: { settings } });
    const expected = { ...settings, autoMemoryEnabled: false, claudeMdExcludes: ['**'] };
    const settingsOf = (argv: readonly string[]): unknown => JSON.parse(argv[argv.indexOf('--settings') + 1]!);
    const first = await box.run(box.claude(), {}, { runtimes });
    assert.equal(first.outcome, 'completed', first.error ?? '');
    assert.deepEqual(settingsOf(box.recorded().argv), expected);
    const second = await box.run(box.claude({ resume: first.runtime.sessionIds[0]! }), {}, { runtimes });
    assert.equal(second.outcome, 'completed', second.error ?? '');
    assert.ok(box.recorded().argv.includes('--resume'));
    assert.deepEqual(settingsOf(box.recorded().argv), expected);
  });

  it('refuses settings that set a pinned variable before anything is recorded or run', async () => {
    const runtimes = defaultRuntimes({ claude: { settings: { env: { CLAUDE_CODE_EFFORT_LEVEL: 'max' } } } });
    await assert.rejects(box.run(box.claude(), {}, { runtimes }), /Claude settings env sets CLAUDE_CODE_EFFORT_LEVEL/);
    assert.ok(box.untouched());
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
