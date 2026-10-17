import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fixSettingsRecordedV1, recordedSettingsV1, reviewConfiguredV6, type ReviewConfiguration } from '../../src/checkpoint/events.ts';
import { repositoryConfigPath, type ConfigFile } from '../../src/config/files.ts';
import { fixSettingsRecordOf, recordedNames, settingOf, settingsRecordOf } from '../../src/config/record.ts';
import { flagLayerOf, noFlags, resolveSettings, type FlagLayer } from '../../src/config/resolve.ts';
import { checkSettingNames, layers, fileLayers, scopeDefaults, settingNames, type SettingName } from '../../src/config/settings.ts';
import { repositoryRolesRoot } from '../../src/roles/assemble.ts';
import { readPolicy } from '../../src/review/policy.ts';
import { configuration, pin, readOnlyReported, settingsBlock, settingsConfigured } from '../helpers/review-history.ts';

const policy = readPolicy(repositoryRolesRoot());
const commit = '1'.repeat(40);

const file = (layer: ConfigFile['layer'], values: Partial<Record<SettingName, unknown>>): ConfigFile => ({
  layer,
  path: layer === 'repository' ? repositoryConfigPath : resolve(`/${layer}.toml`),
  sha256: 'a'.repeat(64),
  commit: layer === 'repository' ? commit : null,
  values: new Map(Object.entries(values) as [SettingName, unknown][]),
  ignored: layer === 'operator' ? ['report.formats'] : [],
});

const resolved = (files: readonly ConfigFile[] = [], flags: FlagLayer = noFlags, runtime = 'claude') =>
  resolveSettings({ policy, runtime, costInUsd: runtime === 'claude', files, flags, repository: files.some((entry) => entry.layer === 'repository') ? { state: 'read', commit } : { state: 'absent', commit }, worktree: resolve('/w'), originHead: () => 'origin/main' });

/** A version 5 payload, as a run configured with the policy's values pins it. */
const v5 = (fix: boolean, runtime = 'claude') => ({
  runtime,
  executable: '/bin/claude',
  executableArgs: ['--x'],
  version: '2.1.310',
  models: { strong: 'opus', fast: 'sonnet' },
  roles: [{ role: 'triage', model: 'opus', effort: 'high' as const, budgetUsd: 8, timeoutMs: 600_000 }],
  rolesDigest: 'd'.repeat(64),
  concurrency: 4,
  runBudgetUsd: runtime === 'claude' ? 60 : null,
  fix,
  checks: fix ? { timeoutMs: 1_200_000 } : null,
  fixes: fix ? { batchSize: 4 } : null,
  survey: { userRules: 'judge' as const },
  codex: runtime === 'codex' ? { windowsSandbox: 'none' as const } : null,
});

describe('the record of the settings', () => {
  it('freezes in the events the registry\'s names, layers and values of scope.default', () => {
    assert.deepEqual([...recordedSettingsV1.names], settingNames);
    assert.deepEqual([...recordedSettingsV1.layers], [...layers]);
    assert.deepEqual([...recordedSettingsV1.fileLayers], [...fileLayers]);
    assert.deepEqual([...recordedSettingsV1.scopeDefaults], [...scopeDefaults]);
    assert.deepEqual([...recordedSettingsV1.checkNames], checkSettingNames);
  });

  it('records the settings that shape every run, the checks only in a fix run, and only the run\'s runtime\'s', () => {
    const readOnly = recordedNames(v5(false));
    assert.ok(!readOnly.some((name) => name.startsWith('checks.')), 'a read-only run records no check setting');
    assert.ok(!readOnly.some((name) => name.startsWith('runtimes.codex.')));
    const fixing = recordedNames(v5(true));
    for (const name of [...checkSettingNames, 'checks.timeout_minutes'] as const) assert.ok(fixing.includes(name), name);
    const codex = recordedNames(v5(false, 'codex'));
    assert.ok(codex.includes('runtimes.codex.windows_sandbox'));
    assert.ok(!codex.some((name) => name.startsWith('runtimes.claude.')));
    assert.ok(!recordedNames({ ...v5(false, 'codex'), codex: null }).includes('runtimes.codex.windows_sandbox'), 'a Codex run off Windows pins no sandbox');
  });

  it('builds a block version 6 records, for a read-only and a fix run, with a file, a flag and a value not followed', () => {
    const settings = resolved([file('repository', { 'checks.test': 'npm test', 'scope.exclude': ['dist/**'] }), file('operator', { 'run.concurrency': 2 })], flagLayerOf([{ name: 'checks.test', value: 'npm run test:fast', flag: '--check' }]));
    for (const fix of [false, true]) {
      const block = settingsRecordOf(settings, v5(fix));
      const parsed = reviewConfiguredV6.safeParse({ ...v5(fix), settings: block });
      assert.ok(parsed.success, parsed.success ? '' : parsed.error.message);
      assert.deepEqual(Object.keys(block.layers).sort(), recordedNames(v5(fix)).sort());
      assert.equal(block.layers['run.concurrency'], 'operator');
      assert.deepEqual(block.values['scope.exclude'], ['dist/**']);
      assert.deepEqual(block.notFollowed.map((entry) => entry.name), fix ? ['checks.test'] : [], 'a check setting is not followed only where the run records it');
      assert.deepEqual(block.ignored.map((entry) => entry.name), ['report.formats']);
    }
    assert.equal(settingsRecordOf(settings, v5(true)).values['checks.test'], 'npm run test:fast');
  });

  it('builds the fix side a version 2 pin records', () => {
    const side = fixSettingsRecordOf(resolved([file('clone', { 'tools.path': ['bin'], 'checks.lint': false })]));
    assert.ok(fixSettingsRecordedV1.safeParse(side).success);
    assert.deepEqual(side.values['tools.path'], [resolve('/w/bin')]);
    assert.equal(side.values['checks.lint'], false);
    assert.equal(side.layers['checks.lint'], 'clone');
    assert.equal(side.layers['checks.timeout_minutes'], 'default');
  });
});

describe('settingOf', () => {
  it('reads a run configured before the settings as its defaults and flags, with no layer (R17)', () => {
    const recorded: ReviewConfiguration = { ...configuration, settings: null, fixSettings: null };
    assert.deepEqual(settingOf(recorded, 'run.concurrency'), { value: 4, layer: null });
    assert.deepEqual(settingOf(recorded, 'budget.usd'), { value: 30, layer: null });
    assert.deepEqual(settingOf(recorded, 'runtimes.claude.strong'), { value: 'opus', layer: null });
    assert.deepEqual(settingOf(recorded, 'runtimes.claude.executable'), { value: '/bin/claude', layer: null });
    assert.deepEqual(settingOf(recorded, 'conventions.user_rules'), { value: 'apply', layer: null });
    assert.deepEqual(settingOf(recorded, 'scope.exclude'), { value: [], layer: null }, 'nothing was left out');
    assert.deepEqual(settingOf(recorded, 'tools.path'), { value: [], layer: null });
    assert.deepEqual(settingOf(recorded, 'review.base'), { value: null, layer: null });
    assert.deepEqual(settingOf(recorded, 'checks.test'), { value: null, layer: null });
    assert.deepEqual(settingOf(recorded, 'checks.timeout_minutes'), { value: null, layer: null }, 'a read-only run pins no check timeout');
    assert.deepEqual(settingOf(recorded, 'runtimes.codex.strong'), { value: null, layer: null }, 'another runtime\'s setting has no value');
  });

  it('reads a version 6 run\'s values from version 5\'s fields and the block, each with its layer', () => {
    const values = { 'review.base': 'origin/main', 'scope.default': 'branch', 'scope.exclude': ['dist/**'], 'tools.path': ['/w/bin'], 'checks.build': null, 'checks.typecheck': null, 'checks.lint': false, 'checks.test': 'npm test' };
    const block = settingsBlock(true, { values, layers: { ...(settingsBlock(true).layers as object), 'checks.test': 'repository', 'checks.lint': 'flag', 'run.concurrency': 'operator', 'checks.timeout_minutes': 'repository' } });
    const recorded = settingsConfigured(true, block).review().configuration;
    assert.deepEqual(settingOf(recorded, 'checks.test'), { value: 'npm test', layer: 'repository' });
    assert.deepEqual(settingOf(recorded, 'checks.lint'), { value: false, layer: 'flag' });
    assert.deepEqual(settingOf(recorded, 'scope.exclude'), { value: ['dist/**'], layer: 'default' });
    assert.deepEqual(settingOf(recorded, 'run.concurrency'), { value: 4, layer: 'operator' });
    assert.deepEqual(settingOf(recorded, 'checks.timeout_minutes'), { value: 10, layer: 'repository' });
    assert.deepEqual(settingOf(recorded, 'scope.default'), { value: 'branch', layer: 'default' });
  });

  it('reads the fix side of a version 2 pin over the configuration\'s, and the rest from the configuration', () => {
    const fixSide = {
      values: { 'checks.build': 'npm run build', 'checks.typecheck': null, 'checks.lint': null, 'checks.test': 'npm test', 'tools.path': ['/w/.venv/bin'] },
      layers: { 'checks.build': 'repository', 'checks.typecheck': 'default', 'checks.lint': 'default', 'checks.test': 'clone', 'checks.timeout_minutes': 'operator', 'tools.path': 'clone' },
      files: [], repository: { state: 'absent', commit: '1'.repeat(40), edited: false }, notFollowed: [], ignored: [],
    };
    const recorded = readOnlyReported().add('fix.pinned', { ...pin(), settings: fixSide }, 2).review().configuration;
    assert.deepEqual(settingOf(recorded, 'checks.test'), { value: 'npm test', layer: 'clone' });
    assert.deepEqual(settingOf(recorded, 'tools.path'), { value: ['/w/.venv/bin'], layer: 'clone' });
    assert.deepEqual(settingOf(recorded, 'checks.timeout_minutes'), { value: 5, layer: 'operator' }, 'the value the pin\'s checks hold, the layer its fix side gives');
    assert.deepEqual(settingOf(recorded, 'run.concurrency'), { value: 4, layer: null }, 'the configuration recorded no settings');
    // A version 6 configuration whose block holds another tools.path: the pin's fix side wins for the settings it records.
    const block = settingsBlock(false, { values: { 'review.base': null, 'scope.default': 'auto', 'scope.exclude': ['dist/**'], 'tools.path': ['/old'] } });
    const both: ReviewConfiguration = { ...recorded, settings: block as unknown as ReviewConfiguration['settings'] };
    assert.deepEqual(settingOf(both, 'tools.path'), { value: ['/w/.venv/bin'], layer: 'clone' });
    assert.deepEqual(settingOf(both, 'scope.exclude'), { value: ['dist/**'], layer: 'default' }, 'a setting the fix side does not record comes from the block');
  });
});
