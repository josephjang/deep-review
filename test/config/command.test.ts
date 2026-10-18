import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { main, type CommandIo } from '../../src/cli.ts';
import { locateCheckpoint } from '../../src/checkpoint/locate.ts';
import { explainLines, initText, tomlValue, validateBytes } from '../../src/config/command.ts';
import { cloneConfigName, parseConfig, repositoryConfigPath } from '../../src/config/files.ts';
import { fileLayers, layerSettings, settingNames, settings } from '../../src/config/settings.ts';
import { repositoryRolesRoot } from '../../src/roles/assemble.ts';
import { readPolicy } from '../../src/review/policy.ts';
import { commitAll, git, repositoryWith, write } from '../helpers/repository.ts';

const policy = readPolicy(repositoryRolesRoot());

describe('the config command\'s text', () => {
  it('explains every setting with its owner, default and sentence, and one setting alone', () => {
    const all = explainLines()!.join('\n');
    for (const name of settingNames) {
      assert.match(all, new RegExp(`^${name.replaceAll('.', '\\.')}$`, 'm'), name);
      assert.ok(all.includes(settings[name].describe), name);
    }
    assert.deepEqual(explainLines('scope.exclude'), [
      'scope.exclude',
      '  owner: repository-first: the repository\'s file wins over the operator\'s file',
      '  default: none',
      `  ${settings['scope.exclude'].describe}`,
    ]);
    assert.equal(explainLines('scope.include'), null);
  });

  it('writes for each layer a file that sets nothing and that its layer reads, each setting it can set commented at its default', () => {
    for (const layer of fileLayers) {
      const text = initText(layer, policy);
      const read = parseConfig(layer, 'config.toml', Buffer.from(text), null);
      assert.deepEqual(read.problems, [], layer);
      assert.equal(read.file?.values.size, 0, `${layer}: every setting is a comment`);
      for (const name of layerSettings(layer)) assert.match(text, new RegExp(`^# ${name.replaceAll('.', '\\.')} = `, 'm'), `${layer} ${name}`);
      // Uncommented, every line is a value the layer takes.
      const uncommented = text.replace(/^# ([a-z_.]+ = .*)$/gm, '$1');
      const all = parseConfig(layer, 'config.toml', Buffer.from(uncommented), null);
      assert.deepEqual(all.problems, [], `${layer} uncommented`);
      assert.equal(all.file?.values.size, layerSettings(layer).length);
    }
    assert.doesNotMatch(initText('repository', policy), /^# tools\.path = /m, 'the repository\'s file cannot set an operator-only setting');
    assert.match(initText('operator', policy), /^# budget\.usd = 60$/m, 'the role policy\'s default');
    assert.match(initText('operator', policy), /^# runtimes\.codex\.strong = "gpt-6-astra"$/m, 'a runtime\'s own default');
    assert.match(initText('clone', policy), /^# checks\.test = "npm test"$/m, 'an example where the engine decides');
  });

  it('writes a value as TOML takes it back', () => {
    assert.equal(tomlValue(['dist/**', 'a "b"']), '[ "dist/**", "a \\"b\\"" ]');
    assert.equal(tomlValue(false), 'false');
    assert.equal(tomlValue(20), '20');
  });

  it('validates a file as its layer reads it, naming every problem, and the names an operator\'s file ignores', () => {
    assert.deepEqual(validateBytes('repository', 'c.toml', Buffer.from('schema = 1\nscope.exclude = ["dist/**"]\n')), { valid: true, lines: ['valid: c.toml as the repository\'s file, setting scope.exclude'] });
    const bad = validateBytes('repository', 'c.toml', Buffer.from('schema = 1\ntools.path = ["bin"]\nnope = 1\n'));
    assert.equal(bad.valid, false);
    assert.equal(bad.lines.length, 3);
    assert.deepEqual(validateBytes('operator', 'o.toml', Buffer.from('schema = 1\nnope = 1\n')), { valid: true, lines: ['valid: o.toml as the operator\'s file, setting nothing', '  ignored: nope: no such setting; the operator\'s file ignores it, and a newer engine may read it'] });
  });
});

describe('deep-review config', () => {
  let root: string;
  let repo: string;
  let out: string[];
  let err: string[];
  let io: CommandIo;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dr-config-command-'));
    repo = repositoryWith(join(root, 'repo'), { 'src/a.ts': 'a\n' });
    write(repo, 'src/a.ts', 'b\n');
    commitAll(repo, 'the change');
    out = [];
    err = [];
    io = { stdout: (text) => out.push(text), stderr: (text) => err.push(text), environment: { APPDATA: join(root, 'appdata'), XDG_CONFIG_HOME: join(root, 'xdg') }, cwd: repo };
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const config = (...args: string[]): Promise<number> => main(['config', ...args], io);

  it('shows the settings of the change a run would review, as text and as JSON, and starts no run', async () => {
    write(repo, repositoryConfigPath, 'schema = 1\nscope.exclude = ["dist/**"]\nchecks.test = "npm test"\n');
    const base = commitAll(repo, 'the policy');
    write(repo, 'src/b.ts', 'b\n');
    write(repo, 'dist/b.js', 'built\n');
    const head = commitAll(repo, 'a change under the policy');
    writeFileSync(join(locateCheckpoint(repo).commonDir, cloneConfigName), 'schema = 1\nchecks.test = "make test"\n');
    assert.equal(await config('show', '--runtime', 'claude', '--set', 'run.concurrency=2'), 0, err.join(''));
    const text = out.join('');
    // Both ends of the change, so a retelling of the line cannot take the base for the commit reviewed (R11 of the skill surface corrections).
    assert.match(text, new RegExp(`^Scope: last-commit, the change from ${base} to ${head}$`, 'm'));
    assert.match(text, /^ {2}scope\.exclude +\[ "dist\/\*\*" \] {2}from the repository's file$/m);
    assert.match(text, /^ {2}checks\.test +"make test" {2}from the clone's file$/m);
    assert.match(text, /^ {2}run\.concurrency +2 {2}from a flag$/m);
    assert.match(text, /^Not followed:\n {2}checks\.test: the repository's "npm test", this run's "make test" from the clone's file$/m);
    assert.doesNotMatch(text, /runtimes\.codex/, 'only the settings of the run\'s runtime');
    out.length = 0;
    assert.equal(await config('show', '--runtime', 'claude', '--json'), 0, err.join(''));
    const json = JSON.parse(out.join('')) as { values: Record<string, { value: unknown; layer: string }>; scope: { mode: string; base: string; target: string | null }; repository: { state: string } };
    assert.deepEqual(json.values['scope.exclude'], { value: ['dist/**'], layer: 'repository' });
    assert.deepEqual(json.scope, { mode: 'last-commit', base, target: head, empty: null });
    assert.equal(json.repository.state, 'read');
    assert.equal(existsSync(join(locateCheckpoint(repo).root, 'ledger.sqlite')), false, 'no checkpoint, so no run');
  });

  it('shows auto and the base git status gives with no scope flag, and says when the change is empty', async () => {
    write(repo, repositoryConfigPath, 'schema = 1\nscope.exclude = ["src/**"]\n');
    commitAll(repo, 'a policy that leaves out everything the next change touches');
    write(repo, 'src/c.ts', 'c\n');
    const head = git(repo, 'rev-parse', 'HEAD');
    assert.equal(await config('show', '--runtime', 'claude'), 0, err.join(''));
    assert.match(out.join(''), new RegExp(`^Scope: auto, the change from ${head} to the working tree; The change has no path left to review: scope\\.exclude \\(src/\\*\\*\\) leaves out all 1 of its changed paths$`, 'm'));
  });

  it('refuses show without a runtime, a mistaken subcommand, an argument or a flag the subcommand does not take, with the usage', async () => {
    for (const args of [['show'], ['nope'], [], ['show', 'extra', '--runtime', 'claude'], ['init', 'x', '--clone'], ['explain', '--json'], ['validate', '--runtime', 'claude'], ['init'], ['init', '--repository', '--clone'], ['explain', 'nope'], ['validate', '--layer', 'managed']]) {
      err.length = 0;
      assert.equal(await config(...args), 1, args.join(' '));
      assert.match(err.join(''), /usage:/, args.join(' '));
    }
  });

  it('refuses a --set of another runtime\'s setting, as the dedicated flag is refused, and takes one of the run\'s runtime', async () => {
    assert.equal(await config('show', '--runtime', 'claude', '--set', 'runtimes.codex.windows_sandbox=none'), 1);
    assert.match(err.join(''), /--set runtimes\.codex\.windows_sandbox applies only to runtime codex, not claude/);
    assert.match(err.join(''), /usage:/);
    err.length = 0;
    assert.equal(await config('show', '--runtime', 'codex', '--set', 'runtimes.claude.strong=x'), 1);
    assert.match(err.join(''), /--set runtimes\.claude\.strong applies only to runtime claude, not codex/);
    err.length = 0;
    assert.equal(await config('show', '--runtime', 'codex', '--set', 'runtimes.codex.windows_sandbox=none'), 0, err.join(''));
    assert.match(out.join(''), /^ {2}runtimes\.codex\.windows_sandbox +"none" {2}from a flag$/m);
  });

  it('refuses a --set of a check command without --fix, and takes the check timeout, which is no check command', async () => {
    assert.equal(await config('show', '--runtime', 'claude', '--set', 'checks.lint=npm run lint'), 1);
    assert.match(err.join(''), /--set checks\.lint applies only with --fix, as --check does/);
    err.length = 0;
    assert.equal(await config('show', '--runtime', 'claude', '--set', 'checks.timeout_minutes=5'), 0, err.join(''));
  });

  it('validates the working tree\'s repository file by default, and a file named for a layer, exiting 2 for a problem', async () => {
    write(repo, repositoryConfigPath, 'schema = 1\nscope.exclude = ["dist/**"]\n');
    assert.equal(await config('validate'), 0, err.join(''));
    assert.match(out.join(''), /^valid: .*config\.toml as the repository's file, setting scope\.exclude$/m);
    write(repo, repositoryConfigPath, 'schema = 1\nrun.concurrency = 2\n');
    assert.equal(await config('validate'), 2);
    assert.match(err.join(''), /run\.concurrency: the repository's file cannot set it/);
    out.length = 0;
    assert.equal(await config('validate', repositoryConfigPath, '--layer', 'operator'), 0, err.join(''));
    assert.match(out.join(''), /as the operator's file, setting run\.concurrency/);
    err.length = 0;
    assert.equal(await config('validate', 'missing.toml'), 2);
    assert.match(err.join(''), /is not a file to validate/);
  });

  it('refuses a directory and an oversized file as the layer\'s read words them, exiting 2', async () => {
    mkdirSync(join(root, 'directory.toml'));
    assert.equal(await config('validate', join(root, 'directory.toml'), '--layer', 'clone'), 2);
    assert.match(err.join(''), /directory\.toml: the clone's file is not a regular file; replace it with a TOML file or remove it/);
    err.length = 0;
    writeFileSync(join(root, 'large.toml'), `schema = 1\n#${'x'.repeat(65_536)}\n`);
    assert.equal(await config('validate', join(root, 'large.toml'), '--layer', 'operator'), 2);
    assert.match(err.join(''), /large\.toml: the operator's file holds \d+ bytes, more than the 65536 the engine reads/);
  });

  it('refuses a file it cannot read, or cannot stat, as a problem exiting 2, not an error exiting 1', async (t) => {
    // Windows has no unreadable mode bits and root reads through them; nothing to test then.
    if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('file modes do not deny reading here');
    writeFileSync(join(root, 'locked.toml'), 'schema = 1\n');
    chmodSync(join(root, 'locked.toml'), 0o000);
    assert.equal(await config('validate', join(root, 'locked.toml')), 2);
    assert.match(err.join(''), /locked\.toml: the repository's file cannot be read: EACCES/);
    err.length = 0;
    mkdirSync(join(root, 'closed'));
    writeFileSync(join(root, 'closed', 'config.toml'), 'schema = 1\n');
    chmodSync(join(root, 'closed'), 0o000);
    try {
      assert.equal(await config('validate', join(root, 'closed', 'config.toml'), '--layer', 'operator'), 2);
      assert.match(err.join(''), /config\.toml: the operator's file cannot be read: EACCES/);
    } finally {
      // Open again, so the tree can be removed.
      chmodSync(join(root, 'closed'), 0o700);
    }
  });

  it('writes a new file for each layer, which validates, and refuses to write over one', async () => {
    const paths = {
      repository: join(repo, ...repositoryConfigPath.split('/')),
      operator: process.platform === 'win32' ? join(root, 'appdata', 'deep-review', 'config.toml') : join(root, 'xdg', 'deep-review', 'config.toml'),
      clone: join(locateCheckpoint(repo).commonDir, cloneConfigName),
    };
    for (const layer of ['repository', 'operator', 'clone'] as const) {
      out.length = 0;
      assert.equal(await config('init', `--${layer}`), 0, err.join(''));
      assert.equal(out.join('').trim(), paths[layer]);
      assert.equal(readFileSync(paths[layer], 'utf8'), initText(layer, policy));
      out.length = 0;
      assert.equal(await config('validate', paths[layer], '--layer', layer), 0, err.join(''));
      err.length = 0;
      assert.equal(await config('init', `--${layer}`), 2, layer);
      assert.match(err.join(''), /exists, and config init writes only a new file/);
    }
  });
});
