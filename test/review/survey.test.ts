import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { noCheckFlags, type CheckFlags } from '../../src/review/checks/discover.ts';
import { StructuralCheckError } from '../../src/review/errors.ts';
import { worktreeLookup } from '../../src/review/locations.ts';
import type { SurveyorCheckOutput, SurveyorOutput } from '../../src/review/schemas.ts';
import { checkSurveyAnswer, droppedReason, offeredUserFiles, policyWords, resolveChecks, surveyFailure, type SurveyCheckContext, type SurveyInputs } from '../../src/review/survey.ts';
import type { UserRulesSetting } from '../../src/review/vocabulary.ts';

/** A surveyor's check entry: a stated command from the CI workflow, or none. */
const stated = (kind: SurveyorCheckOutput['kind'], command: string | null, change: Partial<SurveyorCheckOutput> = {}): SurveyorCheckOutput =>
  command === null
    ? { kind, command: null, basis: null, source: null, missingTool: null, reason: `no ${kind} step`, ...change }
    : { kind, command, basis: 'stated', source: { path: '.github/workflows/ci.yml', quote: `run: ${command}` }, missingTool: null, reason: null, ...change };

/** An answer with nothing in it, and the fields `change` gives. */
const answer = (change: Partial<SurveyorOutput> = {}): SurveyorOutput => ({ conventions: [], userRules: [], checks: null, note: '', ...change });

describe('checkSurveyAnswer', () => {
  let sandbox: string;
  let worktree: string;
  let userFile: string;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'deep-review-survey-'));
    worktree = join(sandbox, 'repo');
    for (const path of ['AGENTS.md', 'docs/contributing.md', '.github/workflows/ci.yml', 'src/AGENTS.md', 'src/deep/CLAUDE.local.md', 'package.json', '.git/config']) {
      mkdirSync(join(worktree, ...path.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(join(worktree, ...path.split('/')), `# ${path}\n`);
    }
    mkdirSync(join(worktree, 'docs', 'guides'));
    userFile = join(sandbox, 'home', '.codex', 'AGENTS.md');
    mkdirSync(join(sandbox, 'home', '.codex'), { recursive: true });
    writeFileSync(userFile, '# rules\n');
  });
  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  /** The context of a read-only run under `judge` with the user-level file offered, unless `change` says otherwise. */
  const context = (change: { setting?: UserRulesSetting; fix?: boolean; flags?: CheckFlags; userFiles?: string[]; hints?: SurveyInputs['hints'] } = {}): SurveyCheckContext => ({
    worktree,
    lookup: worktreeLookup(worktree),
    setting: change.setting ?? 'judge',
    fix: change.fix ?? false,
    inputs: { platform: 'linux', flags: change.flags ?? noCheckFlags, userFiles: change.userFiles ?? [userFile], hints: change.hints ?? [], authorship: { identity: 'unset' } },
  });
  /** The context of a fix run whose flags settle build and typecheck, with a hint for lint. */
  const fixing = (change: Parameters<typeof context>[0] = {}): SurveyCheckContext =>
    context({ fix: true, flags: { commands: { build: 'make build' }, dropped: ['typecheck'] }, hints: [{ kind: 'lint', command: 'npm run lint', rule: 'package', reading: 'the package.json script `lint` through npm' }, { kind: 'test', command: null, rule: 'none', reading: 'none' }], ...change });
  const refuses = (output: SurveyorOutput, at: SurveyCheckContext, message: RegExp): void => {
    assert.throws(() => checkSurveyAnswer(output, at), (error: unknown) => error instanceof StructuralCheckError && message.test(error.message), message.source);
  };

  it('accepts an empty answer of a repository that states no conventions, deciding the offered file not applied', () => {
    const checked = checkSurveyAnswer(answer({ userRules: [{ path: userFile, applied: false, reason: 'not the reviewer\'s repository' }] }), context());
    assert.deepEqual(checked, { conventions: [], userRules: [{ path: userFile, applied: false, reason: 'not the reviewer\'s repository' }], checks: null, note: '' });
  });

  it('spells every repository path as the worktree does, with forward slashes, and keeps what each source governs and applies to', () => {
    const checked = checkSurveyAnswer(answer({
      conventions: [
        { path: 'docs\\contributing.md', level: 'repository', governs: 'style', appliesTo: null, grounds: null },
        { path: `${worktree}/src/AGENTS.md`, level: 'repository', governs: 'comments', appliesTo: ['src/**'], grounds: null },
        { path: userFile, level: 'user', governs: 'the reviewer\'s rules', appliesTo: null, grounds: 'src/AGENTS.md imports it' },
      ],
      userRules: [{ path: userFile, applied: true, reason: 'imported' }],
      note: 'a page outside',
    }), context());
    assert.deepEqual(checked.conventions.map((source) => [source.path, source.level, source.appliesTo]), [['docs/contributing.md', 'repository', null], ['src/AGENTS.md', 'repository', ['src/**']], [userFile, 'user', null]]);
    assert.equal(checked.note, 'a page outside');
  });

  it('refuses a source that is not a regular file of the repository, and one named twice', () => {
    const source = (path: string): SurveyorOutput['conventions'][number] => ({ path, level: 'repository', governs: 'g', appliesTo: null, grounds: null });
    const decided = { userRules: [{ path: userFile, applied: false, reason: 'r' }] };
    refuses(answer({ ...decided, conventions: [source('CONTRIBUTING.md')] }), context(), /not a regular file of the repository/);
    refuses(answer({ ...decided, conventions: [source('docs/guides')] }), context(), /not a regular file of the repository/);
    refuses(answer({ ...decided, conventions: [source('../outside.md')] }), context(), /not a path inside the repository/);
    refuses(answer({ ...decided, conventions: [source(join(sandbox, 'elsewhere.md'))] }), context(), /outside the worktree/);
    // The refusal speaks to a surveyor, not to a fixer.
    refuses(answer({ ...decided, conventions: [source('.git/config')] }), context(), /^The convention source "\.git\/config" is in the git directory, which holds git's own data, not a file of the repository$/);
    refuses(answer({ ...decided, conventions: [source('docs/contributing.md'), source('docs\\contributing.md')] }), context(), /named twice/);
    refuses(answer({ ...decided, conventions: [{ ...source('docs/contributing.md'), grounds: 'mine' }] }), context(), /states grounds, which only a user-level source does/);
  });

  it('refuses, as a failed attempt rather than an error that ends the run, a path the file system cannot resolve', () => {
    const source = (path: string): SurveyorOutput['conventions'][number] => ({ path, level: 'repository', governs: 'g', appliesTo: null, grounds: null });
    const decided = { userRules: [{ path: userFile, applied: false, reason: 'r' }] };
    refuses(answer({ ...decided, conventions: [source('/foo\u0000bar')] }), context(), /^The convention source "\/foo\\u0000bar" contains a NUL character$/);
    refuses(answer({ ...decided, conventions: [source('docs/a\u0000b.md')] }), context(), /contains a NUL character/);
    // Longer than any file system resolves: realpath fails with ENAMETOOLONG, not ENOENT.
    refuses(answer({ ...decided, conventions: [source(join(worktree, 'a'.repeat(40_000)))] }), context(), /^The convention source ".*" cannot be resolved: ENAMETOOLONG/);
    refuses(answer({ ...decided, checks: [stated('lint', 'eslint .', { source: { path: join(worktree, 'a'.repeat(40_000)), quote: 'q' } }), stated('test', null)] }), fixing(), /^The lint check's source ".*" cannot be resolved: ENAMETOOLONG/);
  });

  it('refuses a source inside the tree whose links lead outside the repository', () => {
    const outside = join(sandbox, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'rules.md'), '# not the repository\'s\n');
    // A junction needs no privilege on Windows, and is a directory symlink elsewhere.
    symlinkSync(outside, join(worktree, 'docs', 'linked'), 'junction');
    const decided = { userRules: [{ path: userFile, applied: false, reason: 'r' }] };
    refuses(answer({ ...decided, conventions: [{ path: 'docs/linked/rules.md', level: 'repository', governs: 'g', appliesTo: null, grounds: null }] }), context(), /^The convention source "docs\/linked\/rules\.md" leads outside the repository$/);
    refuses(answer({ ...decided, checks: [stated('lint', 'eslint .', { source: { path: 'docs/linked/rules.md', quote: 'q' } }), stated('test', null)] }), fixing(), /^The lint check's source "docs\/linked\/rules\.md" leads outside the repository$/);
  });

  it('refuses a source that is a file symlink leading outside the repository', (t) => {
    writeFileSync(join(sandbox, 'elsewhere.md'), '# not the repository\'s\n');
    try {
      symlinkSync(join(sandbox, 'elsewhere.md'), join(worktree, 'docs', 'rules.md'), 'file');
    } catch (error) {
      // Windows without Developer Mode denies symlink creation; nothing to test then.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('symlinks are not permitted here');
      throw error;
    }
    refuses(answer({ userRules: [{ path: userFile, applied: false, reason: 'r' }], conventions: [{ path: 'docs/rules.md', level: 'repository', governs: 'g', appliesTo: null, grounds: null }] }), context(), /^The convention source "docs\/rules\.md" leads outside the repository$/);
  });

  it('holds a rules file in a subdirectory to the files at or below it, and lets any other source govern the whole repository', () => {
    const source = (path: string, appliesTo: string[] | null): SurveyorOutput['conventions'][number] => ({ path, level: 'repository', governs: 'g', appliesTo, grounds: null });
    const decided = { userRules: [{ path: userFile, applied: false, reason: 'r' }] };
    const accepted = checkSurveyAnswer(answer({ ...decided, conventions: [source('AGENTS.md', null), source('docs/contributing.md', null), source('src/AGENTS.md', ['src/**', './src/lib/*.ts', 'SRC/deep']), source('src/deep/CLAUDE.local.md', ['src/deep/**'])] }), context());
    assert.deepEqual(accepted.conventions.map((entry) => [entry.path, entry.appliesTo]), [['AGENTS.md', null], ['docs/contributing.md', null], ['src/AGENTS.md', ['src/**', './src/lib/*.ts', 'SRC/deep']], ['src/deep/CLAUDE.local.md', ['src/deep/**']]]);
    refuses(answer({ ...decided, conventions: [source('src/AGENTS.md', null)] }), context(), /^The convention source "src\/AGENTS\.md" is a rules file in src, which governs only the files at or below it, and names no paths it applies to; name them, such as src\/\*\*$/);
    refuses(answer({ ...decided, conventions: [source('src\\deep\\CLAUDE.local.md', null)] }), context(), /rules file in src\/deep, which governs only the files at or below it/);
    refuses(answer({ ...decided, conventions: [source('src/AGENTS.md', ['src/**', '**/*.ts', 'srcs/**'])] }), context(), /^The convention source "src\/AGENTS\.md" is a rules file in src, which governs only the files at or below it, and applies beyond it to "\*\*\/\*\.ts", "srcs\/\*\*"$/);
  });

  it('holds the user-level decisions under judge to the offered files: each decided once, listed exactly when applied, with grounds', () => {
    const listed = { path: userFile, level: 'user' as const, governs: 'g', appliesTo: null, grounds: 'imported' };
    refuses(answer(), context(), /decides nothing about the offered user-level file/);
    refuses(answer({ userRules: [{ path: userFile, applied: false, reason: 'a' }, { path: userFile, applied: false, reason: 'b' }] }), context(), /named twice/);
    refuses(answer({ userRules: [{ path: '/elsewhere/AGENTS.md', applied: false, reason: 'r' }] }), context(), /not about a file the task offered/);
    refuses(answer({ userRules: [{ path: userFile, applied: true, reason: 'r' }] }), context(), /applied but not listed as a source/);
    refuses(answer({ conventions: [listed], userRules: [{ path: userFile, applied: false, reason: 'r' }] }), context(), /listed as a source but not applied/);
    refuses(answer({ conventions: [{ ...listed, grounds: null }], userRules: [{ path: userFile, applied: true, reason: 'r' }] }), context(), /states no grounds/);
    refuses(answer({ conventions: [{ ...listed, path: '/elsewhere/AGENTS.md' }] }), context({ userFiles: [] }), /not a file the task offered; it offered none/);
  });

  it('matches an offered user-level file by its absolute path however it is spelled, and never a relative one, wherever the engine runs', () => {
    const decide = (path: string): SurveyorOutput => answer({ conventions: [{ path, level: 'user', governs: 'g', appliesTo: null, grounds: 'imported' }], userRules: [{ path, applied: true, reason: 'r' }] });
    const respelled = checkSurveyAnswer(decide(userFile.replaceAll('\\', '/')), context());
    assert.deepEqual([respelled.conventions[0]?.path, respelled.userRules[0]?.path], [userFile, userFile], 'the engine\'s spelling of the offered file');
    const relativeToHome = join('.codex', 'AGENTS.md');
    const here = process.cwd();
    // Run from the home directory a relative path would resolve to the offered file; it is still not the path the task gave.
    process.chdir(join(sandbox, 'home'));
    try {
      refuses(decide(relativeToHome), context(), /^The user-level source ".*" is not a file the task offered$/);
      refuses(answer({ userRules: [{ path: relativeToHome, applied: false, reason: 'r' }] }), context(), /is not about a file the task offered/);
    } finally {
      process.chdir(here);
    }
    refuses(decide('/foo\u0000bar'), context(), /contains a NUL character/);
  });

  it('joins the policy\'s part under apply and ignore, and refuses a surveyor deciding what the policy settles', () => {
    const applied = checkSurveyAnswer(answer(), context({ setting: 'apply' }));
    assert.deepEqual(applied.conventions, [{ path: userFile, level: 'user', governs: policyWords.governs, appliesTo: null, grounds: policyWords.grounds }]);
    assert.deepEqual(applied.userRules, [{ path: userFile, applied: true, reason: policyWords.grounds }]);
    const ignored = checkSurveyAnswer(answer(), context({ setting: 'ignore' }));
    assert.deepEqual(ignored.conventions, []);
    assert.deepEqual(ignored.userRules, [{ path: userFile, applied: false, reason: policyWords.ignored }]);
    assert.deepEqual(checkSurveyAnswer(answer(), context({ setting: 'apply', userFiles: [] })).userRules, [], 'no file, nothing to decide');
    for (const setting of ['apply', 'ignore'] as const) {
      refuses(answer({ userRules: [{ path: userFile, applied: true, reason: 'r' }] }), context({ setting }), new RegExp(`which the policy value ${setting} settles`));
      refuses(answer({ conventions: [{ path: userFile, level: 'user', governs: 'g', appliesTo: null, grounds: 'g' }] }), context({ setting }), /not a file the task offered/);
    }
  });

  it('asks no checks of a read-only run, and one per unsettled kind of a fix run, in run order with their sources resolved', () => {
    const decided = { userRules: [{ path: userFile, applied: false, reason: 'r' }] };
    refuses(answer({ ...decided, checks: [] }), context(), /this run does not fix/);
    refuses(answer(decided), fixing(), /chooses no checks, and this run fixes/);
    const checked = checkSurveyAnswer(answer({ ...decided, checks: [stated('test', null), stated('lint', 'npm run lint', { basis: 'hint', source: { path: 'package.json', quote: '"lint": "eslint ."' } })] }), fixing());
    assert.deepEqual(checked.checks, [
      { kind: 'lint', command: 'npm run lint', basis: 'hint', source: { path: 'package.json', quote: '"lint": "eslint ."' }, missingTool: null, reason: null },
      { kind: 'test', command: null, basis: null, source: null, missingTool: null, reason: 'no test step' },
    ]);
    const all = checkSurveyAnswer(answer({ ...decided, checks: [stated('lint', 'ruff check .', { missingTool: 'ruff' }), stated('test', 'uv run pytest', { source: { path: '.github\\workflows\\ci.yml', quote: 'q' } })] }), fixing());
    assert.deepEqual(all.checks?.map((check) => [check.kind, check.missingTool, check.source?.path]), [['lint', 'ruff', '.github/workflows/ci.yml'], ['test', null, '.github/workflows/ci.yml']]);
    assert.deepEqual(checkSurveyAnswer(answer({ ...decided, checks: [] }), fixing({ flags: { commands: { build: 'a', typecheck: 'b', lint: 'c', test: 'd' }, dropped: [] } })).checks, [], 'every kind settled, none to choose');
  });

  it('refuses a check answer that misses a kind, names a settled one or one twice, or a command without its source, basis or hint', () => {
    const decided = { userRules: [{ path: userFile, applied: false, reason: 'r' }] };
    const checks = (...entries: SurveyorCheckOutput[]): SurveyorOutput => answer({ ...decided, checks: entries });
    refuses(checks(stated('lint', null)), fixing(), /chooses nothing for test/);
    refuses(checks(stated('lint', null), stated('test', null), stated('build', 'make')), fixing(), /chooses build, which a flag settles/);
    refuses(checks(stated('lint', null), stated('lint', null), stated('test', null)), fixing(), /The check kind "lint" is named twice/);
    refuses(checks(stated('lint', 'eslint .', { source: null }), stated('test', null)), fixing(), /gives a command without the file it took it from/);
    refuses(checks(stated('lint', 'eslint .', { basis: null }), stated('test', null)), fixing(), /gives a command without its basis/);
    refuses(checks(stated('lint', '   '), stated('test', null)), fixing(), /command is empty/);
    refuses(checks(stated('lint', 'eslint\u0000 .'), stated('test', null)), fixing(), /^The lint check's command contains a NUL character, which no shell runs$/);
    // cmd.exe runs only the first line of a command and sh judges only the last, so one line's exit code alone would decide the check.
    for (const command of ['npm run lint\nnpm run format', 'npm run lint\r\nnpm run format', 'npm run lint\rnpm run format', 'npm run lint\n']) {
      refuses(checks(stated('lint', command), stated('test', null)), fixing(), /^The lint check's command spans more than one line, and cmd.exe runs only the first while sh judges only the last; join the commands on one line with &&$/);
    }
    refuses(checks(stated('lint', 'eslint .', { source: { path: 'eslint.config.js', quote: 'q' } }), stated('test', null)), fixing(), /source "eslint.config.js" is not a regular file/);
    refuses(checks(stated('lint', null, { reason: null }), stated('test', null)), fixing(), /has no command and gives no reason/);
    refuses(checks(stated('lint', null, { missingTool: 'eslint' }), stated('test', null)), fixing(), /names a missing tool and no command/);
    refuses(checks(stated('lint', null, { basis: 'stated' }), stated('test', null)), fixing(), /neither a source nor a basis/);
    refuses(checks(stated('lint', null), stated('test', 'npm test', { basis: 'hint' })), fixing(), /the engine gave no hinted command for test/);
    refuses(checks(stated('lint', 'npx eslint .', { basis: 'hint' }), stated('test', null)), fixing(), /is not the hint's "npm run lint"/);
  });
});

describe('resolveChecks', () => {
  const survey = { checks: [
    { kind: 'build' as const, command: null, basis: null, source: null, missingTool: null, reason: 'no build step' },
    { kind: 'typecheck' as const, command: 'uv run mypy src', basis: 'stated' as const, source: { path: 'ci.yml', quote: 'mypy' }, missingTool: null, reason: null },
    { kind: 'lint' as const, command: 'pre-commit run', basis: 'stated' as const, source: { path: 'ci.yml', quote: 'pre-commit' }, missingTool: 'pre-commit', reason: null },
  ] };

  it('plans each kind by its row: a --no-check, a --check over the survey, the survey\'s command, its missing tool, its none, and a kind nobody answered', () => {
    const resolved = resolveChecks(survey, noCheckFlags);
    assert.deepEqual(resolved.checks, [
      { kind: 'build', command: null, origin: 'none', reason: 'no build step', source: null },
      { kind: 'typecheck', command: 'uv run mypy src', origin: 'survey', reason: null, source: { path: 'ci.yml', quote: 'mypy', basis: 'stated' } },
    ]);
    assert.deepEqual(resolved.unavailable, [{ kind: 'lint', command: 'pre-commit run', source: 'ci.yml', missingTool: 'pre-commit' }]);
    assert.deepEqual(resolved.uncovered, ['test']);
    const flagged = resolveChecks(survey, { commands: { typecheck: 'mypy .', test: 'pytest' }, dropped: ['lint'] });
    assert.deepEqual(flagged.checks.map((check) => [check.kind, check.command, check.origin, check.reason]), [['build', null, 'none', 'no build step'], ['typecheck', 'mypy .', 'flag', null], ['lint', null, 'flag', droppedReason], ['test', 'pytest', 'flag', null]]);
    assert.deepEqual([flagged.unavailable, flagged.uncovered], [[], []]);
  });

  it('plans from the flags alone with no survey, leaving every unflagged kind uncovered', () => {
    assert.deepEqual(resolveChecks(null, { commands: { build: 'make' }, dropped: ['test'] }).uncovered, ['typecheck', 'lint']);
    assert.deepEqual(resolveChecks({ checks: null }, noCheckFlags).uncovered, ['build', 'typecheck', 'lint', 'test']);
  });
});

describe('the policy\'s part of the user-level rules', () => {
  it('offers the files to the surveyor only under judge', () => {
    assert.deepEqual(offeredUserFiles('judge', { userFiles: ['/h/a'] }), ['/h/a']);
    assert.deepEqual(offeredUserFiles('apply', { userFiles: ['/h/a'] }), []);
    assert.deepEqual(offeredUserFiles('ignore', { userFiles: ['/h/a'] }), []);
  });

  it('decides each file for a failed survey by the policy alone: applied, ignored, or not judged', () => {
    assert.deepEqual(surveyFailure('r', 'apply', ['/h/a']), { reason: 'r', conventions: [{ path: '/h/a', level: 'user', governs: policyWords.governs, appliesTo: null, grounds: policyWords.grounds }], userRules: [{ path: '/h/a', applied: true, reason: policyWords.grounds }] });
    assert.deepEqual(surveyFailure('r', 'ignore', ['/h/a']), { reason: 'r', conventions: [], userRules: [{ path: '/h/a', applied: false, reason: policyWords.ignored }] });
    assert.deepEqual(surveyFailure('r', 'judge', ['/h/a']), { reason: 'r', conventions: [], userRules: [{ path: '/h/a', applied: false, reason: policyWords.unjudged }] });
    assert.deepEqual(surveyFailure('r', 'judge', []), { reason: 'r', conventions: [], userRules: [] });
  });
});
