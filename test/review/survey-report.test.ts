import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { SurveyedCheck } from '../../src/checkpoint/events.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { renderStats } from '../../src/review/stats-report.ts';
import { renderReport } from '../../src/review/report.ts';
import { checkUnavailableBlocker } from '../../src/review/steps.ts';
import { checkSourceCell, conventionsReportSection, droppedByOperator, surveyLimitations, unavailableCell } from '../../src/review/survey-report.ts';
import { emptyFixState } from '../../src/checkpoint/fix-state.ts';
import { History, continuedRun, continuedToReport, fixRun, fixStatistics, quietSurveyedChecks, reference, reported, surveyAnswer, surveyedCheck, withSurvey, worker, reportInput } from '../helpers/review-history.ts';

const snapshotPath = resolve(import.meta.dirname, '../fixtures/reports/survey.md');
const patches = [reference('1'), reference('2'), reference('3')];

const userRules = '/home/reviewer/.codex/AGENTS.md';
const otherRules = '/home/reviewer/.claude/CLAUDE.md';
const surveyStatistics = { ...fixStatistics, phases: [{ phase: 'survey' as const, workers: 1, seconds: 20, costUsd: 0.3, costUnreported: 0, inputTokens: 500, cachedInputTokens: 100, outputTokens: 50 }, ...fixStatistics.phases] };

/**
 * The fix run of the fix report's test, surveyed first: the surveyor names
 * a contributing guide, a rules file of src/ and the reviewer's own rules
 * file, which it applies, and another it does not; it hints build, states
 * lint, test and a typecheck whose tool is missing, so the survey blocks;
 * the next invocation drops typecheck with --no-check and names test with
 * --check, and the re-entered survey plans the checks with no new worker.
 */
function surveyedFixRun(): History {
  return withSurvey(fixRun(), (history) => history
    .start('survey')
    .worker(80, 'surveyor survey:survey')
    .add('survey.recorded', {
      workerId: worker(80),
      conventions: [
        { path: 'CONTRIBUTING.md', level: 'repository', governs: 'code style, tests and commit messages', appliesTo: null, grounds: null },
        { path: 'src/AGENTS.md', level: 'repository', governs: 'how the sources are commented', appliesTo: ['src/**'], grounds: null },
        { path: userRules, level: 'user', governs: 'the reviewer\'s engineering rules', appliesTo: null, grounds: 'src/AGENTS.md imports it' },
      ],
      userRules: [{ path: otherRules, applied: false, reason: 'nothing in the repository refers to it' }, { path: userRules, applied: true, reason: 'src/AGENTS.md imports it' }],
      checks: [
        { kind: 'build', command: 'npm run build', basis: 'hint', source: { path: 'package.json', quote: '"build": "tsc -b"' }, missingTool: null, reason: null },
        { kind: 'typecheck', command: 'npx tsc --noEmit', basis: 'stated', source: { path: '.github/workflows/ci.yml', quote: 'run: npx tsc --noEmit' }, missingTool: 'tsc', reason: null },
        { kind: 'lint', command: 'npm run lint', basis: 'stated', source: { path: '.github/workflows/ci.yml', quote: 'run: npm run lint' }, missingTool: null, reason: null },
        { kind: 'test', command: 'npx vitest run', basis: 'stated', source: { path: 'CONTRIBUTING.md', quote: 'run `npx vitest run`' }, missingTool: null, reason: null },
      ],
      note: 'CONTRIBUTING.md links to a style guide outside the repository',
    })
    .finish('survey', 'blocked', 1, checkUnavailableBlocker([{ kind: 'typecheck', command: 'npx tsc --noEmit', source: '.github/workflows/ci.yml', missingTool: 'tsc' }], false))
    .start('survey', 2)
    .add('checks.planned', { checks: [
      { kind: 'build', command: 'npm run build', origin: 'survey', reason: null, source: { path: 'package.json', quote: '"build": "tsc -b"', basis: 'hint' } },
      { kind: 'typecheck', command: null, origin: 'flag', reason: 'dropped by --no-check', source: null },
      { kind: 'lint', command: 'npm run lint', origin: 'survey', reason: null, source: { path: '.github/workflows/ci.yml', quote: 'run: npm run lint', basis: 'stated' } },
      { kind: 'test', command: 'npm run test', origin: 'flag', reason: null, source: null },
    ] }, 2)
    .finish('survey', 'completed', 2));
}

/** The same history with no CONVENTIONS finder, which a run left with no convention source never launches. */
function withoutConventionsFinder(history: History): History {
  const kept = new History();
  const label = 'finder-CONVENTIONS finders:CONVENTIONS';
  const workers = new Set(history.events.filter((event) => event.kind === 'worker.launched' && (event.payload as { label: string }).label === label).map((event) => (event.payload as { workerId: string }).workerId));
  for (const event of history.events) {
    const payload = event.payload as { workerId?: string; key?: string; phase?: string };
    if (payload.workerId !== undefined && workers.has(payload.workerId)) continue;
    if (event.kind === 'candidates.recorded' && payload.phase === 'finders' && payload.key === 'CONVENTIONS') continue;
    kept.add(event.kind, event.payload, event.version);
  }
  return kept;
}

describe('the report of a surveyed run', () => {
  const render = (state: RunState = surveyedFixRun().fold()): string => renderReport(state, { ...reportInput, home: '/home/reviewer', statistics: surveyStatistics, fix: { patches, continueCommand: null } });

  it('renders exactly as the committed snapshot, which a person read once in review', () => {
    assert.equal(render(), readFileSync(snapshotPath, 'utf8'), `the report changed; if on purpose, write the new text to ${snapshotPath}`);
  });

  it('places Conventions before Refuted at verification, and gives the survey its row in the statistics (R12 of the brief of a run; R9 of the report for the person)', () => {
    const report = render();
    const order = ['## Findings', '## Fixes', '## Checks', '## Conventions', '## Refuted at verification'].map((heading) => report.indexOf(`\n${heading}\n`));
    assert.ok(order.every((position) => position > 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(renderStats(surveyedFixRun().fold(), surveyStatistics).join('\n'), /^\| survey \| 1 \| 20\.0 \| 0\.30 \| 500 \| 100 \| 50 \|$/m);
  });

  it('lists each source with its level, what it governs and what it applies to, each user-level decision with its reason, and the surveyor\'s note (R10)', () => {
    const report = render();
    assert.match(report, /^The survey named these files as stating the conventions the change was held to:\n\n\| Source \| Level \| Governs \| Applies to \|$/m);
    assert.match(report, /^\| CONTRIBUTING\.md \| repository \| code style, tests and commit messages \| the whole repository \|$/m);
    assert.match(report, /^\| src\/AGENTS\.md \| repository \| how the sources are commented \| src\/\*\* \|$/m);
    // A user-level file is named under ~, the home directory (R15 of the brief of a run).
    assert.ok(report.includes('| ~/.codex/AGENTS.md | user: src/AGENTS.md imports it | the reviewer\'s engineering rules | the whole repository |'), report);
    assert.ok(report.includes('The reviewer\'s own rules files, under the policy value `judge`:\n\n- ~/.claude/CLAUDE.md: not applied, nothing in the repository refers to it\n- ~/.codex/AGENTS.md: applied, src/AGENTS.md imports it'), report);
    assert.ok(!report.includes(userRules) && !report.includes(otherRules), 'no path under the home directory as it is');
    assert.match(report, /^Surveyor's note: CONTRIBUTING\.md links to a style guide outside the repository$/m);
  });

  it('names each check\'s source, and of a kind the operator dropped after its tool was missing what the project defines (R10, R15)', () => {
    const report = render();
    assert.match(report, /^\| Check \| Command \| Source \| Before the fixes \| After the fixes \| After the repair \|$/m);
    assert.match(report, /^\| build \| npm run build \| package\.json \(hint\) \| passed/m);
    assert.match(report, /^\| typecheck \| dropped by the operator; the project defines `npx tsc --noEmit` \(\.github\/workflows\/ci\.yml\), tsc not found \| --no-check \| - \| - \| - \|$/m);
    assert.match(report, /^\| lint \| npm run lint \| \.github\/workflows\/ci\.yml \(stated\) \| passed/m);
    assert.match(report, /^\| test \| npm run test \| --check \| failed/m);
    assert.match(report, /^- No typecheck check ran: dropped by the operator; the project defines `npx tsc --noEmit` \(\.github\/workflows\/ci\.yml\), tsc not found\.$/m, 'a gap of the brief, with what the operator dropped (R10 of the brief of a run)');
  });

  it('says the survey failed, and that CONVENTIONS had no rule, in a read-only run without a source', () => {
    const failed = withSurvey(withoutConventionsFinder(reported()), (history) => history.start('survey').add('survey.failed', { reason: '2 attempts did not complete: timeout', conventions: [], userRules: [] }).finish('survey', 'degraded'));
    const report = renderReport(failed.fold(), reportInput);
    assert.match(report, /^## Conventions\n\nThe survey failed: 2 attempts did not complete: timeout\. The run went on with no convention source\.\n\nNo user-level rules file of the reviewer's existed on this machine; the policy value was `judge`\.$/m);
    assert.match(report, /^- The survey failed: 2 attempts did not complete: timeout\. No repository convention source was known\.$/m);
    assert.match(report, /^- The CONVENTIONS angle did not run \(the survey failed, so no convention source is known: 2 attempts did not complete: timeout\)\. /m);
    const none = withSurvey(reported(), (history) => history.start('survey').worker(80, 'surveyor survey:survey').add('survey.recorded', { workerId: worker(80), conventions: [], userRules: [], checks: null, note: '' }).finish('survey'));
    assert.match(renderReport(none.fold(), reportInput), /^## Conventions\n\nThe survey found no file that states conventions a change here must follow, so CONVENTIONS had no rule to hold the change to\.$/m);
  });

  it('counts the survey\'s answers, and says it blocked on a check this machine could not run only when the ledger records that block (R10)', () => {
    // The checks fixRun() runs (build, lint, test) as the survey's, and no typecheck.
    const stated = (kind: string, command: string) => ({ kind, command, basis: 'stated', source: { path: 'package.json', quote: `"${kind}"` }, missingTool: null, reason: null });
    const surveyed = [stated('build', 'npm run build'), { kind: 'typecheck', command: null, basis: null, source: null, missingTool: null, reason: 'no typecheck' }, stated('lint', 'npm run lint'), stated('test', 'npm run test')];
    const answer = (n: number) => ({ workerId: worker(n), conventions: [], userRules: [], checks: surveyed, note: '' });
    const plan = { checks: surveyed.map(({ kind, command, basis, source, reason }) => ({ kind, command, origin: command === null ? 'none' : 'survey', reason, source: source === null || basis === null ? null : { ...source, basis } })) };
    const conventionsOf = (history: History): string => {
      const report = render(history.fold());
      return report.slice(report.indexOf('\n## Conventions\n'), report.indexOf('\n## Refuted at verification\n'));
    };
    // The engine died between the first answer and its plan; the resumed invocation surveyed again with no block in between.
    const resumed = withSurvey(fixRun(), (history) => history
      .start('survey').worker(80, 'surveyor survey:survey').add('survey.recorded', answer(80))
      .start('survey', 2).worker(81, 'surveyor survey:survey').add('survey.recorded', answer(81))
      .add('checks.planned', plan, 2).finish('survey', 'completed', 2));
    const resumedText = conventionsOf(resumed);
    assert.match(resumedText, /^The survey answered 2 times; the last answer is shown\.$/m);
    assert.doesNotMatch(resumedText, /blocked/);
    const blocked = withSurvey(fixRun(), (history) => history
      .start('survey').worker(80, 'surveyor survey:survey').add('survey.recorded', answer(80))
      .finish('survey', 'blocked', 1, checkUnavailableBlocker([{ kind: 'test', command: 'npx vitest run', source: 'CONTRIBUTING.md', missingTool: 'vitest' }], false))
      .start('survey', 2).worker(81, 'surveyor survey:survey').add('survey.recorded', answer(81))
      .add('checks.planned', plan, 2).finish('survey', 'completed', 2));
    assert.match(conventionsOf(blocked), /^The survey answered 2 times; it last blocked on a check this machine could not run, and the last answer is shown\.$/m);
    assert.doesNotMatch(render(), /The survey answered/, 'one answer is not counted');
  });

  it('renders a run configured before the survey existed with no Conventions section and no Source column, as it did', () => {
    const older = renderReport(fixRun().fold(), { ...reportInput, statistics: fixStatistics, fix: { patches, continueCommand: null } });
    assert.ok(!older.includes('## Conventions'));
    assert.match(older, /^\| Check \| Command \| Before the fixes \|/m);
  });
});

// R4, PD5 of fix pass continuation: the continuation's answer for the checks is planned, not a repeated survey, and the review's note on its conventions stays.
describe('the Conventions section of a run continued into the fix pass', () => {
  /** `history` with each survey answer's note as `notes` gives it by worker. */
  const noted = (history: History, notes: Record<string, string>): History => {
    const copy = new History();
    for (const event of history.events) {
      const payload = event.payload as { workerId?: string };
      const note = event.kind === 'survey.recorded' && payload.workerId !== undefined ? notes[payload.workerId] : undefined;
      copy.add(event.kind, note === undefined ? event.payload : { ...payload, note }, event.version);
    }
    return copy;
  };
  const conventionsOf = (report: string): string => report.slice(report.indexOf('\n## Conventions\n'), report.indexOf('\n## Refuted at verification\n'));

  it('says the continuation asked for the checks alone, and shows the review\'s note on the conventions beside the note on the checks', () => {
    const state = noted(continuedToReport(), { [worker(80)]: 'AGENTS.md imports the reviewer\'s rules', [worker(81)]: 'checks only; the conventions stand' }).fold();
    const section = conventionsOf(renderReport(state, { ...reportInput, fix: { patches, continueCommand: null } }));
    assert.doesNotMatch(section, /answered/, 'neither a repeated survey nor a review that answered twice');
    assert.ok(section.endsWith([
      '',
      'The continuation into the fix pass asked the survey for the checks alone once, the conventions standing.',
      '',
      'Surveyor\'s note on the conventions: AGENTS.md imports the reviewer\'s rules',
      '',
      'Surveyor\'s note on the checks: checks only; the conventions stand',
      '',
    ].join('\n')), section);
  });

  it('counts the continuation\'s answers after a check it could not run, naming the block, and leaves out a note the review did not write', () => {
    const missing = [surveyedCheck('build', 'npm run build'), surveyedCheck('typecheck', null), surveyedCheck('lint', 'ruff check .', 'ruff'), surveyedCheck('test', 'npm run test')];
    const history = continuedRun()
      .start('survey', 2).worker(81, 'surveyor survey:survey').add('survey.recorded', surveyAnswer(worker(81), { checks: missing, note: 'ruff is missing' }))
      .finish('survey', 'blocked', 2, checkUnavailableBlocker([{ kind: 'lint', command: 'ruff check .', source: '.github/workflows/ci.yml', missingTool: 'ruff' }], true))
      .start('survey', 3).worker(82, 'surveyor survey:survey').add('survey.recorded', surveyAnswer(worker(82), { checks: quietSurveyedChecks(), note: 'ruff is installed now' }));
    const section = conventionsReportSection(history.review())!;
    assert.deepEqual(section.slice(-4), [
      '',
      'The continuation into the fix pass asked the survey for the checks alone 2 times, the conventions standing; it last blocked on a check this machine could not run.',
      '',
      'Surveyor\'s note on the checks: ruff is installed now',
    ]);
    assert.ok(!section.some((line) => /answered|on the conventions/.test(line)), section.join('\n'));
  });

  it('counts the review\'s answers only when it answered more than once, and names no continuation the flags spared a surveyor', () => {
    const review = continuedRun().review();
    const answer = review.survey!.answers[0]!;
    const twice = conventionsReportSection({ ...review, survey: { ...review.survey!, answers: [{ ...answer, note: 'first' }, { ...answer, note: 'second' }] } })!;
    assert.deepEqual(twice.slice(-4), ['', 'The review\'s survey answered 2 times; the conventions of its last answer are shown.', '', 'Surveyor\'s note on the conventions: second']);
    const once = conventionsReportSection(review)!;
    assert.ok(!once.some((line) => /answered|continuation|note/.test(line)), once.join('\n'));
  });
});

describe('the Checks table of a surveyed run', () => {
  const missing = { kind: 'lint' as const, command: 'ruff check .', basis: 'stated' as const, source: { path: 'pyproject.toml', quote: 'ruff' }, missingTool: 'ruff', reason: null };
  const survey = { answers: [{ workerId: worker(1), conventions: [], userRules: [], checks: [missing], note: '' }], failure: null, lastBlock: null };
  const flagged = (command: string | null) => ({ kind: 'lint' as const, command, origin: 'setting' as const, layer: 'flag' as const, reason: command === null ? 'dropped by --no-check' : null, source: null });
  const fromFile = (command: string | null) => ({ ...flagged(command), layer: 'repository' as const, reason: command === null ? 'dropped by checks.lint = false in the repository\'s file' : null });

  it('names a --check that stands in for a check the project defines and this machine could not run, and a plain one', () => {
    assert.equal(checkSourceCell(survey, flagged('uvx ruff check .')), '--check, in place of what the project defines `ruff check .` (pyproject.toml), ruff not found');
    assert.equal(checkSourceCell({ ...survey, answers: [] }, flagged('uvx ruff check .')), '--check');
    assert.equal(checkSourceCell(survey, flagged(null)), '--no-check');
    assert.equal(checkSourceCell(survey, { kind: 'test', command: null, origin: 'none', layer: null, reason: 'no tests', source: null }), 'survey: none');
    assert.equal(checkSourceCell(survey, { kind: 'test', command: 'a | b', origin: 'survey', layer: null, reason: null, source: { path: 'ci.yml', quote: 'q', basis: 'hint' } }), 'ci.yml (hint)');
  });

  // R11 of the configuration: a check a setting in a file settled names the setting and the file.
  it('names the setting and its file for a check a configuration file settled', () => {
    assert.equal(checkSourceCell({ ...survey, answers: [] }, fromFile('make lint')), 'checks.lint in the repository\'s file');
    assert.equal(checkSourceCell(survey, fromFile('make lint')), 'checks.lint in the repository\'s file, in place of what the project defines `ruff check .` (pyproject.toml), ruff not found');
    assert.equal(checkSourceCell(survey, fromFile(null)), 'checks.lint = false in the repository\'s file');
    assert.equal(droppedByOperator(survey, fromFile(null)), 'dropped by checks.lint = false in the repository\'s file; the project defines `ruff check .` (pyproject.toml), ruff not found');
    assert.equal(unavailableCell({ ...survey, answers: [] }, fromFile(null)), 'not available (checks.lint = false in the repository\'s file: dropped by checks.lint = false in the repository\'s file)');
  });

  it('says a kind the operator dropped was the project\'s, and of every other kind with no command who decided and why', () => {
    assert.equal(droppedByOperator(survey, flagged(null)), 'dropped by the operator; the project defines `ruff check .` (pyproject.toml), ruff not found');
    assert.equal(droppedByOperator(survey, flagged('x')), null, 'a --check is no drop');
    assert.equal(droppedByOperator(null, flagged(null)), null, 'a run configured before the survey');
    assert.equal(droppedByOperator({ ...survey, answers: [] }, flagged(null)), null, 'a kind dropped before any survey named it');
    assert.equal(unavailableCell(survey, { kind: 'test', command: null, origin: 'none', layer: null, reason: 'no | tests', source: null }), 'not available (none: no \\| tests)');
  });

  it('reads what the project defines for a kind from the latest answer that names it, not an older one that found its tool missing', () => {
    const answer = (checks: SurveyedCheck[]) => ({ workerId: worker(1), conventions: [], userRules: [], checks, note: '' });
    const testMissing: SurveyedCheck = { kind: 'test', command: 'pytest', basis: 'stated', source: { path: 'tox.ini', quote: 'pytest' }, missingTool: 'pytest', reason: null };
    // Answer 1 found ruff missing; the operator installed it, so answer 2 found lint runnable and the test tool missing.
    const resurveyed = { ...survey, answers: [answer([missing]), answer([{ ...missing, missingTool: null }, testMissing])] };
    assert.equal(checkSourceCell(resurveyed, flagged('uvx ruff check .')), '--check', 'the run\'s survey found lint runnable');
    assert.equal(droppedByOperator(resurveyed, flagged(null)), null, 'a lint dropped by choice, not for a missing tool');
    assert.equal(unavailableCell(resurveyed, flagged(null)), 'not available (flag: dropped by --no-check)');
    // A flag settled lint before the re-survey, which left lint out: answer 1 is the latest that names it.
    const settled = { ...survey, answers: [answer([missing]), answer([testMissing])] };
    assert.equal(checkSourceCell(settled, flagged('uvx ruff check .')), '--check, in place of what the project defines `ruff check .` (pyproject.toml), ruff not found');
    assert.equal(droppedByOperator(settled, flagged(null)), 'dropped by the operator; the project defines `ruff check .` (pyproject.toml), ruff not found');
    // The latest answer that names lint found no command for it, so nothing the project defines was stood in for.
    const none = { ...survey, answers: [answer([missing]), answer([{ ...missing, command: null, basis: null, source: null, missingTool: null, reason: 'no linter' }])] };
    assert.equal(checkSourceCell(none, flagged('uvx ruff check .')), '--check');
    assert.equal(droppedByOperator(none, flagged(null)), null);
  });
});

describe('the limitation of a survey that failed', () => {
  /** A fix run's review that went on without its survey, its checks planned by the layers given. */
  const failedWith = (layers: readonly (string | null)[]): Parameters<typeof surveyLimitations>[0] => {
    const review = reported().fold().review!;
    const checks = (['build', 'typecheck', 'lint', 'test'] as const).map((kind, index) => ({ kind, command: `make ${kind}`, origin: 'setting' as const, layer: layers[index] as never, reason: null, source: null }));
    return { ...review, survey: { answers: [], failure: { reason: 'the surveyor failed twice', conventions: [], userRules: [] }, lastBlock: null }, fix: { ...emptyFixState(), checks: { ...emptyFixState().checks, planned: { checks, manager: null }, runs: { 'baseline-checks': [], checks: [], 'base-checks': [], 'repair-checks': [], 'answer-checks': [] } } } };
  };

  it('says every check was the flags\' when flags settled them, and a setting\'s when a configuration file settled one (R11 of the configuration)', () => {
    assert.deepEqual(surveyLimitations(failedWith(['flag', 'flag', 'flag', 'flag'])), ['- The survey failed: the surveyor failed twice. No repository convention source was known, and every check was the flags\'.']);
    assert.deepEqual(surveyLimitations(failedWith(['flag', 'repository', 'flag', 'clone'])), ['- The survey failed: the surveyor failed twice. No repository convention source was known, and every check was a setting\'s.']);
  });
});
