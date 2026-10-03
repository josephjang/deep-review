import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { renderReport } from '../../src/review/report.ts';
import { checkUnavailableBlocker } from '../../src/review/steps.ts';
import { checkSourceCell, droppedByOperator, unavailableCell } from '../../src/review/survey-report.ts';
import { History, fixRun, fixStatistics, reported, statistics, withSurvey, worker } from '../helpers/review-history.ts';

const snapshotPath = resolve(import.meta.dirname, '../fixtures/reports/survey.md');
const evidencePath = (blob: { sha256: string; bytes: number }): string => `/evidence/${blob.sha256.slice(0, 8)}`;
const patches = ['/evidence/patch-1', '/evidence/patch-2', '/evidence/patch-3'];

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
    .finish('survey', 'blocked', 1, checkUnavailableBlocker([{ kind: 'typecheck', command: 'npx tsc --noEmit', source: '.github/workflows/ci.yml', missingTool: 'tsc' }]))
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
  const render = (state: RunState = surveyedFixRun().fold()): string => renderReport(state, { engine: '0.0.0+dev', statistics: surveyStatistics, fix: { evidencePath, patches } });

  it('renders exactly as the committed snapshot, which a person read once in review', () => {
    assert.equal(render(), readFileSync(snapshotPath, 'utf8'), `the report changed; if on purpose, write the new text to ${snapshotPath}`);
  });

  it('places Conventions after Angles and before Findings, and gives the survey its row in the statistics', () => {
    const report = render();
    const order = ['## Angles', '## Conventions', '## Findings', '## Fixes', '## Checks'].map((heading) => report.indexOf(`\n${heading}\n`));
    assert.ok(order.every((position) => position > 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(report, /^\| survey \| 1 \| 20\.0 \| 0\.30 \| 500 \| 100 \| 50 \|$/m);
  });

  it('lists each source with its level, what it governs and what it applies to, each user-level decision with its reason, and the surveyor\'s note (R10)', () => {
    const report = render();
    assert.match(report, /^The survey named these files as stating the conventions the change was held to:\n\n\| Source \| Level \| Governs \| Applies to \|$/m);
    assert.match(report, /^\| CONTRIBUTING\.md \| repository \| code style, tests and commit messages \| the whole repository \|$/m);
    assert.match(report, /^\| src\/AGENTS\.md \| repository \| how the sources are commented \| src\/\*\* \|$/m);
    assert.ok(report.includes(`| ${userRules} | user: src/AGENTS.md imports it | the reviewer's engineering rules | the whole repository |`), report);
    assert.ok(report.includes(`The reviewer's own rules files, under the policy value \`judge\`:\n\n- ${otherRules}: not applied, nothing in the repository refers to it\n- ${userRules}: applied, src/AGENTS.md imports it`), report);
    assert.match(report, /^Surveyor's note: CONTRIBUTING\.md links to a style guide outside the repository$/m);
  });

  it('names each check\'s source, and of a kind the operator dropped after its tool was missing what the project defines (R10, R15)', () => {
    const report = render();
    assert.match(report, /^\| Check \| Command \| Source \| Before the fixes \| After the fixes \| After the repair \|$/m);
    assert.match(report, /^\| build \| npm run build \| package\.json \(hint\) \| passed/m);
    assert.match(report, /^\| typecheck \| dropped by the operator; the project defines `npx tsc --noEmit` \(\.github\/workflows\/ci\.yml\), tsc not found \| --no-check \| - \| - \| - \|$/m);
    assert.match(report, /^\| lint \| npm run lint \| \.github\/workflows\/ci\.yml \(stated\) \| passed/m);
    assert.match(report, /^\| test \| npm run test \| --check \| failed/m);
    assert.match(report, /^- Checks not available: typecheck \(dropped by the operator; the project defines `npx tsc --noEmit` \(\.github\/workflows\/ci\.yml\), tsc not found\)\.$/m);
  });

  it('says the survey failed, and that CONVENTIONS had no rule, in a read-only run without a source', () => {
    const failed = withSurvey(withoutConventionsFinder(reported()), (history) => history.start('survey').add('survey.failed', { reason: '2 attempts did not complete: timeout', conventions: [], userRules: [] }).finish('survey', 'degraded'));
    const report = renderReport(failed.fold(), { engine: '0.0.0+dev', statistics });
    assert.match(report, /^## Conventions\n\nThe survey failed: 2 attempts did not complete: timeout\. The run went on with no convention source\.\n\nNo user-level rules file of the reviewer's existed on this machine; the policy value was `judge`\.$/m);
    assert.match(report, /^- The survey failed: 2 attempts did not complete: timeout\. No repository convention source was known\.$/m);
    assert.match(report, /^- Angle CONVENTIONS did not run: the survey failed, so no convention source is known: 2 attempts did not complete: timeout\./m);
    const none = withSurvey(reported(), (history) => history.start('survey').worker(80, 'surveyor survey:survey').add('survey.recorded', { workerId: worker(80), conventions: [], userRules: [], checks: null, note: '' }).finish('survey'));
    assert.match(renderReport(none.fold(), { engine: '0.0.0+dev', statistics }), /^## Conventions\n\nThe survey found no file that states conventions a change here must follow, so CONVENTIONS had no rule to hold the change to\.$/m);
  });

  it('renders a run configured before the survey existed with no Conventions section and no Source column, as it did', () => {
    const older = renderReport(fixRun().fold(), { engine: '0.0.0+dev', statistics: fixStatistics, fix: { evidencePath, patches } });
    assert.ok(!older.includes('## Conventions'));
    assert.match(older, /^\| Check \| Command \| Before the fixes \|/m);
  });
});

describe('the Checks table of a surveyed run', () => {
  const missing = { kind: 'lint' as const, command: 'ruff check .', basis: 'stated' as const, source: { path: 'pyproject.toml', quote: 'ruff' }, missingTool: 'ruff', reason: null };
  const survey = { answers: [{ workerId: worker(1), conventions: [], userRules: [], checks: [missing], note: '' }], failure: null, lastBlock: null };
  const flagged = (command: string | null) => ({ kind: 'lint' as const, command, origin: 'flag' as const, reason: command === null ? 'dropped by --no-check' : null, source: null });

  it('names a --check that stands in for a check the project defines and this machine could not run, and a plain one', () => {
    assert.equal(checkSourceCell(survey, flagged('uvx ruff check .')), '--check, in place of what the project defines `ruff check .` (pyproject.toml), ruff not found');
    assert.equal(checkSourceCell({ ...survey, answers: [] }, flagged('uvx ruff check .')), '--check');
    assert.equal(checkSourceCell(survey, flagged(null)), '--no-check');
    assert.equal(checkSourceCell(survey, { kind: 'test', command: null, origin: 'none', reason: 'no tests', source: null }), 'survey: none');
    assert.equal(checkSourceCell(survey, { kind: 'test', command: 'a | b', origin: 'survey', reason: null, source: { path: 'ci.yml', quote: 'q', basis: 'hint' } }), 'ci.yml (hint)');
  });

  it('says a kind the operator dropped was the project\'s, and of every other kind with no command who decided and why', () => {
    assert.equal(droppedByOperator(survey, flagged(null)), 'dropped by the operator; the project defines `ruff check .` (pyproject.toml), ruff not found');
    assert.equal(droppedByOperator(survey, flagged('x')), null, 'a --check is no drop');
    assert.equal(droppedByOperator(null, flagged(null)), null, 'a run configured before the survey');
    assert.equal(droppedByOperator({ ...survey, answers: [] }, flagged(null)), null, 'a kind dropped before any survey named it');
    assert.equal(unavailableCell(survey, { kind: 'test', command: null, origin: 'none', reason: 'no | tests', source: null }), 'not available (none: no \\| tests)');
  });
});
