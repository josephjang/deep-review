/**
 * The settings registry (R3, R12, TD1 of the configuration): every setting
 * a configuration file, `--set` or a dedicated flag can give is declared
 * here once, with its owner, the schema of its value, its default and the
 * flag that sets it, as `checkpoint/events.ts` declares every event kind.
 * The loader, the resolver, the record and `deep-review config` all read
 * these declarations, so no module reads a name of its own from a parsed
 * file, and the schema of each layer comes from the owners rather than
 * from a list written by hand.
 */
import { z } from 'zod';
import { maxConcurrency, type PolicyFile } from '../review/policy.ts';
import { checkKinds, userRulesSettingSchema, type CheckKind } from '../review/vocabulary.ts';
import { windowsSandboxes } from '../runtime/codex.ts';
import { maxTimeoutMs } from '../runtime/contract.ts';

/**
 * Where a value can come from, lowest first in no particular owner's
 * order: the engine's default, the four configuration files, and the
 * flags of one invocation.
 */
export const layers = ['default', 'operator', 'repository', 'clone', 'invocation', 'flag'] as const;
export const layerSchema = z.enum(layers);
export type Layer = z.infer<typeof layerSchema>;

/** The layers a file gives: the repository's, the operator's, the clone's, and the one `--config` names. */
export const fileLayers = ['repository', 'operator', 'clone', 'invocation'] as const;
export type FileLayer = (typeof fileLayers)[number];

/**
 * Who decides a setting when the repository and the operator disagree
 * (R3): a rule or fact of the repository, the means or taste of the
 * operator, or a fact of the operator's machine that the repository has
 * no say in.
 */
export const owners = ['repository-first', 'operator-first', 'operator-only'] as const;
export type Owner = (typeof owners)[number];

/** The order of the layers for each owner, lowest first (the table of R3): the resolver takes the highest layer that sets a setting. */
export const layerOrder: Readonly<Record<Owner, readonly Layer[]>> = {
  'repository-first': ['default', 'operator', 'repository', 'clone', 'invocation', 'flag'],
  'operator-first': ['default', 'repository', 'operator', 'clone', 'invocation', 'flag'],
  'operator-only': ['default', 'operator', 'clone', 'invocation', 'flag'],
};

/** The layer as a person reads it, in a refusal, a line on stderr, the report and `config show`. */
export const layerWords: Readonly<Record<Layer, string>> = {
  default: 'the default',
  operator: "the operator's file",
  repository: "the repository's file",
  clone: "the clone's file",
  invocation: 'the --config file',
  flag: 'a flag',
};

/** The runtimes the registry declares settings for; a test holds them equal to the runtimes the engine ships. */
export const configuredRuntimes = ['claude', 'codex'] as const;
export type ConfiguredRuntime = (typeof configuredRuntimes)[number];

/** The values of `scope.default` (R9): a scope a flag names, or `auto`, today's rule. */
export const scopeDefaults = ['worktree', 'last-commit', 'branch', 'auto'] as const;
export type ScopeDefault = (typeof scopeDefaults)[number];

/** The most patterns `scope.exclude` holds. */
export const maxExcludePatterns = 64;
/** The most directories `tools.path` holds. */
export const maxToolDirectories = 64;

/** Text a setting holds that reaches git or a command line: not empty, no NUL. */
const textSchema = z.string().min(1).max(1000).refine((text) => !text.includes('\0'), 'must not hold a NUL');

/** A revision, as `review.base` names it: never one that git could read as an option. */
const revisionSchema = textSchema.refine((revision) => !revision.startsWith('-'), 'a revision must not start with a dash');

/** A model name, as the role policy's runtime entries spell one. */
const modelSchema = textSchema.refine((model) => !model.startsWith('-'), 'a model name must not start with a dash');

/**
 * A pattern of `scope.exclude` (R10): a relative path pattern in git's
 * glob pathspec syntax, with no magic of its own, no `..` segment, and
 * nothing that names a place outside the repository.
 */
export const excludePatternSchema = textSchema
  .refine((pattern) => !pattern.startsWith(':'), 'a pattern must not start with ":", which git reads as pathspec magic')
  .refine((pattern) => !pattern.replaceAll('\\', '/').split('/').includes('..'), 'a pattern must not have a ".." segment')
  .refine((pattern) => !pattern.startsWith('/') && !pattern.startsWith('\\') && !/^[a-zA-Z]:/.test(pattern), 'a pattern is relative to the repository root');

/** The most characters a check command holds: as long as a command line any shell takes, since `--check` took any length before the settings. */
export const maxCheckCommandLength = 32_000;

/** A check's command, or `false` for no check of the kind (R11). */
const checkCommandSchema = z.union([z.string().min(1).max(maxCheckCommandLength).refine((command) => !command.includes('\0'), 'must not hold a NUL').refine((command) => command.trim().length > 0, 'a command must not be blank'), z.literal(false)]);

/** The most minutes one check can run: a worker's longest timeout. */
const maxCheckMinutes = maxTimeoutMs / 60_000;

/**
 * How one setting is declared. `defaultOf` gives the value with no layer
 * for a run of one runtime, from the role policy where the policy holds it
 * (TD5), or null when the engine decides it some other way, which
 * `defaultWords` says; `example`
 * is what `config init` writes for a setting with no default value.
 */
export interface SettingDeclaration<V extends z.ZodType = z.ZodType> {
  readonly owner: Owner;
  readonly value: V;
  readonly defaultOf: (policy: PolicyFile, runtime: string) => z.infer<V> | null;
  /** The default in words, for `config explain` and `config init`. */
  readonly defaultWords: string;
  /** The value `config init` writes, commented out, for a setting whose default is null. */
  readonly example: z.infer<V>;
  /** The dedicated flag that sets it, if any. */
  readonly flag: string | null;
  /** One sentence, which `config explain` and `config init` print. */
  readonly describe: string;
}

const declare = <V extends z.ZodType>(declaration: SettingDeclaration<V>): SettingDeclaration<V> => declaration;

/** The check of one kind (R11). */
const checkSetting = (kind: CheckKind): SettingDeclaration<typeof checkCommandSchema> =>
  declare({
    owner: 'repository-first',
    value: checkCommandSchema,
    defaultOf: () => null,
    defaultWords: 'none: the survey decides',
    example: kind === 'build' ? 'npm run build' : kind === 'typecheck' ? 'npm run typecheck' : kind === 'lint' ? 'npm run lint' : 'npm test',
    flag: '--check, --no-check',
    describe: `The command of the ${kind} check of a fix run, or false for no ${kind} check; either one settles the kind, so the survey is not asked about it.`,
  });

/** The model of one tier of one runtime. */
const modelSetting = (runtime: ConfiguredRuntime, tier: 'strong' | 'fast'): SettingDeclaration<typeof modelSchema> =>
  declare({
    owner: 'operator-first',
    value: modelSchema,
    defaultOf: (policy) => policy.runtimes[runtime]?.[tier] ?? null,
    defaultWords: `the role policy's ${tier} model of ${runtime}`,
    example: tier === 'strong' ? 'opus' : 'sonnet',
    flag: `--${tier}-model`,
    describe: `The model of the ${tier} tier when a run uses runtime ${runtime}.`,
  });

/** The executable of one runtime. */
const executableSetting = (runtime: ConfiguredRuntime): SettingDeclaration<typeof textSchema> =>
  declare({
    owner: 'operator-only',
    value: textSchema,
    defaultOf: () => null,
    defaultWords: `${runtime} as found on PATH`,
    example: runtime,
    flag: '--executable',
    describe: `The executable that runs the workers of runtime ${runtime}: a path, or a name looked up on PATH.`,
  });

/** One argument of a runtime's executable: empty is one, as --executable-arg took one before the settings. */
const argumentSchema = z.string().max(1000).refine((argument) => !argument.includes('\0'), 'must not hold a NUL');

/** The arguments of one runtime's executable. */
const argsSetting = (runtime: ConfiguredRuntime): SettingDeclaration<z.ZodArray<typeof argumentSchema>> =>
  declare({
    owner: 'operator-only',
    value: z.array(argumentSchema).max(64),
    defaultOf: () => [],
    defaultWords: 'no arguments',
    example: [],
    flag: '--executable-arg',
    describe: `The arguments that go before each worker's own when the executable of runtime ${runtime} runs.`,
  });

/** Every setting the engine knows (R12), by its dotted name. */
export const settings = {
  'review.base': declare({
    owner: 'operator-only',
    value: revisionSchema,
    defaultOf: () => null,
    defaultWords: 'the branch that origin/HEAD names',
    example: 'origin/main',
    flag: '--base',
    describe: 'The branch that a change starts from: --branch reviews the change from its merge base with HEAD.',
  }),
  'scope.default': declare({
    owner: 'operator-only',
    value: z.enum(scopeDefaults),
    defaultOf: () => 'auto' as const,
    defaultWords: 'auto',
    example: 'auto',
    flag: null,
    describe: 'The scope of a run that names none: worktree, last-commit, branch, or auto, which reviews the uncommitted change when the tree has one and the last commit when it has none.',
  }),
  'scope.exclude': declare({
    owner: 'repository-first',
    value: z.array(excludePatternSchema).max(maxExcludePatterns),
    defaultOf: () => [],
    defaultWords: 'none',
    example: ['dist/**'],
    flag: null,
    describe: "Glob patterns, in git's pathspec syntax, of the changed paths that are never part of a reviewed change; the report names each path they leave out.",
  }),
  'checks.build': checkSetting('build'),
  'checks.typecheck': checkSetting('typecheck'),
  'checks.lint': checkSetting('lint'),
  'checks.test': checkSetting('test'),
  'checks.timeout_minutes': declare({
    owner: 'repository-first',
    value: z.number().positive().max(maxCheckMinutes).refine((minutes) => minutes * 60_000 >= 1000, 'a check can run for at least one second'),
    defaultOf: (policy) => policy.checks.timeoutMs / 60_000,
    defaultWords: "the role policy's checks.timeoutMs, in minutes",
    example: 20,
    flag: null,
    describe: 'How many minutes one check of a fix run can run before the engine stops it.',
  }),
  'tools.path': declare({
    owner: 'operator-only',
    value: z.array(textSchema).max(maxToolDirectories),
    defaultOf: () => [],
    defaultWords: 'none',
    example: ['.venv/bin'],
    flag: null,
    describe: 'Directories that go first on PATH for each check and each worker; a relative one is relative to the root of the worktree.',
  }),
  'conventions.user_rules': declare({
    owner: 'repository-first',
    value: userRulesSettingSchema,
    defaultOf: (policy) => policy.survey.userRules,
    defaultWords: "the role policy's survey.userRules",
    example: 'judge',
    flag: null,
    describe: "Whether the reviewer's own rules files count: ignore, apply, or judge, which leaves it to the surveyor.",
  }),
  'budget.usd': declare({
    owner: 'operator-first',
    value: z.number().positive().refine(Number.isFinite, 'must be a finite number'),
    defaultOf: (policy, runtime) => policy.runtimes[runtime]?.runBudgetUsd ?? null,
    defaultWords: "the role policy's run budget of the runtime: 60 on claude, none on codex",
    example: 60,
    flag: '--budget-usd',
    describe: 'The run budget in US dollars, on a runtime that reports its cost.',
  }),
  'run.concurrency': declare({
    owner: 'operator-only',
    value: z.number().int().min(1).max(maxConcurrency),
    defaultOf: (policy) => policy.concurrency,
    defaultWords: "the role policy's concurrency",
    example: 4,
    flag: '--concurrency',
    describe: 'The most workers a run keeps in flight at once.',
  }),
  'runtimes.claude.strong': modelSetting('claude', 'strong'),
  'runtimes.claude.fast': modelSetting('claude', 'fast'),
  'runtimes.claude.executable': executableSetting('claude'),
  'runtimes.claude.args': argsSetting('claude'),
  'runtimes.codex.strong': modelSetting('codex', 'strong'),
  'runtimes.codex.fast': modelSetting('codex', 'fast'),
  'runtimes.codex.executable': executableSetting('codex'),
  'runtimes.codex.args': argsSetting('codex'),
  'runtimes.codex.windows_sandbox': declare({
    owner: 'operator-only',
    value: z.enum(windowsSandboxes),
    defaultOf: (policy) => policy.runtimes.codex?.windowsSandbox ?? null,
    defaultWords: "the role policy's windowsSandbox of codex",
    example: 'none',
    flag: '--codex-windows-sandbox',
    describe: 'How the workers of a Codex run on Windows are confined: unelevated, elevated, or none.',
  }),
} as const;

export type Settings = typeof settings;
export type SettingName = keyof Settings;
/** A setting's value, or null when it has none: a default the engine decides some other way. */
export type SettingValue<N extends SettingName> = z.infer<Settings[N]['value']> | null;

/** Every setting's name, in the order the registry declares them. */
export const settingNames = Object.keys(settings) as SettingName[];

/** Whether a dotted name is a setting the registry declares. */
export const isSettingName = (name: string): name is SettingName => Object.hasOwn(settings, name);

/** The setting of one check kind. */
export const checkSettingName = (kind: CheckKind): SettingName => `checks.${kind}`;

/** The check settings, in the order the kinds run. */
export const checkSettingNames: readonly SettingName[] = checkKinds.map(checkSettingName);

/** The names of the settings of one runtime: its two models, its executable and its arguments. */
export function runtimeSettingNames(runtime: ConfiguredRuntime): { strong: SettingName; fast: SettingName; executable: SettingName; args: SettingName } {
  return { strong: `runtimes.${runtime}.strong`, fast: `runtimes.${runtime}.fast`, executable: `runtimes.${runtime}.executable`, args: `runtimes.${runtime}.args` };
}

/** Whether `runtime` is one the registry declares settings for. */
export const isConfiguredRuntime = (runtime: string): runtime is ConfiguredRuntime => (configuredRuntimes as readonly string[]).includes(runtime);

/**
 * Whether a table name is a prefix of some setting, so a file can hold
 * it as a table, as `[runtimes.claude]` holds `strong`.
 */
export const isSettingPrefix = (name: string): boolean => settingNames.some((setting) => setting.startsWith(`${name}.`));

/** Whether a file of `layer` can set the setting: every layer can, but the repository's file cannot set an operator-only setting (R3). */
export const settableBy = (name: SettingName, layer: Layer): boolean => layer !== 'repository' || settings[name].owner !== 'operator-only';

/** The settings a file of `layer` can set, in the registry's order: the schema of the layer. */
export const layerSettings = (layer: Layer): SettingName[] => settingNames.filter((name) => settableBy(name, layer));
