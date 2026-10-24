import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { shortLineLimit } from '../../src/review/brief.ts';
import { fixLines } from '../../src/review/fix-lines.ts';
import { answer, answerableDecisions, decidedFixRun, decisions, passToReport, readOnlyReported } from '../helpers/review-history.ts';

/** The run with the fix pass's answer of RIPPLE-1 changed as `change` says. */
const withRipple = (state: RunState, change: Record<string, unknown>): RunState => {
  const fix = state.review!.fix!;
  const answered = fix.answers.fixes['c1-1']!;
  const findings = answered.findings.map((finding) => (finding.id === 'RIPPLE-1' ? { ...finding, ...change } : finding));
  return { ...state, review: { ...state.review!, fix: { ...fix, answers: { ...fix.answers, fixes: { 'c1-1': { ...answered, findings } } } } } };
};

describe('fixLines (R6 of the questions in the chat)', () => {
  it('gives a fix of the fix pass with what became of it and the subject of its commit message', () => {
    assert.deepEqual(fixLines(decidedFixRun().fold()), ['RIPPLE-1, applied: fix: Guard the null']);
  });

  it('gives a fix an answer pass applied with the subject of that pass\'s message, the answer that gave its last outcome', () => {
    const passed = passToReport(decidedFixRun(answerableDecisions(), 'deferred').add('answer.recorded', answer('SWEEP-1', 1)).add('answer.pass', { ids: ['SWEEP-1'] }), 1, [['SWEEP-1', 'applied']], 1).fold();
    assert.deepEqual(fixLines(passed), ['RIPPLE-1, put off by its fixer: RIPPLE-1 deferred', 'SWEEP-1, applied: fix: Answer SWEEP-1']);
  });

  it('gives the first sentence of the note of an answer with no message, and the words of each fate', () => {
    assert.deepEqual(fixLines(withRipple(decidedFixRun(answerableDecisions(), 'deferred').fold(), { note: 'The fix needs the format of the record. The next change sets it.' })), ['RIPPLE-1, put off by its fixer: The fix needs the format of the record.']);
    assert.deepEqual(fixLines(decidedFixRun(answerableDecisions(), 'blocked').fold()), ['RIPPLE-1, not applied by its fixer: RIPPLE-1 blocked']);
    assert.deepEqual(fixLines(decidedFixRun(answerableDecisions(), 'already-applied').fold()), ['RIPPLE-1, already in the tree: RIPPLE-1 already-applied']);
  });

  it('gives why no fixer attempted a fix with no answer', () => {
    const state = decidedFixRun().fold();
    const fix = state.review!.fix!;
    const unattempted: RunState = { ...state, review: { ...state.review!, fix: { ...fix, answers: { ...fix.answers, fixes: {} }, notAttempted: { ...fix.notAttempted, fixes: { 'c1-1': { cause: 'budget', reason: 'spent 61.00 USD of 60.00 USD' } as never } } } } };
    assert.deepEqual(fixLines(unattempted), ['RIPPLE-1, not attempted: the run budget was reached first: spent 61.00 USD of 60.00 USD']);
  });

  it('cuts a line past 200 characters at a word, and keeps it on one line', () => {
    const [line] = fixLines(withRipple(decidedFixRun().fold(), { message: { subject: `fix: ${'guard the\nnull '.repeat(30)}`, body: 'Why.' } }));
    assert.ok(line!.length <= shortLineLimit && line!.endsWith('...') && !line!.includes('\n'), line!);
  });

  it('names no finding a decision left or asked with a default that keeps the code, which no fixer saw', () => {
    assert.deepEqual(fixLines(decidedFixRun(decisions).fold()), ['RIPPLE-1, applied: fix: Guard the null'], 'SWEEP-1 was left');
  });

  it('says of a fix run that gave no finding to a fixer that it applied no fix, with what it left', () => {
    const state = decidedFixRun(decisions).fold();
    const review = state.review!;
    const fix = review.fix!;
    const leave = review.decisions!.find((decision) => decision.id === 'SWEEP-1')!;
    const allLeft: RunState = {
      ...state,
      review: {
        ...review,
        decisions: review.decisions!.map((decision) => (decision.id === 'RIPPLE-1' ? { ...leave, id: 'RIPPLE-1' } : decision)),
        fix: { ...fix, plan: { ...fix.plan!, routes: fix.plan!.routes.map((route) => ({ ...route, route: 'held' as const })), clusters: [], batches: [] }, answers: { ...fix.answers, fixes: {} } },
      },
    };
    assert.deepEqual(fixLines(allLeft), ['This run gave no finding to a fixer, so it applied no fix. It left 2 findings: RIPPLE-1 and SWEEP-1.']);
  });

  it('says of a run that only reviewed that it changed nothing, with the fixes it decided', () => {
    assert.deepEqual(fixLines(readOnlyReported(answerableDecisions()).fold()), ['This run only reviewed: it changed nothing. It decided to fix 1 finding, which `review --fix` applies: RIPPLE-1.']);
  });
});
