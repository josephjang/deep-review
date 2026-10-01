/**
 * Which commands are the repository's checks (R8, PD6, TD5 of the fix
 * pass): for each kind, the first source that names one, in the order a
 * `--check` flag, a Taskfile task, a Makefile target, a justfile recipe,
 * a `package.json` script run through the package manager the repository
 * names, and a language's default. Discovery is pure over a snapshot of
 * the repository root, which `readRootManifests` takes, so the same root
 * and flags always give the same checks; nothing here runs a command or
 * asks a model.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ReviewRefusedError } from '../errors.ts';
import { checkKinds, type CheckKind, type CheckOrigin } from '../vocabulary.ts';

/** The names Task reads its Taskfile under, in the order it looks for them. */
const taskfileNames = ['Taskfile.yml', 'taskfile.yml', 'Taskfile.yaml', 'taskfile.yaml'] as const;
/** The names make reads its makefile under, in the order GNU make looks for them; BSD make reads the last two. */
const makefileNames = ['GNUmakefile', 'makefile', 'Makefile'] as const;
/** The names just reads its justfile under. */
const justfileNames = ['justfile', 'Justfile', '.justfile'] as const;

/** The files at the repository root discovery reads, when they are regular files. */
export const manifestNames = [
  'package.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json',
  ...taskfileNames, ...makefileNames, ...justfileNames,
  'go.mod', 'Cargo.toml', 'pyproject.toml', 'pytest.ini',
] as const;
export type ManifestName = (typeof manifestNames)[number];

/** What discovery reads of the repository root: the text of each manifest present, and the names of the root's entries. */
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

/** One kind's check as discovery resolved it: its command, or null with the reason none runs. */
export interface PlannedCheck {
  readonly kind: CheckKind;
  readonly command: string | null;
  readonly origin: CheckOrigin;
  /** Why the kind has no command; null when it has one. */
  readonly reason: string | null;
}

export interface DiscoveredChecks {
  /** One entry per kind, in the order the checks run. */
  readonly checks: readonly PlannedCheck[];
  /** The package manager a `package.json` script runs through, or null when no check is one. */
  readonly manager: string | null;
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
const languageDefaults: readonly { readonly marks: (root: RootManifests) => boolean; readonly commands: Readonly<Partial<Record<CheckKind, string>>> }[] = [
  { marks: (root) => root.files['go.mod'] !== undefined, commands: { build: 'go build ./...', typecheck: 'go vet ./...', test: 'go test ./...' } },
  { marks: (root) => root.files['Cargo.toml'] !== undefined, commands: { build: 'cargo build --workspace', typecheck: 'cargo check --workspace', lint: 'cargo clippy --workspace', test: 'cargo test --workspace' } },
  { marks: (root) => root.files['pyproject.toml'] !== undefined || root.files['pytest.ini'] !== undefined, commands: { test: 'python -m pytest' } },
  { marks: (root) => root.entries.some((name) => /\.(sln|csproj)$/i.test(name)), commands: { build: 'dotnet build', test: 'dotnet test --no-build' } },
];

/** Characters a regular expression gives meaning to, so a kind is matched as written. */
const escape = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
    if (leading === indent && new RegExp(`^${escape(indent)}${escape(kind)}:(\\s|$)`).test(line)) return true;
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
  return linesOf(text).some((line) => new RegExp(`^@?${escape(kind)}(\\s[^:]*)?:(?!=)`).test(line));
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
 * The package manager a script runs through: the `packageManager` field's
 * name, else the one the lock files name, else npm. Lock files of two
 * managers and no field are refused, naming them and the flag that
 * settles it, since either guess may run the wrong tool.
 */
function packageManager(root: RootManifests): string {
  const declared = declaredManager(root.files['package.json']);
  if (declared !== null) return declared;
  const present = lockFiles.filter(([name]) => root.files[name] !== undefined);
  const managers = [...new Set(present.map(([, manager]) => manager))];
  if (managers.length > 1) {
    throw new ReviewRefusedError(`the repository holds lock files of more than one package manager (${present.map(([name]) => name).join(', ')}) and package.json names none in its packageManager field; name each check's command with --check <kind>=<command>, or add the field`);
  }
  return managers[0] ?? 'npm';
}

/** The first of a Taskfile task, a Makefile target or a justfile recipe named `kind`, as the command and its origin. */
function taskRunnerCheck(root: RootManifests, kind: CheckKind): { command: string; origin: CheckOrigin } | null {
  // Each tool reads the first of its names present, so a later name is never the one it runs.
  const first = (names: readonly ManifestName[]): string | undefined => names.map((name) => root.files[name]).find((text) => text !== undefined);
  const taskfile = first(taskfileNames);
  if (taskfile !== undefined && taskfileHas(taskfile, kind)) return { command: `task ${kind}`, origin: 'taskfile' };
  const makefile = first(makefileNames);
  if (makefile !== undefined && makefileHas(makefile, kind)) return { command: `make ${kind}`, origin: 'makefile' };
  const justfile = first(justfileNames);
  if (justfile !== undefined && justfileHas(justfile, kind)) return { command: `just ${kind}`, origin: 'justfile' };
  return null;
}

/** The reason a kind with no source has no command. */
export const noSourceReason = 'no --check flag, Taskfile task, Makefile target, justfile recipe, package.json script or language default names it';
/** The reason a kind dropped by `--no-check` has no command. */
export const droppedReason = 'dropped by --no-check';

/**
 * Resolve every kind's check, in the order they run (R8, PD6). Throws
 * `ReviewRefusedError` when a kind would run a `package.json` script and
 * the repository's lock files name two package managers.
 */
export function discoverChecks(root: RootManifests, flags: CheckFlags = noCheckFlags): DiscoveredChecks {
  const scripts = packageScripts(root.files['package.json']);
  let manager: string | null = null;
  const checks = checkKinds.map((kind): PlannedCheck => {
    if (flags.dropped.includes(kind)) return { kind, command: null, origin: 'flag', reason: droppedReason };
    const flagged = flags.commands[kind];
    if (flagged !== undefined) return { kind, command: flagged, origin: 'flag', reason: null };
    const runner = taskRunnerCheck(root, kind);
    if (runner !== null) return { kind, ...runner, reason: null };
    const script = scripts === null ? null : packageScriptFor(scripts, kind);
    if (script !== null) {
      manager ??= packageManager(root);
      return { kind, command: `${manager} run ${script}`, origin: 'package', reason: null };
    }
    const language = languageDefaults.find((entry) => entry.marks(root) && entry.commands[kind] !== undefined);
    if (language !== undefined) return { kind, command: language.commands[kind]!, origin: 'language', reason: null };
    return { kind, command: null, origin: 'none', reason: noSourceReason };
  });
  return { checks, manager };
}

/** Read the repository root as discovery needs it: each manifest that is a regular file, and the names of the root's entries. */
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
