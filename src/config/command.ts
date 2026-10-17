/**
 * `deep-review config` (R14 of the configuration): the configuration a run
 * will use, shown without a run; the registry, explained; one file,
 * checked as its layer reads it; and a new file for a layer, written with
 * each setting it can set as a comment at its default. Each function here
 * returns what the command prints, so the command line only reads, writes
 * and exits.
 */
import { stringify } from 'smol-toml';
import type { PolicyFile } from '../review/policy.ts';
import { configSchemaVersion, parseConfig } from './files.ts';
import type { ResolvedSettings } from './resolve.ts';
import { fileWords, isConfiguredRuntime, layerSettings, layerWords, settingNames, settings, type FileLayer, type Owner, type SettingName } from './settings.ts';

/** What each owner means, as `config explain` says it (R3). */
const ownerWords: Readonly<Record<Owner, string>> = {
  'repository-first': 'the repository\'s file wins over the operator\'s file',
  'operator-first': 'the operator\'s file wins over the repository\'s file',
  'operator-only': 'the repository\'s file cannot set it',
};

/** A value as TOML writes it, which a file and `--set` take back. */
export const tomlValue = (value: unknown): string => stringify({ value }).replace(/^value = /, '').trimEnd();

/** The runtime a setting belongs to, or null for one of every run. */
const runtimeOf = (name: SettingName): string | null => (name.startsWith('runtimes.') ? name.split('.')[1]! : null);

/** The settings of a run of `runtime`: every setting but another runtime's. */
const settingsOfRuntime = (runtime: string): SettingName[] => settingNames.filter((name) => runtimeOf(name) === null || runtimeOf(name) === runtime);

/** What `config show` prints about the change a run would review. */
export interface ShownScope {
  readonly mode: string;
  readonly base: string;
  /** Why the change has nothing to review, or null when it has a path left. */
  readonly empty: string | null;
}

/**
 * `config show` as text (R14): the scope a run would review and its base,
 * each setting of the runtime with its value and origin, the files read,
 * the state of the repository's file, the repository values not followed
 * and the settings ignored.
 */
export function showLines(resolved: ResolvedSettings, scope: ShownScope): string[] {
  const names = settingsOfRuntime(resolved.runtime);
  const width = Math.max(...names.map((name) => name.length));
  const repository = resolved.repository;
  return [
    `Scope: ${scope.mode} from ${scope.base}${scope.empty === null ? '' : `; ${scope.empty}`}`,
    `Runtime: ${resolved.runtime}`,
    'Settings:',
    ...names.map((name) => {
      const { value, layer } = resolved.values[name];
      return `  ${name.padEnd(width)}  ${value === null ? '(none)' : tomlValue(value)}  from ${layerWords[layer]}`;
    }),
    'Files:',
    ...(resolved.files.length === 0 ? ['  (none)'] : resolved.files.map((file) => `  ${fileWords(file)}`)),
    `Repository's file: ${repository.state === 'skipped' ? 'skipped by --no-repository-config' : `${repository.state} at ${repository.commit ?? ''}`}${repository.edited ? '; edited by this change, whose edit applies to later changes' : ''}`,
    ...(resolved.notFollowed.length === 0 ? [] : ['Not followed:', ...resolved.notFollowed.map((entry) => `  ${entry.name}: the repository's ${tomlValue(entry.repository)}, this run's ${entry.value === null ? '(none)' : tomlValue(entry.value)} from ${layerWords[entry.layer]}`)]),
    ...(resolved.ignored.length === 0 ? [] : ['Ignored:', ...resolved.ignored.map((entry) => `  ${entry.name} in ${entry.path}: ${entry.reason}`)]),
  ];
}

/** `config explain` (R14): each setting, or the one named, with its owner, its default, the flag that sets it and its sentence; null for a name the registry lacks. */
export function explainLines(name?: string): string[] | null {
  const names = name === undefined ? settingNames : settingNames.filter((candidate) => candidate === name);
  if (names.length === 0) return null;
  return names.flatMap((setting, index) => {
    const declaration = settings[setting];
    return [
      ...(index === 0 ? [] : ['']),
      setting,
      `  owner: ${declaration.owner}: ${ownerWords[declaration.owner]}`,
      `  default: ${declaration.defaultWords}`,
      ...(declaration.flag === null ? [] : [`  flag: ${declaration.flag}, or --set ${setting}=<value>`]),
      `  ${declaration.describe}`,
    ];
  });
}

/** What `config validate` found in one file (R14): no problem, with the settings it sets and the names it ignores, or every problem. */
export interface Validated {
  readonly valid: boolean;
  readonly lines: readonly string[];
}

/** `config validate` (R14): the file's bytes checked as `layer` reads them, the four checks of the loader, every problem named. */
export function validateBytes(layer: FileLayer, path: string, bytes: Buffer): Validated {
  const read = parseConfig(layer, path, bytes, null);
  if (read.file === null) return { valid: false, lines: [`invalid: ${path} as ${layerWords[layer]}:`, ...read.problems.map((problem) => `  ${problem}`)] };
  const set = [...read.file.values.keys()];
  return {
    valid: true,
    lines: [
      `valid: ${path} as ${layerWords[layer]}, setting ${set.length === 0 ? 'nothing' : set.join(', ')}`,
      ...read.file.ignored.map((name) => `  ignored: ${name}: no such setting; ${layerWords[layer]} ignores it, and a newer engine may read it`),
    ],
  };
}

/**
 * The text `config init` writes for a layer (R14): `schema = 1`, then each
 * setting the layer can set as a comment, with its sentence, its default
 * in words and its line at its default, or at an example when the engine
 * decides it some other way, so removing the `#` gives a line the file
 * takes. The defaults come from the role policy, a runtime's own for its
 * settings and Claude Code's for the run budget, whose words name both.
 */
export function initText(layer: FileLayer, policy: PolicyFile): string {
  const blocks = layerSettings(layer).map((name) => {
    const declaration = settings[name];
    const runtime = runtimeOf(name);
    const value = declaration.defaultOf(policy, runtime !== null && isConfiguredRuntime(runtime) ? runtime : 'claude');
    return [`# ${declaration.describe}`, `# Default: ${declaration.defaultWords}.`, `# ${name} = ${tomlValue(value ?? declaration.example)}`].join('\n');
  });
  return `# deep-review configuration: ${layerWords[layer]}. Remove the # of a line to set it; deep-review config explain says more.\nschema = ${String(configSchemaVersion)}\n\n${blocks.join('\n\n')}\n`;
}
