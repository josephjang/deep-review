import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RecordedDecision } from '../../src/checkpoint/events.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { briefMarkdown, briefOf, type Brief } from '../../src/review/brief.ts';
import { shortRunId } from '../../src/review/runs.ts';
import { answer, answerableDecisions, askDecision, decidedFixRun, decisions, departure, readOnlyReported, worker } from '../helpers/review-history.ts';

/** The run with no revision of the fix pass: a fixer reported its fix applied, and the tree held no change of it. */
const withoutRevisions = (state: RunState): RunState => ({ ...state, review: { ...state.review!, fix: { ...state.review!.fix!, revisions: [] } } });

describe('the status of a fix in the brief', () => {
  it('says a fix against a written rule is committed only when a committed patch holds it', () => {
    const departure = (state: RunState): string => briefOf(state).needs.find((need) => need.condition === 'departure')!.lines[0]!;
    assert.equal(departure(withoutRevisions(decidedFixRun().fold())), '**Finding 1 is fixed against a written rule.** The fix is in your working tree.');
  });

  it('counts no open question whose editing default a fixer found already in the tree, so no count goes below zero', () => {
    const state = decidedFixRun([askDecision('RIPPLE-1', true), askDecision('SWEEP-1', false)], 'already-applied').fold();
    const { status } = briefOf(state);
    assert.deepEqual([status.fixed, status.alreadyInTree, status.questions], [0, 0, 2]);
    assert.equal(status.text, `deep-review's fix run ${shortRunId(state.id)} has 2 findings. It fixed no finding. It asks you 2 questions.`);
  });

  it('says no fix of the run went against a written rule when only the one already in the tree did', () => {
    // RIPPLE-1 a plain fix its fixer applied; SWEEP-1 a fix against a written rule that the same fixer found already in the tree.
    const state = decidedFixRun([decisions[0], decisions[1]]).fold();
    const decided = state.review!.decisions!.map((decision) => (decision.id === 'SWEEP-1' ? { ...state.review!.decisions![0]!, id: 'SWEEP-1', departure } : decision)) as RecordedDecision[];
    const fix = state.review!.fix!;
    const answered = fix.answers.fixes['c1-1']!;
    const plan = { ...fix.plan!, routes: fix.plan!.routes.map((route) => ({ ...route, route: 'fixer' as const })), batches: fix.plan!.batches.map((batch) => ({ ...batch, findingIds: ['RIPPLE-1', 'SWEEP-1'] })) };
    const inTree = { ...answered.findings[0]!, id: 'SWEEP-1', status: 'already-applied' as const, message: null, files: [] };
    const both = { ...state, review: { ...state.review!, decisions: decided, fix: { ...fix, plan, answers: { ...fix.answers, fixes: { 'c1-1': { ...answered, findings: [...answered.findings, inTree] } } } } } } as RunState;
    const brief = briefOf(both);
    assert.deepEqual(brief.findings.map((finding) => [finding.id, finding.status]), [['RIPPLE-1', 'fixed'], ['SWEEP-1', 'fixed-against-rule']]);
    assert.deepEqual([brief.status.fixed, brief.status.againstRule, brief.status.alreadyInTree], [1, 0, 1]);
    assert.equal(brief.status.text, `deep-review's fix run ${shortRunId(state.id)} has 2 findings. It fixed 1 in your working tree. It found 1 already fixed in the tree.`);
  });
});

describe('an answer recorded and not applied in the brief', () => {
  const run = (state: RunState): string => shortRunId(state.id);
  const owedItem = (brief: Brief, finding: number): string | undefined => brief.needs.find((need) => need.condition === 'unapplied-fix' && need.finding === finding)?.lines[0];

  it('says an answer to a question that `answer --record-only` recorded on a fix run is not applied, and does not leave the finding as the answer asked', () => {
    // SWEEP-1's default keeps the code; its option 2 edits it, and no answer pass ran.
    const state = decidedFixRun().add('answer.recorded', answer('SWEEP-1', 1)).fold();
    assert.equal(state.review!.answers[0]!.appliedBy, null);
    const brief = briefOf(state);
    assert.equal(brief.findings[1]!.status, 'not-fixed');
    assert.equal(brief.status.text, `deep-review's fix run ${run(state)} has 2 findings. It fixed 1 in your working tree, against a written rule. It has not yet applied your answers to finding 2 and did not fix 1.`);
    assert.deepEqual(brief.status.answered, []);
    assert.equal(brief.leftAs, null, 'not "your answer keeps the code as it is"');
    assert.match(owedItem(brief, 2) ?? '', new RegExp(`no answer pass applied it yet, and \`deep-review answer --run ${run(state)} --finding 2 --option 2\` applies it`));
    assert.doesNotMatch(brief.needsLine, /^Nothing needs you/);
  });

  it('says a rejection of an applied fix against a written rule that no pass applied is not applied', () => {
    const state = decidedFixRun().add('answer.recorded', answer('RIPPLE-1', 'reject')).fold();
    const brief = briefOf(state);
    assert.equal(brief.findings[0]!.status, 'fixed', 'the fixer\'s fix is still in the tree');
    assert.equal(brief.status.text, `deep-review's fix run ${run(state)} has 2 findings. It fixed 1 in your working tree. It asks you 1 question and has not yet applied your answers to finding 1.`);
    assert.match(owedItem(brief, 1) ?? '', new RegExp(`no answer pass applied it yet, and \`deep-review answer --run ${run(state)} --finding 1 --reject\` applies it`));
  });

  it('follows an answer the tree holds, and in a run that only reviewed, every answer', () => {
    const held = briefOf(decidedFixRun().add('answer.recorded', answer('RIPPLE-1', 'accept')).fold());
    assert.deepEqual(held.status.answered, [1]);
    assert.equal(owedItem(held, 1), undefined);
    const planned = readOnlyReported(answerableDecisions()).add('answer.recorded', answer('SWEEP-1', 1)).fold();
    const brief = briefOf(planned);
    assert.deepEqual(brief.status.answered, [2]);
    assert.match(brief.status.text, /It follows your answers to finding 2\.$/);
    assert.equal(owedItem(brief, 2), undefined);
  });
});

describe('the default a fixer applied to an open question in the brief', () => {
  it('gives it a row of what deep-review fixed, marked as the default of a question, and names it in the status line, still counted as a question', () => {
    // RIPPLE-1 asks with a default that edits the code, so a fixer applied it; nobody answered.
    const state = decidedFixRun([askDecision('RIPPLE-1', true), askDecision('SWEEP-1', false)]).fold();
    const brief = briefOf(state);
    assert.equal(brief.findings[0]!.status, 'question');
    assert.deepEqual(brief.fixes.map((fix) => [fix.finding, fix.subject, fix.patches]), [[1, 'fix: Guard the null', [1]]]);
    assert.equal(brief.status.text, `deep-review's fix run ${shortRunId(state.id)} has 2 findings. It fixed no finding. It asks you 2 questions and applied the default of finding 1.`);
    const lines = briefMarkdown(brief);
    assert.equal(lines.at(-1), '| [1](#finding-1), major, the default of a question | fix: Guard the null | none reported | 1 |');
    assert.ok(!lines.includes('deep-review fixed no finding.'));
  });

  it('gives no row to an open question whose default no fixer applied', () => {
    const brief = briefOf(decidedFixRun([askDecision('RIPPLE-1', true), askDecision('SWEEP-1', false)], 'blocked').fold());
    assert.deepEqual(brief.fixes, []);
    assert.doesNotMatch(brief.status.text, /applied the default/);
  });
});

describe('the fixes a run that only reviewed would apply in the brief', () => {
  it('counts a question answered with an option that edits among them, in the status line, the count line, the item and the table alike', () => {
    // RIPPLE-1 a decided fix; SWEEP-1 a question the person answered with option 2, which edits the code.
    const state = readOnlyReported([decisions[0], askDecision('SWEEP-1', false)]).add('answer.recorded', answer('SWEEP-1', 1)).fold();
    const brief = briefOf(state);
    assert.deepEqual(brief.findings.map((finding) => finding.status), ['planned', 'planned']);
    assert.equal(brief.status.toFix, 2);
    assert.match(brief.status.text, /It would fix 2\./);
    assert.match(brief.needsLine, /2 fixes to apply/);
    assert.match(brief.needs.find((need) => need.rank === 8)!.lines[0]!, /^\*\*Apply the 2 fixes that deep-review decided\.\*\*/);
    assert.deepEqual(brief.fixes.map((fix) => [fix.finding, fix.subject]), [[1, 'guard the null once, before parse reads it'], [2, 'accept it and return an empty result']]);
  });
});

describe('the items of what needs you in the brief', () => {
  it('indents the lines under an item by the width of its number, so item 10 keeps its options and commands', () => {
    const brief = briefOf(decidedFixRun().fold());
    const needs = Array.from({ length: 10 }, (_, index) => ({ rank: 1 as const, condition: 'edits' as const, finding: null, check: null, document: null, patch: null, lines: [`Lead ${String(index + 1)}.`, `Under ${String(index + 1)}.`] }));
    const lines = briefMarkdown({ ...brief, needs });
    assert.deepEqual(lines.slice(lines.indexOf('9. Lead 9.'), lines.indexOf('9. Lead 9.') + 4), ['9. Lead 9.', '   - Under 9.', '10. Lead 10.', '    - Under 10.']);
  });
});

describe('a fix whose fixer did not finish in the brief', () => {
  /** The run whose one fixer, of RIPPLE-1, left an attempt's edits and gave no answer, its retry stopped as `cause` says. */
  const lost = (cause: 'budget' | 'failures' | null): Brief => {
    const state = decidedFixRun([decisions[0], decisions[1]]).fold();
    const fix = state.review!.fix!;
    const attempt = { ...fix.revisions[0]!, source: { kind: 'attempt' as const, key: 'c1-1', workerId: worker(60) } };
    const notAttempted = cause === null ? fix.notAttempted : { ...fix.notAttempted, fixes: { 'c1-1': { cause, reason: 'spent 31 USD of 30 USD' } } };
    return briefOf({ ...state, review: { ...state.review!, fix: { ...fix, revisions: [attempt], answers: { ...fix.answers, fixes: {} }, notAttempted } } } as RunState);
  };
  const unapplied = (brief: Brief): string | undefined => brief.needs.find((need) => need.condition === 'unapplied-fix')?.lines[0];

  it('says its fixer did not finish and the run budget stopped another attempt, not that the budget stopped the fixes before it', () => {
    const brief = lost('budget');
    assert.deepEqual(brief.needs.filter((need) => need.rank === 4).map((need) => [need.condition, need.finding]), [['unfinished-edits', 1], ['unapplied-fix', 1]]);
    assert.equal(unapplied(brief), '**Finding 1 is not fixed: its fixer did not finish, and the run budget stopped another attempt; the end of the report gives the command that continues the fixes.** If you do nothing, the finding stays as it is.');
  });

  it('says its fixer did not finish when a second failure stopped another attempt, or nothing did, never that no fixer attempted it', () => {
    assert.match(unapplied(lost('failures')) ?? '', /: its fixer did not finish, and a second failure stopped another attempt\.\*\*/);
    assert.match(unapplied(lost(null)) ?? '', /: its fixer did not finish\.\*\*/);
  });

  it('names the finding once in the item that names the unfinished work past the cap', () => {
    const brief = lost('budget');
    const documents = Array.from({ length: 3 }, (_, index) => ({ rank: 4 as const, condition: 'document' as const, finding: null, check: null, document: `docs/${String(index)}.md`, patch: null, lines: [`**\`docs/${String(index)}.md\` is out of date.**`] }));
    const lines = briefMarkdown({ ...brief, needs: [...documents, ...brief.needs] });
    assert.ok(lines.includes('4. **2 more:** finding 1.'), lines.join('\n'));
  });
});
