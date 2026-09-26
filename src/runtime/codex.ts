import type { Decoded, LaunchPlan, RuntimeAdapter, WorkerCommand, WorkerOutputs } from './adapter.ts';
import type { Invocation } from './contract.ts';
import { spellingsOf, withoutVariables } from './environment.ts';

/** Flags of the top-level command. */
const codexRootFlags = ['--ask-for-approval'] as const;

/**
 * Flags of `exec`, every one of which `exec resume` also takes. The sandbox
 * and its writable roots are `--config` overrides rather than `--sandbox`
 * and `--add-dir`, because `exec resume` accepts neither flag and a
 * continuation must run under the same sandbox as the worker it continues.
 */
const codexExecFlags = [
  '--ignore-user-config',
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

/** A TOML string for a `--config` value. JSON's escapes are a subset of TOML's basic-string escapes. */
const tomlString = (value: string): string => JSON.stringify(value);

/**
 * The caller's environment, with every spelling of PATH merged into one on
 * Windows and directories under WindowsApps removed: Codex runs tools under a
 * restricted token that cannot launch the Store's app-execution aliases.
 */
export function codexEnvironment(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  if (platform !== 'win32') return { ...environment };
  const directories = spellingsOf(environment, 'PATH')
    .flatMap(([, value]) => (value ?? '').split(';'))
    .filter((directory) => directory.length > 0 && !directory.toLowerCase().includes('windowsapps'));
  return { ...withoutVariables(environment, ['PATH']), Path: directories.join(';') };
}

export function codexCommand(invocation: Invocation, plan: LaunchPlan): WorkerCommand {
  const writable = invocation.access === 'edit' && plan.scratch !== null ? [plan.scratch] : [];
  const options = [
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--config', `sandbox_mode=${tomlString(invocation.access === 'edit' ? 'workspace-write' : 'read-only')}`,
    // A read-only sandbox writes nowhere, so only an editor is given the scratch directory.
    ...(writable.length === 0 ? [] : ['--config', `sandbox_workspace_write.writable_roots=[${writable.map(tomlString).join(',')}]`]),
    ...(plan.platform === 'win32' ? ['--config', 'windows.sandbox="unelevated"'] : []),
    ...isolation.flatMap((setting) => ['--config', setting]),
    '--model', invocation.model,
    '--config', `model_reasoning_effort=${tomlString(invocation.effort)}`,
    '--json',
    '--output-schema', plan.schemaFile,
    '--output-last-message', plan.finalMessageFile,
  ];
  return {
    environment: codexEnvironment(plan.environment, plan.platform),
    // `-` reads the prompt from stdin; a continuation names its session just before it.
    args: ['--ask-for-approval', 'never', 'exec', ...(plan.resume === null ? [...options, '-'] : ['resume', ...options, plan.resume, '-'])],
  };
}

type CodexEvent = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The message an `error` or `turn.failed` event carries, if any. */
function eventMessage(event: CodexEvent): string {
  if (typeof event.message === 'string') return event.message;
  if (isObject(event.error) && typeof event.error.message === 'string') return event.error.message;
  return 'no message';
}

/**
 * Read the `exec --json` event stream and the final message file. Codex has
 * no denial evidence, so `denials` is always null (TD4). Every complete line
 * is parsed before any rule is applied, so a malformed later line cannot hide
 * the session id an earlier one recorded.
 */
export function decodeCodex(_invocation: Invocation, plan: LaunchPlan, outputs: WorkerOutputs): Decoded {
  const sessionIds: string[] = plan.sessionId === null ? [] : [plan.sessionId];
  const events: CodexEvent[] = [];
  let malformed: string | null = null;
  for (const [index, line] of outputs.stdout.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      malformed ??= `Codex printed line ${String(index + 1)} that is not JSON: ${(error as Error).message}`;
      continue;
    }
    if (!isObject(event)) {
      malformed ??= `Codex printed line ${String(index + 1)} that is not an event object`;
      continue;
    }
    events.push(event);
    if (event.type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id.length > 0 && !sessionIds.includes(event.thread_id)) {
      sessionIds.push(event.thread_id);
    }
  }
  const completed = events.filter((event) => event.type === 'turn.completed');
  const usage = completed.at(-1)?.usage ?? null;
  const failed = (error: string): Decoded => ({ sessionIds, usage, denials: null, answer: null, budgetStop: false, error });

  if (malformed !== null) return failed(malformed);
  const threads = events.filter((event) => event.type === 'thread.started');
  if (threads.length !== 1) return failed(`Codex started ${String(threads.length)} threads; a worker is exactly one`);
  const thread = threads[0]!.thread_id;
  if (typeof thread !== 'string' || thread.length === 0) return failed('Codex started a thread without an id');
  if (plan.sessionId !== null && thread !== plan.sessionId) return failed(`Codex ran thread ${thread}, not the continued session ${plan.sessionId}`);
  const failure = events.find((event) => event.type === 'error' || event.type === 'turn.failed');
  if (failure !== undefined) return failed(`Codex reported ${String(failure.type)}: ${eventMessage(failure)}`);
  if (completed.length !== 1 || events.at(-1)?.type !== 'turn.completed') return failed('Codex did not end with exactly one completed turn');

  const pending = new Set<string>();
  const messages: string[] = [];
  for (const event of events) {
    if (event.type !== 'item.started' && event.type !== 'item.completed') continue;
    const item = event.item;
    if (!isObject(item) || typeof item.id !== 'string') return failed(`Codex reported ${event.type} without an item id`);
    // Outside the review's boundary: the isolation config turns both off, so either one means it did not hold.
    if (item.type === 'mcp_tool_call' || item.type === 'web_search') return failed(`Codex used ${item.type}, which the worker is not given`);
    if (event.type === 'item.started') {
      pending.add(item.id);
      continue;
    }
    pending.delete(item.id);
    // A command may exit nonzero on purpose: a failing reproducer, a grep with no match, a refused write.
    const nonzeroCommand = item.type === 'command_execution' && typeof item.exit_code === 'number' && item.exit_code !== 0;
    if (item.type === 'error' || (item.status === 'failed' && !nonzeroCommand)) return failed(`Codex item ${item.id} (${String(item.type)}) failed`);
    if (item.type === 'agent_message' && typeof item.text === 'string') messages.push(item.text);
  }
  if (pending.size > 0) return failed(`Codex left ${String(pending.size)} item(s) started without completing: ${[...pending].join(', ')}`);
  if (outputs.finalMessage === null) return failed('Codex wrote no final message file');
  const last = messages.at(-1);
  if (last === undefined || last.trim() !== outputs.finalMessage.trim()) return failed('Codex wrote a final message that is not its last agent message');
  let value: unknown;
  try {
    value = JSON.parse(outputs.finalMessage);
  } catch (error) {
    return failed(`Codex wrote a final message that is not JSON: ${(error as Error).message}`);
  }
  return { sessionIds, usage, denials: null, answer: { value }, budgetStop: false, error: null };
}

/**
 * Codex `exec`. Its session id is observed from `thread.started`, it has no
 * budget cap and no denial evidence, every worker has a shell, a read-only
 * sandbox writes nowhere, it has no `max` effort, and it resumes by id.
 */
export const codexAdapter: RuntimeAdapter = {
  name: 'codex',
  capabilities: {
    assignsSessionId: false,
    budgetCap: false,
    denialEvidence: false,
    withholdShell: false,
    readOnlyScratch: false,
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
    resume: true,
  },
  qualification: {
    version: { args: ['--version'], pattern: /^codex-cli (\d+\.\d+\.\d+)$/ },
    help: [
      { args: ['--help'], flags: codexRootFlags },
      { args: ['exec', '--help'], flags: codexExecFlags },
      { args: ['exec', 'resume', '--help'], flags: codexExecFlags },
    ],
  },
  command: codexCommand,
  decode: decodeCodex,
};
