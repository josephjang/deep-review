import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { repositoryConfigPath } from '../../src/config/files.ts';
import { checkFlagsOf, dedicatedFlagValues } from '../../src/config/flags.ts';
import { flagLayerOf, parseSetFlag, type FlagValue } from '../../src/config/resolve.ts';
import type { SettingName } from '../../src/config/settings.ts';
import { configurationSource, type ConfigurationSource } from '../../src/config/source.ts';
import { assembleRoles } from '../../src/roles/assemble.ts';
import { checkSettingsInForce, checkSettingsOfResolved, recordedCheckSettings, refuseOldNode, unappliedLines } from '../../src/review/configuration.ts';
import { flagCheckSettings, type CheckSettings } from '../../src/review/checks/discover.ts';
import { ReviewRefusedError } from '../../src/review/errors.ts';
import { readPolicy, resolvePolicy } from '../../src/review/policy.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { fakeClaude } from '../helpers/launcher.ts';
import { commitAll, write } from '../helpers/repository.ts';
import { settingsConfigured, settingsBlock } from '../helpers/review-history.ts';
import { ReviewSandbox } from '../helpers/review-sandbox.ts';

/** The files and flags of one invocation in a sandbox, as the command line would build them: the fake runtime's argument is a flag, as --executable-arg is. */
interface SourceOptions {
  readonly operator?: string;
  readonly clone?: string;
  readonly invocation?: string;
  readonly sets?: readonly string[];
  readonly checks?: CheckSettings | null;
  readonly repositoryConfig?: boolean;
}

function sourceFor(box: ReviewSandbox, options: SourceOptions = {}): ConfigurationSource {
  const directory = join(box.directory, 'config');
  mkdirSync(directory, { recursive: true });
  const file = (name: string, text: string | undefined): string => {
    const path = join(directory, name);
    if (text !== undefined) writeFileSync(path, text);
    return path;
  };
  const operator = file('operator.toml', options.operator);
  const clone = file('clone.toml', options.clone);
  const invocation = options.invocation === undefined ? null : file('run.toml', options.invocation);
  const flags = flagLayerOf([...dedicatedFlagValues({ runtime: 'claude', policy: {}, checks: options.checks ?? null, executableArgs: [fakeClaude] }), ...(options.sets ?? []).map(parseSetFlag)]);
  return configurationSource({ worktree: box.repo, locations: { operator, clone, invocation }, repositoryConfig: options.repositoryConfig ?? true, flags });
}

/** Commit the repository's file, then a change on top of it, so the last commit's review reads the file at its base. */
function policyAtBase(box: ReviewSandbox, policy: string, change: Readonly<Record<string, string>> = { 'src/c.ts': 'export const c = 1;\n' }): string {
  write(box.repo, repositoryConfigPath, policy);
  const base = commitAll(box.repo, 'the policy');
  for (const [path, text] of Object.entries(change)) write(box.repo, path, text);
  commitAll(box.repo, 'a change under the policy');
  return base;
}

/** The configuration the run recorded, as the ledger holds it. */
const configuredPayload = (box: ReviewSandbox): Record<string, unknown> & { settings: Record<string, unknown> & { layers: Record<string, string>; values: Record<string, unknown> } } =>
  box.events(box.run().id).find(([kind]) => kind === 'review.configured')![1] as never;

describe('the settings in a run (R1, R4 to R6, R10, R11 of the configuration)', () => {
  it('pins with no file what the role policy and the flags give, every recorded setting at its default or a flag (R1)', async (t) => {
    const box = ReviewSandbox.forTest(t, { triage: { exit: 2 } });
    const outcome = await box.review('claude');
    assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome));
    const configured = configuredPayload(box);
    const policy = resolvePolicy(readPolicy(box.rolesRoot), assembleRoles(box.rolesRoot), claudeAdapter, {}, process.platform);
    assert.deepEqual(configured.models, policy.models);
    assert.equal(configured.concurrency, policy.concurrency);
    assert.equal(configured.runBudgetUsd, policy.runBudgetUsd);
    assert.deepEqual(configured.survey, policy.survey);
    assert.deepEqual(configured.roles, policy.roles);
    assert.equal(configured.rolesDigest, policy.rolesDigest);
    const { settings } = configured;
    assert.deepEqual(settings.files, []);
    assert.equal((settings.repository as { state: string }).state, 'absent');
    for (const [name, layer] of Object.entries(settings.layers)) assert.equal(layer, name === 'runtimes.claude.executable' || name === 'runtimes.claude.args' ? 'flag' : 'default', name);
    assert.deepEqual(settings.values, { 'review.base': null, 'scope.default': 'auto', 'scope.exclude': [], 'tools.path': [] });
    assert.ok(box.logs.includes(`run ${box.run().id}: settings from the defaults and the flags; no configuration file`), box.logs.join('\n'));
    assert.deepEqual(box.run().scope?.excluded, { paths: [], count: 0 });
  });

  it('records each value with the layer it came from: the repository\'s file at the base, the operator\'s, the clone\'s, the invocation file and --set (R2, R3, R6)', async (t) => {
    const box = ReviewSandbox.forTest(t, { triage: { exit: 2 } });
    const base = policyAtBase(box, 'schema = 1\nscope.exclude = ["dist/**"]\nbudget.usd = 120\nchecks.test = "npm test"\nconventions.user_rules = "apply"\n', { 'src/c.ts': 'export const c = 1;\n', 'dist/c.js': 'built\n' });
    const source = sourceFor(box, {
      operator: 'schema = 1\nbudget.usd = 40\n[runtimes.claude]\nstrong = "opus-next"\n',
      clone: 'schema = 1\ntools.path = [".venv/bin"]\nreport.formats = ["html"]\n',
      invocation: 'schema = 1\nchecks.test = "npm run test:fast"\n',
      sets: ['run.concurrency=2'],
      checks: flagCheckSettings({}, []),
    });
    const outcome = await box.review('claude', { configuration: source, fix: flagCheckSettings({}, []) });
    assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome));
    const configured = configuredPayload(box);
    const { settings } = configured;
    assert.equal(configured.runBudgetUsd, 40, 'operator-first: the operator\'s file over the repository\'s');
    assert.deepEqual(configured.models, { strong: 'opus-next', fast: 'sonnet' });
    assert.equal(configured.concurrency, 2);
    assert.deepEqual(configured.survey, { userRules: 'apply' });
    assert.deepEqual([settings.layers['budget.usd'], settings.layers['runtimes.claude.strong'], settings.layers['run.concurrency'], settings.layers['conventions.user_rules'], settings.layers['scope.exclude'], settings.layers['checks.test'], settings.layers['tools.path']], ['operator', 'operator', 'flag', 'repository', 'repository', 'invocation', 'clone']);
    assert.deepEqual(settings.values['checks.test'], 'npm run test:fast');
    assert.deepEqual(settings.values['tools.path'], [join(box.repo, '.venv', 'bin')]);
    assert.deepEqual(settings.notFollowed, [{ name: 'checks.test', repository: 'npm test', value: 'npm run test:fast', layer: 'invocation' }]);
    assert.deepEqual((settings.ignored as { name: string }[]).map((entry) => entry.name), ['report.formats']);
    assert.deepEqual((settings.files as { layer: string; commit: string | null }[]).map((file) => [file.layer, file.commit]), [['repository', base], ['operator', null], ['clone', null], ['invocation', null]]);
    // scope.exclude left dist/ out of the change, and the scope records it.
    const scope = box.run().scope!;
    assert.deepEqual(scope.files.map((file) => file.path), ['src/c.ts']);
    assert.deepEqual(scope.excluded, { paths: ['dist/c.js'], count: 1 });
    assert.ok(box.logs.some((line) => line.endsWith('scope.exclude left out 1 changed path')), box.logs.join('\n'));
    assert.ok(box.logs.some((line) => line.includes(`settings from the repository's file ${repositoryConfigPath} at ${base}`)), box.logs.join('\n'));
    assert.ok(box.logs.some((line) => line.includes('ignored report.formats in ') && line.endsWith(': no such setting')), box.logs.join('\n'));
    assert.ok(box.logs.some((line) => line.includes('tools.path names') && line.includes('which does not exist yet')), box.logs.join('\n'));
  });

  it('reads the repository\'s file as the base holds it, and says the change\'s own edit applies only to later changes (R4)', async (t) => {
    const box = ReviewSandbox.forTest(t, { triage: { exit: 2 } });
    policyAtBase(box, 'schema = 1\nconventions.user_rules = "ignore"\n');
    // The uncommitted change edits the policy, so the review is of the worktree, whose base is HEAD.
    write(box.repo, repositoryConfigPath, 'schema = 1\nconventions.user_rules = "apply"\nscope.exclude = ["src/**"]\n');
    write(box.repo, 'src/d.ts', 'export const d = 1;\n');
    await box.review('claude', { configuration: sourceFor(box) });
    const configured = configuredPayload(box);
    assert.deepEqual(configured.survey, { userRules: 'ignore' }, 'the base\'s value, not the change\'s');
    assert.deepEqual((configured.settings.repository as { edited: boolean }).edited, true);
    assert.ok(box.run().scope!.files.some((file) => file.path === 'src/d.ts'), 'the change\'s exclusion does not apply');
    assert.ok(box.logs.some((line) => line.endsWith('this change edits .deep-review/config.toml; the edit applies to later changes, and this review reads the file as its base holds it')), box.logs.join('\n'));
  });

  it('refuses a change the patterns leave empty, and an empty change, before a run exists (R10)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    policyAtBase(box, 'schema = 1\nscope.exclude = ["dist/**"]\n', { 'dist/c.js': 'built\n' });
    await assert.rejects(box.review('claude', { configuration: sourceFor(box) }), (error: unknown) => error instanceof ReviewRefusedError && /scope\.exclude \(dist\/\*\*\) leaves out all 1 of its changed paths; nothing to review$/.test(error.message));
    assert.deepEqual(box.checkpoint.foldRuns(), [], 'no run was created');
    await assert.rejects(box.review('claude', { scope: { named: true, request: () => ({ range: { from: 'HEAD', to: 'HEAD', mergeBase: false }, paths: [] }) } }), (error: unknown) => error instanceof ReviewRefusedError && /The change is empty/.test(error.message));
    assert.deepEqual(box.checkpoint.foldRuns(), []);
  });

  it('refuses a repository file it cannot read before a run exists, and reviews without it under --no-repository-config (R5, PD6)', async (t) => {
    const box = ReviewSandbox.forTest(t, { triage: { exit: 2 } });
    policyAtBase(box, 'schema = 1\nscope.exclude = "dist/**"\n');
    await assert.rejects(box.review('claude', { configuration: sourceFor(box) }), (error: unknown) => error instanceof ReviewRefusedError && /scope\.exclude: /.test(error.message) && /run with --no-repository-config/.test(error.message));
    assert.deepEqual(box.checkpoint.foldRuns(), []);
    await box.review('claude', { configuration: sourceFor(box, { repositoryConfig: false }) });
    assert.deepEqual(configuredPayload(box).settings.repository, { state: 'skipped', commit: null, edited: false });
    assert.ok(box.logs.some((line) => line.endsWith('the repository\'s file was skipped by --no-repository-config, so the run does not apply the policy of the repository')), box.logs.join('\n'));
  });

  it('records the names an operator\'s file holds that the engine does not know, however odd, within what the record holds (R5, R7)', async (t) => {
    const box = ReviewSandbox.forTest(t, { triage: { exit: 2 } });
    const many = Array.from({ length: 300 }, (_, index) => `n${String(index)} = 1`).join('\n');
    const outcome = await box.review('claude', { configuration: sourceFor(box, { operator: `schema = 1\n"" = 1\n"${'k'.repeat(1500)}" = 1\n${many}\n` }) });
    assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome));
    const ignored = configuredPayload(box).settings.ignored as { name: string }[];
    assert.equal(ignored.length, 256, 'at most 256 recorded');
    assert.equal(ignored[0]!.name, '""', 'an empty name is recorded as its quotes');
    assert.equal(ignored[1]!.name.length, 1000, 'a long name is cut to 1000 characters');
  });

  it('refuses an operator\'s file it cannot read before a run exists (R5)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    const source = sourceFor(box, { operator: 'schema = 1\nrun.concurrency = "four"\n' });
    await assert.rejects(box.review('claude', { configuration: source }), (error: unknown) => error instanceof ReviewRefusedError && /run\.concurrency/.test(error.message));
    // Pass 1 reads the same files, so a command that asks the scope's settings is refused the same way.
    assert.throws(() => source.scopeSettings(), ReviewRefusedError);
    assert.deepEqual(box.checkpoint.foldRuns(), []);
  });

  it('keeps what a resumed run recorded, naming each changed file and each setting it does not apply, and goes on when a file cannot be read now (R6)', async (t) => {
    const box = ReviewSandbox.forTest(t, { triage: { exit: 2 } });
    await box.review('claude', { configuration: sourceFor(box, { operator: 'schema = 1\nbudget.usd = 40\nconventions.user_rules = "apply"\n' }) });
    const runId = box.run().id;
    box.logs.length = 0;
    // The operator's file changes; only the concurrency and the run budget a flag gives apply on a resume.
    await box.review('claude', { configuration: sourceFor(box, { operator: 'schema = 1\nbudget.usd = 45\nconventions.user_rules = "ignore"\nrun.concurrency = 2\n', sets: ['budget.usd=50'] }), flags: { budgetUsd: 50 } });
    assert.ok(box.logs.includes(`run ${runId}: the operator's file ${join(box.directory, 'config', 'operator.toml')} changed since the run recorded it; the run keeps what it recorded`), box.logs.join('\n'));
    assert.ok(box.logs.includes(`run ${runId}: conventions.user_rules is now "ignore" from the operator's file, which is not applied; the run keeps "apply" from the operator's file`), box.logs.join('\n'));
    assert.ok(box.logs.includes(`run ${runId}: run.concurrency is now 2 from the operator's file, which is not applied; the run keeps 4 from the default`), box.logs.join('\n'));
    assert.ok(!box.logs.some((line) => line.includes('budget.usd is now')), 'the budget a flag gives applies');
    const run = box.run();
    assert.deepEqual(run.review!.limits, { concurrency: 4, runBudgetUsd: 50 });
    assert.deepEqual(run.review!.configuration.survey, { userRules: 'apply' });
    // A file it cannot read now does not stop the resume.
    box.logs.length = 0;
    const outcome = await box.review('claude', { configuration: sourceFor(box, { operator: 'not toml' }) });
    assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome));
    assert.ok(box.logs.some((line) => line.startsWith(`run ${runId}: the configuration cannot be read now, so the run keeps the settings it recorded: `)), box.logs.join('\n'));
  });

  it('names a model a --set gives a resume once, as the flag given (R6)', async (t) => {
    const box = ReviewSandbox.forTest(t, { triage: { exit: 2 } });
    await box.review('claude', { configuration: sourceFor(box) });
    const { id, review } = box.run();
    box.logs.length = 0;
    await box.review('claude', { configuration: sourceFor(box, { sets: ['runtimes.claude.strong=another-model'] }), flags: { strongModel: 'another-model' } });
    const named = box.logs.filter((line) => line.includes('runtimes.claude.strong') || line.includes('-model'));
    assert.deepEqual(named, [`run ${id} is pinned to models ${review!.configuration.models.strong} and ${review!.configuration.models.fast}; --set runtimes.claude.strong is ignored`]);
  });

  it('settles a check by a setting so the surveyor is not asked about it, and a resume before the plan needs no flag (R11)', async (t) => {
    const box = ReviewSandbox.forTest(t, { triage: { exit: 2 } });
    const flags = ReviewSandbox.checkFlags();
    policyAtBase(box, `schema = 1\nchecks.build = ${JSON.stringify(flags.commands.build)}\nchecks.typecheck = false\n`);
    await box.review('claude', { configuration: sourceFor(box, { checks: flagCheckSettings({}, []) }), fix: flagCheckSettings({}, []) });
    const state = box.run();
    const surveyor = Object.values(state.workers).find((worker) => worker.launch.label === 'surveyor survey:survey')!;
    const task = box.checkpoint.evidence.read(surveyor.launch.prompt).toString('utf8');
    assert.match(task, /^Settled by the operator's flags and the configuration, which you leave out of `checks`:$/m);
    assert.match(task, /^- typecheck: dropped by checks\.typecheck = false in the repository's file$/m);
    assert.match(task, /^Kinds to choose: lint, test$/m);
    assert.deepEqual(state.review!.fix!.checks.planned!.checks.slice(0, 2).map((check) => [check.kind, check.origin, check.layer]), [['build', 'setting', 'repository'], ['typecheck', 'setting', 'repository']]);
    // The log names the setting once: the dropped kind's reason already says `= false`.
    assert.ok(box.logs.includes(`run ${state.id}: check build: ${flags.commands.build} (checks.build in the repository's file)`), box.logs.join('\n'));
    assert.ok(box.logs.includes(`run ${state.id}: check typecheck: not available (checks.typecheck in the repository's file: dropped by checks.typecheck = false in the repository's file)`), box.logs.join('\n'));
  });
});

// The fixers run the engine's snapshot and claim commands as `node` on their PATH, which tools.path comes first on.
describe('the node of tools.path', () => {
  const node = process.platform === 'win32' ? 'node.exe' : 'node';
  const withNode = (t: { after: (hook: () => void) => void }): string => {
    const directory = mkdtempSync(join(tmpdir(), 'dr-tools-node-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, node), '');
    return directory;
  };

  it('refuses a directory whose node is older than the engine needs, naming it, the version and the setting', (t) => {
    const directory = withNode(t);
    assert.throws(() => refuseOldNode([directory], process.platform, () => 'v20.11.1'), (error: unknown) => error instanceof ReviewRefusedError && error.message.includes(directory) && /v20\.11\.1/.test(error.message) && /tools\.path/.test(error.message) && /Node 26 or newer/.test(error.message));
  });

  it('refuses a node it cannot ask its version', (t) => {
    const directory = withNode(t);
    assert.throws(() => refuseOldNode([directory], process.platform, () => { throw new Error('not a program'); }), (error: unknown) => error instanceof ReviewRefusedError && /cannot be asked its version: not a program/.test(error.message));
  });

  it('refuses a fix run, before it exists, whose tools.path holds a node that cannot run, and lets a read-only run go on', async (t) => {
    const box = ReviewSandbox.forTest(t, { triage: { exit: 2 } });
    const directory = withNode(t);
    const clone = `schema = 1\ntools.path = [${JSON.stringify(directory)}]\n`;
    await assert.rejects(box.review('claude', { configuration: sourceFor(box, { clone, checks: flagCheckSettings({}, []) }), fix: flagCheckSettings({}, []) }), (error: unknown) => error instanceof ReviewRefusedError && error.message.includes(`tools.path names ${directory}, whose node cannot be asked its version`));
    assert.deepEqual(box.checkpoint.foldRuns(), [], 'no run was created');
    assert.equal((await box.review('claude', { configuration: sourceFor(box, { clone }) })).kind, 'blocked', 'a read-only run runs no engine command in a fixer');
  });

  it('qualifies the executable with tools.path first on PATH, as its workers run, for a new run and its resume', async (t) => {
    const box = ReviewSandbox.forTest(t, { triage: { exit: 2 } });
    const directory = mkdtempSync(join(tmpdir(), 'dr-tools-first-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const clone = `schema = 1\ntools.path = [${JSON.stringify(directory)}]\n`;
    const fake = { FAKE_QUALIFIED_FIRST_ON_PATH: directory };
    assert.equal((await box.review('claude', { configuration: sourceFor(box, { clone }) }, fake)).kind, 'blocked', box.logs.join('\n'));
    assert.equal(configuredPayload(box).version, '2.1.283');
    // The resume qualifies the pinned executable with the tools.path the run recorded, which its workers run with.
    assert.equal((await box.review('claude', { configuration: sourceFor(box, { clone: 'schema = 1\n' }) }, fake)).kind, 'blocked', box.logs.join('\n'));
  });

  it('takes a node of 26 or newer, a directory with no node, and the engine\'s own node without asking it', (t) => {
    const directory = withNode(t);
    refuseOldNode([directory], process.platform, () => 'v26.0.0');
    refuseOldNode([directory], process.platform, () => 'v27.3.1\n');
    let asked = 0;
    const probe = (): string => {
      asked += 1;
      return 'v1.0.0';
    };
    refuseOldNode([join(directory, 'none'), dirname(process.execPath)], process.platform, probe);
    assert.equal(asked, 0, 'no node to ask, and the engine\'s own is not asked');
  });
});

describe('the check settings in force', () => {
  /** The command's resolver of the executable, as one that finds the runtime's name where the fixture's run pinned it. */
  const onPath = (configured: string | null): string => configured ?? '/bin/claude';
  const recorded: CheckSettings = { commands: { build: 'make', test: 'npm test' }, dropped: ['lint'], layers: { build: 'repository', test: 'clone', lint: 'operator' } };

  /** The settings a resume of a `settingsConfigured(fix)` run resolves when its files and flags are as the run recorded them: the ones version 5 holds read back from its fields. */
  const unchangedNow = (fix: boolean): { runtime: string; values: Record<string, { value: unknown; layer: string }>; files: { layer: string; path: string; sha256: string; commit: string | null }[]; repository: { state: 'read' | 'absent' | 'skipped'; commit: string | null; edited: boolean }; notFollowed: []; ignored: [] } => ({
    runtime: 'claude',
    values: {
      ...Object.fromEntries(Object.keys(settingsBlock(fix).layers as object).map((name) => [name, { value: null, layer: 'default' }])),
      'scope.default': { value: 'auto', layer: 'default' }, 'scope.exclude': { value: [], layer: 'default' }, 'tools.path': { value: [], layer: 'default' }, 'conventions.user_rules': { value: 'judge', layer: 'default' }, 'budget.usd': { value: 30, layer: 'default' }, 'run.concurrency': { value: 4, layer: 'default' }, 'runtimes.claude.strong': { value: 'opus', layer: 'default' }, 'runtimes.claude.fast': { value: 'sonnet', layer: 'default' }, 'runtimes.claude.args': { value: [], layer: 'default' },
      ...(fix ? { 'checks.timeout_minutes': { value: 10, layer: 'default' } } : {}),
    },
    files: [],
    repository: { state: 'absent', commit: '1'.repeat(40), edited: false },
    notFollowed: [],
    ignored: [],
  });

  it('takes the recorded settings, each kind a flag settles taking the flag\'s place with the flag layer', () => {
    assert.deepEqual(checkSettingsInForce(recorded, null), recorded);
    assert.deepEqual(checkSettingsInForce(recorded, flagCheckSettings({ test: 'npm run t' }, ['build'])), { commands: { test: 'npm run t' }, dropped: ['build', 'lint'], layers: { build: 'flag', lint: 'operator', test: 'flag' } });
    assert.deepEqual(checkSettingsInForce(null, flagCheckSettings({ test: 'x' }, [])), { commands: { test: 'x' }, dropped: [], layers: { test: 'flag' } }, 'a run that recorded none has the flags alone');
    assert.deepEqual(checkSettingsInForce(null, null), { commands: {}, dropped: [], layers: {} });
  });

  it('reads the check settings the resolved settings settle, each with its layer, and leaves the rest to the survey', () => {
    const now = unchangedNow(true);
    const resolved = { ...now, values: { ...now.values, 'checks.build': { value: 'make', layer: 'repository' }, 'checks.lint': { value: false, layer: 'operator' }, 'checks.test': { value: 'npm test', layer: 'flag' } } };
    assert.deepEqual(checkSettingsOfResolved(resolved as never), { commands: { build: 'make', test: 'npm test' }, dropped: ['lint'], layers: { build: 'repository', lint: 'operator', test: 'flag' } });
    assert.deepEqual(checkSettingsOfResolved(now as never), { commands: {}, dropped: [], layers: {} }, 'no layer settles a check');
  });

  it('reads the check settings a fix run recorded, and none for a read-only run or one recorded before the settings', () => {
    const values = { 'review.base': null, 'scope.default': 'auto', 'scope.exclude': [], 'tools.path': [], 'checks.build': 'make', 'checks.typecheck': null, 'checks.lint': false, 'checks.test': null };
    const fixing = settingsConfigured(true, { values, layers: { ...(settingsBlock(true).layers as object), 'checks.build': 'repository', 'checks.lint': 'flag' } }).review().configuration;
    assert.deepEqual(recordedCheckSettings(fixing), { commands: { build: 'make' }, dropped: ['lint'], layers: { build: 'repository', lint: 'flag' } });
    assert.equal(recordedCheckSettings(settingsConfigured(false).review().configuration), null);
    assert.equal(recordedCheckSettings({ ...fixing, settings: null }), null);
  });

  it('names no unapplied setting for a resume whose files and flags are as the run recorded them', () => {
    const configuration = settingsConfigured(false).review().configuration;
    const now = unchangedNow(false);
    assert.deepEqual(unappliedLines('r', configuration, now as never, flagLayerOf([]), onPath), []);
    assert.deepEqual(unappliedLines('r', settingsConfigured(true).review().configuration, unchangedNow(true) as never, flagLayerOf([]), onPath), [], 'a fix run reads its check settings back as well');
    assert.deepEqual(unappliedLines('r', configuration, { ...now, values: { ...now.values, 'run.concurrency': { value: 2, layer: 'flag' } } } as never, flagLayerOf([{ name: 'run.concurrency', value: 2, flag: '--concurrency' }]), onPath), [], 'a concurrency flag applies per invocation');
    assert.deepEqual(unappliedLines('r', configuration, { ...now, values: { ...now.values, 'scope.exclude': { value: ['dist/**'], layer: 'clone' } } } as never, flagLayerOf([]), onPath), ['run r: scope.exclude is now ["dist/**"] from the clone\'s file, which is not applied; the run keeps [] from the default']);
  });

  it('compares a setting the run recorded from a flag only with a flag given now', () => {
    const configuration = settingsConfigured(false, { layers: { ...(settingsBlock(false).layers as object), 'runtimes.claude.args': 'flag', 'runtimes.claude.strong': 'flag' } }, { executableArgs: ['--foo'], models: { strong: 'x', fast: 'sonnet' } }).review().configuration;
    const now = unchangedNow(false);
    assert.deepEqual(unappliedLines('r', configuration, now as never, flagLayerOf([]), onPath), [], 'a resume without --executable-arg and --strong-model');
    const set = parseSetFlag('runtimes.claude.args=["--bar"]');
    assert.deepEqual(unappliedLines('r', configuration, { ...now, values: { ...now.values, 'runtimes.claude.args': { value: ['--bar'], layer: 'flag' } } } as never, flagLayerOf([set]), onPath), [`run r: runtimes.claude.args is now ["--bar"] from ${set.flag}, which is not applied; the run keeps ["--foo"] from a flag`]);
  });

  it('compares the path the executable setting resolves to now with the path the run pinned, and names one it cannot resolve', () => {
    const configuration = settingsConfigured(false).review().configuration;
    const now = unchangedNow(false);
    const changed = { ...now, values: { ...now.values, 'runtimes.claude.executable': { value: 'claude-beta', layer: 'operator' } } };
    assert.deepEqual(unappliedLines('r', configuration, changed as never, flagLayerOf([]), (configured) => (configured === 'claude-beta' ? '/opt/claude-beta' : onPath(configured))), ['run r: runtimes.claude.executable is now "/opt/claude-beta" from the operator\'s file, which is not applied; the run keeps "/bin/claude" from the default']);
    assert.deepEqual(unappliedLines('r', configuration, changed as never, flagLayerOf([]), () => '/bin/claude'), [], 'a setting that resolves to the pinned path');
    const refused = (): string => {
      throw new ReviewRefusedError('claude-beta is not on PATH');
    };
    assert.deepEqual(unappliedLines('r', configuration, changed as never, flagLayerOf([]), refused), ['run r: runtimes.claude.executable is now "claude-beta" from the operator\'s file, which is not applied and does not resolve now: claude-beta is not on PATH; the run keeps "/bin/claude" from the default']);
    assert.deepEqual(unappliedLines('r', configuration, now as never, flagLayerOf([]), '/usr/local/bin/claude'), ['run r: runtimes.claude.executable is now "/usr/local/bin/claude" from the default, which is not applied; the run keeps "/bin/claude" from the default'], 'a caller\'s path is the executable whatever the setting');
  });

  it('leaves a setting with a resume line of its own to that line whichever flag gives it, and names the rest as the flag given', () => {
    const configuration = settingsConfigured(false).review().configuration;
    const now = unchangedNow(false);
    const given = (name: SettingName, value: unknown, flag: FlagValue): string[] => unappliedLines('r', configuration, { ...now, values: { ...now.values, [name]: { value, layer: 'flag' } } } as never, flagLayerOf([flag]), onPath);
    assert.deepEqual(given('runtimes.claude.strong', 'x', parseSetFlag('runtimes.claude.strong=x')), [], 'the model line names --set runtimes.claude.strong');
    assert.deepEqual(given('runtimes.claude.strong', 'x', { name: 'runtimes.claude.strong', value: 'x', flag: '--strong-model' }), []);
    assert.deepEqual(given('run.concurrency', 2, parseSetFlag('run.concurrency=2')), [], 'a concurrency --set applies per invocation');
    assert.deepEqual(given('budget.usd', 50, parseSetFlag('budget.usd=50')), [], 'a run budget --set applies per invocation');
    assert.deepEqual(given('runtimes.claude.args', ['--bar'], { name: 'runtimes.claude.args', value: ['--bar'], flag: '--executable-arg' }), ['run r: runtimes.claude.args is now ["--bar"] from --executable-arg, which is not applied; the run keeps [] from the default'], 'no resume line of its own names --executable-arg');
  });

  it('leaves a check command a flag gives to the planning of the checks, but not the check timeout', () => {
    const configuration = settingsConfigured(true).review().configuration;
    const now = unchangedNow(true);
    const command = parseSetFlag('checks.test=make test');
    assert.deepEqual(unappliedLines('r', configuration, { ...now, values: { ...now.values, 'checks.test': { value: 'make test', layer: 'flag' } } } as never, flagLayerOf([command]), onPath), [], 'a check command applies until the checks are planned');
    const timeout = parseSetFlag('checks.timeout_minutes=2');
    assert.equal(unappliedLines('r', configuration, { ...now, values: { ...now.values, 'checks.timeout_minutes': { value: 2, layer: 'flag' } } } as never, flagLayerOf([timeout]), onPath).length, 1, 'the check timeout is no check command');
  });

  it('names a recorded file this invocation did not read apart from one that is gone', () => {
    const repository = { layer: 'repository', path: '.deep-review/config.toml', sha256: 'a'.repeat(64), commit: '1'.repeat(40) };
    const invocation = { layer: 'invocation', path: '/w/run.toml', sha256: 'b'.repeat(64), commit: null };
    const operator = { layer: 'operator', path: '/home/config.toml', sha256: 'c'.repeat(64), commit: null };
    const configuration = settingsConfigured(false, { files: [repository, operator, invocation], repository: { state: 'read', commit: '1'.repeat(40), edited: false } }).review().configuration;
    const now = unchangedNow(false);
    assert.deepEqual(unappliedLines('r', configuration, { ...now, repository: { state: 'skipped', commit: null, edited: false } } as never, flagLayerOf([]), onPath), [
      'run r: the repository\'s file .deep-review/config.toml is skipped by --no-repository-config; the run keeps what it recorded',
      'run r: the operator\'s file /home/config.toml is gone since the run recorded it; the run keeps what it recorded',
      'run r: the --config file /w/run.toml is not given again with --config; the run keeps what it recorded',
    ]);
    assert.deepEqual(unappliedLines('r', configuration, { ...now, files: [repository, operator, invocation], repository: { state: 'read', commit: '1'.repeat(40), edited: false } } as never, flagLayerOf([]), onPath), [], 'every file read again as it was');
    assert.deepEqual(unappliedLines('r', configuration, { ...now, files: [operator, invocation] } as never, flagLayerOf([]), onPath), ['run r: the repository\'s file .deep-review/config.toml is gone since the run recorded it; the run keeps what it recorded'], 'a repository file looked for at the base and not found');
  });

  it('compares the check timeout in the whole milliseconds the run pinned', () => {
    // 1.23456 minutes is 74073.6 ms, which the pin rounds to 74074, and 74074 ms reads back as 1.2345666666666666 minutes.
    const configuration = settingsConfigured(true, { layers: { ...(settingsBlock(true).layers as object), 'checks.timeout_minutes': 'repository' } }, { checks: { timeoutMs: 74_074 } }).review().configuration;
    const now = unchangedNow(true);
    assert.deepEqual(unappliedLines('r', configuration, { ...now, values: { ...now.values, 'checks.timeout_minutes': { value: 1.23456, layer: 'repository' } } } as never, flagLayerOf([]), onPath), [], 'the same file, read again');
    assert.deepEqual(unappliedLines('r', configuration, { ...now, values: { ...now.values, 'checks.timeout_minutes': { value: 1.5, layer: 'repository' } } } as never, flagLayerOf([]), onPath), ['run r: checks.timeout_minutes is now 1.5 from the repository\'s file, which is not applied; the run keeps 1.2345666666666666 from the repository\'s file']);
  });

  it('builds the invocation\'s check flags from --check, --no-check and --set alike', () => {
    const layer = flagLayerOf([...dedicatedFlagValues({ runtime: 'claude', policy: {}, checks: flagCheckSettings({ build: 'make' }, ['lint']) }), parseSetFlag('checks.test=npm test')]);
    assert.deepEqual(checkFlagsOf(layer), { commands: { build: 'make', test: 'npm test' }, dropped: ['lint'], layers: { build: 'flag', lint: 'flag', test: 'flag' } });
  });
});
