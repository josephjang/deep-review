/**
 * The settings in a run (R1, R4, R6, R11 of the configuration): the source
 * of a caller that gives none, what the role policy and the checks read of
 * the resolved settings, the check settings a run recorded, and the lines
 * the run prints when it is configured from the settings and when a
 * resumed run meets settings other than the ones it recorded.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewConfiguration } from '../checkpoint/events.ts';
import { dedicatedFlagValues } from '../config/flags.ts';
import { fixSideNames, recordedNames, settingOf } from '../config/record.ts';
import { resolvedValue, type FlagLayer, type ResolvedSettings } from '../config/resolve.ts';
import { checkSettingName, isConfiguredRuntime, layerWords, runtimeSettingNames, type Layer, type SettingName } from '../config/settings.ts';
import { configurationSource, type ConfigurationSource } from '../config/source.ts';
import { canonicalPath, isFile } from '../paths.ts';
import type { CheckFlags } from './checks/discover.ts';
import { ReviewRefusedError } from './errors.ts';
import type { PolicyFlags, PolicyOverrides } from './policy.ts';
import { checkKinds, type CheckKind } from './vocabulary.ts';

/** What a caller that gives no configuration source names of its flags. */
export interface UnconfiguredOptions {
  readonly worktree: string;
  readonly runtime: string;
  readonly flags: PolicyFlags;
  readonly fix?: CheckFlags | null;
  readonly executable: string | ((configured: string | null) => string);
  readonly executableArgs?: readonly string[];
}

/**
 * The configuration of a caller that gives none, a library caller or a
 * test: no operator's, clone's or invocation file, the repository's file
 * read at the base as a command's is, and a flag layer of the caller's
 * flags, its check flags, and its executable when it names one. The
 * flags are not checked here: the role policy checks them as it checks a
 * command's (`refuseInvocationFlags`), with the messages a caller knows.
 */
export function unconfiguredSource(options: UnconfiguredOptions): ConfigurationSource {
  const values = dedicatedFlagValues({
    runtime: options.runtime,
    policy: options.flags,
    checks: options.fix ?? null,
    ...(typeof options.executable === 'string' ? { executable: options.executable } : {}),
    ...(options.executableArgs === undefined ? {} : { executableArgs: options.executableArgs }),
  });
  const flags: FlagLayer = new Map(values.map((value) => [value.name, value]));
  return configurationSource({ worktree: options.worktree, locations: null, repositoryConfig: true, flags });
}

/** The values the role policy reads of the resolved settings (R12): the models, the concurrency, the run budget, the Codex Windows sandbox, the check timeout and the reviewer's own rules. */
export function policyOverridesOf(resolved: ResolvedSettings): PolicyOverrides {
  const runtime = isConfiguredRuntime(resolved.runtime) ? runtimeSettingNames(resolved.runtime) : null;
  const strong = runtime === null ? null : (resolved.values[runtime.strong].value as string | null);
  const fast = runtime === null ? null : (resolved.values[runtime.fast].value as string | null);
  const sandbox = resolvedValue(resolved, 'runtimes.codex.windows_sandbox');
  const minutes = resolvedValue(resolved, 'checks.timeout_minutes');
  const userRules = resolvedValue(resolved, 'conventions.user_rules');
  const concurrency = resolvedValue(resolved, 'run.concurrency');
  return {
    ...(strong === null ? {} : { strongModel: strong }),
    ...(fast === null ? {} : { fastModel: fast }),
    ...(concurrency === null ? {} : { concurrency }),
    budgetUsd: resolvedValue(resolved, 'budget.usd'),
    ...(resolved.runtime !== 'codex' || sandbox === null ? {} : { codexWindowsSandbox: sandbox }),
    ...(minutes === null ? {} : { checksTimeoutMs: Math.round(minutes * 60_000) }),
    ...(userRules === null ? {} : { userRules }),
  };
}

/** The runtime's executable and arguments as the settings resolved them: the executable null when no layer names one. */
export function executableOf(resolved: ResolvedSettings): { executable: string | null; args: readonly string[] } {
  if (!isConfiguredRuntime(resolved.runtime)) return { executable: null, args: [] };
  const names = runtimeSettingNames(resolved.runtime);
  return { executable: resolved.values[names.executable].value as string | null, args: (resolved.values[names.args].value as string[] | null) ?? [] };
}

/** The checks the resolved settings settle, each with its layer (R11): a command, `false` for a dropped kind, or nothing, which the survey decides. */
export function checkFlagsOfResolved(resolved: ResolvedSettings): CheckFlags {
  const commands: Partial<Record<CheckKind, string>> = {};
  const dropped: CheckKind[] = [];
  const layers: Partial<Record<CheckKind, Exclude<Layer, 'default'>>> = {};
  for (const kind of checkKinds) {
    const { value, layer } = resolved.values[checkSettingName(kind)];
    if (value === null || layer === 'default') continue;
    if (value === false) dropped.push(kind);
    else commands[kind] = value as string;
    layers[kind] = layer;
  }
  return { commands, dropped, layers };
}

/**
 * The checks a run recorded the settings of (R11): the configuration's, or
 * a version 2 pin's fix side, each kind's command or drop with its layer;
 * null for a run that recorded none, a read-only run's or one configured
 * before the settings, whose check flags are its invocation's.
 */
export function recordedCheckFlags(configuration: ReviewConfiguration): CheckFlags | null {
  const recorded = configuration.fixSettings !== null || (configuration.settings !== null && configuration.settings.values['checks.build'] !== undefined);
  if (!recorded) return null;
  const commands: Partial<Record<CheckKind, string>> = {};
  const dropped: CheckKind[] = [];
  const layers: Partial<Record<CheckKind, Exclude<Layer, 'default'>>> = {};
  for (const kind of checkKinds) {
    const { value, layer } = settingOf(configuration, checkSettingName(kind));
    if (value === null || layer === null || layer === 'default') continue;
    if (value === false) dropped.push(kind);
    else commands[kind] = value as string;
    layers[kind] = layer;
  }
  return { commands, dropped, layers };
}

/**
 * The check settings in force for a fix run that has not planned its
 * checks (R11 of the configuration, TD6 of the repository survey): the
 * ones the run recorded, each kind this invocation's `--check`,
 * `--no-check` or `--set checks.<kind>` settles taking the flag's place,
 * since a flag settles its kind for the invocation that gives it, as a
 * blocker's action asks; a run that recorded none has the flags alone.
 */
export function checkFlagsInForce(recorded: CheckFlags | null, invocation: CheckFlags | null): CheckFlags {
  const flags = invocation ?? { commands: {}, dropped: [] };
  if (recorded === null) return flags;
  const commands: Partial<Record<CheckKind, string>> = {};
  const dropped: CheckKind[] = [];
  const layers: Partial<Record<CheckKind, Exclude<Layer, 'default'>>> = {};
  for (const kind of checkKinds) {
    const flagged = flags.dropped.includes(kind) ? null : flags.commands[kind];
    const fromFlag = flags.dropped.includes(kind) || flagged !== undefined;
    const source = fromFlag ? flags : recorded;
    if (source.dropped.includes(kind)) dropped.push(kind);
    else if (source.commands[kind] !== undefined) commands[kind] = source.commands[kind];
    else continue;
    layers[kind] = fromFlag ? 'flag' : (recorded.layers?.[kind] ?? 'flag');
  }
  return { commands, dropped, layers };
}

/** The oldest Node the engine runs on, as `package.json` says: what a fixer's `snapshot` and `claim` commands need. */
export const minimumNodeMajor = 26;

/** Ask a `node` executable its version, as `node --version` prints it. */
const nodeVersionOf = (executable: string): string => execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Refuse a `tools.path` whose `node` is older than the engine needs (R11
 * of the configuration): the fixers run the engine's `snapshot` and
 * `claim` commands as `node` on their `PATH`, which these directories
 * come first on, so such a `node` would run them and fail. Each
 * directory's `node`, other than the engine's own, is asked its version,
 * and one older than 26, or that cannot answer, refuses the run before it
 * exists. A directory with no `node` is left alone.
 */
export function refuseOldNode(toolsPath: readonly string[], platform: NodeJS.Platform, versionOf: (executable: string) => string = nodeVersionOf): void {
  const own = canonicalPath(process.execPath);
  for (const directory of toolsPath) {
    const executable = join(directory, platform === 'win32' ? 'node.exe' : 'node');
    if (!isFile(executable) || canonicalPath(executable) === own) continue;
    const action = `a fixer runs the engine's snapshot and claim commands with the first node on its PATH, which tools.path comes first on, and they need Node ${String(minimumNodeMajor)} or newer; remove ${directory} from tools.path, or put a newer node there`;
    let version: string;
    try {
      version = versionOf(executable).trim();
    } catch (error) {
      throw new ReviewRefusedError(`tools.path names ${directory}, whose node cannot be asked its version: ${error instanceof Error ? error.message : String(error)}; ${action}`);
    }
    const major = /^v?(\d+)\./.exec(version)?.[1];
    if (major === undefined || Number(major) < minimumNodeMajor) throw new ReviewRefusedError(`tools.path names ${directory}, whose node is ${version}; ${action}`);
  }
}

/** A value as a line names it. */
const valueWords = (value: unknown): string => (value === null ? 'none' : JSON.stringify(value));

/**
 * What a new run configured from the settings says on stderr (R4, R5,
 * R11): the files it read, each with its layer, or that it read none; a
 * repository's file skipped by `--no-repository-config`, or edited by the
 * change, whose edit applies to later changes; each setting ignored; and
 * each `tools.path` directory that does not exist yet, which is kept, since
 * a check can create it.
 */
export function configuredLines(runId: string, resolved: ResolvedSettings): string[] {
  const files = resolved.files.map((file) => `${layerWords[file.layer]} ${file.path}${file.commit === null ? '' : ` at ${file.commit}`}`);
  const tools = resolvedValue(resolved, 'tools.path') ?? [];
  return [
    `run ${runId}: settings from ${files.length === 0 ? 'the defaults and the flags; no configuration file' : files.join(', ')}`,
    ...(resolved.repository.state === 'skipped' ? [`run ${runId}: the repository's file was skipped by --no-repository-config, so the run does not apply the policy of the repository`] : []),
    ...(resolved.repository.edited ? [`run ${runId}: this change edits .deep-review/config.toml; the edit applies to later changes, and this review reads the file as its base holds it`] : []),
    ...resolved.ignored.map((entry) => `run ${runId}: ignored ${entry.name} in ${entry.path}: ${entry.reason}`),
    ...tools.filter((directory) => !existsSync(directory)).map((directory) => `run ${runId}: tools.path names ${directory}, which does not exist yet; it goes first on PATH anyway`),
  ];
}

/**
 * What a resumed run says of the settings as they are now (R6): each file
 * it recorded that changed or is gone, and each recorded setting whose
 * value now differs, which the run does not apply. A setting a dedicated
 * flag gives is left to that flag's own line; the concurrency and the run
 * budget a flag gives apply per invocation; the executable is the one the
 * run pinned, which the resume preflights.
 */
export function unappliedLines(runId: string, configuration: ReviewConfiguration, now: ResolvedSettings, flags: FlagLayer): string[] {
  // A continuation read the files again, so its record is the one the files are compared with.
  const recordedFiles = (configuration.fixSettings ?? configuration.settings)?.files ?? [];
  const fileLines = recordedFiles.flatMap((file) => {
    const current = now.files.find((candidate) => candidate.layer === file.layer && candidate.path === file.path);
    if (current === undefined) return [`run ${runId}: ${layerWords[file.layer]} ${file.path} is gone since the run recorded it; the run keeps what it recorded`];
    return current.sha256 === file.sha256 ? [] : [`run ${runId}: ${layerWords[file.layer]} ${file.path} changed since the run recorded it; the run keeps what it recorded`];
  });
  const newFiles = now.files.filter((file) => !recordedFiles.some((recorded) => recorded.layer === file.layer && recorded.path === file.path)).map((file) => `run ${runId}: ${layerWords[file.layer]} ${file.path} is new since the run recorded its settings; it does not apply`);
  // A run configured before the settings recorded only its fix side, if a continuation recorded one.
  const names = [...new Set<SettingName>([...(configuration.settings === null ? [] : recordedNames(configuration)), ...(configuration.fixSettings === null ? [] : fixSideNames)])];
  const executable = isConfiguredRuntime(configuration.runtime) ? runtimeSettingNames(configuration.runtime).executable : null;
  const settingLines = names.flatMap((name) => {
    const current = now.values[name];
    const flag = flags.get(name);
    if (name === executable || (flag !== undefined && !flag.flag.startsWith('--set'))) return [];
    // The concurrency and the run budget a flag gives apply per invocation, and so do the check settings until the checks are planned.
    if ((name === 'run.concurrency' || name === 'budget.usd' || (name.startsWith('checks.') && name !== 'checks.timeout_minutes')) && current.layer === 'flag') return [];
    const recorded = settingOf(configuration, name);
    if (JSON.stringify(recorded.value) === JSON.stringify(current.value)) return [];
    return [`run ${runId}: ${name} is now ${valueWords(current.value)} from ${flag?.flag ?? layerWords[current.layer]}, which is not applied; the run keeps ${valueWords(recorded.value)}${recorded.layer === null ? '' : ` from ${layerWords[recorded.layer]}`}`];
  });
  return [...fileLines, ...newFiles, ...settingLines];
}
