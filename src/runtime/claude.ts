import type { Access, DeniedTool, Effort } from '../checkpoint/events.ts';
import { emptyUsageSummary, maxDecodeBytes, type Decoded, type LaunchPlan, type RuntimeAdapter, type UsageSummary, type WorkerCommand, type WorkerOutputs } from './adapter.ts';
import type { Invocation } from './contract.ts';
import { launcherPins, pinVariables, spellingsOf, withoutVariables } from './environment.ts';
import { InheritedOverrideError, InvalidInvocationError } from './errors.ts';
import { finiteNumber, isObject, sumOrNull } from './json.ts';

/** Every flag the command below uses; the preflight requires each in `--help` (R4). */
export const claudeFlags = [
  '--print',
  '--output-format',
  '--model',
  '--effort',
  '--session-id',
  '--resume',
  '--add-dir',
  '--max-budget-usd',
  '--tools',
  '--allowedTools',
  '--permission-mode',
  '--disable-slash-commands',
  '--strict-mcp-config',
  '--setting-sources',
  '--settings',
  '--json-schema',
] as const;

/** Inherited variables that change how much the model thinks, which the pinned effort must decide alone. */
export const thinkingOverrides = ['MAX_THINKING_TOKENS', 'CLAUDE_CODE_DISABLE_THINKING', 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING'] as const;

/**
 * Variables a running Claude Code session sets to describe itself to the
 * processes it starts, which the engine inherits when it runs inside one.
 * They describe that session, not the worker: the CLI reads them to mark
 * itself a child session (which turns session persistence off in an
 * interactive child), to take the parent's entrypoint, to connect to the
 * parent's IDE and to join the parent's messaging socket with its token.
 * `CLAUDE_JOB_DIR` names the parent's job directory.
 * A worker is a session of its own, so they are dropped, never refused:
 * refusing would stop every worker the engine starts from inside Claude
 * Code. The worker's CLI sets its own for the processes it starts.
 *
 * The list is kept by hand, so a newer Claude Code can set a variable it
 * lacks, which a worker then inherits until the name is added here.
 */
export const claudeSessionMarkers = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_INVOKED_SKILLS',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_JOB_DIR',
] as const;

/**
 * Settings of the interactive screen, which a worker in print mode never
 * draws. A user sets the full repaint for a terminal that leaves stale text
 * on screen, and Claude Code sets it itself on Windows for a background
 * session and agent view, whose workers then inherit it:
 * https://code.claude.com/docs/en/fullscreen#stale-or-misplaced-text-on-screen
 * An inherited one is dropped with the session markers, since it describes
 * the enclosing session's screen. Unlike a marker, a settings `env` block may
 * set one: it changes nothing the engine decides for a worker.
 */
export const claudeScreenSettings = ['CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT'] as const;

/**
 * The settings a Claude adapter may be given, each a command Claude Code
 * runs to obtain a credential for its provider or its proxy. They are
 * given here because the user's own settings, where they usually live, are
 * switched off (`--setting-sources ''`). `otelHeadersHelper` is left out:
 * it supplies telemetry headers, not a credential.
 */
export const claudeCredentialSettings = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'proxyAuthHelper'] as const;
export type ClaudeCredentialSetting = (typeof claudeCredentialSettings)[number];

/**
 * Settings merged into the worker's `--settings` object: credential
 * helpers, and an `env` block Claude Code sets in its own environment, such
 * as `CLAUDE_CODE_USE_BEDROCK` or `ANTHROPIC_BASE_URL`.
 */
export type ClaudeSettings = { readonly [Setting in ClaudeCredentialSetting]?: string } & { readonly env?: Readonly<Record<string, string>> };

/** How a Claude adapter is built. The user's own settings are switched off, so any credential a machine needs is given here. */
export interface ClaudeOptions {
  /** None by default: credentials then come from the inherited environment or the CLI's login. */
  readonly settings?: ClaudeSettings;
}

/**
 * Variables a settings `env` block may not set, since Claude Code would set
 * them over what the engine pinned: the thinking overrides and the pinned
 * effort and auto memory (R8), an enclosing session's markers, and the
 * temporary directory and build-server pins of the launcher.
 */
const reservedSettingsVariables: readonly string[] = [
  ...thinkingOverrides,
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  ...claudeSessionMarkers,
  ...launcherPins,
];

/**
 * The settings after every check that needs no platform, copied so a caller
 * changing its object later cannot change the adapter: a known key, each
 * credential a non-empty string, and `env` an object of strings under names
 * a process environment can hold. Options can arrive from outside TypeScript.
 */
function checkedSettings(settings: unknown): ClaudeSettings {
  const refuse = (reason: string): never => {
    throw new Error(`Claude settings ${reason}`);
  };
  if (!isObject(settings)) return refuse('must be an object');
  const known: readonly string[] = [...claudeCredentialSettings, 'env'];
  const unknown = Object.keys(settings).find((key) => !known.includes(key));
  if (unknown !== undefined) refuse(`have unknown key ${JSON.stringify(unknown)}; a Claude adapter takes only ${known.join(', ')}`);
  const checked: Record<string, unknown> = {};
  for (const key of claudeCredentialSettings) {
    const value = settings[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '' || !value.isWellFormed()) refuse(`${key} must be a non-empty string`);
    checked[key] = value;
  }
  if (settings.env !== undefined) {
    if (!isObject(settings.env)) refuse('env must be an object of strings');
    const env = Object.entries(isObject(settings.env) ? settings.env : {});
    for (const [name, value] of env) {
      if (!/^[^=\0]+$/.test(name) || !name.isWellFormed()) refuse(`env has a name ${JSON.stringify(name)} no environment can hold`);
      if (typeof value !== 'string' || value.includes('\0') || !value.isWellFormed()) refuse(`env value of ${name} is not a string an environment can hold`);
    }
    checked.env = Object.freeze(Object.fromEntries(env));
  }
  return Object.freeze(checked) as ClaudeSettings;
}

/**
 * Refuse a settings `env` name the engine pins or drops, by any spelling
 * the worker's platform reads as it: Claude Code sets the block in its own
 * environment, which on Windows takes every spelling of a name as one
 * variable, and elsewhere only the exact name.
 */
export function refuseReservedSettings(settings: ClaudeSettings, platform: NodeJS.Platform): void {
  if (settings.env === undefined) return;
  for (const name of reservedSettingsVariables) {
    const [spelling] = spellingsOf(settings.env, name, platform)[0] ?? [];
    if (spelling !== undefined) throw new Error(`Claude settings env sets ${spelling}, which the engine decides for every worker; remove it from the adapter's settings`);
  }
}

/** How long a denial's command or path may be on the receipt, in UTF-16 code units. */
const maxDenialDetail = 300;

/**
 * The longest command line Windows starts a process with, in UTF-16 code
 * units: CreateProcess allows 32767 including the terminating NUL, and a
 * longer one fails the spawn with ENAMETOOLONG.
 */
export const windowsCommandLineLimit = 32_766;

/**
 * The longest single argument a POSIX system is held to, in UTF-8 bytes:
 * Linux's MAX_ARG_STRLEN is 128 KiB including the terminating NUL. macOS
 * has no per-argument limit, only a larger total, but the same bound holds
 * there so an invocation accepted on one POSIX system is accepted on all.
 */
export const posixArgumentLimit = 128 * 1024 - 1;

/** The Claude Code tools for the two permission axes (TD3): reading always, the shell and editing on request. */
export function claudeTools(access: Access, shell: boolean): string[] {
  return ['Read', 'Glob', 'Grep', ...(shell ? ['Bash'] : []), ...(access === 'edit' ? ['Edit', 'Write'] : [])];
}

/**
 * The caller's environment with the effort and auto memory pinned and the
 * markers and screen settings of an enclosing Claude Code session removed.
 * Claude Code lets `CLAUDE_CODE_EFFORT_LEVEL` outrank `--effort`, so both
 * are set; an inherited thinking override is refused by name rather than
 * dropped, so the operator learns their shell was changing every worker.
 * A name is any spelling on Windows, where the worker reads every spelling
 * as one variable, and the exact name elsewhere.
 */
export function claudeEnvironment(environment: NodeJS.ProcessEnv, effort: Effort, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  for (const name of thinkingOverrides) {
    for (const [spelling, value] of spellingsOf(environment, name, platform)) {
      if (value !== undefined && value.trim() !== '') throw new InheritedOverrideError(spelling, 'would override the pinned effort');
    }
  }
  return pinVariables(
    withoutVariables(environment, [...thinkingOverrides, ...claudeSessionMarkers, ...claudeScreenSettings], platform),
    { CLAUDE_CODE_EFFORT_LEVEL: effort, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    platform,
  );
}

/**
 * How many UTF-16 code units one argument takes on a Windows command line,
 * quoted the way libuv quotes it for CreateProcess: an empty argument is
 * `""`; one without a space, tab or quote is verbatim; otherwise it is
 * wrapped in quotes, each quote is escaped with a backslash, and each run
 * of backslashes before a quote or the closing quote is doubled.
 */
export function windowsArgumentLength(argument: string): number {
  if (argument === '') return 2;
  if (!/[ \t"]/.test(argument)) return argument.length;
  let length = argument.length + 2;
  // Walking backwards, a backslash is doubled while it still precedes a quote or the closing quote.
  let beforeQuote = true;
  for (let index = argument.length - 1; index >= 0; index--) {
    const character = argument[index];
    if (character === '"') {
      length += 1;
      beforeQuote = true;
    } else if (character === '\\') {
      if (beforeQuote) length += 1;
    } else {
      beforeQuote = false;
    }
  }
  return length;
}

/**
 * Refuse, before anything is recorded or run, a command line the platform
 * would not start. The compiled output schema travels as one argument, so a
 * large schema is what reaches the limit, and the adapter's settings travel
 * as another; left alone, the spawn would fail after the launch is on the
 * ledger. `argv` is the whole command line, the executable first.
 */
export function refuseOversizedCommandLine(platform: NodeJS.Platform, argv: readonly string[]): void {
  const schemaHint = 'the compiled output schema is passed on the command line, so a smaller output schema is the remedy';
  const settingsHint = "the adapter's settings are passed on the command line, so smaller settings are the remedy";
  if (platform === 'win32') {
    const length = argv.reduce((total, argument) => total + windowsArgumentLength(argument), argv.length - 1);
    if (length > windowsCommandLineLimit) {
      throw new InvalidInvocationError(`The Claude Code command line would be ${length} characters long, over the ${windowsCommandLineLimit} Windows allows; the compiled output schema and the adapter's settings are passed on the command line, so a smaller output schema or smaller settings are the remedy`);
    }
    return;
  }
  for (const [index, argument] of argv.entries()) {
    const bytes = Buffer.byteLength(argument, 'utf8');
    if (bytes > posixArgumentLimit) {
      const previous = index > 0 ? argv[index - 1] : undefined;
      const flag = previous?.startsWith('--') === true ? `the value of ${previous}` : `argument ${index}`;
      throw new InvalidInvocationError(`On the Claude Code command line, ${flag} is ${bytes} bytes, over the ${posixArgumentLimit} one argument may have; ${previous === '--settings' ? settingsHint : schemaHint}`);
    }
  }
}

/**
 * The Claude Code command line for one worker. `settings` are the
 * adapter's, merged into the `--settings` object for a fresh worker and a
 * continuation alike, under the keys that switch sources off.
 */
export function claudeCommand(invocation: Invocation, plan: LaunchPlan, settings: ClaudeSettings = {}): WorkerCommand {
  if (plan.sessionId === null) throw new Error('A Claude Code worker needs its session id before launch');
  refuseReservedSettings(settings, plan.platform);
  const tools = claudeTools(invocation.access, invocation.shell).join(',');
  const environment = claudeEnvironment(plan.environment, invocation.effort, plan.platform);
  const args = [
    '--print',
    '--output-format', 'json',
    '--model', invocation.model,
    '--effort', invocation.effort,
    // A fresh worker runs under the id the ledger already holds; a
    // continuation keeps the id of the session it resumes.
    ...(plan.resume === null ? ['--session-id', plan.sessionId] : ['--resume', plan.resume]),
    // Without this the CLI denies every write outside the worktree, including the scratch directory the prompt names.
    ...(plan.scratch === null ? [] : ['--add-dir', plan.scratch]),
    ...(invocation.budgetUsd === undefined ? [] : ['--max-budget-usd', String(invocation.budgetUsd)]),
    '--tools', tools,
    '--allowedTools', tools,
    '--permission-mode', 'dontAsk',
    '--disable-slash-commands',
    '--strict-mcp-config',
    // No user, project or local settings, no CLAUDE.md, no auto memory: the prompt is the whole instruction.
    // So an `env` block or `apiKeyHelper` in a settings file does not reach the worker either: its
    // credentials and provider (Bedrock, Vertex, a gateway) come from the inherited environment or
    // from the adapter's settings. The keys that switch sources off come last, so they always win.
    '--setting-sources', '',
    '--settings', JSON.stringify({ ...settings, autoMemoryEnabled: false, claudeMdExcludes: ['**'] }),
    '--json-schema', plan.schema.text,
  ];
  refuseOversizedCommandLine(plan.platform, [invocation.executable, ...invocation.executableArgs, ...args]);
  return { environment, args };
}

/** Whether a UTF-16 code unit is the first half of a surrogate pair. */
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

/**
 * A denial's detail cut to `maxDenialDetail` code units without splitting a
 * surrogate pair, and with any lone surrogate the runtime sent replaced, so
 * the ledger never holds text that is not valid Unicode.
 */
export function truncateDetail(detail: string): string {
  let end = Math.min(detail.length, maxDenialDetail);
  // A high surrogate as the last kept unit would lose its low half to the cut.
  if (end < detail.length && isHighSurrogate(detail.charCodeAt(end - 1))) end -= 1;
  return detail.slice(0, end).toWellFormed();
}

/** A denial without readable input is still a denial; keep the tool and whatever detail there is. */
function deniedTools(denials: readonly unknown[]): DeniedTool[] {
  return denials.map((entry) => {
    const denial = isObject(entry) ? entry : {};
    const tool = typeof denial.tool_name === 'string' && denial.tool_name.length > 0 ? denial.tool_name : 'unknown tool';
    const input = isObject(denial.tool_input) ? denial.tool_input : {};
    const detail = ['command', 'file_path', 'path', 'url'].map((key) => input[key]).find((value): value is string => typeof value === 'string');
    return { tool, detail: detail === undefined ? null : truncateDetail(detail) };
  });
}

const isBudgetStop = (envelope: Record<string, unknown>): boolean =>
  envelope.terminal_reason === 'budget_exhausted' || (typeof envelope.subtype === 'string' && envelope.subtype.startsWith('error_max_budget'));

/**
 * Read the `--output-format json` envelope. The session ids are the one the
 * envelope names, if any; the launcher adds the pinned or continued id to
 * every finish, so a worker that never answered still names its transcript.
 * The envelope is one JSON value, so stdout is read whole: a stdout above
 * the decode cap, which the launcher does not hand over as one text, fails
 * the worker, and its bytes are still frozen as evidence.
 */
export function decodeClaude(invocation: Invocation, plan: LaunchPlan, outputs: WorkerOutputs): Decoded {
  const expected = plan.sessionId;
  const failed = (error: string, known: Omit<Decoded, 'result'> = { sessionIds: [], usage: null, denials: null }): Decoded => ({ ...known, result: { kind: 'failed', error } });

  const stdout = outputs.stdout;
  if (stdout === null) return failed(`Claude Code printed more than the ${String(maxDecodeBytes)} bytes of stdout the launcher decodes as one result envelope; it is frozen as evidence`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    return failed(stdout.trim() === '' ? 'Claude Code printed no result envelope' : `Claude Code printed a result envelope that is not JSON: ${(error as Error).message}`);
  }
  if (!isObject(parsed)) return failed('Claude Code printed a result envelope that is not an object');
  const envelope = parsed;

  const observed = typeof envelope.session_id === 'string' && envelope.session_id.length > 0 ? envelope.session_id : null;
  const usage = { usage: envelope.usage ?? null, modelUsage: envelope.modelUsage ?? null, total_cost_usd: envelope.total_cost_usd ?? null };
  const denials = Array.isArray(envelope.permission_denials) ? deniedTools(envelope.permission_denials) : null;
  const known = { sessionIds: observed === null ? [] : [observed], usage, denials };

  // The ledger named this session before launch; an answer from any other session is not this worker's.
  if (observed !== expected) return failed(`Claude Code answered from session ${String(observed)}, not ${String(expected)}`, known);
  // A budget stop is the pinned limit doing its job, not a malformed result.
  if (isBudgetStop(envelope)) {
    const result = typeof envelope.result === 'string' && envelope.result.length > 0 ? `: ${envelope.result}` : '';
    return { ...known, result: { kind: 'budget', error: `Claude Code stopped at its budget of ${String(invocation.budgetUsd)} USD${result}` } };
  }
  if (envelope.type !== 'result' || envelope.subtype !== 'success' || envelope.is_error !== false) {
    const result = typeof envelope.result === 'string' && envelope.result.length > 0 ? `: ${envelope.result}` : '';
    return failed(`Claude Code reported ${String(envelope.type)}/${String(envelope.subtype)} with is_error ${String(envelope.is_error)}${result}`, known);
  }
  if (!Object.hasOwn(envelope, 'structured_output')) return failed('Claude Code returned no structured_output', known);
  // Without the list there is no evidence that nothing was refused.
  if (denials === null) return failed('Claude Code returned no permission_denials array, so its denials are unknown', known);
  return { ...known, result: { kind: 'answer', value: envelope.structured_output } };
}

/**
 * The neutral view of what `decodeClaude` stores as usage: `total_cost_usd`
 * is the cost, and the envelope's `usage` gives the tokens. Claude Code's
 * `input_tokens` leaves out the tokens read from and written to the prompt
 * cache, so all three are summed for `inputTokens`, and any of the three
 * missing leaves it null rather than undercounted. For a fresh worker the
 * envelope covers this process alone; a continuation's `total_cost_usd`
 * covers the whole session (runtime adapter, Open Questions), and nothing
 * here can tell the two apart, so a caller that continues sessions must not
 * sum continuations' costs as if they were their own.
 */
export function summarizeClaudeUsage(usage: unknown): UsageSummary {
  if (!isObject(usage)) return emptyUsageSummary;
  const tokens = isObject(usage.usage) ? usage.usage : {};
  const cached = finiteNumber(tokens.cache_read_input_tokens);
  return {
    costUsd: finiteNumber(usage.total_cost_usd),
    inputTokens: sumOrNull(finiteNumber(tokens.input_tokens), cached, finiteNumber(tokens.cache_creation_input_tokens)),
    cachedInputTokens: cached,
    outputTokens: finiteNumber(tokens.output_tokens),
  };
}

/**
 * Claude Code in headless mode. It takes a session id before launch, stops at
 * a budget, lists the tool calls it refused, runs without a shell, lets a
 * read-only worker write to an added directory, resumes a session by id,
 * and reports what a worker cost in US dollars.
 */
export function createClaudeAdapter(options: ClaudeOptions = {}): RuntimeAdapter {
  // Options can arrive from outside TypeScript, and every value goes straight into a command line.
  const given: unknown = options;
  if (!isObject(given)) throw new Error('Claude options must be an object');
  const unknown = Object.keys(given).find((key) => key !== 'settings');
  if (unknown !== undefined) throw new Error(`Unknown Claude option ${JSON.stringify(unknown)}; use settings`);
  const settings = options.settings === undefined ? {} : checkedSettings(options.settings);
  return {
    ...claudeRuntime,
    command: (invocation, plan) => claudeCommand(invocation, plan, settings),
  };
}

/** Everything about the Claude adapter that no option changes; `createClaudeAdapter` adds the command. */
const claudeRuntime: Omit<RuntimeAdapter, 'command'> = {
  name: 'claude',
  capabilities: {
    assignsSessionId: true,
    budgetCap: true,
    denialEvidence: true,
    withholdShell: true,
    readOnlyScratch: true,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    resume: true,
    costInUsd: true,
  },
  qualification: {
    version: { args: ['--version'], pattern: /^(\d+\.\d+\.\d+) \(Claude Code\)$/ },
    help: [{ args: ['--help'], flags: claudeFlags }],
  },
  decode: decodeClaude,
  summarizeUsage: summarizeClaudeUsage,
};

/** The Claude adapter with its defaults: no settings beyond the ones that switch sources off. */
export const claudeAdapter: RuntimeAdapter = createClaudeAdapter();
