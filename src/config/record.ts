/**
 * The settings as a run records them (R6, R17, TD4 of the configuration):
 * the block `review.configured@6` adds beside version 5's fields, the fix
 * side a `fix.pinned@2` records, and `settingOf`, the one reader of a
 * recorded setting, which the report, `status` and the controller use
 * whichever version recorded the run.
 */
import type { FixSettingsRecorded, ReviewConfiguration, ReviewConfigurationV5, SettingsRecorded } from '../checkpoint/events.ts';
import type { ResolvedSettings } from './resolve.ts';
import { checkSettingNames, isConfiguredRuntime, runtimeSettingNames, type Layer, type SettingName, type SettingValue } from './settings.ts';

/** A value as the record holds one: what a file or a flag gives is JSON-like. */
type JsonValue = SettingsRecorded['notFollowed'][number]['value'];

/** A setting as a run recorded it: its value, and its layer, or null for a run configured before the settings existed, whose values came from the defaults or its flags, which the ledger does not tell apart. */
export interface RecordedSetting<V = unknown> {
  readonly value: V;
  readonly layer: Layer | null;
}

/** The settings a continuation records with the fix side (R6): the check commands, the check timeout and `tools.path`. */
export const fixSideNames: readonly SettingName[] = [...checkSettingNames, 'checks.timeout_minutes', 'tools.path'];

/**
 * The settings a run records, by what it is (R6): the ones that choose,
 * shape and run every review; the check settings only in a run that
 * fixes; the run budget always, null on a runtime that reports no cost;
 * the runtime's own models, executable and arguments; and the Codex
 * Windows sandbox only where the run pins one.
 */
export function recordedNames(configuration: Pick<ReviewConfigurationV5, 'runtime' | 'fix' | 'codex'>): SettingName[] {
  const runtime = isConfiguredRuntime(configuration.runtime) ? Object.values(runtimeSettingNames(configuration.runtime)) : [];
  return [
    'review.base', 'scope.default', 'scope.exclude', 'tools.path', 'conventions.user_rules', 'budget.usd', 'run.concurrency',
    ...(configuration.fix ? [...checkSettingNames, 'checks.timeout_minutes' as const] : []),
    ...runtime,
    ...(configuration.codex === null ? [] : ['runtimes.codex.windows_sandbox' as const]),
  ];
}

/** The most ignored settings a record names. */
export const maxRecordedIgnored = 256;

/** The longest name of an ignored setting a record holds. */
export const maxIgnoredNameLength = 1000;

/**
 * The ignored settings as a record holds them: at most 256, each name cut
 * to 1000 characters and an empty one written as its quotes. An operator's
 * or a clone's file can hold any name TOML takes, and the run must record
 * what it ignored without being refused for it.
 */
export function ignoredRecordOf(ignored: ResolvedSettings['ignored']): SettingsRecorded['ignored'] {
  return ignored.slice(0, maxRecordedIgnored).map((entry) => ({ ...entry, name: entry.name === '' ? '""' : entry.name.slice(0, maxIgnoredNameLength) }));
}

/**
 * The block `review.configured@6` records for a run of this configuration
 * (R6): the files, the state of the repository's file, the values version
 * 5 has no field for, the layer of each recorded setting, the repository
 * values not followed and the settings ignored. A check setting is
 * recorded only in a run that fixes.
 */
export function settingsRecordOf(resolved: ResolvedSettings, configuration: Pick<ReviewConfigurationV5, 'runtime' | 'fix' | 'codex'>): SettingsRecorded {
  const value = <N extends SettingName>(name: N): SettingValue<N> => resolved.values[name].value as SettingValue<N>;
  const checks = configuration.fix ? { 'checks.build': value('checks.build'), 'checks.typecheck': value('checks.typecheck'), 'checks.lint': value('checks.lint'), 'checks.test': value('checks.test') } : {};
  const names = recordedNames(configuration);
  return {
    files: resolved.files.map((file) => ({ ...file })),
    repository: { ...resolved.repository },
    values: {
      'review.base': value('review.base'),
      'scope.default': value('scope.default') ?? 'auto',
      'scope.exclude': [...(value('scope.exclude') ?? [])],
      'tools.path': [...(value('tools.path') ?? [])],
      ...checks,
    },
    layers: Object.fromEntries(names.map((name) => [name, resolved.values[name].layer])),
    notFollowed: resolved.notFollowed.filter((entry) => names.includes(entry.name)).map((entry) => ({ name: entry.name, repository: entry.repository as JsonValue, value: entry.value as JsonValue, layer: entry.layer })),
    ignored: ignoredRecordOf(resolved.ignored),
  };
}

/** The fix side a continuation records (R6, R7): the check commands and `tools.path` with their layers, the layer of the check timeout, whose value the pin's `checks` holds, and where it took them from: the files, the repository's file, the fix side's values not followed and the settings ignored. */
export function fixSettingsRecordOf(resolved: ResolvedSettings): FixSettingsRecorded {
  const value = <N extends SettingName>(name: N): SettingValue<N> => resolved.values[name].value as SettingValue<N>;
  return {
    files: resolved.files.map((file) => ({ ...file })),
    repository: { ...resolved.repository },
    notFollowed: resolved.notFollowed.filter((entry) => fixSideNames.includes(entry.name)).map((entry) => ({ name: entry.name, repository: entry.repository as JsonValue, value: entry.value as JsonValue, layer: entry.layer })),
    ignored: ignoredRecordOf(resolved.ignored),
    values: { 'checks.build': value('checks.build'), 'checks.typecheck': value('checks.typecheck'), 'checks.lint': value('checks.lint'), 'checks.test': value('checks.test'), 'tools.path': [...(value('tools.path') ?? [])] },
    layers: {
      'checks.build': resolved.values['checks.build'].layer,
      'checks.typecheck': resolved.values['checks.typecheck'].layer,
      'checks.lint': resolved.values['checks.lint'].layer,
      'checks.test': resolved.values['checks.test'].layer,
      'checks.timeout_minutes': resolved.values['checks.timeout_minutes'].layer,
      'tools.path': resolved.values['tools.path'].layer,
    },
  };
}

/** The value version 5 records in a field of its own for a setting, or undefined for a setting it has no field for. */
function fieldValue(configuration: ReviewConfiguration, name: SettingName): unknown {
  const runtime = isConfiguredRuntime(configuration.runtime) ? runtimeSettingNames(configuration.runtime) : null;
  switch (name) {
    case 'run.concurrency':
      return configuration.concurrency;
    case 'budget.usd':
      return configuration.runBudgetUsd;
    case 'checks.timeout_minutes':
      return configuration.checks === null ? null : configuration.checks.timeoutMs / 60_000;
    case 'conventions.user_rules':
      return configuration.survey.userRules;
    case 'runtimes.codex.windows_sandbox':
      return configuration.codex?.windowsSandbox ?? null;
    default:
      if (runtime === null || !name.startsWith(`runtimes.${configuration.runtime}.`)) return name.startsWith('runtimes.') ? null : undefined;
      if (name === runtime.strong) return configuration.models.strong;
      if (name === runtime.fast) return configuration.models.fast;
      if (name === runtime.executable) return configuration.executable;
      return configuration.executableArgs;
  }
}

/** A recorded setting no version 5 field holds, as a run recorded before the settings reads: nothing excluded, no tool directory, no base or default scope named, and no check settled by a setting. */
const unrecorded = (name: SettingName): unknown => (name === 'scope.exclude' || name === 'tools.path' ? [] : null);

/**
 * One setting as a run recorded it (R6, R17), whichever version recorded
 * the run: the value from version 5's field where it has one, else from
 * the settings block, the fix side of a continuation first for the
 * settings it records; the layer from the fix side or the block. A run
 * configured before the settings reads as its defaults and flags, with
 * no layer; a setting of another runtime than the run's has no value.
 */
export function settingOf<N extends SettingName>(configuration: ReviewConfiguration, name: N): RecordedSetting<SettingValue<N>> {
  const fixSide = configuration.fixSettings !== null && fixSideNames.includes(name) ? configuration.fixSettings : null;
  const field = fieldValue(configuration, name);
  const layer = (fixSide?.layers as Readonly<Partial<Record<string, Layer>>> | undefined)?.[name] ?? (configuration.settings?.layers as Readonly<Partial<Record<string, Layer>>> | undefined)?.[name] ?? null;
  if (field !== undefined) return { value: field as SettingValue<N>, layer };
  const fromFix = (fixSide?.values as Readonly<Partial<Record<string, unknown>>> | undefined)?.[name];
  const recorded = fromFix !== undefined ? fromFix : (configuration.settings?.values as Readonly<Partial<Record<string, unknown>>> | undefined)?.[name];
  return { value: (recorded === undefined ? unrecorded(name) : recorded) as SettingValue<N>, layer };
}
