/**
 * The configuration files and how the engine reads each (R2, R4, R5 of the
 * configuration): where the four files are, the read of the repository's
 * file through git at a commit, and the checks every file passes before
 * its values count. A file that fails a check is a problem, not an error:
 * the caller collects the problems of every file it reads and refuses the
 * run once, naming them all (`refuseProblems`).
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parse, TomlError } from 'smol-toml';
import { ReviewRefusedError } from '../review/errors.ts';
import { spellingsOf } from '../runtime/environment.ts';
import { git, literal, records } from '../scope/git.ts';
import { isSettingName, isSettingPrefix, layerWords, settableBy, settings, type FileLayer, type SettingName } from './settings.ts';

/** The repository's file, relative to the root of the repository. */
export const repositoryConfigPath = '.deep-review/config.toml';

/** The clone's file, in the git common directory (TD7). */
export const cloneConfigName = 'deep-review.toml';

/** A file larger than this is refused unread. */
export const maxConfigBytes = 64 * 1024;

/** The one schema this engine reads. */
export const configSchemaVersion = 1;

/** One configuration file as the engine read it: where it is, what it held, and the names it ignored. */
export interface ConfigFile {
  readonly layer: FileLayer;
  /** Absolute, for a file on disk; relative to the repository, for the repository's file. */
  readonly path: string;
  /** SHA-256 of the bytes read. */
  readonly sha256: string;
  /** The commit the repository's file was read at; null for any other file. */
  readonly commit: string | null;
  /** Each setting the file sets, by its dotted name, with its value as its schema parsed it. */
  readonly values: ReadonlyMap<SettingName, unknown>;
  /** The names an operator's or a clone's file holds that this engine does not know, which it ignores (R5). */
  readonly ignored: readonly string[];
}

/** A read of one file: the file, or null when there is none, and what is wrong with it. A file with a problem has no values that count. */
export interface FileRead {
  readonly file: ConfigFile | null;
  readonly problems: readonly string[];
}

const absent: FileRead = { file: null, problems: [] };

/**
 * The operator's file (R2): `%APPDATA%\deep-review\config.toml` on
 * Windows, else `$XDG_CONFIG_HOME/deep-review/config.toml` when that
 * variable holds an absolute path, else `~/.config/deep-review/config.toml`.
 * Null on Windows when `APPDATA` has no value, where no file is looked for.
 * The variables are read as the platform spells them, so `AppData` names
 * `APPDATA` on Windows.
 */
export function operatorConfigPath(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string = homedir()): string | null {
  const variable = (name: string): string | undefined => spellingsOf(environment, name, platform).find(([, value]) => value !== undefined && value !== '')?.[1];
  if (platform === 'win32') {
    const appData = variable('APPDATA');
    return appData === undefined ? null : join(appData, 'deep-review', 'config.toml');
  }
  const xdg = variable('XDG_CONFIG_HOME');
  return join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, '.config'), 'deep-review', 'config.toml');
}

/** The clone's file (R2, TD7): beside the git data of the clone, shared by all its worktrees and held by no commit. */
export const cloneConfigPath = (commonDir: string): string => join(commonDir, cloneConfigName);

/**
 * Read a file of `layer` from disk: absent when nothing is at `path`,
 * which is no problem for the operator's and the clone's file; a file that
 * `--config` names must exist.
 */
export function readConfigFile(layer: Exclude<FileLayer, 'repository'>, path: string): FileRead {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return layer === 'invocation' ? { file: null, problems: [`${path}: no such file; give --config the path of a configuration file`] } : absent;
  if (!stat.isFile()) return { file: null, problems: [`${path}: ${layerWords[layer]} is not a regular file; replace it with a TOML file or remove it`] };
  if (stat.size > maxConfigBytes) return tooLarge(layer, path, stat.size);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return { file: null, problems: [`${path}: ${layerWords[layer]} cannot be read: ${(error as Error).message}`] };
  }
  return parseConfig(layer, path, bytes, null);
}

/**
 * Read the repository's file as `commit` holds it (R4, TD6): through git,
 * never from the working tree; absent when the commit holds nothing at
 * the path, as the empty tree of a root commit's review does. A path that
 * is not a regular file there, such as a directory or a symlink, is a
 * problem.
 */
export function readRepositoryConfig(repo: string, commit: string): FileRead {
  const [record, ...more] = records(git(repo, ['ls-tree', '-z', '--full-tree', commit, '--', literal(repositoryConfigPath)]).toString('utf8'));
  if (record === undefined) return absent;
  const match = /^([0-7]+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
  if (match === null || more.length > 0) throw new Error(`Unexpected ls-tree output for ${repositoryConfigPath} at ${commit}: ${JSON.stringify(record)}`);
  const [, mode, type, objectId] = match as unknown as [string, string, string, string];
  const where = `${repositoryConfigPath} at ${commit}`;
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) return { file: null, problems: [`${where}: the repository's file is ${type === 'tree' ? 'a directory' : mode === '120000' ? 'a symlink' : `a ${type}`}, not a regular file; commit a TOML file there, or run with --no-repository-config`] };
  const size = Number(git(repo, ['cat-file', '-s', objectId]).toString('utf8').trim());
  if (size > maxConfigBytes) return tooLarge('repository', where, size);
  return parseConfig('repository', repositoryConfigPath, git(repo, ['cat-file', 'blob', objectId]), commit);
}

function tooLarge(layer: FileLayer, path: string, size: number): FileRead {
  return { file: null, problems: [`${path}: ${layerWords[layer]} holds ${String(size)} bytes, more than the ${String(maxConfigBytes)} the engine reads`] };
}

/** A TOML table, as the parser gives one: neither an array nor a date. */
const isTable = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

/**
 * The settings of a parsed file by their dotted names, and the names the
 * registry does not hold: a table whose name is a prefix of some setting
 * is read into, so `[runtimes.claude]` with `strong` gives
 * `runtimes.claude.strong`; anything else is unknown under its full name.
 */
function flatten(table: Record<string, unknown>, prefix: string, values: Map<SettingName, unknown>, unknown: string[]): void {
  for (const [key, value] of Object.entries(table)) {
    const name = prefix === '' ? key : `${prefix}.${key}`;
    if (prefix === '' && key === 'schema') continue;
    if (isSettingName(name)) values.set(name, value);
    else if (isTable(value) && isSettingPrefix(name)) flatten(value, name, values, unknown);
    else unknown.push(name);
  }
}

/**
 * Check one file's bytes for its layer, in the four steps of the design,
 * each problem naming the file, the setting and what to do: the bytes are
 * UTF-8 TOML; `schema` is 1, and a larger one says to update the engine;
 * each name is known, an unknown one refused in the repository's and the
 * invocation file and ignored in the operator's and the clone's, which go
 * across machines and engine versions; the layer can set each setting; and
 * each value parses under its setting's schema. A file whose `schema` is
 * wrong is checked no further, since its names may be another schema's.
 */
export function parseConfig(layer: FileLayer, path: string, bytes: Buffer, commit: string | null): FileRead {
  const where = commit === null ? path : `${path} at ${commit}`;
  const problem = (text: string): FileRead => ({ file: null, problems: [`${where}: ${text}`] });
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return problem(`${layerWords[layer]} is not UTF-8 text`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parse(text);
  } catch (error) {
    const detail = error instanceof TomlError ? error.message.split('\n')[0]! : (error as Error).message;
    return problem(`${layerWords[layer]} is not valid TOML: ${detail}`);
  }
  if (!Object.hasOwn(parsed, 'schema')) return problem(`schema: ${layerWords[layer]} must say schema = ${String(configSchemaVersion)}`);
  const schema = parsed.schema;
  if (typeof schema === 'number' && Number.isInteger(schema) && schema > configSchemaVersion) {
    return problem(`schema: ${layerWords[layer]} says schema = ${String(schema)}, which a newer engine reads; update deep-review, or remove the file's newer settings and say schema = ${String(configSchemaVersion)}`);
  }
  if (schema !== configSchemaVersion) return problem(`schema: ${layerWords[layer]} must say schema = ${String(configSchemaVersion)}, not ${JSON.stringify(schema)}`);
  const found = new Map<SettingName, unknown>();
  const unknown: string[] = [];
  flatten(parsed, '', found, unknown);
  const problems: string[] = [];
  const ignoresUnknown = layer === 'operator' || layer === 'clone';
  if (!ignoresUnknown) for (const name of unknown) problems.push(`${where}: ${name}: no such setting; remove it, or see deep-review config explain for the settings this engine knows`);
  const values = new Map<SettingName, unknown>();
  for (const [name, value] of found) {
    if (!settableBy(name, layer)) {
      problems.push(`${where}: ${name}: ${layerWords[layer]} cannot set it, since it is ${settings[name].owner}; set it in the operator's or the clone's file`);
      continue;
    }
    const checked = settings[name].value.safeParse(value);
    if (!checked.success) {
      problems.push(`${where}: ${name}: ${checked.error.issues.map((issue) => `${issue.path.length === 0 ? '' : `[${issue.path.join('.')}] `}${issue.message}`).join('; ')}, not ${JSON.stringify(value)}`);
      continue;
    }
    values.set(name, checked.data);
  }
  if (problems.length > 0) return { file: null, problems };
  return {
    file: { layer, path, sha256: createHash('sha256').update(bytes).digest('hex'), commit, values, ignored: ignoresUnknown ? unknown : [] },
    problems: [],
  };
}

/**
 * Refuse the run when any file read has a problem (R5): one refusal that
 * names every problem, before a run exists, so the command exits 2 with
 * them all on stderr.
 */
export function refuseProblems(problems: readonly string[]): void {
  if (problems.length === 0) return;
  // The repository's file is read at the base, so the change that repairs it is reviewed only past it (PD6).
  const escape = problems.some((line) => line.startsWith(`${repositoryConfigPath} at `)) ? `\nthe repository's file is read as the base of the change holds it; to review the change that repairs it, run with --no-repository-config` : '';
  throw new ReviewRefusedError(`the configuration cannot be read, so no run starts:\n${problems.map((line) => `  ${line}`).join('\n')}${escape}`);
}
