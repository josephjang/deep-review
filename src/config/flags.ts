/**
 * The dedicated flags as settings (TD9 of the configuration): each flag
 * that sets a setting gives its value to the flag layer, as `--set` does,
 * and the flag layer gives back what the run's policy and checks read of
 * an invocation's flags, so a `--set` of a setting a dedicated flag also
 * sets acts as that flag would.
 */
import { flagCheckSettings, type CheckSettings } from '../review/checks/discover.ts';
import type { PolicyFlags } from '../review/policy.ts';
import { checkKinds, type CheckKind } from '../review/vocabulary.ts';
import { isWindowsSandbox } from '../runtime/codex.ts';
import type { FlagLayer, FlagValue } from './resolve.ts';
import { checkSettingName, isConfiguredRuntime, runtimeSettingNames } from './settings.ts';

/** What the dedicated flags of an invocation give, as the command line parsed and checked them. */
export interface DedicatedFlags {
  readonly runtime: string;
  readonly policy: PolicyFlags;
  /** The `--check` and `--no-check` of a `--fix`, or null. */
  readonly checks: CheckSettings | null;
  /** `--executable`, as given. */
  readonly executable?: string;
  /** Each `--executable-arg`; none given is no value. */
  readonly executableArgs?: readonly string[];
  /** `--base`. */
  readonly base?: string;
}

/**
 * The flag values the dedicated flags give, each named as the command
 * line spells it (the table of TD9): the models, executable and arguments
 * of the run's runtime, the Codex Windows sandbox, the concurrency, the run
 * budget, each check a `--check` or `--no-check` settles, and the base.
 */
export function dedicatedFlagValues(flags: DedicatedFlags): FlagValue[] {
  const values: FlagValue[] = [];
  const runtime = isConfiguredRuntime(flags.runtime) ? runtimeSettingNames(flags.runtime) : null;
  const { policy } = flags;
  if (runtime !== null && policy.strongModel !== undefined) values.push({ name: runtime.strong, value: policy.strongModel, flag: '--strong-model' });
  if (runtime !== null && policy.fastModel !== undefined) values.push({ name: runtime.fast, value: policy.fastModel, flag: '--fast-model' });
  if (runtime !== null && flags.executable !== undefined) values.push({ name: runtime.executable, value: flags.executable, flag: '--executable' });
  if (runtime !== null && flags.executableArgs !== undefined && flags.executableArgs.length > 0) values.push({ name: runtime.args, value: [...flags.executableArgs], flag: '--executable-arg' });
  if (policy.codexWindowsSandbox !== undefined) values.push({ name: 'runtimes.codex.windows_sandbox', value: policy.codexWindowsSandbox, flag: '--codex-windows-sandbox' });
  if (policy.concurrency !== undefined) values.push({ name: 'run.concurrency', value: policy.concurrency, flag: '--concurrency' });
  if (policy.budgetUsd !== undefined) values.push({ name: 'budget.usd', value: policy.budgetUsd, flag: '--budget-usd' });
  for (const kind of checkKinds) {
    if (flags.checks === null) break;
    if (flags.checks.dropped.includes(kind)) values.push({ name: checkSettingName(kind), value: false, flag: '--no-check' });
    else if (flags.checks.commands[kind] !== undefined) values.push({ name: checkSettingName(kind), value: flags.checks.commands[kind], flag: '--check' });
  }
  if (flags.base !== undefined) values.push({ name: 'review.base', value: flags.base, flag: '--base' });
  return values;
}

/**
 * What a run's policy reads of an invocation's flags: each of the flag
 * layer's values a dedicated policy flag sets for the run's runtime,
 * whether that flag or `--set` gave it, so both are checked and applied
 * alike, per invocation for the concurrency and the run budget.
 */
export function policyFlagsOf(layer: FlagLayer, runtime: string): PolicyFlags {
  const names = isConfiguredRuntime(runtime) ? runtimeSettingNames(runtime) : null;
  const strong = names === null ? undefined : layer.get(names.strong)?.value;
  const fast = names === null ? undefined : layer.get(names.fast)?.value;
  const concurrency = layer.get('run.concurrency')?.value;
  const budget = layer.get('budget.usd')?.value;
  const sandbox = runtime === 'codex' ? layer.get('runtimes.codex.windows_sandbox')?.value : undefined;
  return {
    ...(typeof strong === 'string' ? { strongModel: strong } : {}),
    ...(typeof fast === 'string' ? { fastModel: fast } : {}),
    ...(typeof concurrency === 'number' ? { concurrency } : {}),
    ...(typeof budget === 'number' ? { budgetUsd: budget } : {}),
    ...(isWindowsSandbox(sandbox) ? { codexWindowsSandbox: sandbox } : {}),
  };
}

/** The checks the flag layer settles, `--check`, `--no-check` and `--set checks.<kind>` alike, each of the flag layer. */
export function checkFlagsOf(layer: FlagLayer): CheckSettings {
  const commands: Partial<Record<CheckKind, string>> = {};
  const dropped: CheckKind[] = [];
  for (const kind of checkKinds) {
    const value = layer.get(checkSettingName(kind))?.value;
    if (value === false) dropped.push(kind);
    else if (typeof value === 'string') commands[kind] = value;
  }
  return flagCheckSettings(commands, dropped);
}
