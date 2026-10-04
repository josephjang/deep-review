/**
 * The manifest rules (R8, PD6, TD5 of the fix pass), kept as hints for the
 * surveyor (R11, PD5, TD11 of the repository survey): for each kind, the
 * first source that names one, in the order a Taskfile task, a Makefile
 * target, a justfile recipe, a `package.json` script run through the
 * package manager the repository names, and a language's default. They
 * decide nothing: a hint is a mechanical guess the surveyor's task carries
 * for a kind the repository states nothing about, and a hinted command
 * runs only when the surveyor returns it. The rules are frozen as they
 * are; a repository they miss is the surveyor's to read. Hints are pure
 * over a snapshot of the repository root, which `readRootManifests` takes,
 * so the same root always gives the same hints; nothing here runs a
 * command or asks a model.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkKinds, type CheckKind } from '../vocabulary.ts';

/** The names Task reads its Taskfile under, in the order it looks for them. */
const taskfileNames = ['Taskfile.yml', 'taskfile.yml', 'Taskfile.yaml', 'taskfile.yaml'] as const;
/** The names make reads its makefile under, in the order GNU make looks for them; BSD make reads the last two. */
const makefileNames = ['GNUmakefile', 'makefile', 'Makefile'] as const;
/** The names just reads its justfile under. */
const justfileNames = ['justfile', 'Justfile', '.justfile'] as const;

/** The files at the repository root the rules read, when they are regular files. */
export const manifestNames = [
  'package.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json',
  ...taskfileNames, ...makefileNames, ...justfileNames,
  'go.mod', 'Cargo.toml', 'pyproject.toml', 'pytest.ini',
] as const;
export type ManifestName = (typeof manifestNames)[number];

/** What the rules read of the repository root: the text of each manifest present, and the names of the root's entries. */
export interface RootManifests {
  readonly files: Readonly<Partial<Record<ManifestName, string>>>;
  /** Every entry name at the root, so a `.sln` or `.csproj` there is seen. */
  readonly entries: readonly string[];
}

/** What the command line says about the checks: a command per kind it names, and the kinds it drops. */
export interface CheckFlags {
  readonly commands: Readonly<Partial<Record<CheckKind, string>>>;
  readonly dropped: readonly CheckKind[];
}

export const noCheckFlags: CheckFlags = { commands: {}, dropped: [] };

/**
 * What the flags say about one kind (R5 of the repository survey): no
 * command when `--no-check` drops it, which wins over a `--check` naming
 * it; else the command `--check` names; or null when no flag settles it.
 * The one place that order is written, for every reader of the flags.
 */
export function flagSetting(flags: CheckFlags, kind: CheckKind): { readonly command: string | null } | null {
  if (flags.dropped.includes(kind)) return { command: null };
  const command = flags.commands[kind];
  return command === undefined ? null : { command };
}

/** Whether a flag settles the kind, naming its command or dropping it (R5 of the repository survey). */
export const isSettled = (flags: CheckFlags, kind: CheckKind): boolean => flagSetting(flags, kind) !== null;

/** The kinds a flag settles, in the order the checks run, each with the flag's command, or null for one it drops. */
export const settledKinds = (flags: CheckFlags): { readonly kind: CheckKind; readonly command: string | null }[] =>
  checkKinds.flatMap((kind) => {
    const setting = flagSetting(flags, kind);
    return setting === null ? [] : [{ kind, command: setting.command }];
  });

/** The kinds no flag settles, in the order the checks run: the ones the surveyor chooses. */
export const unsettledKinds = (flags: CheckFlags): CheckKind[] => checkKinds.filter((kind) => !isSettled(flags, kind));

/** The rule a hint came from: the sources the fix pass once decided by, as `checks.planned@1` names them, or none. */
export const hintRules = ['taskfile', 'makefile', 'justfile', 'package', 'language', 'none'] as const;
export type HintRule = (typeof hintRules)[number];

/** One kind's hint: the command the old precedence gives, or none, with the rule and what it read, in words for the surveyor's task. */
export interface CheckHint {
  readonly kind: CheckKind;
  /** The command, or null when the rules give none, or give one only ambiguously. */
  readonly command: string | null;
  readonly rule: HintRule;
  /** What the rule read, such as "package.json script `lint` through pnpm, which pnpm-lock.yaml names". */
  readonly reading: string;
}

/** The lock files and the package manager each names. */
const lockFiles: readonly [ManifestName, string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

/** The `package.json` script names each kind is found under, in the order they are tried. */
export const packageScriptNames: Readonly<Record<CheckKind, readonly string[]>> = {
  build: ['build'],
  typecheck: ['typecheck', 'type-check', 'check-types', 'tsc'],
  lint: ['lint'],
  test: ['test'],
};

/** A language's default command per kind, by the manifest that marks the language; a kind a language has no default for is absent. */
const languageDefaults: readonly { readonly marker: string; readonly marks: (root: RootManifests) => boolean; readonly commands: Readonly<Partial<Record<CheckKind, string>>> }[] = [
  { marker: 'go.mod', marks: (root) => root.files['go.mod'] !== undefined, commands: { build: 'go build ./...', typecheck: 'go vet ./...', test: 'go test ./...' } },
  { marker: 'Cargo.toml', marks: (root) => root.files['Cargo.toml'] !== undefined, commands: { build: 'cargo build --workspace', typecheck: 'cargo check --workspace', lint: 'cargo clippy --workspace', test: 'cargo test --workspace' } },
  { marker: 'pyproject.toml or pytest.ini', marks: (root) => root.files['pyproject.toml'] !== undefined || root.files['pytest.ini'] !== undefined, commands: { test: 'python -m pytest' } },
  { marker: 'a .sln or .csproj file', marks: (root) => root.entries.some((name) => /\.(sln|csproj)$/i.test(name)), commands: { build: 'dotnet build', test: 'dotnet test --no-build' } },
];

/** The lines of a file, whatever its line endings. */
const linesOf = (text: string): string[] => text.split(/\r?\n/);

/**
 * Whether a Taskfile declares a task named `kind`: a key at the
 * indentation of the first entry under `tasks:`, with no YAML parser, as
 * the proof of concept matched.
 */
export function taskfileHas(text: string, kind: string): boolean {
  const lines = linesOf(text);
  const start = lines.findIndex((line) => /^tasks:\s*(#.*)?$/.test(line));
  if (start === -1) return false;
  let indent: string | null = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const leading = /^[ \t]*/.exec(line)![0];
    // A line back at the left margin ends the `tasks:` mapping.
    if (leading.length === 0) return false;
    indent ??= leading;
    if (leading === indent && new RegExp(`^${RegExp.escape(indent)}${RegExp.escape(kind)}:(\\s|$)`).test(line)) return true;
  }
  return false;
}

/** Whether a Makefile has a rule with `kind` among its targets, at the left margin and not a `:=` assignment. */
export function makefileHas(text: string, kind: string): boolean {
  return linesOf(text).some((line) => {
    const rule = /^([^\s:#=][^:#=]*?)\s*::?(?!=)/.exec(line);
    return rule !== null && rule[1]!.split(/\s+/).includes(kind);
  });
}

/** Whether a justfile has a recipe named `kind`, quiet (`@`) or not, with or without parameters and their defaults, and not a `:=` assignment. */
export function justfileHas(text: string, kind: string): boolean {
  return linesOf(text).some((line) => new RegExp(`^@?${RegExp.escape(kind)}(\\s[^:]*)?:(?!=)`).test(line));
}

/** The scripts of a `package.json`, or null when it has none or is not JSON an object. */
function packageScripts(text: string | undefined): Readonly<Record<string, string>> | null {
  if (text === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const scripts = (value as { scripts?: unknown }).scripts;
  if (typeof scripts !== 'object' || scripts === null) return null;
  return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** The `packageManager` field's name (`pnpm` of `pnpm@9.1.0`), or null when the field is absent or not a name. */
function declaredManager(text: string | undefined): string | null {
  if (text === undefined) return null;
  try {
    const field = (JSON.parse(text) as { packageManager?: unknown }).packageManager;
    if (typeof field !== 'string') return null;
    const name = /^([a-z][a-z0-9-]*)(@.*)?$/.exec(field);
    return name === null ? null : name[1]!;
  } catch {
    return null;
  }
}

/** The script a kind runs as: the first of its names present, or that name's `:check` variant when both exist (TD5). */
export function packageScriptFor(scripts: Readonly<Record<string, string>>, kind: CheckKind): string | null {
  const name = packageScriptNames[kind].find((candidate) => Object.hasOwn(scripts, candidate));
  if (name === undefined) return null;
  return Object.hasOwn(scripts, `${name}:check`) ? `${name}:check` : name;
}

/**
 * The package manager a script runs through, and what named it: the
 * `packageManager` field, else the lock files, else npm, which no file
 * names. Lock files of two managers and no field name none: either guess
 * may run the wrong tool, so the hint says so instead of guessing.
 */
function packageManager(root: RootManifests): { readonly manager: string; readonly namedBy: string } | { readonly ambiguous: readonly string[] } {
  const declared = declaredManager(root.files['package.json']);
  if (declared !== null) return { manager: declared, namedBy: 'which the packageManager field of package.json names' };
  const present = lockFiles.filter(([name]) => root.files[name] !== undefined);
  const managers = [...new Set(present.map(([, manager]) => manager))];
  if (managers.length > 1) return { ambiguous: present.map(([name]) => name) };
  if (managers.length === 1) return { manager: managers[0]!, namedBy: `which ${present.map(([name]) => name).join(' and ')} names` };
  return { manager: 'npm', namedBy: 'the default, since no lock file or packageManager field names a manager' };
}

/** The first of a Taskfile task, a Makefile target or a justfile recipe named `kind`, as the command, its rule and what it read. */
function taskRunnerHint(root: RootManifests, kind: CheckKind): Omit<CheckHint, 'kind'> | null {
  // Each tool reads the first of its names present, so a later name is never the one it runs.
  const first = (names: readonly ManifestName[]): ManifestName | undefined => names.find((name) => root.files[name] !== undefined);
  const taskfile = first(taskfileNames);
  if (taskfile !== undefined && taskfileHas(root.files[taskfile]!, kind)) return { command: `task ${kind}`, rule: 'taskfile', reading: `the task \`${kind}\` of ${taskfile}` };
  const makefile = first(makefileNames);
  if (makefile !== undefined && makefileHas(root.files[makefile]!, kind)) return { command: `make ${kind}`, rule: 'makefile', reading: `the target \`${kind}\` of ${makefile}` };
  const justfile = first(justfileNames);
  if (justfile !== undefined && justfileHas(root.files[justfile]!, kind)) return { command: `just ${kind}`, rule: 'justfile', reading: `the recipe \`${kind}\` of ${justfile}` };
  return null;
}

/** What a kind with no hint reads, since none of the rules names it. */
export const noHintReading = 'no Taskfile task, Makefile target, justfile recipe, package.json script or language default names it';

/**
 * The hint of every kind in `kinds`, in the order the checks run (R11 of
 * the repository survey): the first rule that names a command, or a
 * hint of none. A script whose package manager the repository leaves
 * ambiguous is named with no command, and the lock files that disagree.
 */
export function hintChecks(root: RootManifests, kinds: readonly CheckKind[] = checkKinds): CheckHint[] {
  const scripts = packageScripts(root.files['package.json']);
  return checkKinds.filter((kind) => kinds.includes(kind)).map((kind): CheckHint => {
    const runner = taskRunnerHint(root, kind);
    if (runner !== null) return { kind, ...runner };
    const script = scripts === null ? null : packageScriptFor(scripts, kind);
    if (script !== null) {
      const manager = packageManager(root);
      if ('ambiguous' in manager) {
        return { kind, command: null, rule: 'package', reading: `the package.json script \`${script}\`, but the lock files name more than one package manager (${manager.ambiguous.join(', ')}) and package.json names none in its packageManager field, so the rules cannot tell which runs it` };
      }
      return { kind, command: `${manager.manager} run ${script}`, rule: 'package', reading: `the package.json script \`${script}\` through ${manager.manager}, ${manager.namedBy}` };
    }
    const language = languageDefaults.find((entry) => entry.marks(root) && entry.commands[kind] !== undefined);
    if (language !== undefined) return { kind, command: language.commands[kind]!, rule: 'language', reading: `the default for a repository with ${language.marker}` };
    return { kind, command: null, rule: 'none', reading: noHintReading };
  });
}

/** Read the repository root as the rules need it: each manifest that is a regular file, and the names of the root's entries. */
export function readRootManifests(root: string): RootManifests {
  const entries = readdirSync(root);
  const files: Partial<Record<ManifestName, string>> = {};
  for (const name of manifestNames) {
    // Only a name the directory's own listing holds: a case-insensitive file system would answer for `makefile` with a `Makefile`, reading one file under two names.
    if (!entries.includes(name)) continue;
    const path = join(root, name);
    if (statSync(path, { throwIfNoEntry: false })?.isFile() !== true) continue;
    files[name] = readFileSync(path, 'utf8');
  }
  return { files, entries };
}
