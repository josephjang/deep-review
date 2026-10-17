import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { configuredRuntimes, isSettingName, isSettingPrefix, layerOrder, layerSettings, layers, owners, settableBy, settingNames, settings, type Owner, type SettingName } from '../../src/config/settings.ts';
import { repositoryRolesRoot } from '../../src/roles/assemble.ts';
import { readPolicy } from '../../src/review/policy.ts';
import { defaultRuntimes } from '../../src/runtime/runtimes.ts';
import { maxExcludePatterns, resolveScopeRequest } from '../../src/scope/capture.ts';
import { InvalidScopeRequestError } from '../../src/scope/errors.ts';

const policy = readPolicy(repositoryRolesRoot());

/** The table of R12, one row per setting name the registry declares, with its owner and dedicated flag. */
const expected: Readonly<Record<string, { owner: Owner; flag: string | null }>> = {
  'review.base': { owner: 'operator-only', flag: '--base' },
  'scope.default': { owner: 'operator-only', flag: null },
  'scope.exclude': { owner: 'repository-first', flag: null },
  'checks.build': { owner: 'repository-first', flag: '--check, --no-check' },
  'checks.typecheck': { owner: 'repository-first', flag: '--check, --no-check' },
  'checks.lint': { owner: 'repository-first', flag: '--check, --no-check' },
  'checks.test': { owner: 'repository-first', flag: '--check, --no-check' },
  'checks.timeout_minutes': { owner: 'repository-first', flag: null },
  'tools.path': { owner: 'operator-only', flag: null },
  'conventions.user_rules': { owner: 'repository-first', flag: null },
  'budget.usd': { owner: 'operator-first', flag: '--budget-usd' },
  'run.concurrency': { owner: 'operator-only', flag: '--concurrency' },
  'runtimes.claude.strong': { owner: 'operator-first', flag: '--strong-model' },
  'runtimes.claude.fast': { owner: 'operator-first', flag: '--fast-model' },
  'runtimes.claude.executable': { owner: 'operator-only', flag: '--executable' },
  'runtimes.claude.args': { owner: 'operator-only', flag: '--executable-arg' },
  'runtimes.codex.strong': { owner: 'operator-first', flag: '--strong-model' },
  'runtimes.codex.fast': { owner: 'operator-first', flag: '--fast-model' },
  'runtimes.codex.executable': { owner: 'operator-only', flag: '--executable' },
  'runtimes.codex.args': { owner: 'operator-only', flag: '--executable-arg' },
  'runtimes.codex.windows_sandbox': { owner: 'operator-only', flag: '--codex-windows-sandbox' },
};

describe('the settings registry', () => {
  it('declares exactly the settings of R12, each with its owner and dedicated flag', () => {
    assert.deepEqual([...settingNames].sort(), Object.keys(expected).sort());
    for (const name of settingNames) {
      assert.equal(settings[name].owner, expected[name]!.owner, name);
      assert.equal(settings[name].flag, expected[name]!.flag, name);
      assert.ok(settings[name].describe.endsWith('.'), `${name} has one sentence`);
    }
  });

  it('declares the settings of each runtime the engine ships, and of no other', () => {
    assert.deepEqual([...configuredRuntimes].sort(), [...defaultRuntimes().names()].sort());
  });

  it('orders the layers of each owner as R3 does, lowest first, with the repository\'s file outside the operator-only order', () => {
    assert.deepEqual(owners, ['repository-first', 'operator-first', 'operator-only']);
    assert.deepEqual(layerOrder['repository-first'], ['default', 'operator', 'repository', 'clone', 'invocation', 'flag']);
    assert.deepEqual(layerOrder['operator-first'], ['default', 'repository', 'operator', 'clone', 'invocation', 'flag']);
    assert.deepEqual(layerOrder['operator-only'], ['default', 'operator', 'clone', 'invocation', 'flag']);
    for (const owner of owners) assert.deepEqual(layerOrder[owner].slice(-3), ['clone', 'invocation', 'flag'], owner);
  });

  it('gives the repository\'s layer every setting but the operator-only ones, and every other layer all of them', () => {
    const operatorOnly = settingNames.filter((name) => settings[name].owner === 'operator-only');
    assert.deepEqual(operatorOnly, ['review.base', 'scope.default', 'tools.path', 'run.concurrency', 'runtimes.claude.executable', 'runtimes.claude.args', 'runtimes.codex.executable', 'runtimes.codex.args', 'runtimes.codex.windows_sandbox']);
    assert.deepEqual(layerSettings('repository'), settingNames.filter((name) => !operatorOnly.includes(name)));
    for (const name of operatorOnly) assert.equal(settableBy(name, 'repository'), false, name);
    for (const layer of layers.filter((candidate) => candidate !== 'repository')) assert.deepEqual(layerSettings(layer), settingNames, layer);
  });

  it('takes each default the role policy holds from the role policy, and none of its own for what the engine decides', () => {
    const defaultOf = (name: SettingName, runtime: string): unknown => settings[name].defaultOf(policy, runtime);
    assert.equal(defaultOf('checks.timeout_minutes', 'claude'), policy.checks.timeoutMs / 60_000);
    assert.equal(defaultOf('checks.timeout_minutes', 'claude'), 20);
    assert.equal(defaultOf('conventions.user_rules', 'claude'), policy.survey.userRules);
    assert.equal(defaultOf('run.concurrency', 'claude'), policy.concurrency);
    assert.equal(defaultOf('budget.usd', 'claude'), 60);
    assert.equal(defaultOf('budget.usd', 'codex'), null, 'Codex reports no cost, so its run has no budget');
    for (const runtime of configuredRuntimes) {
      assert.equal(defaultOf(`runtimes.${runtime}.strong`, runtime), policy.runtimes[runtime]!.strong);
      assert.equal(defaultOf(`runtimes.${runtime}.fast`, runtime), policy.runtimes[runtime]!.fast);
      assert.equal(defaultOf(`runtimes.${runtime}.executable`, runtime), null, 'found on PATH by the runtime\'s name');
      assert.deepEqual(defaultOf(`runtimes.${runtime}.args`, runtime), []);
    }
    assert.equal(defaultOf('runtimes.codex.windows_sandbox', 'codex'), policy.runtimes.codex!.windowsSandbox);
    assert.equal(defaultOf('scope.default', 'claude'), 'auto');
    assert.deepEqual(defaultOf('scope.exclude', 'claude'), []);
    assert.deepEqual(defaultOf('tools.path', 'claude'), []);
    for (const name of ['review.base', 'checks.build', 'checks.typecheck', 'checks.lint', 'checks.test'] as const) assert.equal(defaultOf(name, 'claude'), null, name);
  });

  it('gives each setting an example its own schema accepts, which config init writes', () => {
    for (const name of settingNames) assert.ok(settings[name].value.safeParse(settings[name].example).success, name);
  });

  it('knows a name, and a table that is a prefix of one, but not a part of a name', () => {
    assert.ok(isSettingName('checks.test'));
    assert.ok(!isSettingName('checks'));
    assert.ok(!isSettingName('runtimes.gemini.strong'));
    assert.ok(isSettingPrefix('runtimes'));
    assert.ok(isSettingPrefix('runtimes.claude'));
    assert.ok(!isSettingPrefix('runtimes.claude.strong'));
    assert.ok(!isSettingPrefix('runt'));
  });

  it('refuses a scope.exclude pattern that git would read as magic, that leaves the repository, or that is absolute', () => {
    const exclude = settings['scope.exclude'].value;
    assert.ok(exclude.safeParse(['dist/**', 'test/fixtures/checkpoints/**', '*.min.js']).success);
    for (const pattern of [':(top)src', '../outside', 'a/../b', '/abs', 'C:/x', '', 'a\0b']) assert.ok(!exclude.safeParse([pattern]).success, JSON.stringify(pattern));
    const patterns = (count: number): string[] => Array.from({ length: count }, (_, index) => `p${String(index)}`);
    assert.ok(exclude.safeParse(patterns(maxExcludePatterns)).success, 'as many patterns as a capture takes');
    assert.ok(!exclude.safeParse(patterns(maxExcludePatterns + 1)).success, 'no more patterns than a capture takes');
  });

  it('refuses exactly the scope.exclude patterns the capture refuses', () => {
    const exclude = settings['scope.exclude'].value;
    const repo = mkdtempSync(join(tmpdir(), 'deep-review-exclude-'));
    try {
      for (const pattern of ['dist/**', '*.min.js', ':(top)src', ':!x', '../outside', 'a/../b', 'a\\..\\b', '..', '/abs', '\\abs', 'C:/x', 'c:x', 'a:b', 'a..b/c', '', 'a\0b']) {
        const capture = (() => {
          try {
            // A pattern passes the capture's own checks only to fail on the empty directory, which is no repository.
            resolveScopeRequest(repo, { paths: [] }, [pattern]);
            return true;
          } catch (error) {
            return !(error instanceof InvalidScopeRequestError);
          }
        })();
        assert.equal(exclude.safeParse([pattern]).success, capture, JSON.stringify(pattern));
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('takes a check\'s command or false, and refuses true or a blank command', () => {
    const check = settings['checks.test'].value;
    assert.ok(check.safeParse('npm test').success);
    assert.ok(check.safeParse(false).success);
    for (const value of [true, '', '   ', 3]) assert.ok(!check.safeParse(value).success, JSON.stringify(value));
  });

  it('bounds the check timeout at a worker\'s longest and the concurrency at the engine\'s', () => {
    const minutes = settings['checks.timeout_minutes'].value;
    assert.ok(minutes.safeParse(60).success);
    assert.ok(minutes.safeParse(0.5).success);
    for (const value of [0, -1, 61, 1 / 120]) assert.ok(!minutes.safeParse(value).success, String(value));
    const concurrency = settings['run.concurrency'].value;
    for (const value of [0, 17, 2.5]) assert.ok(!concurrency.safeParse(value).success, String(value));
  });
});
