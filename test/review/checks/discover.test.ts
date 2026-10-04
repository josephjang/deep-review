import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { flagSetting, hintChecks, isSettled, justfileHas, makefileHas, noHintReading, packageScriptFor, readRootManifests, settledKinds, taskfileHas, unsettledKinds, type RootManifests } from '../../../src/review/checks/discover.ts';

/** A root holding the given manifests, and `extra` entries besides them. */
const root = (files: RootManifests['files'], extra: readonly string[] = []): RootManifests => ({ files, entries: [...Object.keys(files), ...extra] });
const packageJson = (scripts: Record<string, string>, field: Record<string, unknown> = {}): string => JSON.stringify({ name: 'x', scripts, ...field });

/** Each kind's hinted command, in the order the checks run. */
const commands = (manifests: RootManifests): (string | null)[] => hintChecks(manifests).map((hint) => hint.command);

describe('hintChecks', () => {
  it('hints nothing in an empty repository, giving every kind the rule none and what it read', () => {
    assert.deepEqual(hintChecks(root({})), ['build', 'typecheck', 'lint', 'test'].map((kind) => ({ kind, command: null, rule: 'none', reading: noHintReading })));
  });

  it('hints only the kinds it is asked for, in the order the checks run', () => {
    const manifests = root({ 'package.json': packageJson({ build: 'tsc', lint: 'eslint .', test: 'node --test' }) });
    assert.deepEqual(hintChecks(manifests, ['test', 'build']).map((hint) => [hint.kind, hint.command]), [['build', 'npm run build'], ['test', 'npm run test']]);
    assert.deepEqual(hintChecks(manifests, []), []);
  });

  it('prefers a Taskfile task, then a Makefile target, then a justfile recipe, over a package script, naming the file each read', () => {
    const manifests = root({
      'Taskfile.yml': 'version: "3"\ntasks:\n  test:\n    cmds: [go test ./...]\n',
      Makefile: 'test:\n\tmake-test\nlint:\n\tmake-lint\n',
      justfile: 'lint:\n  just-lint\ntypecheck:\n  just-typecheck\n',
      'package.json': packageJson({ build: 'tsc -b', typecheck: 'tsc', lint: 'eslint', test: 'vitest' }),
    });
    assert.deepEqual(hintChecks(manifests).map((hint) => [hint.kind, hint.command, hint.rule, hint.reading]), [
      ['build', 'npm run build', 'package', 'the package.json script `build` through npm, the default, since no lock file or packageManager field names a manager'],
      ['typecheck', 'just typecheck', 'justfile', 'the recipe `typecheck` of justfile'],
      ['lint', 'make lint', 'makefile', 'the target `lint` of Makefile'],
      ['test', 'task test', 'taskfile', 'the task `test` of Taskfile.yml'],
    ]);
  });

  it('reads every name each tool reads, and only the first of them present, as the tool does', () => {
    assert.deepEqual(commands(root({ 'taskfile.yaml': 'tasks:\n  build: go build\n', '.justfile': 'test:\n  go test\n', makefile: 'lint:\n\tx\n' })), ['task build', null, 'make lint', 'just test']);
    // GNU make reads GNUmakefile before makefile, so a target only the later file has is not one make runs.
    assert.deepEqual(commands(root({ GNUmakefile: 'build:\n\tx\n', Makefile: 'test:\n\tx\n' })), ['make build', null, null, null]);
    assert.deepEqual(commands(root({ 'Taskfile.yml': 'tasks:\n  lint: x\n', 'Taskfile.yaml': 'tasks:\n  test: x\n' })), [null, null, 'task lint', null]);
  });

  it('runs a package script through the manager each lock file names, npm when none does, and says what named it', () => {
    const scripts = packageJson({ test: 'vitest run' });
    const cases: [RootManifests['files'], string, string][] = [
      [{ 'package.json': scripts }, 'npm', 'the default, since no lock file or packageManager field names a manager'],
      [{ 'package.json': scripts, 'package-lock.json': '{}' }, 'npm', 'which package-lock.json names'],
      [{ 'package.json': scripts, 'npm-shrinkwrap.json': '{}' }, 'npm', 'which npm-shrinkwrap.json names'],
      [{ 'package.json': scripts, 'pnpm-lock.yaml': '' }, 'pnpm', 'which pnpm-lock.yaml names'],
      [{ 'package.json': scripts, 'yarn.lock': '' }, 'yarn', 'which yarn.lock names'],
      [{ 'package.json': scripts, 'bun.lock': '' }, 'bun', 'which bun.lock names'],
      [{ 'package.json': scripts, 'bun.lockb': '' }, 'bun', 'which bun.lockb names'],
      // Two lock files of one manager are no ambiguity.
      [{ 'package.json': scripts, 'bun.lock': '', 'bun.lockb': '' }, 'bun', 'which bun.lock and bun.lockb names'],
    ];
    for (const [files, manager, namedBy] of cases) {
      const hint = hintChecks(root(files))[3]!;
      assert.equal(hint.command, `${manager} run test`, Object.keys(files).join(', '));
      assert.equal(hint.reading, `the package.json script \`test\` through ${manager}, ${namedBy}`);
    }
  });

  it('takes the packageManager field over the lock files, even two that disagree', () => {
    const hint = hintChecks(root({ 'package.json': packageJson({ lint: 'biome lint' }, { packageManager: 'pnpm@9.1.0+sha512.abc' }), 'yarn.lock': '', 'package-lock.json': '{}' }))[2]!;
    assert.equal(hint.command, 'pnpm run lint');
    assert.match(hint.reading, /which the packageManager field of package\.json names$/);
  });

  it('hints no command for a script whose lock files name two managers and no packageManager field, naming the lock files, and refuses nothing', () => {
    const manifests = root({ 'package.json': packageJson({ test: 'jest', lint: 'eslint .' }), 'yarn.lock': '', 'package-lock.json': '{}', 'go.mod': '' });
    const hints = hintChecks(manifests);
    for (const hint of [hints[2]!, hints[3]!]) {
      assert.equal(hint.command, null);
      assert.equal(hint.rule, 'package');
      assert.match(hint.reading, /lock files name more than one package manager \(yarn\.lock, package-lock\.json\)/);
    }
    // A kind no script names still gets its language default.
    assert.equal(hints[0]!.command, 'go build ./...');
  });

  it('finds each kind under its aliases, the first present winning', () => {
    for (const name of ['typecheck', 'type-check', 'check-types', 'tsc']) {
      assert.equal(hintChecks(root({ 'package.json': packageJson({ [name]: 'tsc --noEmit' }) }))[1]!.command, `npm run ${name}`, name);
    }
    assert.equal(hintChecks(root({ 'package.json': packageJson({ tsc: 'tsc', 'type-check': 'tsc -p .' }) }))[1]!.command, 'npm run type-check');
  });

  it('takes <name>:check beside <name> (TD5), and <name> alone otherwise', () => {
    assert.equal(packageScriptFor({ lint: 'biome lint --write .', 'lint:check': 'biome lint .' }, 'lint'), 'lint:check');
    assert.equal(packageScriptFor({ lint: 'biome lint .' }, 'lint'), 'lint');
    assert.equal(packageScriptFor({ 'lint:check': 'biome lint .' }, 'lint'), null, 'a :check variant with no script beside it is no alias');
    assert.equal(packageScriptFor({}, 'test'), null);
  });

  it('gives each language its defaults, and nothing for a kind it has no default for', () => {
    assert.deepEqual(commands(root({ 'go.mod': 'module x\n' })), ['go build ./...', 'go vet ./...', null, 'go test ./...']);
    assert.deepEqual(commands(root({ 'Cargo.toml': '[package]\n' })), ['cargo build --workspace', 'cargo check --workspace', 'cargo clippy --workspace', 'cargo test --workspace']);
    assert.deepEqual(commands(root({ 'pyproject.toml': '[project]\n' })), [null, null, null, 'python -m pytest']);
    assert.deepEqual(commands(root({ 'pytest.ini': '[pytest]\n' })), [null, null, null, 'python -m pytest']);
    assert.deepEqual(commands(root({}, ['App.sln'])), ['dotnet build', null, null, 'dotnet test --no-build']);
    assert.deepEqual(commands(root({}, ['App.csproj'])), ['dotnet build', null, null, 'dotnet test --no-build']);
    const go = hintChecks(root({ 'go.mod': '' }))[0]!;
    assert.deepEqual([go.rule, go.reading], ['language', 'the default for a repository with go.mod']);
  });

  it('takes a package script over a language default', () => {
    assert.deepEqual(commands(root({ 'package.json': packageJson({ test: 'vitest' }), 'pyproject.toml': '' })), [null, null, null, 'npm run test']);
  });

  it('ignores a package.json that is not JSON, or whose scripts are not strings', () => {
    assert.deepEqual(commands(root({ 'package.json': '{ not json' })), [null, null, null, null]);
    assert.deepEqual(commands(root({ 'package.json': JSON.stringify({ scripts: { test: 1, lint: 'eslint' } }) })), [null, null, 'npm run lint', null]);
  });
});

describe('the settled kinds', () => {
  it('counts a kind settled by --check or --no-check, and leaves the rest to choose in run order', () => {
    const flags = { commands: { lint: 'eslint .' }, dropped: ['build' as const] };
    assert.equal(isSettled(flags, 'lint'), true);
    assert.equal(isSettled(flags, 'build'), true);
    assert.equal(isSettled(flags, 'test'), false);
    assert.deepEqual(unsettledKinds(flags), ['typecheck', 'test']);
    assert.deepEqual(unsettledKinds({ commands: {}, dropped: [] }), ['build', 'typecheck', 'lint', 'test']);
    assert.deepEqual(unsettledKinds({ commands: { build: 'a', typecheck: 'b', lint: 'c' }, dropped: ['test'] }), []);
  });

  it('reads one setting per kind, a drop winning over a command, and lists the settled kinds in run order', () => {
    // --check build=make --no-check build: the drop wins, as the survey's task and the plan both read it.
    const flags = { commands: { test: 'npm test', lint: 'eslint .', build: 'make' }, dropped: ['build' as const] };
    assert.deepEqual(flagSetting(flags, 'lint'), { command: 'eslint .' });
    assert.deepEqual(flagSetting(flags, 'build'), { command: null });
    assert.deepEqual(flagSetting(flags, 'test'), { command: 'npm test' });
    assert.equal(flagSetting(flags, 'typecheck'), null);
    assert.deepEqual(settledKinds(flags), [{ kind: 'build', command: null }, { kind: 'lint', command: 'eslint .' }, { kind: 'test', command: 'npm test' }]);
    assert.deepEqual(settledKinds({ commands: {}, dropped: [] }), []);
  });
});

describe('the task runners\' matching', () => {
  it('matches a Taskfile task at the indentation of the tasks mapping only', () => {
    const text = 'version: "3"\ntasks:\n  # comment\n  build:\n    cmds:\n      - go build\n    vars:\n      test: nested\n  lint: golangci-lint run\nvars:\n  test: top\n';
    assert.equal(taskfileHas(text, 'build'), true);
    assert.equal(taskfileHas(text, 'lint'), true, 'the short form, a task and its command on one line');
    assert.equal(taskfileHas(text, 'test'), false, 'a nested key and a key of another mapping are not tasks');
    assert.equal(taskfileHas('build:\n  cmds: []\n', 'build'), false, 'no tasks mapping');
    assert.equal(taskfileHas('tasks:\r\n  test:\r\n    cmds: [x]\r\n', 'test'), true, 'CRLF line endings');
    assert.equal(taskfileHas('tasks:\n  testing:\n', 'test'), false);
  });

  it('matches a Makefile rule that names the target, not an assignment or a recipe line', () => {
    assert.equal(makefileHas('test: build\n\tgo test\n', 'test'), true);
    assert.equal(makefileHas('lint test check:\n\techo\n', 'test'), true, 'one of several targets');
    assert.equal(makefileHas('test:: a\n', 'test'), true, 'a double-colon rule');
    assert.equal(makefileHas('test := go test\ntest = x\n', 'test'), false, 'assignments');
    assert.equal(makefileHas('\ttest: x\n', 'test'), false, 'a recipe line');
    assert.equal(makefileHas('.PHONY: test\n', 'test'), false, 'a .PHONY list');
    assert.equal(makefileHas('testing: x\n', 'test'), false);
  });

  it('matches a justfile recipe, quiet or with parameters, not an assignment', () => {
    assert.equal(justfileHas('test:\n  cargo test\n', 'test'), true);
    assert.equal(justfileHas('@test filter="":\n  cargo test {{filter}}\n', 'test'), true);
    assert.equal(justfileHas('test := "x"\n', 'test'), false);
    assert.equal(justfileHas('  test:\n', 'test'), false);
    assert.equal(justfileHas('tests:\n', 'test'), false);
  });
});

describe('readRootManifests', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'deep-review-discover-'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('reads each manifest present as a file, lists the root\'s entries, and skips a directory of a manifest\'s name', () => {
    writeFileSync(join(directory, 'package.json'), '{"scripts":{"test":"x"}}');
    writeFileSync(join(directory, 'App.sln'), '');
    mkdirSync(join(directory, 'Makefile'));
    const read = readRootManifests(directory);
    assert.deepEqual(read.files, { 'package.json': '{"scripts":{"test":"x"}}' });
    assert.deepEqual([...read.entries].sort(), ['App.sln', 'Makefile', 'package.json']);
    assert.deepEqual(commands(read), ['dotnet build', null, null, 'npm run test']);
  });

  it('reads a manifest only under the name the directory lists, never a case-insensitive match for another', () => {
    writeFileSync(join(directory, 'makefile'), 'test:\n\techo\n');
    writeFileSync(join(directory, 'CARGO.TOML'), '');
    assert.deepEqual(readRootManifests(directory).files, { makefile: 'test:\n\techo\n' });
  });
});
