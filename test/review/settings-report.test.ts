import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReviewConfiguration, ScopeState } from '../../src/checkpoint/events.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { renderReport } from '../../src/review/report.ts';
import { namedExcludedPaths, settingsHeaderLine, settingsLimitations } from '../../src/review/settings-report.ts';
import { describeRun } from '../../src/review/status.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { configuration, reported, scope as scopeV1, settingsBlock, reportInput } from '../helpers/review-history.ts';

const base = '1'.repeat(40);
/** The scope as the fold holds it, with the patterns given and the paths they left out. */
const scopeWith = (exclude: string[] = [], excluded: string[] = [], count = excluded.length): ScopeState => ({ ...scopeV1, request: { ...scopeV1.request, exclude }, excluded: { paths: excluded, count } });
/** A configuration with a settings block, as version 6 records it, over the one given. */
const configuredWith = (settings: Record<string, unknown> = {}): ReviewConfiguration => ({ ...configuration, survey: { userRules: 'judge' }, settings: settingsBlock(false, settings) as unknown as ReviewConfiguration['settings'] });

describe('the settings in the report and status (R7 of the configuration)', () => {
  it('says only that no file was read, for a run whose values are all defaults and flags', () => {
    const plain = configuredWith();
    assert.equal(settingsHeaderLine(plain), 'Settings: no configuration file');
    assert.deepEqual(settingsLimitations(plain, scopeWith()), []);
  });

  it('names the files read, each with its layer, and the commit of the repository\'s', () => {
    const files = [
      { layer: 'repository', path: '.deep-review/config.toml', sha256: 'a'.repeat(64), commit: base },
      { layer: 'operator', path: '/home/me/.config/deep-review/config.toml', sha256: 'b'.repeat(64), commit: null },
    ];
    assert.equal(settingsHeaderLine(configuredWith({ files, repository: { state: 'read', commit: base, edited: false } })), `Settings: the repository's file .deep-review/config.toml at ${base}, the operator's file /home/me/.config/deep-review/config.toml`);
  });

  it('says the repository\'s file was skipped, or edited by the change, in the header and among what the run did not follow', () => {
    const skipped = configuredWith({ repository: { state: 'skipped', commit: null, edited: false } });
    assert.equal(settingsHeaderLine(skipped), 'Settings: no configuration file; the repository\'s file skipped by --no-repository-config');
    assert.deepEqual(settingsLimitations(skipped, scopeWith()), ['The repository\'s file was skipped by --no-repository-config, so the run did not apply the policy of the repository.']);
    const edited = configuredWith({ repository: { state: 'absent', commit: base, edited: true } });
    assert.equal(settingsHeaderLine(edited), 'Settings: no configuration file; .deep-review/config.toml edited by this change: the edit applies to later changes');
    assert.deepEqual(settingsLimitations(edited, scopeWith()), ['This change edits .deep-review/config.toml; the edit applies to later changes, and this review read the file as its base holds it.']);
  });

  it('names the patterns of scope.exclude and the paths they left out, the first 50 and the count of the rest', () => {
    assert.deepEqual(settingsLimitations(configuredWith(), scopeWith(['dist/**'], ['dist/a.js'])), ['scope.exclude (dist/**) left out 1 changed path, which no worker reviewed: dist/a.js.']);
    assert.deepEqual(settingsLimitations(configuredWith(), scopeWith(['dist/**', 'vendor/**'])), ['scope.exclude (dist/**, vendor/**) left out no changed path.']);
    const many = Array.from({ length: 60 }, (_, index) => `dist/${String(index)}.js`);
    const line = settingsLimitations(configuredWith(), scopeWith(['dist/**'], many, 2500))[0]!;
    assert.ok(line.startsWith('scope.exclude (dist/**) left out 2500 changed paths, which no worker reviewed: dist/0.js, '), line);
    assert.ok(line.endsWith(`dist/${String(namedExcludedPaths - 1)}.js, and 2450 more.`), line);
  });

  it('names each repository value a higher layer did not follow, with the value used and its layer, and each ignored setting', () => {
    const settings = configuredWith({
      notFollowed: [{ name: 'checks.test', repository: 'npm test', value: 'npm run test:fast', layer: 'clone' }, { name: 'scope.exclude', repository: ['dist/**'], value: [], layer: 'flag' }],
      ignored: [{ layer: 'operator', path: '/home/me/.config/deep-review/config.toml', name: 'report.formats', reason: 'no such setting' }],
    });
    assert.deepEqual(settingsLimitations(settings, scopeWith()), [
      'Not followed: checks.test: the repository\'s "npm test", this run\'s "npm run test:fast" from the clone\'s file.',
      'Not followed: scope.exclude: the repository\'s ["dist/**"], this run\'s [] from a flag.',
      'Ignored: report.formats in /home/me/.config/deep-review/config.toml: no such setting.',
    ]);
    // A recorded value of null reads as none, as the line on stderr names it.
    const none = configuredWith({ notFollowed: [{ name: 'checks.test', repository: 'npm test', value: null, layer: 'clone' }] });
    assert.deepEqual(settingsLimitations(none, scopeWith()), ['Not followed: checks.test: the repository\'s "npm test", this run\'s none from the clone\'s file.']);
  });

  it('says a run configured before the settings is older than them, and names no other line but its exclusions, which it had none of', () => {
    assert.equal(settingsHeaderLine(configuration), 'Settings: recorded before the settings existed; the run\'s values came from the defaults and its flags');
    assert.deepEqual(settingsLimitations(configuration, scopeWith()), []);
  });

  it('adds what a continuation read and did not follow, its fix side speaking for the settings it holds, each line once', () => {
    const repository = { layer: 'repository' as const, path: '.deep-review/config.toml', sha256: 'a'.repeat(64), commit: base };
    const clone = { layer: 'clone' as const, path: '/r/.git/deep-review.toml', sha256: 'b'.repeat(64), commit: null };
    const ignoredOne = { layer: 'clone' as const, path: clone.path, name: 'profile', reason: 'no such setting' };
    const fixSettings = {
      values: { 'checks.build': null, 'checks.typecheck': null, 'checks.lint': null, 'checks.test': 'make test', 'tools.path': [] },
      layers: { 'checks.build': 'default', 'checks.typecheck': 'default', 'checks.lint': 'default', 'checks.test': 'clone', 'checks.timeout_minutes': 'default', 'tools.path': 'default' },
      files: [repository, clone],
      repository: { state: 'read', commit: base, edited: false },
      notFollowed: [{ name: 'checks.test', repository: 'npm test', value: 'make test', layer: 'clone' }],
      ignored: [ignoredOne],
    } as unknown as ReviewConfiguration['fixSettings'];
    const continued: ReviewConfiguration = {
      ...configuredWith({ files: [repository], repository: { state: 'read', commit: base, edited: false }, notFollowed: [{ name: 'scope.exclude', repository: ['dist/**'], value: [], layer: 'flag' }], ignored: [ignoredOne] }),
      fixSettings,
    };
    assert.equal(settingsHeaderLine(continued), `Settings: the repository's file .deep-review/config.toml at ${base}; the fix pass: the repository's file .deep-review/config.toml at ${base}, the clone's file /r/.git/deep-review.toml`);
    assert.deepEqual(settingsLimitations(continued, scopeWith()), [
      'Not followed: scope.exclude: the repository\'s ["dist/**"], this run\'s [] from a flag.',
      'Not followed: checks.test: the repository\'s "npm test", this run\'s "make test" from the clone\'s file.',
      'Ignored: profile in /r/.git/deep-review.toml: no such setting.',
    ]);
    // A run configured before the settings and continued since names the continuation's record alone.
    const older: ReviewConfiguration = { ...configuration, fixSettings };
    assert.equal(settingsHeaderLine(older), `Settings: recorded before the settings existed; the run's values came from the defaults and its flags; the fix pass: the repository's file .deep-review/config.toml at ${base}, the clone's file /r/.git/deep-review.toml`);
    assert.equal(settingsLimitations(older, scopeWith()).length, 2);
    // A continuation that skipped the repository's file says so for the fix pass.
    const skipped: ReviewConfiguration = { ...older, fixSettings: { ...fixSettings!, files: [clone], repository: { state: 'skipped', commit: null, edited: false }, notFollowed: [], ignored: [] } };
    assert.deepEqual(settingsLimitations(skipped, scopeWith()), ['The repository\'s file was skipped by --no-repository-config for the fix pass, so its checks did not follow the policy of the repository.']);
  });

  it('puts the header line in the facts of the run, the paths left out among the gaps of the brief and the rest in the notes, and the same lines in status', () => {
    const finished = reported().fold();
    const settings = configuredWith({ notFollowed: [{ name: 'checks.test', repository: 'npm test', value: 'make test', layer: 'operator' }] });
    const state: RunState = { ...finished, scope: scopeWith(['dist/**'], ['dist/a.js']), review: { ...finished.review!, configuration: settings } };
    const report = renderReport(state, reportInput);
    assert.match(report, /^Models: strong opus, fast sonnet\nSettings: no configuration file\n/m);
    assert.ok(report.includes(' 1 changed path under dist/**, which the settings leave out.'), 'a gap of the brief (R10 of the brief of a run)');
    // The facts of the run name each path left out and each value not followed, beside the Settings line the skills point at (R12, R15 of the brief of a run).
    const facts = report.slice(report.indexOf('\n## The run\n'));
    assert.match(facts, /^Settings: no configuration file\nscope\.exclude \(dist\/\*\*\) left out 1 changed path, which no worker reviewed: dist\/a\.js\.\nNot followed: checks\.test: the repository's "npm test", this run's "make test" from the operator's file\.$/m);
    assert.doesNotMatch(report.slice(0, report.indexOf('\n## The run\n')), /Not followed: |scope\.exclude \(/, 'nowhere else');
    const lines = describeRun(state, claudeAdapter, (reference) => `/evidence/${reference.sha256.slice(0, 8)}`).lines;
    assert.equal(lines[4], 'Settings: no configuration file');
    assert.deepEqual(lines.slice(5, 7), ['scope.exclude (dist/**) left out 1 changed path, which no worker reviewed: dist/a.js.', 'Not followed: checks.test: the repository\'s "npm test", this run\'s "make test" from the operator\'s file.']);
    // A run configured before the settings renders as it did, with no settings line.
    assert.doesNotMatch(renderReport(finished, reportInput), /^Settings:/m);
  });
});
