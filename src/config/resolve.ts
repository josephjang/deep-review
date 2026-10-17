/**
 * The resolution of the settings (R3, R8, R9, R13 of the configuration):
 * the flag layer an invocation gives, and the two passes that put the
 * layers in the order of each setting's owner. Pass 1 resolves the two
 * operator-only settings that choose the change, `scope.default` and
 * `review.base`, from every layer but the repository's file, since the
 * engine reads that file at the base those two settings choose (R4).
 * Pass 2 reads the repository's file at that base and resolves every
 * setting, with the layer each value came from.
 */
import { resolve } from 'node:path';
import { parse } from 'smol-toml';
import { ReviewRefusedError } from '../review/errors.ts';
import type { PolicyFile } from '../review/policy.ts';
import { git } from '../scope/git.ts';
import { SettingFlagError } from './errors.ts';
import { readConfigFile, refuseProblems, repositoryConfigPath, valueText, type ConfigFile } from './files.ts';
import { isSettingName, layerOrder, layerWords, settingNames, settings, type FileLayer, type Layer, type ScopeDefault, type SettingName, type SettingValue } from './settings.ts';

/** One flag's value for one setting, with the flag as the command line spelled it, which a refusal names. */
export interface FlagValue {
  readonly name: SettingName;
  readonly value: unknown;
  readonly flag: string;
  /** The text a `--set` gave, which its setting takes as a string when it refuses the TOML value read from it. */
  readonly text?: string;
}

/** The flag layer of one invocation (TD9): each setting a dedicated flag or `--set` gives, by its name. */
export type FlagLayer = ReadonlyMap<SettingName, FlagValue>;

/** No setting flag. */
export const noFlags: FlagLayer = new Map();

/**
 * The value of a `--set` (TD9): the right side of a TOML key-value line
 * when it parses as one, else the raw text as a string. So
 * `checks.test=npm test` gives the string `npm test`, and
 * `scope.exclude=["dist/**"]` a list.
 */
export function parseSetValue(text: string): unknown {
  try {
    const table = parse(`value = ${text}`);
    const keys = Object.keys(table);
    if (keys.length === 1 && keys[0] === 'value') return table.value;
  } catch {
    // Not a TOML value: the text is a string.
  }
  return text;
}

/** One `--set <setting>=<value>` as a flag value, split at its first `=`; a name the registry lacks is refused. */
export function parseSetFlag(argument: string): FlagValue {
  const equals = argument.indexOf('=');
  if (equals <= 0) throw new SettingFlagError(`--set takes <setting>=<value>, not ${JSON.stringify(argument)}`);
  const name = argument.slice(0, equals).trim();
  if (!isSettingName(name)) throw new SettingFlagError(`--set names no setting ${JSON.stringify(name)}; deep-review config explain lists the settings this engine knows`);
  const text = argument.slice(equals + 1);
  return { name, value: parseSetValue(text), flag: `--set ${name}`, text };
}

/**
 * The flag layer of the flag values given, each checked against its
 * setting's schema; a `--set` whose TOML value the setting refuses is
 * taken as its text when the setting takes that, so `review.base=1234567`
 * is a revision and `checks.test=true` a command. A TOML string is not
 * retried, since its text is only the string in quotes, so
 * `checks.test="  "` is refused as blank. Two flags for one
 * setting, a dedicated flag and `--set` or `--set` twice, are refused,
 * naming both.
 */
export function flagLayerOf(values: readonly FlagValue[]): FlagLayer {
  const layer = new Map<SettingName, FlagValue>();
  for (const entry of values) {
    const earlier = layer.get(entry.name);
    if (earlier !== undefined) throw new SettingFlagError(`${entry.flag} and ${earlier.flag} both set ${entry.name}; give one`);
    const parsed = settings[entry.name].value.safeParse(entry.value);
    const asText = !parsed.success && entry.text !== undefined && typeof entry.value !== 'string' ? settings[entry.name].value.safeParse(entry.text) : null;
    // When the text is refused too, the TOML value's problem is the one to name.
    const checked = asText?.success === true ? asText : parsed;
    if (!checked.success) throw new SettingFlagError(`${entry.flag}: ${checked.error.issues.map((issue) => issue.message).join('; ')}, not ${valueText(entry.value)}`);
    layer.set(entry.name, { ...entry, value: checked.data });
  }
  return layer;
}

/** Where an invocation's configuration files are: null for a layer with no file to look for. */
export interface FileLocations {
  readonly operator: string | null;
  readonly clone: string;
  readonly invocation: string | null;
}

/**
 * Read the operator's, the clone's and the invocation file, refusing with
 * every problem of the three in one refusal (R5); the files that exist
 * and pass, in the order of their layers.
 */
export function readOperatorFiles(locations: FileLocations): ConfigFile[] {
  const reads = [
    ...(locations.operator === null ? [] : [readConfigFile('operator', locations.operator)]),
    readConfigFile('clone', locations.clone),
    ...(locations.invocation === null ? [] : [readConfigFile('invocation', locations.invocation)]),
  ];
  refuseProblems(reads.flatMap((read) => read.problems));
  return reads.flatMap((read) => (read.file === null ? [] : [read.file]));
}

/** A setting's value with the layer it came from. */
export interface ResolvedSetting<V = unknown> {
  readonly value: V;
  readonly layer: Layer;
}

/** Where each layer's values are: the files read, by their layers, and the flags. */
interface Sources {
  readonly files: readonly ConfigFile[];
  readonly flags: FlagLayer;
}

/** The highest layer of the setting's owner's order that sets it, or null when only the default could. */
function winner(name: SettingName, sources: Sources): ResolvedSetting | null {
  const order = layerOrder[settings[name].owner];
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const layer = order[index]!;
    if (layer === 'default') return null;
    if (layer === 'flag') {
      const flagged = sources.flags.get(name);
      if (flagged !== undefined) return { value: flagged.value, layer };
      continue;
    }
    const file = sources.files.find((candidate) => candidate.layer === layer);
    if (file !== undefined && file.values.has(name)) return { value: file.values.get(name), layer };
  }
  return null;
}

/**
 * The branch `origin/HEAD` names, as `origin/<branch>`, or null when the
 * clone has no such symbolic ref: the base of `--branch` when
 * `review.base` has no value (R8).
 */
export function originHeadBranch(repo: string): string | null {
  const ref = git(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { okExitCodes: [1, 128] }).toString('utf8').trim();
  const prefix = 'refs/remotes/';
  return ref.startsWith(prefix) && ref.length > prefix.length ? ref.slice(prefix.length) : null;
}

/** What pass 1 resolves: the two settings that choose the change. */
export interface ScopeSettings {
  readonly scopeDefault: ResolvedSetting<ScopeDefault>;
  /** The base branch: the value a layer gives, else the branch `origin/HEAD` names, else null. */
  readonly reviewBase: ResolvedSetting<string | null>;
}

/**
 * Pass 1 (R3, R8, R9): `scope.default` and `review.base` from the
 * operator's, the clone's and the invocation file and the flags, which
 * are the layers of an operator-only setting, so the repository's file
 * never chooses the change it is read at the base of. `originHead` is
 * asked only when no layer gives a base.
 */
export function resolveScopeSettings(files: readonly ConfigFile[], flags: FlagLayer, originHead: () => string | null): ScopeSettings {
  const sources: Sources = { files: files.filter((file) => file.layer !== 'repository'), flags };
  const scopeDefault = winner('scope.default', sources) as ResolvedSetting<ScopeDefault> | null;
  const reviewBase = winner('review.base', sources) as ResolvedSetting<string> | null;
  return {
    scopeDefault: scopeDefault ?? { value: 'auto', layer: 'default' },
    reviewBase: reviewBase ?? { value: originHead(), layer: 'default' },
  };
}

/** The base branch `--branch` reviews from (R8), or a refusal naming the setting and the flag when none is known. */
export function requireBase(reviewBase: ResolvedSetting<string | null>): string {
  if (reviewBase.value === null) throw new ReviewRefusedError('--branch needs the branch the change starts from, and this clone has no origin/HEAD; set review.base in the operator\'s or the clone\'s file, or give --base <rev>');
  return reviewBase.value;
}

/** The repository's file as a run met it (R4, R5): read at a commit, absent there, or skipped by `--no-repository-config`; and whether the change edits it. */
export interface RepositoryFileState {
  readonly state: 'read' | 'absent' | 'skipped';
  /** The commit the engine looked for the file at; null when it was skipped. */
  readonly commit: string | null;
  /** Whether the reviewed change edits the file, whose edit then applies only to later changes. */
  readonly edited: boolean;
}

/** A repository value a higher layer replaced with another (R7, PD7): the run did not follow the repository's policy there. */
export interface NotFollowed {
  readonly name: SettingName;
  readonly repository: unknown;
  readonly value: unknown;
  readonly layer: Layer;
}

/** A setting a file gave that the run does not apply, and why. */
export interface IgnoredSetting {
  readonly layer: FileLayer;
  readonly path: string;
  readonly name: string;
  readonly reason: string;
}

/** A file the run read, as the record names it. */
export interface FileRecord {
  readonly layer: FileLayer;
  readonly path: string;
  readonly sha256: string;
  readonly commit: string | null;
}

/**
 * Everything pass 2 resolves (R6, R7, R14): every setting's value with its
 * layer, the files read, the state of the repository's file, the
 * repository values the run does not follow, and the settings ignored.
 * `config show` prints it and a new run records it.
 */
export interface ResolvedSettings {
  readonly runtime: string;
  readonly values: Readonly<Record<SettingName, ResolvedSetting>>;
  readonly files: readonly FileRecord[];
  readonly repository: RepositoryFileState;
  readonly notFollowed: readonly NotFollowed[];
  readonly ignored: readonly IgnoredSetting[];
}

/** What pass 2 reads. */
export interface SettingsInputs {
  readonly policy: PolicyFile;
  readonly runtime: string;
  /** Whether the runtime reports its cost in US dollars: a run budget from a file is ignored on one that does not. */
  readonly costInUsd: boolean;
  /** Every file read, the repository's among them when it was read. */
  readonly files: readonly ConfigFile[];
  readonly flags: FlagLayer;
  readonly repository: Omit<RepositoryFileState, 'edited'>;
  /** The root of the worktree, which a relative `tools.path` entry is relative to (R11). */
  readonly worktree: string;
  readonly originHead: () => string | null;
}

/** Whether two values are the same, as a file or a flag gives them: JSON-like values, compared as their JSON. */
const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Pass 2 (R3, R5, R7, R11, R12): every setting by its owner's order, the
 * highest layer that sets it winning and a list replacing a lower list
 * whole, else its default. A repository-first value that a higher layer
 * replaces with another is not followed. A run budget a file gives for a
 * runtime that reports no cost is ignored, as is each name an operator's
 * or a clone's file holds that this engine does not know. A relative
 * `tools.path` entry is made absolute against the worktree.
 */
export function resolveSettings(inputs: SettingsInputs): ResolvedSettings {
  const sources: Sources = { files: inputs.files, flags: inputs.flags };
  const repositoryFile = inputs.files.find((file) => file.layer === 'repository') ?? null;
  const ignored: IgnoredSetting[] = inputs.files.flatMap((file) => file.ignored.map((name) => ({ layer: file.layer, path: file.path, name, reason: 'no such setting' })));
  const notFollowed: NotFollowed[] = [];
  const values = {} as Record<SettingName, ResolvedSetting>;
  for (const name of settingNames) {
    let found = winner(name, sources);
    if (name === 'budget.usd' && !inputs.costInUsd && found !== null && found.layer !== 'flag') {
      // Every file that sets the budget is ignored, not only the one that wins, so each is named, lowest layer first.
      const order = layerOrder[settings[name].owner];
      const setting = inputs.files.filter((file) => file.values.has(name)).sort((a, b) => order.indexOf(a.layer) - order.indexOf(b.layer));
      for (const file of setting) ignored.push({ layer: file.layer, path: file.path, name, reason: `runtime ${inputs.runtime} reports no cost in USD, so its run has no budget` });
      found = null;
    }
    const resolved: ResolvedSetting = found ?? { value: name === 'review.base' ? inputs.originHead() : settings[name].defaultOf(inputs.policy, inputs.runtime), layer: 'default' };
    values[name] = name === 'tools.path' ? { ...resolved, value: (resolved.value as string[]).map((directory) => resolve(inputs.worktree, directory)) } : resolved;
    if (repositoryFile !== null && settings[name].owner === 'repository-first' && repositoryFile.values.has(name) && resolved.layer !== 'repository' && !sameValue(resolved.value, repositoryFile.values.get(name))) {
      notFollowed.push({ name, repository: repositoryFile.values.get(name), value: resolved.value, layer: resolved.layer });
    }
  }
  return {
    runtime: inputs.runtime,
    values,
    files: inputs.files.map((file) => ({ layer: file.layer, path: file.path, sha256: file.sha256, commit: file.commit })),
    repository: { ...inputs.repository, edited: false },
    notFollowed,
    ignored,
  };
}

/** One setting's resolved value. */
export const resolvedValue = <N extends SettingName>(resolved: Pick<ResolvedSettings, 'values'>, name: N): SettingValue<N> => resolved.values[name].value as SettingValue<N>;

/**
 * The resolved settings of a change whose changed paths, before any
 * exclusion, are `changed` (R4): the repository's file read at the base is
 * edited when one of them is its path, whatever `scope.exclude` leaves
 * out, so a pattern cannot hide the edit.
 */
export function withChangedPaths(resolved: ResolvedSettings, changed: readonly string[]): ResolvedSettings {
  const edited = resolved.repository.state !== 'skipped' && changed.includes(repositoryConfigPath);
  return edited === resolved.repository.edited ? resolved : { ...resolved, repository: { ...resolved.repository, edited } };
}

/** A resolved setting as a line names its origin: the layer, and for a flag the flag that gave it. */
export function originWords(setting: ResolvedSetting, name: SettingName, flags: FlagLayer = noFlags): string {
  return setting.layer === 'flag' ? (flags.get(name)?.flag ?? layerWords.flag) : layerWords[setting.layer];
}
