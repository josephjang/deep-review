import { emptyUsageSummary, maxLineBytes, type Decoded, type LaunchPlan, type RuntimeAdapter, type UsageSummary, type WorkerCommand, type WorkerOutputs } from './adapter.ts';
import type { Invocation } from './contract.ts';
import { pinVariables, spellingsOf, withoutVariables } from './environment.ts';
import { finiteNumber, isObject } from './json.ts';

/** Flags of the top-level command. */
const codexRootFlags = ['--ask-for-approval'] as const;

/**
 * Flags of `exec`, every one of which `exec resume` also takes. The sandbox
 * and its writable roots are `--config` overrides rather than `--sandbox`
 * and `--add-dir`, because `exec resume` accepts neither flag and a
 * continuation must run under the same sandbox as the worker it continues.
 * `--strict-config` makes Codex refuse a `--config` key it does not know,
 * which it otherwise ignores without a word: a key renamed by a Codex update
 * would silently stop switching its source off.
 */
const codexExecFlags = [
  '--ignore-user-config',
  '--strict-config',
  '--ignore-rules',
  '--skip-git-repo-check',
  '--config',
  '--model',
  '--json',
  '--output-schema',
  '--output-last-message',
] as const;

/** Every flag the command below uses; the preflight requires each in the matching help text (R4). */
export const codexFlags = [...codexRootFlags, ...codexExecFlags] as const;

/** Configuration that switches off every instruction and tool source the review does not control. */
const isolation = [
  'project_doc_max_bytes=0',
  'skills.include_instructions=false',
  'web_search="disabled"',
  'features.apps=false',
  'features.plugins=false',
  'features.remote_plugin=false',
  'features.skill_search=false',
  'features.skill_mcp_dependency_install=false',
];

/**
 * A TOML basic string for a `--config` value. JSON's escapes are a subset of
 * TOML's, and JSON escapes every control character TOML forbids bare but
 * DEL (U+007F), which is escaped here. A lone surrogate has no TOML form,
 * since TOML's `\u` escape names a Unicode scalar value, so a string
 * holding one is refused rather than written as a value Codex cannot parse.
 */
export function tomlString(value: string): string {
  if (!value.isWellFormed()) throw new Error(`${JSON.stringify(value)} holds a lone surrogate, which no TOML string can`);
  return JSON.stringify(value).replaceAll('\x7f', '\\u007F');
}

/**
 * Whether a Windows PATH entry is a WindowsApps directory or lies under one,
 * judged by whole path segments so that a directory whose name merely
 * contains the word, such as `D:\tools\mywindowsapps`, is kept. Quotes a
 * PATH entry may carry are not part of any segment.
 */
function underWindowsApps(directory: string): boolean {
  return directory
    .replaceAll('"', '')
    .split(/[\\/]/)
    .some((segment) => segment.toLowerCase() === 'windowsapps');
}

/**
 * How Codex workers are confined on Windows. `unelevated` runs every
 * worker's commands under a restricted token of the operator's account and
 * works on any machine, but a process there cannot create a named pipe,
 * through which Node gives a child its piped stdio, so a Node process
 * cannot start a child whose output it captures. `elevated` runs them as a
 * separate sandbox user and needs Codex's one-time elevated setup on the
 * machine. `none` runs a worker with edit access in no sandbox at all and
 * every other worker read-only under `unelevated`: Codex has no tool
 * allowlist, so its sandbox is the only thing that keeps a reader from
 * writing.
 */
export const windowsSandboxes = ['unelevated', 'elevated', 'none'] as const;
export type WindowsSandbox = (typeof windowsSandboxes)[number];

/**
 * The PowerShell execution policy an elevated worker's process tree runs
 * under. As the sandbox user, Windows PowerShell refuses every `.ps1` shim
 * (`npm`, `pnpm`, `npx`), most likely because a user with no policy of its
 * own gets the Windows default, `Restricted`. The variable sets the policy
 * for one process tree only and changes nothing on the machine, and a
 * machine or group policy still overrides it.
 */
export const elevatedExecutionPolicy = { name: 'PSExecutionPolicyPreference', value: 'RemoteSigned' } as const;

/**
 * The caller's environment, with every spelling of PATH merged into one on
 * Windows and directories under WindowsApps removed: Codex runs tools under a
 * restricted token that cannot launch the Store's app-execution aliases.
 * The one is spelled `PATH`, because Codex's elevated runner adds a `PATH`
 * of its own: under any other spelling the worker's process sees two, and a
 * tool that prepends to one while its child shell reads the other, as
 * `pnpm exec` does with `node_modules\.bin`, loses what it prepended (R11
 * of the Codex sandbox). Windows reads the name in any case, so this
 * changes nothing where no runner adds one.
 * Under the elevated sandbox the PowerShell execution policy is set too,
 * unless the caller already sets it to something; under the others the
 * worker runs as the operator's own account, whose policy is the operator's.
 */
export function codexEnvironment(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform, windowsSandbox: WindowsSandbox = 'unelevated'): NodeJS.ProcessEnv {
  if (platform !== 'win32') return { ...environment };
  const directories = spellingsOf(environment, 'PATH', platform)
    .flatMap(([, value]) => (value ?? '').split(';'))
    .filter((directory) => directory.length > 0 && !underWindowsApps(directory));
  const adjusted = { ...withoutVariables(environment, ['PATH'], platform), PATH: directories.join(';') };
  if (windowsSandbox !== 'elevated') return adjusted;
  // An empty value sets no policy, so it is replaced, every other spelling with it.
  const { name, value } = elevatedExecutionPolicy;
  const given = spellingsOf(adjusted, name, platform).some(([, set]) => set !== undefined && set !== '');
  return given ? adjusted : pinVariables(adjusted, { [name]: value }, platform);
}

/**
 * A model provider other than Codex's built-in OpenAI one, written as an
 * entry of Codex's `model_providers` table and chosen as `model_provider`.
 * It is given here because the user's own config, where such an entry
 * usually lives, is ignored. The API key never reaches the command line:
 * `envKey` names the inherited variable Codex reads it from.
 */
export interface CodexProvider {
  /** The provider's key in `model_providers` and its display name: lowercase letters, digits, `_` and `-`. A built-in id such as `openai` is refused by Codex itself. */
  readonly id: string;
  /** The provider's API base URL, http or https, without a user name or password. */
  readonly baseUrl: string;
  /** The inherited environment variable holding the API key. Without it Codex sends the credentials it keeps under `CODEX_HOME`. */
  readonly envKey?: string;
  /** Query parameters added to every request, such as Azure's `api-version`. */
  readonly queryParams?: Readonly<Record<string, string>>;
}

/** How a Codex adapter is built. The user's own config is ignored, so anything a machine needs is chosen here. */
export interface CodexOptions {
  /**
   * Unelevated by default, so a caller that builds the adapter and names
   * nothing, such as the smoke script, keeps every worker confined on any
   * machine, though a fixer there cannot run a Node toolchain's build or
   * tests. Applied only on Windows. A review does not rely on this default:
   * it passes the value the run pinned, from the flag or the policy, which
   * ships `none` (D4 of docs/changes/2026-10-04-codex-sandbox.md).
   */
  readonly windowsSandbox?: WindowsSandbox;
  /** Codex's built-in OpenAI provider by default. */
  readonly provider?: CodexProvider;
}

const codexOptionKeys: readonly (keyof CodexOptions)[] = ['windowsSandbox', 'provider'];
const codexProviderKeys: readonly (keyof CodexProvider)[] = ['id', 'baseUrl', 'envKey', 'queryParams'];

/** The keys of `value` that are not among `known`, which options arriving from outside TypeScript can carry. */
function unknownKeys(value: object, known: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !known.includes(key));
}

/**
 * The provider after every check a command line needs, copied so a caller
 * changing its object later cannot change the adapter. Each value goes
 * straight into a `--config` entry, so a value Codex would read as something
 * other than meant is refused here, before any worker runs.
 */
function checkedProvider(provider: unknown): CodexProvider {
  const refuse = (reason: string): never => {
    throw new Error(`Codex provider ${reason}`);
  };
  if (!isObject(provider)) return refuse('must be an object with an id and a baseUrl');
  const unknown = unknownKeys(provider, codexProviderKeys);
  if (unknown.length > 0) refuse(`has unknown key ${JSON.stringify(unknown[0])}; it takes ${codexProviderKeys.join(', ')}`);
  const { id, baseUrl, envKey, queryParams } = provider;
  if (typeof id !== 'string' || !/^[a-z0-9_-]+$/.test(id)) return refuse(`id ${JSON.stringify(id)} is not lowercase letters, digits, _ and -`);
  if (typeof baseUrl !== 'string' || !baseUrl.isWellFormed()) return refuse(`baseUrl ${JSON.stringify(baseUrl)} is not a string`);
  const url = URL.parse(baseUrl);
  if (url === null) return refuse(`baseUrl ${JSON.stringify(baseUrl)} is not a URL`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') refuse(`baseUrl ${JSON.stringify(baseUrl)} is not http or https`);
  // A command line is visible to every process on the machine; the key belongs in the variable envKey names.
  if (url.username !== '' || url.password !== '') refuse('baseUrl carries a user name or password; name the variable holding the key as envKey instead');
  if (envKey !== undefined && (typeof envKey !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey))) refuse(`envKey ${JSON.stringify(envKey)} is not an environment variable name`);
  if (queryParams !== undefined && !isObject(queryParams)) refuse('queryParams must be an object of strings');
  const params = Object.entries(isObject(queryParams) ? queryParams : {});
  for (const [name, value] of params) {
    if (name === '' || !name.isWellFormed()) refuse(`queryParams has a name ${JSON.stringify(name)} that is empty or not valid Unicode`);
    if (typeof value !== 'string' || !value.isWellFormed()) refuse(`queryParams value of ${JSON.stringify(name)} is not a string`);
  }
  return {
    id,
    baseUrl,
    ...(typeof envKey === 'string' ? { envKey } : {}),
    ...(queryParams === undefined ? {} : { queryParams: Object.freeze(Object.fromEntries(params) as Record<string, string>) }),
  };
}

/**
 * The `--config` entries that choose the provider: `model_provider` and the
 * provider's `model_providers` entry. Its id is a bare TOML key, which the
 * id's pattern guarantees; the query parameters are an inline table with
 * quoted keys.
 */
export function providerConfig(provider: CodexProvider): string[] {
  const entry = `model_providers.${provider.id}`;
  const params = provider.queryParams === undefined ? null : Object.entries(provider.queryParams);
  return [
    `model_provider=${tomlString(provider.id)}`,
    `${entry}.name=${tomlString(provider.id)}`,
    `${entry}.base_url=${tomlString(provider.baseUrl)}`,
    ...(provider.envKey === undefined ? [] : [`${entry}.env_key=${tomlString(provider.envKey)}`]),
    ...(params === null ? [] : [`${entry}.query_params={${params.map(([name, value]) => `${tomlString(name)}=${tomlString(value)}`).join(',')}}`]),
  ];
}

/**
 * The `sandbox_mode` a worker runs under: `read-only` for a reader and
 * `workspace-write` for an editor, except that on Windows under `none` an
 * editor runs in no sandbox, `danger-full-access`. A reader keeps its
 * sandbox under every value, and no other platform has a `none`.
 */
function sandboxMode(invocation: Invocation, platform: NodeJS.Platform, windowsSandbox: WindowsSandbox): 'read-only' | 'workspace-write' | 'danger-full-access' {
  if (invocation.access !== 'edit') return 'read-only';
  return platform === 'win32' && windowsSandbox === 'none' ? 'danger-full-access' : 'workspace-write';
}

/**
 * The Codex command line for one worker. `windowsSandbox` is the adapter's
 * choice, applied only on Windows: Codex's own Windows sandbox for every
 * worker, `unelevated` for the readers under `none`, and the environment
 * the adapter adjusts for it. `provider`, when there is one, is chosen for
 * a fresh worker and a continuation alike.
 */
export function codexCommand(invocation: Invocation, plan: LaunchPlan, windowsSandbox: WindowsSandbox, provider: CodexProvider | null = null): WorkerCommand {
  const mode = sandboxMode(invocation, plan.platform, windowsSandbox);
  // A read-only sandbox writes nowhere and no sandbox needs no root, so only a confined editor is given the scratch directory.
  const writable = mode === 'workspace-write' && plan.scratch !== null ? [plan.scratch] : [];
  const options = [
    '--ignore-user-config',
    '--strict-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--config', `sandbox_mode=${tomlString(mode)}`,
    ...(writable.length === 0 ? [] : ['--config', `sandbox_workspace_write.writable_roots=[${writable.map(tomlString).join(',')}]`]),
    ...(plan.platform === 'win32' ? ['--config', `windows.sandbox=${tomlString(windowsSandbox === 'none' ? 'unelevated' : windowsSandbox)}`] : []),
    ...isolation.flatMap((setting) => ['--config', setting]),
    ...(provider === null ? [] : providerConfig(provider)).flatMap((setting) => ['--config', setting]),
    '--model', invocation.model,
    '--config', `model_reasoning_effort=${tomlString(invocation.effort)}`,
    '--json',
    '--output-schema', plan.schemaFile,
    '--output-last-message', plan.finalMessageFile,
  ];
  return {
    environment: codexEnvironment(plan.environment, plan.platform, windowsSandbox),
    // `-` reads the prompt from stdin; a continuation names its session just before it.
    args: ['--ask-for-approval', 'never', 'exec', ...(plan.resume === null ? [...options, '-'] : ['resume', ...options, plan.resume, '-'])],
  };
}

type CodexEvent = Record<string, unknown>;

/** How much of stderr, from its end, names why a Codex that started no thread stopped. */
const maxStderrExcerpt = 1000;

/**
 * The line Codex logs to stderr when its sandbox cannot run a command at
 * all, as opposed to a command that ran and was refused a write. Such a
 * call leaves no item in the event stream, so stderr is the only place
 * that shows the worker never had a working shell.
 */
const refusedCommand = /\bERROR codex_core::tools::router: error=exec_command failed: (.*)$/gm;

/** The message an `error` or `turn.failed` event carries, if any. */
function eventMessage(event: CodexEvent): string {
  if (typeof event.message === 'string') return event.message;
  if (isObject(event.error) && typeof event.error.message === 'string') return event.error.message;
  return 'no message';
}

/**
 * Whether a failed item is one the model saw and could work around, and so
 * part of its work rather than the worker's failure: a command that ran and
 * exited nonzero (a failing reproducer, a grep with no match, a refused
 * write) or a patch that did not apply. A command that never ran at all has
 * no exit code and is not survivable: the worker had no working shell. An
 * item of a kind not named here that failed is not survivable either.
 */
function survivableFailure(item: Record<string, unknown>): boolean {
  if (item.type === 'file_change') return true;
  return item.type === 'command_execution' && typeof item.exit_code === 'number' && item.exit_code !== 0;
}

/**
 * What one read of the `exec --json` stream established, held as the few
 * facts the rules need rather than as the events themselves, so a stream of
 * any length is read in one pass with one line decoded at a time.
 */
interface StreamFacts {
  /** Each distinct id a `thread.started` named, in the order named. */
  readonly sessionIds: string[];
  /** Why the first line that is not an event object is not one, or null. */
  malformed: string | null;
  /** How many `thread.started` events there were. */
  threads: number;
  /** The `thread_id` the first `thread.started` carried, whatever it was. */
  firstThread: unknown;
  /** How many `turn.completed` events there were. */
  completedTurns: number;
  /** The usage of the last `turn.completed`, or null. */
  usage: unknown;
  /** The type of the last event, whatever it was. */
  lastType: unknown;
  /** The message of the first `turn.failed` event, or null. */
  turnFailed: string | null;
  /** The message of the last `error` event, or null. */
  lastError: string | null;
  /** The first item the worker must not have: one without an id, one outside the boundary, or one that failed and is not survivable. */
  itemProblem: string | null;
  /** Items started and not yet completed. */
  readonly pending: Set<string>;
  /** The text of the last completed `agent_message`. */
  lastMessage: string | undefined;
}

/** Fold one item event into the facts. After the first item problem no item is looked at, since that problem decides. */
function observeItem(facts: StreamFacts, event: CodexEvent): void {
  if (facts.itemProblem !== null) return;
  const item = event.item;
  if (!isObject(item) || typeof item.id !== 'string') {
    facts.itemProblem = `Codex reported ${String(event.type)} without an item id`;
    return;
  }
  // Outside the review's boundary: the isolation config turns both off, so either one means it did not hold.
  if (item.type === 'mcp_tool_call' || item.type === 'web_search') {
    facts.itemProblem = `Codex used ${item.type}, which the worker is not given`;
    return;
  }
  if (event.type === 'item.started') {
    facts.pending.add(item.id);
    return;
  }
  facts.pending.delete(item.id);
  if (item.status === 'failed' && !survivableFailure(item)) {
    facts.itemProblem = `Codex item ${item.id} (${String(item.type)}) failed`;
    return;
  }
  if (item.type === 'agent_message' && typeof item.text === 'string') facts.lastMessage = item.text;
}

/** Fold one event into the facts. */
function observe(facts: StreamFacts, event: CodexEvent): void {
  facts.lastType = event.type;
  switch (event.type) {
    case 'thread.started':
      facts.threads += 1;
      if (facts.threads === 1) facts.firstThread = event.thread_id;
      if (typeof event.thread_id === 'string' && event.thread_id.length > 0 && !facts.sessionIds.includes(event.thread_id)) facts.sessionIds.push(event.thread_id);
      break;
    case 'turn.completed':
      facts.completedTurns += 1;
      facts.usage = event.usage ?? null;
      break;
    case 'turn.failed':
      facts.turnFailed ??= eventMessage(event);
      break;
    case 'error':
      facts.lastError = eventMessage(event);
      break;
    case 'item.started':
    case 'item.completed':
      observeItem(facts, event);
      break;
    default:
      // Any other event, such as `turn.started` or `item.updated`, only counts as the last one.
      break;
  }
}

/**
 * Read the whole stream, one line at a time, before any rule is applied, so
 * a malformed later line cannot hide the session id an earlier one recorded.
 * Lines are numbered from 1, blank ones included, and a blank one is skipped.
 */
function readStream(lines: Iterable<string | null>): StreamFacts {
  const facts: StreamFacts = {
    sessionIds: [],
    malformed: null,
    threads: 0,
    firstThread: undefined,
    completedTurns: 0,
    usage: null,
    lastType: undefined,
    turnFailed: null,
    lastError: null,
    itemProblem: null,
    pending: new Set(),
    lastMessage: undefined,
  };
  let number = 0;
  for (const line of lines) {
    number += 1;
    if (line === null) {
      facts.malformed ??= `Codex printed line ${String(number)} that is longer than the ${String(maxLineBytes)} bytes the launcher decodes as one line`;
      continue;
    }
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      facts.malformed ??= `Codex printed line ${String(number)} that is not JSON: ${(error as Error).message}`;
      continue;
    }
    if (!isObject(event)) {
      facts.malformed ??= `Codex printed line ${String(number)} that is not an event object`;
      continue;
    }
    observe(facts, event);
  }
  return facts;
}

/**
 * Read the `exec --json` event stream, stderr and the final message file.
 * Codex has no denial evidence, so `denials` is always null (TD4); a sandbox
 * that could not run commands at all is a failure, not a denial. The stream
 * is read a line at a time, so its length alone never fails a worker, and
 * all of it is read before any rule is applied. The session ids are the
 * threads the stream started; the launcher adds a continued one itself.
 *
 * A turn that completed is judged by its answer, not by what went wrong on
 * the way: an `error` event (Codex's report of a stream reconnect), an
 * `error` item (its report of a warning) and a survivable failed item leave
 * it standing. Their text stays in stdout, which the launcher keeps as
 * evidence of the worker. A `turn.failed` event always fails the worker.
 */
export function decodeCodex(_invocation: Invocation, plan: LaunchPlan, outputs: WorkerOutputs): Decoded {
  const facts = readStream(outputs.stdoutLines);
  const { sessionIds, usage } = facts;
  const failed = (error: string): Decoded => ({ sessionIds, usage, denials: null, result: { kind: 'failed', error } });

  if (facts.malformed !== null) return failed(facts.malformed);
  const refusals = [...outputs.stderr.matchAll(refusedCommand)].map((match) => match[1]!.trim());
  if (refusals.length > 0) {
    return failed(`Codex refused to run ${String(refusals.length)} command(s) in its sandbox, so the worker had no working shell: ${refusals[0]!.slice(0, 500)}`);
  }
  if (facts.threads !== 1) {
    // A Codex that refused its command line, such as a --config key it does not know, starts no thread and says why only on stderr.
    const said = facts.threads === 0 ? outputs.stderr.trim() : '';
    const reason = said === '' ? '' : `; its stderr ends: ${said.slice(-maxStderrExcerpt).toWellFormed()}`;
    return failed(`Codex started ${String(facts.threads)} threads; a worker is exactly one${reason}`);
  }
  const thread = facts.firstThread;
  if (typeof thread !== 'string' || thread.length === 0) return failed('Codex started a thread without an id');
  if (plan.sessionId !== null && thread !== plan.sessionId) return failed(`Codex ran thread ${thread}, not the continued session ${plan.sessionId}`);
  if (facts.turnFailed !== null) return failed(`Codex reported turn.failed: ${facts.turnFailed}`);
  if (facts.completedTurns !== 1 || facts.lastType !== 'turn.completed') {
    // Codex reports an error it survives, such as a stream reconnect, as an
    // `error` event too, so one only explains a turn that did not complete.
    const reported = facts.lastError === null ? '' : `; it reported error: ${facts.lastError}`;
    return failed(`Codex did not end with exactly one completed turn${reported}`);
  }
  if (facts.itemProblem !== null) return failed(facts.itemProblem);
  const { pending } = facts;
  if (pending.size > 0) return failed(`Codex left ${String(pending.size)} item(s) started without completing: ${[...pending].join(', ')}`);
  if (outputs.finalMessage === null) return failed('Codex wrote no final message file');
  const last = facts.lastMessage;
  if (last === undefined || last.trim() !== outputs.finalMessage.trim()) return failed('Codex wrote a final message that is not its last agent message');
  let value: unknown;
  try {
    value = JSON.parse(outputs.finalMessage);
  } catch (error) {
    return failed(`Codex wrote a final message that is not JSON: ${(error as Error).message}`);
  }
  return { sessionIds, usage, denials: null, result: { kind: 'answer', value } };
}

/**
 * The neutral view of what `decodeCodex` stores as usage, the `usage` of the
 * last `turn.completed`: Codex reports no cost, its `input_tokens` already
 * counts the cached ones, and `cached_input_tokens` says how many of them.
 */
export function summarizeCodexUsage(usage: unknown): UsageSummary {
  if (!isObject(usage)) return emptyUsageSummary;
  return {
    costUsd: null,
    inputTokens: finiteNumber(usage.input_tokens),
    cachedInputTokens: finiteNumber(usage.cached_input_tokens),
    outputTokens: finiteNumber(usage.output_tokens),
  };
}

/**
 * Codex `exec`. Its session id is observed from `thread.started`, it has no
 * budget cap and no denial evidence, every worker has a shell, a read-only
 * sandbox writes nowhere, it has no `max` effort, it resumes by id, and it
 * reports tokens but no cost.
 */
export function createCodexAdapter(options: CodexOptions = {}): RuntimeAdapter {
  // Options can arrive from outside TypeScript, and every value goes straight into a command line.
  const given: unknown = options;
  if (!isObject(given)) throw new Error('Codex options must be an object');
  const unknown = unknownKeys(given, codexOptionKeys);
  if (unknown.length > 0) throw new Error(`Unknown Codex option ${JSON.stringify(unknown[0])}; use ${codexOptionKeys.join(' or ')}`);
  const windowsSandbox = options.windowsSandbox ?? 'unelevated';
  if (!windowsSandboxes.includes(windowsSandbox)) throw new Error(`Unknown Codex Windows sandbox ${JSON.stringify(windowsSandbox)}; use ${windowsSandboxes.join(', ')}`);
  const provider = options.provider === undefined ? null : checkedProvider(options.provider);
  return {
    ...codexRuntime,
    command: (invocation, plan) => codexCommand(invocation, plan, windowsSandbox, provider),
  };
}

/** The name the Codex adapter registers under, which a review's Codex-only settings are keyed by. */
export const codexRuntimeName = 'codex';

/** Everything about the Codex adapter that no option changes; `createCodexAdapter` adds the command. */
const codexRuntime: Omit<RuntimeAdapter, 'command'> = {
  name: codexRuntimeName,
  capabilities: {
    assignsSessionId: false,
    budgetCap: false,
    denialEvidence: false,
    withholdShell: false,
    readOnlyScratch: false,
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
    resume: true,
    costInUsd: false,
  },
  qualification: {
    version: { args: ['--version'], pattern: /^codex-cli (\d+\.\d+\.\d+)$/ },
    help: [
      { args: ['--help'], flags: codexRootFlags },
      { args: ['exec', '--help'], flags: codexExecFlags },
      { args: ['exec', 'resume', '--help'], flags: codexExecFlags },
    ],
  },
  decode: decodeCodex,
  summarizeUsage: summarizeCodexUsage,
};

/** The Codex adapter with its defaults: the unelevated Windows sandbox and the built-in provider. */
export const codexAdapter: RuntimeAdapter = createCodexAdapter();
