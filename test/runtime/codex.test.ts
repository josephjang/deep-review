import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { maxLineBytes, type Decoded, type LaunchPlan } from '../../src/runtime/adapter.ts';
import { codexAdapter, codexEnvironment, codexFlags, createCodexAdapter, tomlString, type CodexProvider } from '../../src/runtime/codex.ts';
import { defaultRuntimes } from '../../src/runtime/runtimes.ts';
import { textOutputs } from '../helpers/outputs.ts';
import { compileOutputSchema, parseInvocation, type Invocation, type InvocationInput } from '../../src/runtime/contract.ts';

const thread = '0199a3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b';
const schema = z.strictObject({ answer: z.string() });
const compiled = compileOutputSchema(schema);
const schemaFile = resolve('/checkpoint/io/w/schema.json');
const finalMessageFile = resolve('/checkpoint/io/w/final-message');
const scratch = resolve('/checkpoint/scratch/w');

const invocation = (change: Partial<InvocationInput> = {}): Invocation =>
  parseInvocation({
    runtime: 'codex',
    executable: resolve('/bin/codex'),
    model: 'gpt-5.5',
    effort: 'high',
    access: 'read-only',
    shell: true,
    prompt: 'p',
    outputSchema: schema,
    timeoutMs: 60_000,
    ...change,
  });

const plan = (change: Partial<LaunchPlan> = {}): LaunchPlan => ({
  sessionId: null,
  resume: null,
  scratch: null,
  schema: compiled,
  schemaFile,
  finalMessageFile,
  platform: 'linux',
  environment: {},
  ...change,
});

const isolation = [
  '--config', 'project_doc_max_bytes=0',
  '--config', 'skills.include_instructions=false',
  '--config', 'web_search="disabled"',
  '--config', 'features.apps=false',
  '--config', 'features.plugins=false',
  '--config', 'features.remote_plugin=false',
  '--config', 'features.skill_search=false',
  '--config', 'features.skill_mcp_dependency_install=false',
];
const tail = (effort: string): string[] => [
  '--model', 'gpt-5.5',
  '--config', `model_reasoning_effort="${effort}"`,
  '--json',
  '--output-schema', schemaFile,
  '--output-last-message', finalMessageFile,
];

describe('codex command', () => {
  it('builds a read-only worker in a read-only sandbox with no scratch directory', () => {
    assert.deepEqual(codexAdapter.command(invocation(), plan()).args, [
      '--ask-for-approval', 'never', 'exec',
      '--ignore-user-config', '--strict-config', '--ignore-rules', '--skip-git-repo-check',
      '--config', 'sandbox_mode="read-only"',
      ...isolation,
      ...tail('high'),
      '-',
    ]);
  });

  it('never gives a read-only worker a writable root, even when handed a scratch directory', () => {
    const args = codexAdapter.command(invocation(), plan({ scratch })).args;
    assert.equal(args.some((arg) => arg.includes('writable_roots')), false);
  });

  it('builds an editor in a workspace-write sandbox with the scratch directory writable, on Windows unelevated', () => {
    assert.deepEqual(codexAdapter.command(invocation({ access: 'edit', effort: 'xhigh' }), plan({ scratch, platform: 'win32' })).args, [
      '--ask-for-approval', 'never', 'exec',
      '--ignore-user-config', '--strict-config', '--ignore-rules', '--skip-git-repo-check',
      '--config', 'sandbox_mode="workspace-write"',
      '--config', `sandbox_workspace_write.writable_roots=[${JSON.stringify(scratch)}]`,
      '--config', 'windows.sandbox="unelevated"',
      ...isolation,
      ...tail('xhigh'),
      '-',
    ]);
  });

  it('writes a Windows scratch path as a valid TOML string', () => {
    const args = codexAdapter.command(invocation({ access: 'edit' }), plan({ scratch: 'C:\\repo\\.git\\deep-review-checkpoint\\scratch\\w "q"' })).args;
    assert.ok(args.includes('sandbox_workspace_write.writable_roots=["C:\\\\repo\\\\.git\\\\deep-review-checkpoint\\\\scratch\\\\w \\"q\\""]'));
  });

  it('continues a session with exec resume, the same flags, and the session just before stdin', () => {
    const fresh = codexAdapter.command(invocation({ access: 'edit' }), plan({ scratch })).args;
    const continued = codexAdapter.command(invocation({ access: 'edit', resume: thread }), plan({ scratch, sessionId: thread, resume: thread })).args;
    assert.deepEqual(continued.slice(0, 4), ['--ask-for-approval', 'never', 'exec', 'resume']);
    assert.deepEqual(continued.slice(-2), [thread, '-']);
    assert.deepEqual(continued.slice(4, -2), fresh.slice(3, -1));
  });

  it('makes Codex refuse a config key it does not know, fresh and continued, so a renamed isolation key cannot lapse unnoticed', () => {
    const fresh = codexAdapter.command(invocation(), plan()).args;
    const continued = codexAdapter.command(invocation({ resume: thread }), plan({ sessionId: thread, resume: thread })).args;
    for (const args of [fresh, continued]) assert.ok(args.includes('--strict-config'), args.join(' '));
    for (const probe of codexAdapter.qualification.help.slice(1)) assert.ok(probe.flags.includes('--strict-config'), probe.args.join(' '));
  });

  it('uses no flag the preflight does not check, and checks resume separately', () => {
    const variants = [
      codexAdapter.command(invocation({ access: 'edit' }), plan({ scratch, platform: 'win32' })),
      codexAdapter.command(invocation({ resume: thread }), plan({ sessionId: thread, resume: thread })),
    ];
    const used = new Set(variants.flatMap((command) => command.args.filter((arg) => arg.startsWith('--'))));
    assert.deepEqual([...used].sort(), [...codexFlags].sort());
    const probes = codexAdapter.qualification.help;
    assert.deepEqual(probes.map((probe) => probe.args), [['--help'], ['exec', '--help'], ['exec', 'resume', '--help']]);
    assert.deepEqual(probes[0]!.flags, ['--ask-for-approval']);
    assert.deepEqual(probes[1]!.flags, probes[2]!.flags);
  });
});

describe('Windows sandbox option', () => {
  const sandboxOf = (args: readonly string[]): string[] => args.filter((arg) => arg.startsWith('windows.sandbox='));

  it('runs unelevated unless told otherwise', () => {
    assert.deepEqual(sandboxOf(codexAdapter.command(invocation(), plan({ platform: 'win32' })).args), ['windows.sandbox="unelevated"']);
    assert.deepEqual(sandboxOf(createCodexAdapter().command(invocation(), plan({ platform: 'win32' })).args), ['windows.sandbox="unelevated"']);
  });

  it('runs elevated when built so, fresh and continued, and only on Windows', () => {
    const elevated = createCodexAdapter({ windowsSandbox: 'elevated' });
    assert.deepEqual(sandboxOf(elevated.command(invocation(), plan({ platform: 'win32' })).args), ['windows.sandbox="elevated"']);
    assert.deepEqual(sandboxOf(elevated.command(invocation({ resume: thread }), plan({ platform: 'win32', sessionId: thread, resume: thread })).args), ['windows.sandbox="elevated"']);
    assert.deepEqual(sandboxOf(elevated.command(invocation(), plan({ platform: 'darwin' })).args), []);
  });

  it('changes nothing else about the adapter', () => {
    const elevated = createCodexAdapter({ windowsSandbox: 'elevated' });
    assert.equal(elevated.name, codexAdapter.name);
    assert.deepEqual(elevated.capabilities, codexAdapter.capabilities);
    assert.deepEqual(elevated.qualification, codexAdapter.qualification);
    const strip = (args: readonly string[]): string[] => args.filter((arg) => !arg.startsWith('windows.sandbox='));
    assert.deepEqual(strip(elevated.command(invocation(), plan({ platform: 'win32' })).args), strip(codexAdapter.command(invocation(), plan({ platform: 'win32' })).args));
  });

  it('refuses a sandbox Codex does not have, naming the three it does', () => {
    assert.throws(() => createCodexAdapter({ windowsSandbox: 'full-access' as never }), /Unknown Codex Windows sandbox "full-access"; use unelevated, elevated, none$/);
    assert.throws(() => createCodexAdapter({ windowsSandbox: '' as never }), /Unknown Codex Windows sandbox ""/);
  });

  describe('none', () => {
    const none = createCodexAdapter({ windowsSandbox: 'none' });
    const modeOf = (args: readonly string[]): string[] => args.filter((arg) => arg.startsWith('sandbox_mode=') || arg.startsWith('sandbox_workspace_write.'));

    it('runs an editor on Windows in no sandbox, with no writable root, fresh and continued', () => {
      const fresh = none.command(invocation({ access: 'edit' }), plan({ scratch, platform: 'win32' })).args;
      const continued = none.command(invocation({ access: 'edit', resume: thread }), plan({ scratch, platform: 'win32', sessionId: thread, resume: thread })).args;
      for (const args of [fresh, continued]) {
        assert.deepEqual(modeOf(args), ['sandbox_mode="danger-full-access"']);
        assert.deepEqual(sandboxOf(args), ['windows.sandbox="unelevated"']);
      }
    });

    it('keeps a reader on Windows read-only under the unelevated sandbox, which needs no setup', () => {
      const args = none.command(invocation(), plan({ scratch, platform: 'win32' })).args;
      assert.deepEqual(modeOf(args), ['sandbox_mode="read-only"']);
      assert.deepEqual(sandboxOf(args), ['windows.sandbox="unelevated"']);
      assert.deepEqual(args, codexAdapter.command(invocation(), plan({ scratch, platform: 'win32' })).args, 'a reader runs exactly as under unelevated');
    });

    it('changes nothing on another platform: an editor stays in its workspace-write sandbox', () => {
      for (const platform of ['linux', 'darwin'] as const) {
        const editor = invocation({ access: 'edit' });
        assert.deepEqual(none.command(editor, plan({ scratch, platform })).args, codexAdapter.command(editor, plan({ scratch, platform })).args, platform);
        assert.deepEqual(modeOf(none.command(editor, plan({ scratch, platform })).args), ['sandbox_mode="workspace-write"', `sandbox_workspace_write.writable_roots=[${JSON.stringify(scratch)}]`]);
      }
    });

    it('leaves the environment as unelevated does, WindowsApps dropped even for the unsandboxed editor', () => {
      const environment = { PATH: 'C:\\Windows;C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps', HOME: 'h' };
      for (const access of ['edit', 'read-only'] as const) {
        assert.deepEqual(none.command(invocation({ access }), plan({ scratch, platform: 'win32', environment })).environment, { HOME: 'h', PATH: 'C:\\Windows' }, access);
      }
    });
  });

  it('is chosen through the default runtimes', () => {
    const codex = defaultRuntimes({ codex: { windowsSandbox: 'elevated' } }).get('codex');
    assert.deepEqual(sandboxOf(codex.command(invocation(), plan({ platform: 'win32' })).args), ['windows.sandbox="elevated"']);
    assert.deepEqual(sandboxOf(defaultRuntimes().get('codex').command(invocation(), plan({ platform: 'win32' })).args), ['windows.sandbox="unelevated"']);
    assert.deepEqual(defaultRuntimes().names(), ['claude', 'codex']);
  });
});

describe('Codex provider option', () => {
  const azure: CodexProvider = {
    id: 'azure-east_2',
    baseUrl: 'https://example.openai.azure.com/openai',
    envKey: 'AZURE_OPENAI_API_KEY',
    queryParams: { 'api-version': '2025-04-01-preview' },
  };
  const azureConfig = [
    '--config', 'model_provider="azure-east_2"',
    '--config', 'model_providers.azure-east_2.name="azure-east_2"',
    '--config', 'model_providers.azure-east_2.base_url="https://example.openai.azure.com/openai"',
    '--config', 'model_providers.azure-east_2.env_key="AZURE_OPENAI_API_KEY"',
    '--config', 'model_providers.azure-east_2.query_params={"api-version"="2025-04-01-preview"}',
  ];
  const providerArgs = (args: readonly string[]): string[] => args.filter((arg) => arg.startsWith('model_provider'));

  it('chooses the provider after the isolation config for a fresh worker', () => {
    assert.deepEqual(createCodexAdapter({ provider: azure }).command(invocation(), plan()).args, [
      '--ask-for-approval', 'never', 'exec',
      '--ignore-user-config', '--strict-config', '--ignore-rules', '--skip-git-repo-check',
      '--config', 'sandbox_mode="read-only"',
      ...isolation,
      ...azureConfig,
      ...tail('high'),
      '-',
    ]);
  });

  it('chooses the same provider for a continuation', () => {
    const adapter = createCodexAdapter({ provider: azure });
    const fresh = adapter.command(invocation({ access: 'edit' }), plan({ scratch, platform: 'win32' })).args;
    const continued = adapter.command(invocation({ access: 'edit', resume: thread }), plan({ scratch, platform: 'win32', sessionId: thread, resume: thread })).args;
    assert.deepEqual(continued.slice(0, 4), ['--ask-for-approval', 'never', 'exec', 'resume']);
    assert.deepEqual(continued.slice(4, -2), fresh.slice(3, -1));
    assert.deepEqual(providerArgs(continued), azureConfig.filter((arg) => arg !== '--config'));
  });

  it('writes only the entries a provider has', () => {
    const minimal = createCodexAdapter({ provider: { id: 'gateway', baseUrl: 'http://127.0.0.1:8080/v1' } });
    assert.deepEqual(providerArgs(minimal.command(invocation(), plan()).args), [
      'model_provider="gateway"',
      'model_providers.gateway.name="gateway"',
      'model_providers.gateway.base_url="http://127.0.0.1:8080/v1"',
    ]);
    assert.deepEqual(providerArgs(createCodexAdapter({ provider: { ...azure, queryParams: {} } }).command(invocation(), plan()).args).at(-1), 'model_providers.azure-east_2.query_params={}');
  });

  it('chooses no provider by default, so Codex uses its built-in one', () => {
    assert.deepEqual(providerArgs(codexAdapter.command(invocation(), plan()).args), []);
    assert.deepEqual(providerArgs(createCodexAdapter({ windowsSandbox: 'elevated' }).command(invocation(), plan()).args), []);
  });

  it('writes odd values as TOML strings Codex reads back as given', () => {
    const odd = createCodexAdapter({
      provider: { id: 'odd', baseUrl: 'https://h.example/p?x="y"&z=\\', queryParams: { 'a"b c': 'q\\r\n\t\u007f\u2028\u{1F600}', plain: '' } },
    });
    assert.deepEqual(providerArgs(odd.command(invocation(), plan()).args).slice(2), [
      'model_providers.odd.base_url="https://h.example/p?x=\\"y\\"&z=\\\\"',
      'model_providers.odd.query_params={"a\\"b c"="q\\\\r\\n\\t\\u007F\u2028\u{1F600}","plain"=""}',
    ]);
  });

  it('keeps the provider it was built with when the caller changes its object later', () => {
    const queryParams: Record<string, string> = { 'api-version': '1' };
    const provider = { id: 'later', baseUrl: 'https://a.example', queryParams };
    const adapter = createCodexAdapter({ provider });
    provider.baseUrl = 'https://b.example';
    queryParams['api-version'] = '2';
    assert.deepEqual(providerArgs(adapter.command(invocation(), plan()).args).slice(2), [
      'model_providers.later.base_url="https://a.example"',
      'model_providers.later.query_params={"api-version"="1"}',
    ]);
  });

  it('refuses options it does not know, naming the key', () => {
    assert.throws(() => createCodexAdapter({ sandbox: 'elevated' } as never), /Unknown Codex option "sandbox"; use windowsSandbox or provider/);
    assert.throws(() => createCodexAdapter(null as never), /Codex options must be an object/);
    assert.throws(() => createCodexAdapter({ provider: { ...azure, wireApi: 'chat' } as never }), /Codex provider has unknown key "wireApi"/);
    assert.throws(() => createCodexAdapter({ provider: 'azure' as never }), /Codex provider must be an object/);
  });

  it('refuses an id that is not a bare TOML key of lowercase letters, digits, _ and -', () => {
    for (const id of ['', 'Azure', 'a.b', 'a b', 'a"b', 'é', 7]) {
      assert.throws(() => createCodexAdapter({ provider: { ...azure, id: id as string } }), /Codex provider id .* is not lowercase letters, digits, _ and -/, String(id));
    }
  });

  it('refuses a baseUrl that is not an http or https URL, or that carries credentials', () => {
    assert.throws(() => createCodexAdapter({ provider: { ...azure, baseUrl: 'not a url' } }), /baseUrl "not a url" is not a URL/);
    assert.throws(() => createCodexAdapter({ provider: { ...azure, baseUrl: 'ftp://h.example' } }), /baseUrl "ftp:\/\/h.example" is not http or https/);
    assert.throws(() => createCodexAdapter({ provider: { ...azure, baseUrl: 'file:///etc/passwd' } }), /is not http or https/);
    assert.throws(() => createCodexAdapter({ provider: { ...azure, baseUrl: 'https://user:secret@h.example' } }), /carries a user name or password/);
    assert.throws(() => createCodexAdapter({ provider: { ...azure, baseUrl: 'https://user@h.example' } }), /carries a user name or password/);
    assert.throws(() => createCodexAdapter({ provider: { ...azure, baseUrl: 'https://h.example/\uD800' } }), /is not a string/);
    assert.throws(() => createCodexAdapter({ provider: { ...azure, baseUrl: undefined as never } }), /baseUrl undefined is not a string/);
  });

  it('refuses an envKey that is not an environment variable name', () => {
    for (const envKey of ['', '1KEY', 'A-B', 'A B', 'KEY=1', 5]) {
      assert.throws(() => createCodexAdapter({ provider: { ...azure, envKey: envKey as string } }), /envKey .* is not an environment variable name/, String(envKey));
    }
  });

  it('refuses queryParams that are not an object of strings', () => {
    assert.throws(() => createCodexAdapter({ provider: { ...azure, queryParams: ['a'] as never } }), /queryParams must be an object of strings/);
    assert.throws(() => createCodexAdapter({ provider: { ...azure, queryParams: { a: 1 } as never } }), /queryParams value of "a" is not a string/);
    assert.throws(() => createCodexAdapter({ provider: { ...azure, queryParams: { a: '\uDC00' } } }), /queryParams value of "a" is not a string/);
    assert.throws(() => createCodexAdapter({ provider: { ...azure, queryParams: { '': 'x' } } }), /queryParams has a name "" that is empty/);
  });

  it('is chosen through the default runtimes', () => {
    const codex = defaultRuntimes({ codex: { provider: azure } }).get('codex');
    assert.deepEqual(providerArgs(codex.command(invocation(), plan()).args), azureConfig.filter((arg) => arg !== '--config'));
    assert.throws(() => defaultRuntimes({ codex: { provider: { ...azure, id: 'A' } } }), /Codex provider id "A"/);
  });
});

describe('tomlString', () => {
  it('escapes what TOML forbids bare in a basic string, DEL included, and keeps the rest', () => {
    assert.equal(tomlString('plain'), '"plain"');
    assert.equal(tomlString(''), '""');
    assert.equal(tomlString('a"b\\c'), '"a\\"b\\\\c"');
    assert.equal(tomlString('\n\r\t\b\f'), '"\\n\\r\\t\\b\\f"');
    assert.equal(tomlString('\u0000\u0001\u001f'), '"\\u0000\\u0001\\u001f"');
    assert.equal(tomlString('a\u007fb'), '"a\\u007Fb"');
    assert.equal(tomlString('\u2028\u00e9\u{1F600}'), '"\u2028\u00e9\u{1F600}"');
  });

  it('refuses a lone surrogate, which no TOML string can hold', () => {
    assert.throws(() => tomlString('a\uD800'), /lone surrogate/);
    assert.throws(() => tomlString('\uDFFFb'), /lone surrogate/);
  });

  it('refuses a scratch path with a lone surrogate before the command exists', () => {
    assert.throws(() => codexAdapter.command(invocation({ access: 'edit' }), plan({ scratch: 'C:\\s\\\uD800' })), /lone surrogate/);
  });
});

describe('codexEnvironment', () => {
  it('merges every PATH spelling on Windows and drops WindowsApps', () => {
    const environment = codexEnvironment(
      { Path: 'C:\\Windows;C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps', PATH: 'C:\\tools;;D:\\windowsapps\\x', HOME: 'h' },
      'win32',
    );
    assert.deepEqual(environment, { HOME: 'h', PATH: 'C:\\Windows;C:\\tools' });
  });

  it('drops a WindowsApps directory however it is written: trailing separator, forward slashes, quotes, any case', () => {
    const windowsApps = [
      'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\',
      'C:/Program Files/WindowsApps/Package_1.0_x64',
      '"C:\\Users\\u\\AppData\\Local\\Microsoft\\WINDOWSAPPS"',
    ];
    assert.deepEqual(codexEnvironment({ PATH: ['C:\\Windows', ...windowsApps].join(';') }, 'win32'), { PATH: 'C:\\Windows' });
  });

  it('keeps a directory whose name only contains WindowsApps', () => {
    const kept = ['D:\\tools\\mywindowsapps\\bin', 'C:\\WindowsAppsTools', 'E:\\windowsapps-cache', 'C:\\WindowsApps.old\\bin'];
    assert.deepEqual(codexEnvironment({ PATH: kept.join(';') }, 'win32'), { PATH: kept.join(';') });
  });

  it('leaves the environment alone elsewhere', () => {
    const inherited = { PATH: '/usr/bin:/opt/WindowsApps', HOME: '/h' };
    assert.deepEqual(codexEnvironment(inherited, 'linux'), inherited);
    assert.notEqual(codexEnvironment(inherited, 'darwin'), inherited);
  });

  it('hands the worker one search path spelled PATH, whatever spellings the caller held, so a runner that adds its own PATH makes no second one (R11)', () => {
    for (const sandbox of ['unelevated', 'elevated', 'none'] as const) {
      const environment = codexEnvironment({ Path: 'C:\\a', path: 'C:\\b', HOME: 'h' }, 'win32', sandbox);
      assert.deepEqual(Object.keys(environment).filter((key) => key.toLowerCase() === 'path'), ['PATH'], sandbox);
      assert.equal(environment.PATH, 'C:\\a;C:\\b', sandbox);
    }
  });

  it('is what the command runs with', () => {
    assert.deepEqual(codexAdapter.command(invocation(), plan({ platform: 'win32', environment: { PATH: 'a;b\\WindowsApps' } })).environment, { PATH: 'a' });
  });

  describe('the execution policy under the elevated sandbox', () => {
    it('is RemoteSigned for the worker\'s process tree on Windows, reader and editor alike', () => {
      assert.deepEqual(codexEnvironment({ PATH: 'C:\\Windows', HOME: 'h' }, 'win32', 'elevated'), { HOME: 'h', PATH: 'C:\\Windows', PSExecutionPolicyPreference: 'RemoteSigned' });
      const elevated = createCodexAdapter({ windowsSandbox: 'elevated' });
      for (const access of ['edit', 'read-only'] as const) {
        assert.equal(elevated.command(invocation({ access }), plan({ scratch, platform: 'win32' })).environment.PSExecutionPolicyPreference, 'RemoteSigned', access);
      }
    });

    it('keeps a policy the caller already sets, in any spelling', () => {
      assert.deepEqual(codexEnvironment({ PSExecutionPolicyPreference: 'AllSigned' }, 'win32', 'elevated'), { PATH: '', PSExecutionPolicyPreference: 'AllSigned' });
      assert.deepEqual(codexEnvironment({ psexecutionpolicypreference: 'Bypass' }, 'win32', 'elevated'), { PATH: '', psexecutionpolicypreference: 'Bypass' });
    });

    it('replaces an empty value, which sets no policy, and every other spelling with it', () => {
      assert.deepEqual(codexEnvironment({ psexecutionpolicypreference: '' }, 'win32', 'elevated'), { PATH: '', PSExecutionPolicyPreference: 'RemoteSigned' });
      assert.deepEqual(codexEnvironment({ psexecutionpolicypreference: '', PSExecutionPolicyPreference: undefined }, 'win32', 'elevated'), { PATH: '', PSExecutionPolicyPreference: 'RemoteSigned' });
    });

    // Node hands a Windows child only the spelling that sorts first, so a second spelling must never survive beside the one kept.
    it('keeps the policy the caller sets in one spelling when another is empty or unset, whichever sorts first', () => {
      for (const empty of ['', undefined]) {
        for (const environment of [
          { PSExecutionPolicyPreference: empty, psexecutionpolicypreference: 'AllSigned' },
          { psexecutionpolicypreference: 'AllSigned', PSExecutionPolicyPreference: empty },
        ]) {
          assert.deepEqual(codexEnvironment(environment, 'win32', 'elevated'), { PATH: '', psexecutionpolicypreference: 'AllSigned' }, JSON.stringify(environment));
        }
      }
    });

    it('keeps only the spelling Node would have passed when two set different policies', () => {
      assert.deepEqual(codexEnvironment({ psexecutionpolicypreference: 'Bypass', PSExecutionPolicyPreference: 'AllSigned' }, 'win32', 'elevated'), { PATH: '', PSExecutionPolicyPreference: 'AllSigned' });
    });

    it('is not set under the other values, where the worker is the operator\'s own account, nor on another platform', () => {
      for (const sandbox of ['unelevated', 'none'] as const) assert.equal(codexEnvironment({}, 'win32', sandbox).PSExecutionPolicyPreference, undefined, sandbox);
      assert.equal(codexEnvironment({}, 'win32').PSExecutionPolicyPreference, undefined, 'unelevated by default');
      assert.deepEqual(codexEnvironment({ HOME: '/h' }, 'linux', 'elevated'), { HOME: '/h' });
      assert.equal(createCodexAdapter({ windowsSandbox: 'elevated' }).command(invocation(), plan({ platform: 'darwin' })).environment.PSExecutionPolicyPreference, undefined);
    });
  });
});

describe('codex decode', () => {
  const message = '{"answer":"ok"}';
  const line = (event: Record<string, unknown>): string => JSON.stringify(event);
  const stream = (...events: Record<string, unknown>[]): string => `${events.map(line).join('\n')}\n`;
  const started = { type: 'thread.started', thread_id: thread };
  const turnStarted = { type: 'turn.started' };
  const agent = (text: string, id = 'item_9'): Record<string, unknown>[] => [
    { type: 'item.started', item: { id, type: 'agent_message', text: '' } },
    { type: 'item.completed', item: { id, type: 'agent_message', text } },
  ];
  const usage = { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 };
  const done = { type: 'turn.completed', usage };
  const happy = (): Record<string, unknown>[] => [started, turnStarted, ...agent(message), done];
  const decode = (stdout: string, finalMessage: string | null = message, planChange: Partial<LaunchPlan> = {}): Decoded =>
    codexAdapter.decode(invocation(), plan(planChange), textOutputs(stdout, '', finalMessage));
  /** The error of a failed result; an answer fails the assertion. */
  const failure = (decoded: Decoded): string => {
    assert.equal(decoded.result.kind, 'failed');
    return decoded.result.kind === 'failed' ? decoded.result.error : '';
  };
  const answered = { kind: 'answer', value: { answer: 'ok' } };

  it('reads a completed turn: one thread, usage, the final message as the answer, no denial evidence', () => {
    assert.deepEqual(decode(stream(...happy())), { sessionIds: [thread], usage, denials: null, result: answered });
  });

  it('accepts CRLF line endings and a final message that differs only in surrounding whitespace', () => {
    assert.deepEqual(decode(happy().map(line).join('\r\n'), `${message}\r\n`).result, answered);
  });

  it('keeps a command that exited nonzero, since a failing command can be the point', () => {
    const command = [
      { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'grep x', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'grep x', exit_code: 1, status: 'failed' } },
    ];
    assert.deepEqual(decode(stream(started, turnStarted, ...command, ...agent(message), done)).result, answered);
  });

  it('keeps a completed turn that reconnected on the way, with the error still in its stdout', () => {
    // codex-cli reports a transient stream error as a top-level error event and a warning as an error item.
    const reconnect = { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' };
    const warning = { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Under-development features enabled' } };
    const stdout = stream(started, turnStarted, reconnect, warning, ...agent(message), done);
    assert.deepEqual(decode(stdout), { sessionIds: [thread], usage, denials: null, result: answered });
    assert.match(stdout, /Reconnecting\.\.\. 1\/5/);
  });

  it('keeps a completed turn after a patch that did not apply, since the model saw the failure and answered anyway', () => {
    const patch = [
      { type: 'item.started', item: { id: 'item_1', type: 'file_change', changes: [], status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'item_1', type: 'file_change', changes: [], status: 'failed' } },
    ];
    assert.deepEqual(decode(stream(started, turnStarted, ...patch, ...agent(message), done)).result, answered);
  });

  it('ignores events it does not read, such as item updates', () => {
    const update = { type: 'item.updated', item: { id: 'todo', type: 'todo_list', items: [] } };
    assert.deepEqual(decode(stream(started, turnStarted, update, ...agent(message), done)).result, answered);
  });

  const failures: [string, () => string, RegExp, (string | null)?][] = [
    ['two thread.started events', () => stream(started, { ...started, thread_id: 'other' }, ...agent(message), done), /started 2 threads/],
    ['no thread.started event', () => stream(turnStarted, ...agent(message), done), /started 0 threads/],
    ['a thread without an id', () => stream({ type: 'thread.started' }, ...agent(message), done), /without an id/],
    ['an incomplete turn', () => stream(started, turnStarted, ...agent(message)), /exactly one completed turn/],
    ['two completed turns', () => stream(started, done, ...agent(message), done), /exactly one completed turn/],
    ['a completed turn that is not last', () => stream(started, done, ...agent(message)), /exactly one completed turn/],
    ['an error event on a turn that never completed', () => stream(started, turnStarted, { type: 'error', message: 'Reconnecting... 1/5' }, { type: 'error', message: 'stream lost' }), /did not end with exactly one completed turn; it reported error: stream lost$/],
    ['an error event before a failed turn', () => stream(started, { type: 'error', message: 'stream lost' }, { type: 'turn.failed', error: { message: 'quota' } }), /reported turn.failed: quota/],
    ['a failed turn even when a completed turn follows', () => stream(started, { type: 'turn.failed', error: { message: 'quota' } }, ...agent(message), done), /reported turn.failed: quota/],
    ['a failed turn', () => stream(started, { type: 'turn.failed', error: { message: 'quota' } }, done), /reported turn.failed: quota/],
    ['an MCP tool call', () => stream(started, { type: 'item.started', item: { id: 'm', type: 'mcp_tool_call' } }, ...agent(message), done), /used mcp_tool_call/],
    ['a web search', () => stream(started, { type: 'item.completed', item: { id: 'w', type: 'web_search' } }, ...agent(message), done), /used web_search/],
    ['a failed command without an exit code', () => stream(started, { type: 'item.completed', item: { id: 'c', type: 'command_execution', status: 'failed' } }, ...agent(message), done), /item c \(command_execution\) failed/],
    ['a failed item of a kind it does not know', () => stream(started, { type: 'item.completed', item: { id: 'n', type: 'new_kind', status: 'failed' } }, ...agent(message), done), /item n \(new_kind\) failed/],
    ['an item without an id', () => stream(started, { type: 'item.completed', item: { type: 'agent_message' } }, ...agent(message), done), /without an item id/],
    ['an item left started', () => stream(started, { type: 'item.started', item: { id: 'c', type: 'command_execution' } }, ...agent(message), done), /started without completing: c/],
    ['a malformed line', () => `${line(started)}\n{"type":\n${line(done)}\n`, /line 2 that is not JSON/],
    ['a line that is not an object', () => `${line(started)}\n[1]\n${line(done)}\n`, /line 2 that is not an event object/],
    ['no final message file', () => stream(...happy()), /no final message file/, null],
    ['a final message other than the last agent message', () => stream(...happy()), /not its last agent message/, '{"answer":"other"}'],
    ['no agent message at all', () => stream(started, done), /not its last agent message/],
    ['a final message that is not JSON', () => stream(started, ...agent('not json'), done), /final message that is not JSON/, 'not json'],
  ];
  for (const [name, stdout, pattern, finalMessage] of failures) {
    it(`fails ${name}`, () => {
      const decoded = decode(stdout(), finalMessage === undefined ? message : finalMessage);
      assert.match(failure(decoded), pattern);
      assert.equal(decoded.denials, null);
    });
  }

  it('reads the stream from its lines alone, never needing all of stdout as one text', () => {
    const outputs = { ...textOutputs(stream(...happy()), '', message), stdout: null };
    assert.deepEqual(codexAdapter.decode(invocation(), plan(), outputs), { sessionIds: [thread], usage, denials: null, result: answered });
  });

  it('fails a line too long to decode, naming it, and keeps the thread and usage the other lines hold', () => {
    const lines = [line(started), line(turnStarted), null, ...agent(message).map(line), line(done)];
    const decoded = codexAdapter.decode(invocation(), plan(), { stdout: null, stdoutLines: lines, stderr: '', finalMessage: message });
    assert.equal(failure(decoded), `Codex printed line 3 that is longer than the ${String(maxLineBytes)} bytes the launcher decodes as one line`);
    assert.deepEqual(decoded.sessionIds, [thread]);
    assert.deepEqual(decoded.usage, usage);
  });

  it('numbers lines from 1 counting blank ones, and names the first malformed line', () => {
    const decoded = decode(`${line(started)}\r\n\r\nnot json\r\n[1]\r\n${line(done)}\r\n`);
    assert.match(failure(decoded), /^Codex printed line 3 that is not JSON/);
  });

  it('keeps the session id of every well-formed line even when another line is malformed', () => {
    const decoded = decode(`${line(started)}\nnot json\n`);
    assert.deepEqual(decoded.sessionIds, [thread]);
    assert.match(failure(decoded), /not JSON/);
  });

  it('keeps usage from the completed turn on a failure', () => {
    assert.deepEqual(decode(stream(...happy()), '{"answer":"other"}').usage, usage);
  });

  it('expects the continued session and reports the thread it observed when that differs', () => {
    assert.deepEqual(decode(stream(...happy()), message, { sessionId: thread, resume: thread }), { sessionIds: [thread], usage, denials: null, result: answered });
    const other = '0199a3c4-0000-7f80-9a1b-2c3d4e5f6a7b';
    const decoded = decode(stream(...happy()), message, { sessionId: other, resume: other });
    assert.match(failure(decoded), new RegExp(`ran thread ${thread}, not the continued session ${other}`));
    // The continued id is the launcher's to add; the decoder names only the thread the stream started.
    assert.deepEqual(decoded.sessionIds, [thread]);
  });

  it('fails a worker whose commands the sandbox refused to run, even though its turn completed', () => {
    // Exactly what codex-cli 0.157.1 printed for an editor whose writable root sat under .git.
    // The stream has no command item at all, so only stderr shows the worker never had a shell.
    const refused =
      '2026-09-27T00:07:23.500940Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "UnsupportedOperation(\\"windows elevated sandbox cannot reopen writable descendants under read-only carveouts directly; refusing to run unsandboxed\\")" }\n' +
      '2026-09-27T00:07:28.455002Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "UnsupportedOperation(\\"second\\")" }\n';
    const decoded = codexAdapter.decode(invocation(), plan(), textOutputs(stream(...happy()), refused, message));
    assert.match(failure(decoded), /refused to run 2 command\(s\).*cannot reopen writable descendants/);
    assert.deepEqual(decoded.sessionIds, [thread]);
    assert.deepEqual(decoded.usage, usage);
  });

  it('does not mistake other stderr lines for a refused command', () => {
    const noise = '2026-09-27T00:07:23Z WARN codex_core::tools::router: slow tool\nERROR somewhere else: exec_command failed\nmise WARN: chpwd\n';
    assert.deepEqual(codexAdapter.decode(invocation(), plan(), textOutputs(stream(...happy()), noise, message)).result, answered);
  });

  it('names what Codex said on stderr when it started no thread, such as a config key it does not know', () => {
    // Exactly what codex-cli 0.157.1 printed for an unknown --config key under --strict-config.
    const stderr = 'Error loading config.toml: unknown configuration field `project_doc_max_bytes` in -c/--config override\n';
    const decoded = codexAdapter.decode(invocation(), plan(), textOutputs('', stderr));
    assert.equal(
      failure(decoded),
      'Codex started 0 threads; a worker is exactly one; its stderr ends: Error loading config.toml: unknown configuration field `project_doc_max_bytes` in -c/--config override',
    );
  });

  it('keeps only the end of a long stderr, and no half of a surrogate pair', () => {
    const stderr = `${'x'.repeat(5000)}\u{1F600}${'y'.repeat(999)}`;
    const error = failure(codexAdapter.decode(invocation(), plan(), textOutputs('', stderr)));
    const excerpt = error.slice(error.indexOf('its stderr ends: ') + 'its stderr ends: '.length);
    assert.equal(excerpt, `\uFFFD${'y'.repeat(999)}`);
    assert.equal(excerpt.isWellFormed(), true);
  });

  it('adds no stderr excerpt when stderr is blank, or when Codex started more than one thread', () => {
    const blank = codexAdapter.decode(invocation(), plan(), textOutputs('', ' \n\t\n'));
    assert.equal(failure(blank), 'Codex started 0 threads; a worker is exactly one');
    const twice = stream(started, { ...started, thread_id: 'other' }, ...agent(message), done);
    const two = codexAdapter.decode(invocation(), plan(), textOutputs(twice, 'mise WARN: chpwd\n', message));
    assert.equal(failure(two), 'Codex started 2 threads; a worker is exactly one');
  });

  it('reports no session when nothing was printed, even for a continuation', () => {
    const decoded = decode('', null, { sessionId: thread, resume: thread });
    assert.deepEqual(decoded.sessionIds, []);
    assert.match(failure(decoded), /started 0 threads/);
  });

  it('reports each thread the stream started once, even when a malformed stream repeats one', () => {
    const decoded = decode(stream(started, started, { ...started, thread_id: 'other' }, done));
    assert.deepEqual(decoded.sessionIds, [thread, 'other']);
    assert.match(failure(decoded), /started 3 threads/);
  });
});
