import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { SettingFlagError } from '../../src/config/errors.ts';
import { dedicatedFlagValues } from '../../src/config/flags.ts';
import { repositoryConfigPath, type ConfigFile } from '../../src/config/files.ts';
import { flagLayerOf, noFlags, originHeadBranch, parseSetFlag, parseSetValue, readOperatorFiles, requireBase, resolvedValue, resolveScopeSettings, resolveSettings, withChangedPaths, type FlagLayer, type SettingsInputs } from '../../src/config/resolve.ts';
import { layerOrder, owners, scopeDefaults, settableBy, settings, type FileLayer, type Layer, type Owner, type SettingName } from '../../src/config/settings.ts';
import { repositoryRolesRoot } from '../../src/roles/assemble.ts';
import { ReviewRefusedError } from '../../src/review/errors.ts';
import { readPolicy } from '../../src/review/policy.ts';
import { git, repositoryWith } from '../helpers/repository.ts';

const policy = readPolicy(repositoryRolesRoot());
const worktree = resolve('/repo');

/** A file of one layer that sets the given settings, as the loader would give it. */
const file = (layer: FileLayer, values: Partial<Record<SettingName, unknown>>, ignored: string[] = []): ConfigFile => ({
  layer,
  path: layer === 'repository' ? repositoryConfigPath : `/${layer}.toml`,
  sha256: '0'.repeat(64),
  commit: layer === 'repository' ? 'a'.repeat(40) : null,
  values: new Map(Object.entries(values) as [SettingName, unknown][]),
  ignored,
});

const flags = (values: Partial<Record<SettingName, unknown>>): FlagLayer => flagLayerOf(Object.entries(values).map(([name, value]) => ({ name: name as SettingName, value, flag: `--set ${name}` })));

const inputs = (files: readonly ConfigFile[], flagLayer: FlagLayer = noFlags, overrides: Partial<SettingsInputs> = {}): SettingsInputs => ({
  policy,
  runtime: 'claude',
  costInUsd: true,
  files,
  flags: flagLayer,
  repository: files.some((candidate) => candidate.layer === 'repository') ? { state: 'read', commit: 'a'.repeat(40) } : { state: 'absent', commit: 'a'.repeat(40) },
  worktree,
  originHead: () => 'origin/main',
  ...overrides,
});

/** One setting of each owner, with two values its schema takes. */
const samples: Readonly<Record<Owner, { name: SettingName; low: unknown; high: unknown }>> = {
  'repository-first': { name: 'checks.test', low: 'npm test', high: 'npm run test:fast' },
  'operator-first': { name: 'budget.usd', low: 30, high: 90 },
  'operator-only': { name: 'run.concurrency', low: 2, high: 8 },
};

/** The values the layer gives the setting, for a layer of a file or the flags. */
const givenBy = (layer: Exclude<Layer, 'default'>, name: SettingName, value: unknown): { files: ConfigFile[]; flagLayer: FlagLayer } =>
  layer === 'flag' ? { files: [], flagLayer: flags({ [name]: value }) } : { files: [file(layer, { [name]: value })], flagLayer: noFlags };

describe('resolveSettings: the order of the layers', () => {
  for (const owner of owners) {
    const { name, low, high } = samples[owner];
    const order = layerOrder[owner].filter((layer): layer is Exclude<Layer, 'default'> => layer !== 'default');
    for (const [lowIndex, lower] of order.entries()) {
      for (const higher of order.slice(lowIndex + 1)) {
        it(`for ${owner} ${name}, ${higher} wins over ${lower}`, () => {
          const below = givenBy(lower, name, low);
          const above = givenBy(higher, name, high);
          const flagLayer = higher === 'flag' ? above.flagLayer : below.flagLayer;
          const resolved = resolveSettings(inputs([...below.files, ...above.files], flagLayer));
          assert.deepEqual(resolved.values[name], { value: high, layer: higher });
          const repositoryLost = owner === 'repository-first' && lower === 'repository';
          assert.deepEqual(resolved.notFollowed, repositoryLost ? [{ name, repository: low, value: high, layer: higher }] : [], 'only a repository-first value a higher layer replaces is not followed');
        });
      }
    }
  }

  it('gives each setting its default with no layer, and the role policy\'s values for the ones it holds', () => {
    const resolved = resolveSettings(inputs([]));
    for (const [name, setting] of Object.entries(resolved.values)) assert.equal(setting.layer, 'default', name);
    assert.equal(resolvedValue(resolved, 'run.concurrency'), policy.concurrency);
    assert.equal(resolvedValue(resolved, 'budget.usd'), 60);
    assert.equal(resolvedValue(resolved, 'checks.timeout_minutes'), 20);
    assert.equal(resolvedValue(resolved, 'conventions.user_rules'), 'judge');
    assert.equal(resolvedValue(resolved, 'runtimes.claude.strong'), 'opus');
    assert.equal(resolvedValue(resolved, 'review.base'), 'origin/main', 'the branch origin/HEAD names');
    assert.equal(resolvedValue(resolved, 'checks.test'), null, 'the survey decides');
    assert.deepEqual(resolved.notFollowed, []);
    assert.deepEqual(resolved.ignored, []);
  });

  it('lets an operator\'s file fill a gap a repository-first setting\'s file leaves, and lose to the repository\'s value', () => {
    const operator = file('operator', { 'checks.test': 'make test', 'checks.lint': 'make lint' });
    const repository = file('repository', { 'checks.test': 'npm test' });
    const resolved = resolveSettings(inputs([operator, repository]));
    assert.deepEqual(resolved.values['checks.test'], { value: 'npm test', layer: 'repository' });
    assert.deepEqual(resolved.values['checks.lint'], { value: 'make lint', layer: 'operator' });
    assert.deepEqual(resolved.notFollowed, [], 'the operator\'s file is below the repository\'s for its settings');
  });

  it('replaces a lower list whole with a higher one, and does not list a higher layer that gives the repository\'s own value', () => {
    const repository = file('repository', { 'scope.exclude': ['dist/**', 'vendor/**'] });
    const clone = file('clone', { 'scope.exclude': ['dist/**'] });
    assert.deepEqual(resolveSettings(inputs([repository, clone])).values['scope.exclude'], { value: ['dist/**'], layer: 'clone' });
    const same = resolveSettings(inputs([repository, file('clone', { 'scope.exclude': ['dist/**', 'vendor/**'] })]));
    assert.deepEqual(same.notFollowed, []);
    const empty = resolveSettings(inputs([repository], flags({ 'scope.exclude': [] })));
    assert.deepEqual(empty.values['scope.exclude'], { value: [], layer: 'flag' }, 'an empty list is a value');
    assert.deepEqual(empty.notFollowed, [{ name: 'scope.exclude', repository: ['dist/**', 'vendor/**'], value: [], layer: 'flag' }]);
  });

  it('takes a suggestion of the repository for an operator-first setting only where the operator says nothing', () => {
    const repository = file('repository', { 'budget.usd': 120 });
    assert.deepEqual(resolveSettings(inputs([repository])).values['budget.usd'], { value: 120, layer: 'repository' });
    assert.deepEqual(resolveSettings(inputs([repository, file('operator', { 'budget.usd': 40 })])).values['budget.usd'], { value: 40, layer: 'operator' });
  });

  it('ignores a run budget a file gives a runtime that reports no cost, and names it', () => {
    const resolved = resolveSettings(inputs([file('repository', { 'budget.usd': 120 })], noFlags, { runtime: 'codex', costInUsd: false }));
    assert.deepEqual(resolved.values['budget.usd'], { value: null, layer: 'default' });
    assert.deepEqual(resolved.ignored, [{ layer: 'repository', path: repositoryConfigPath, name: 'budget.usd', reason: 'runtime codex reports no cost in USD, so its run has no budget' }]);
  });

  it('lists the names an operator\'s or a clone\'s file holds that the engine does not know', () => {
    const resolved = resolveSettings(inputs([file('operator', {}, ['report.formats']), file('clone', {}, ['profile'])]));
    assert.deepEqual(resolved.ignored.map((entry) => [entry.layer, entry.name, entry.reason]), [['operator', 'report.formats', 'no such setting'], ['clone', 'profile', 'no such setting']]);
  });

  it('makes a relative tools.path entry absolute against the root of the worktree, and keeps an absolute one', () => {
    const absolute = resolve('/opt/node/bin');
    const resolved = resolveSettings(inputs([file('clone', { 'tools.path': ['.venv/bin', absolute] })]));
    assert.deepEqual(resolved.values['tools.path'], { value: [join(worktree, '.venv', 'bin'), absolute], layer: 'clone' });
  });

  it('records the files read with their layers, and the state of the repository\'s file', () => {
    const resolved = resolveSettings(inputs([file('operator', {}), file('repository', {})]));
    assert.deepEqual(resolved.files.map((entry) => [entry.layer, entry.path, entry.commit]), [['operator', '/operator.toml', null], ['repository', repositoryConfigPath, 'a'.repeat(40)]]);
    assert.deepEqual(resolved.repository, { state: 'read', commit: 'a'.repeat(40), edited: false });
    const skipped = resolveSettings(inputs([], noFlags, { repository: { state: 'skipped', commit: null } }));
    assert.deepEqual(skipped.repository, { state: 'skipped', commit: null, edited: false });
  });

  it('finds an edit of the repository\'s file in the change\'s full list of paths, unless the file was skipped', () => {
    const resolved = resolveSettings(inputs([file('repository', {})]));
    assert.equal(withChangedPaths(resolved, ['src/a.ts', repositoryConfigPath]).repository.edited, true);
    assert.equal(withChangedPaths(resolved, ['src/a.ts']).repository.edited, false);
    const skipped = resolveSettings(inputs([], noFlags, { repository: { state: 'skipped', commit: null } }));
    assert.equal(withChangedPaths(skipped, [repositoryConfigPath]).repository.edited, false);
  });

  it('never gives the repository\'s file an operator-only setting, even when a file of its layer holds one', () => {
    for (const name of Object.keys(settings) as SettingName[]) {
      if (settableBy(name, 'repository')) continue;
      const resolved = resolveSettings(inputs([file('repository', { [name]: settings[name].example })]));
      assert.notEqual(resolved.values[name].layer, 'repository', name);
    }
  });
});

describe('the flag layer', () => {
  it('reads a --set value as TOML, or else as the raw text', () => {
    assert.equal(parseSetValue('120'), 120);
    assert.equal(parseSetValue('2.5'), 2.5);
    assert.equal(parseSetValue('false'), false);
    assert.deepEqual(parseSetValue('["dist/**", "vendor/**"]'), ['dist/**', 'vendor/**']);
    assert.equal(parseSetValue('"quoted"'), 'quoted');
    assert.equal(parseSetValue('npm test'), 'npm test');
    assert.equal(parseSetValue('a = b'), 'a = b');
    assert.equal(parseSetValue('"x"\nother = 1'), '"x"\nother = 1', 'a second key makes it text, not two settings');
  });

  it('splits --set at the first =, so a value can hold one', () => {
    assert.deepEqual(parseSetFlag('checks.test=FOO=1 npm test'), { name: 'checks.test', value: 'FOO=1 npm test', flag: '--set checks.test', text: 'FOO=1 npm test' });
    assert.deepEqual(parseSetFlag('checks.lint=false'), { name: 'checks.lint', value: false, flag: '--set checks.lint', text: 'false' });
    assert.deepEqual(parseSetFlag('budget.usd=120'), { name: 'budget.usd', value: 120, flag: '--set budget.usd', text: '120' });
    assert.deepEqual(parseSetFlag('scope.exclude=["dist/**"]'), { name: 'scope.exclude', value: ['dist/**'], flag: '--set scope.exclude', text: '["dist/**"]' });
    for (const argument of ['checks.test', '=x', 'nope=1', 'runtimes.gemini.strong=x']) assert.throws(() => parseSetFlag(argument), SettingFlagError, argument);
  });

  it('keeps the text of a --set whose TOML value its setting refuses but whose text it takes, so a digit-only revision or the command true stay strings', () => {
    assert.deepEqual(flagLayerOf([parseSetFlag('review.base=1234567')]).get('review.base')?.value, '1234567');
    assert.deepEqual(flagLayerOf([parseSetFlag('checks.test=true')]).get('checks.test')?.value, 'true');
    assert.equal(flagLayerOf([parseSetFlag('checks.test=false')]).get('checks.test')?.value, false, 'false drops the check, as in a file');
    assert.equal(flagLayerOf([parseSetFlag('run.concurrency=2')]).get('run.concurrency')?.value, 2);
    assert.throws(() => flagLayerOf([parseSetFlag('run.concurrency=two')]), /--set run\.concurrency: /, 'text a number setting refuses is still refused');
  });

  it('refuses a quoted --set string its setting refuses, and does not take the quotes as the text', () => {
    assert.throws(() => flagLayerOf([parseSetFlag('checks.test="   "')]), /--set checks\.test: .*not " {3}"$/);
    assert.throws(() => flagLayerOf([parseSetFlag('checks.lint=""')]), /--set checks\.lint: .*not ""$/);
    assert.throws(() => flagLayerOf([parseSetFlag('review.base="-x"')]), /--set review\.base: .*not "-x"$/);
  });

  // R1 of the configuration: a dedicated flag the command line took before the settings is still taken.
  it('takes every --check command and --executable-arg the command line took before the settings, a long command and an empty argument among them', () => {
    const long = `npm test -- ${'x'.repeat(5000)}`;
    const layer = flagLayerOf(dedicatedFlagValues({ runtime: 'claude', policy: {}, checks: { commands: { test: long }, dropped: [] }, executableArgs: ['', '--flag'] }));
    assert.equal(layer.get('checks.test')?.value, long);
    assert.deepEqual(layer.get('runtimes.claude.args')?.value, ['', '--flag']);
  });

  it('checks each value against its setting, and refuses two flags for one setting', () => {
    assert.throws(() => flagLayerOf([parseSetFlag('budget.usd=cheap')]), /--set budget\.usd: .*not "cheap"/);
    assert.throws(() => flagLayerOf([parseSetFlag('run.concurrency=0')]), /--set run\.concurrency/);
    assert.throws(() => flagLayerOf([parseSetFlag('budget.usd=inf')]), /--set budget\.usd: .*not inf$/);
    assert.throws(() => flagLayerOf([parseSetFlag('budget.usd=-inf')]), /--set budget\.usd: .*not -inf$/);
    assert.throws(() => flagLayerOf([parseSetFlag('run.concurrency=nan')]), /--set run\.concurrency: .*not nan$/);
    assert.throws(() => flagLayerOf([{ name: 'budget.usd', value: 30, flag: '--budget-usd' }, parseSetFlag('budget.usd=40')]), /--set budget\.usd and --budget-usd both set budget\.usd; give one/);
    assert.throws(() => flagLayerOf([parseSetFlag('checks.test=a'), parseSetFlag('checks.test=b')]), SettingFlagError);
    const layer = flagLayerOf([{ name: 'budget.usd', value: 30, flag: '--budget-usd' }, parseSetFlag('checks.test=npm test')]);
    assert.deepEqual([...layer.keys()], ['budget.usd', 'checks.test']);
  });
});

describe('pass 1: the settings that choose the change', () => {
  it('gives each value of scope.default from the layer that sets it, and auto by default', () => {
    assert.deepEqual(resolveScopeSettings([], noFlags, () => null).scopeDefault, { value: 'auto', layer: 'default' });
    for (const value of scopeDefaults) {
      assert.deepEqual(resolveScopeSettings([file('operator', { 'scope.default': value })], noFlags, () => null).scopeDefault, { value, layer: 'operator' });
    }
    const both = resolveScopeSettings([file('operator', { 'scope.default': 'branch' }), file('clone', { 'scope.default': 'worktree' })], flags({ 'scope.default': 'last-commit' }), () => null);
    assert.deepEqual(both.scopeDefault, { value: 'last-commit', layer: 'flag' });
  });

  it('never reads the two settings from the repository\'s file', () => {
    const settingsOfScope = resolveScopeSettings([file('repository', { 'scope.default': 'branch', 'review.base': 'develop' })], noFlags, () => 'origin/main');
    assert.deepEqual(settingsOfScope, { scopeDefault: { value: 'auto', layer: 'default' }, reviewBase: { value: 'origin/main', layer: 'default' } });
  });

  it('takes the base from a layer over origin/HEAD, asking git only when no layer gives one', () => {
    let asked = 0;
    const originHead = (): string => {
      asked += 1;
      return 'origin/main';
    };
    assert.deepEqual(resolveScopeSettings([file('clone', { 'review.base': 'origin/develop' })], noFlags, originHead).reviewBase, { value: 'origin/develop', layer: 'clone' });
    assert.equal(asked, 0);
    assert.deepEqual(resolveScopeSettings([file('clone', { 'review.base': 'origin/develop' })], flags({ 'review.base': 'v2.0' }), originHead).reviewBase, { value: 'v2.0', layer: 'flag' });
    assert.deepEqual(resolveScopeSettings([], noFlags, originHead).reviewBase, { value: 'origin/main', layer: 'default' });
    assert.equal(asked, 1);
  });

  it('refuses --branch with no base, naming the setting and the flag', () => {
    assert.equal(requireBase({ value: 'origin/main', layer: 'default' }), 'origin/main');
    assert.throws(() => requireBase({ value: null, layer: 'default' }), (error: unknown) => error instanceof ReviewRefusedError && /review\.base/.test(error.message) && /--base <rev>/.test(error.message));
  });
});

describe('the files of a repository', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dr-config-resolve-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the branch origin/HEAD names, and none in a clone without it', () => {
    const repo = repositoryWith(join(root, 'repo'), { 'a.txt': 'a\n' });
    assert.equal(originHeadBranch(repo), null);
    git(repo, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    assert.equal(originHeadBranch(repo), 'origin/trunk');
  });

  it('refuses with every problem of the operator\'s, the clone\'s and the invocation file at once, and reads the ones that pass', () => {
    const operator = join(root, 'operator.toml');
    const clone = join(root, 'clone.toml');
    const invocation = join(root, 'run.toml');
    writeFileSync(operator, 'schema = 1\nrun.concurrency = 99\n');
    writeFileSync(clone, 'nope');
    writeFileSync(invocation, 'schema = 1\nunknown.name = 1\n');
    assert.throws(() => readOperatorFiles({ operator, clone, invocation }), (error: unknown) => {
      assert.ok(error instanceof ReviewRefusedError);
      assert.match(error.message, /run\.concurrency/);
      assert.match(error.message, /clone\.toml/);
      assert.match(error.message, /unknown\.name: no such setting/);
      return true;
    });
    writeFileSync(operator, 'schema = 1\nrun.concurrency = 2\n');
    writeFileSync(clone, 'schema = 1\n');
    writeFileSync(invocation, 'schema = 1\nbudget.usd = 5\n');
    assert.deepEqual(readOperatorFiles({ operator, clone, invocation }).map((read) => read.layer), ['operator', 'clone', 'invocation']);
    assert.deepEqual(readOperatorFiles({ operator: null, clone: join(root, 'none.toml'), invocation: null }), []);
  });
});
