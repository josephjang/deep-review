import type { Access, DeniedTool, Effort } from '../checkpoint/events.ts';
import type { Decoded, LaunchPlan, RuntimeAdapter, WorkerCommand, WorkerOutputs } from './adapter.ts';
import type { Invocation } from './contract.ts';
import { pinVariables, spellingsOf, withoutVariables } from './environment.ts';
import { InheritedOverrideError } from './errors.ts';
import { isObject } from './json.ts';

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

/** How long a denial's command or path may be on the receipt. */
const maxDenialDetail = 300;

/** The Claude Code tools for the two permission axes (TD3): reading always, the shell and editing on request. */
export function claudeTools(access: Access, shell: boolean): string[] {
  return ['Read', 'Glob', 'Grep', ...(shell ? ['Bash'] : []), ...(access === 'edit' ? ['Edit', 'Write'] : [])];
}

/**
 * The caller's environment with the effort and auto memory pinned. Claude
 * Code lets `CLAUDE_CODE_EFFORT_LEVEL` outrank `--effort`, so both are set;
 * an inherited thinking override is refused by name rather than dropped, so
 * the operator learns their shell was changing every worker. A name is any
 * spelling on Windows, where the worker reads every spelling as one
 * variable, and the exact name elsewhere.
 */
export function claudeEnvironment(environment: NodeJS.ProcessEnv, effort: Effort, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  for (const name of thinkingOverrides) {
    for (const [spelling, value] of spellingsOf(environment, name, platform)) {
      if (value !== undefined && value.trim() !== '') throw new InheritedOverrideError(spelling, 'would override the pinned effort');
    }
  }
  return pinVariables(withoutVariables(environment, thinkingOverrides, platform), { CLAUDE_CODE_EFFORT_LEVEL: effort, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, platform);
}

export function claudeCommand(invocation: Invocation, plan: LaunchPlan): WorkerCommand {
  if (plan.sessionId === null) throw new Error('A Claude Code worker needs its session id before launch');
  const tools = claudeTools(invocation.access, invocation.shell).join(',');
  return {
    environment: claudeEnvironment(plan.environment, invocation.effort, plan.platform),
    args: [
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
      '--setting-sources', '',
      '--settings', JSON.stringify({ autoMemoryEnabled: false, claudeMdExcludes: ['**'] }),
      '--json-schema', plan.schema.text,
    ],
  };
}

/** A denial without readable input is still a denial; keep the tool and whatever detail there is. */
function deniedTools(denials: readonly unknown[]): DeniedTool[] {
  return denials.map((entry) => {
    const denial = isObject(entry) ? entry : {};
    const tool = typeof denial.tool_name === 'string' && denial.tool_name.length > 0 ? denial.tool_name : 'unknown tool';
    const input = isObject(denial.tool_input) ? denial.tool_input : {};
    const detail = ['command', 'file_path', 'path', 'url'].map((key) => input[key]).find((value): value is string => typeof value === 'string');
    return { tool, detail: detail === undefined ? null : detail.slice(0, maxDenialDetail) };
  });
}

const isBudgetStop = (envelope: Record<string, unknown>): boolean =>
  envelope.terminal_reason === 'budget_exhausted' || (typeof envelope.subtype === 'string' && envelope.subtype.startsWith('error_max_budget'));

/**
 * Read the `--output-format json` envelope. The session ids are the one the
 * envelope names, if any; the launcher adds the pinned or continued id to
 * every finish, so a worker that never answered still names its transcript.
 */
export function decodeClaude(invocation: Invocation, plan: LaunchPlan, outputs: WorkerOutputs): Decoded {
  const expected = plan.sessionId;
  const failed = (error: string, known: Omit<Decoded, 'result'> = { sessionIds: [], usage: null, denials: null }): Decoded => ({ ...known, result: { kind: 'failed', error } });

  let parsed: unknown;
  try {
    parsed = JSON.parse(outputs.stdout);
  } catch (error) {
    return failed(outputs.stdout.trim() === '' ? 'Claude Code printed no result envelope' : `Claude Code printed a result envelope that is not JSON: ${(error as Error).message}`);
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
 * Claude Code in headless mode. It takes a session id before launch, stops at
 * a budget, lists the tool calls it refused, runs without a shell, lets a
 * read-only worker write to an added directory, and resumes a session by id.
 */
export const claudeAdapter: RuntimeAdapter = {
  name: 'claude',
  capabilities: {
    assignsSessionId: true,
    budgetCap: true,
    denialEvidence: true,
    withholdShell: true,
    readOnlyScratch: true,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    resume: true,
  },
  qualification: {
    version: { args: ['--version'], pattern: /^(\d+\.\d+\.\d+) \(Claude Code\)$/ },
    help: [{ args: ['--help'], flags: claudeFlags }],
  },
  command: claudeCommand,
  decode: decodeClaude,
};
