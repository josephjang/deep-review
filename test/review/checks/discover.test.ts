import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { discoverChecks, droppedReason, justfileHas, makefileHas, noSourceReason, packageScriptFor, readRootManifests, taskfileHas, type RootManifests } from '../../../src/review/checks/discover.ts';
import { ReviewRefusedError } from '../../../src/review/errors.ts';

/** A root holding the given manifests, and `extra` entries besides them. */
const root = (files: RootManifests['files'], extra: readonly string[] = []): RootManifests => ({ files, entries: [...Object.keys(files), ...extra] });
const packageJson = (scripts: Record<string, string>, field: Record<string, unknown> = {}): string => JSON.stringify({ name: 'x', scripts, ...field });

/** Each kind's command, in the order the checks run. */
const commands = (manifests: RootManifests, flags?: Parameters<typeof discoverChecks>[1]): (string | null)[] => discoverChecks(manifests, flags).checks.map((check) => check.command);

describe('discoverChecks', () => {
  it('finds nothing in an empty repository, giving every kind origin none and the reason', () => {
    const discovered = discoverChecks(root({}));
    assert.deepEqual(discovered.checks, ['build', 'typecheck', 'lint', 'test'].map((kind) => ({ kind, command: null, origin: 'none', reason: noSourceReason })));
    assert.equal(discovered.manager, null);
  });

  it('takes a --check flag over every other source, and drops a kind with --no-check', () => {
    const manifests = root({ 'package.json': packageJson({ build: 'tsc', test: 'node --test' }), Makefile: 'lint:\n\techo lint\n' });
    const discovered = discoverChecks(manifests, { commands: { test: 'make quick-test', lint: 'eslint .' }, dropped: ['build'] });
    assert.deepEqual(discovered.checks, [
      { kind: 'build', command: null, origin: 'flag', reason: droppedReason },
      { kind: 'typecheck', command: null, origin: 'none', reason: noSourceReason },
      { kind: 'lint', command: 'eslint .', origin: 'flag', reason: null },
      { kind: 'test', command: 'make quick-test', origin: 'flag', reason: null },
    ]);
    assert.equal(discovered.manager, null, 'no kind runs a package script, so no manager is named');
  });

  it('prefers a Taskfile task, then a Makefile target, then a justfile recipe, over a package script', () => {
    const manifests = root({
      'Taskfile.yml': 'version: "3"\ntasks:\n  test:\n    cmds: [go test ./...]\n',
      Makefile: 'test:\n\tmake-test\nlint:\n\tmake-lint\n',
      justfile: 'lint:\n  just-lint\ntypecheck:\n  just-typecheck\n',
      'package.json': packageJson({ build: 'tsc -b', typecheck: 'tsc', lint: 'eslint', test: 'vitest' }),
    });
    const discovered = discoverChecks(manifests);
    assert.deepEqual(discovered.checks.map((check) => [check.kind, check.command, check.origin]), [
      ['build', 'npm run build', 'package'],
      ['typecheck', 'just typecheck', 'justfile'],
      ['lint', 'make lint', 'makefile'],
      ['test', 'task test', 'taskfile'],
    ]);
  });

  it('reads every name each tool reads, and only the first of them present, as the tool does', () => {
    assert.deepEqual(commands(root({ 'taskfile.yaml': 'tasks:\n  build: go build\n', '.justfile': 'test:\n  go test\n', makefile: 'lint:\n\tx\n' })), ['task build', null, 'make lint', 'just test']);
    // GNU make reads GNUmakefile before makefile, so a target only the later file has is not one make runs.
    assert.deepEqual(commands(root({ GNUmakefile: 'build:\n\tx\n', Makefile: 'test:\n\tx\n' })), ['make build', null, null, null]);
    assert.deepEqual(commands(root({ 'Taskfile.yml': 'tasks:\n  lint: x\n', 'Taskfile.yaml': 'tasks:\n  test: x\n' })), [null, null, 'task lint', null]);
  });

  it('runs a package script through the manager each lock file names, npm when none does', () => {
    const scripts = packageJson({ test: 'vitest run' });
    const cases: [RootManifests['files'], string][] = [
      [{ 'package.json': scripts }, 'npm'],
      [{ 'package.json': scripts, 'package-lock.json': '{}' }, 'npm'],
      [{ 'package.json': scripts, 'npm-shrinkwrap.json': '{}' }, 'npm'],
      [{ 'package.json': scripts, 'pnpm-lock.yaml': '' }, 'pnpm'],
      [{ 'package.json': scripts, 'yarn.lock': '' }, 'yarn'],
      [{ 'package.json': scripts, 'bun.lock': '' }, 'bun'],
      [{ 'package.json': scripts, 'bun.lockb': '' }, 'bun'],
      // Two lock files of one manager are no ambiguity.
      [{ 'package.json': scripts, 'bun.lock': '', 'bun.lockb': '' }, 'bun'],
    ];
    for (const [files, manager] of cases) {
      const discovered = discoverChecks(root(files));
      assert.equal(discovered.manager, manager, Object.keys(files).join(', '));
      assert.equal(discovered.checks[3]!.command, `${manager} run test`);
    }
  });

  it('takes the packageManager field over the lock files, even two that disagree', () => {
    const discovered = discoverChecks(root({ 'package.json': packageJson({ lint: 'biome lint' }, { packageManager: 'pnpm@9.1.0+sha512.abc' }), 'yarn.lock': '', 'package-lock.json': '{}' }));
    assert.equal(discovered.manager, 'pnpm');
    assert.equal(discovered.checks[2]!.command, 'pnpm run lint');
  });

  it('refuses lock files of two managers with no packageManager field, naming them and the flag', () => {
    const manifests = root({ 'package.json': packageJson({ test: 'jest' }), 'yarn.lock': '', 'package-lock.json': '{}' });
    assert.throws(() => discoverChecks(manifests), (error: unknown) => error instanceof ReviewRefusedError && /yarn\.lock, package-lock\.json/.test(error.message) && /--check <kind>=<command>/.test(error.message));
    // The ambiguity matters only to a kind that would run a package script.
    assert.deepEqual(commands(manifests, { commands: { test: 'npx jest' }, dropped: [] }), [null, null, null, 'npx jest']);
  });

  it('finds each kind under its aliases, the first present winning', () => {
    for (const name of ['typecheck', 'type-check', 'check-types', 'tsc']) {
      assert.equal(discoverChecks(root({ 'package.json': packageJson({ [name]: 'tsc --noEmit' }) })).checks[1]!.command, `npm run ${name}`, name);
    }
    assert.equal(discoverChecks(root({ 'package.json': packageJson({ tsc: 'tsc', 'type-check': 'tsc -p .' }) })).checks[1]!.command, 'npm run type-check');
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
    assert.equal(discoverChecks(root({ 'go.mod': '' })).checks[0]!.origin, 'language');
  });

  it('takes a package script over a language default', () => {
    assert.deepEqual(commands(root({ 'package.json': packageJson({ test: 'vitest' }), 'pyproject.toml': '' })), [null, null, null, 'npm run test']);
  });

  it('ignores a package.json that is not JSON, or whose scripts are not strings', () => {
    assert.deepEqual(commands(root({ 'package.json': '{ not json' })), [null, null, null, null]);
    assert.deepEqual(commands(root({ 'package.json': JSON.stringify({ scripts: { test: 1, lint: 'eslint' } }) })), [null, null, 'npm run lint', null]);
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
