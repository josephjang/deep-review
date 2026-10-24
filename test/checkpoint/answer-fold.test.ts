import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { owedAnswers, passKey, standingAnswer } from '../../src/checkpoint/answer-state.ts';
import { admits, treeHolds } from '../../src/checkpoint/answer-fold.ts';
import { InvalidHistoryError } from '../../src/checkpoint/errors.ts';
import { applyEvent, type DecodedEvent } from '../../src/checkpoint/fold.ts';
import type { RecordedDecision } from '../../src/checkpoint/events.ts';
import { reviewStatus } from '../../src/review/state.ts';
import type { History } from '../helpers/review-history.ts';
import {
  answer,
  answerableDecisions,
  askDecision,
  checkRun,
  decidedFixRun,
  decisions,
  departure,
  endCheck,
  passAnswer,
  passToReport,
  readOnlyReported,
  reference,
  reported,
  statistics,
  worker,
} from '../helpers/review-history.ts';

/** Whether folding the history throws the invalid history whose message matches. */
const refuses = (history: History, message: RegExp): void => {
  assert.throws(() => history.fold(), (error: unknown) => error instanceof InvalidHistoryError && message.test(error.message), message.source);
};

/** The decided fix run of these tests: RIPPLE-1 a fix departing from a rule, applied by c1-1; SWEEP-1 an ask whose default keeps the code. */
const fixRun = (): History => decidedFixRun();

/** RIPPLE-1 decided as an ask whose default edits the code, applied by c1-1 as `status` says; SWEEP-1 an ask that keeps it. */
const editingAskRun = (status = 'applied'): History => decidedFixRun(answerableDecisions(askDecision('RIPPLE-1', true)), status);

/**
 * The answer pass `n` over `id`, open on `history`, to its report, leaving
 * edits of src/a.ts that apply no answer: with `left` `attempt`, a first
 * fixer fails after revising for `id`, or with `unnamed` for no finding,
 * and its retry answers `status`; with `fix`, the one fixer answers
 * `status` and revises for `id` all the same. The checks run once more,
 * and the report has `patches`, one per revision of the run.
 */
function editsLeft(history: History, n: number, id: string, left: 'attempt' | 'unnamed' | 'fix', status: string, patches: number): History {
  const key = passKey(n);
  const revision = (source: Record<string, unknown>, findings: readonly string[]): Record<string, unknown> => ({
    phase: 'answer',
    source,
    change: { findings, message: { subject: `fix: Answer ${id} in part`, body: 'The fixer stopped short.' } },
    files: [{ path: 'src/a.ts', status: 'modified', before: { blob: reference('f') }, beforeSymlink: false, symlink: false, after: { blob: reference('8') } }],
  });
  history.start('answer', n);
  if (left !== 'fix') {
    history.worker(80 + 2 * n, `fixer answer:${key}`)
      .add('attempt.failed', { phase: 'answer', key, workerId: worker(80 + 2 * n), reason: 'timeout', fault: 'unit' }, 6)
      .add('tree.revised', revision({ kind: 'attempt', key, workerId: worker(80 + 2 * n) }, left === 'attempt' ? [id] : []), 2);
  }
  history.worker(81 + 2 * n, `fixer answer:${key}`).add('fix.recorded', passAnswer(worker(81 + 2 * n), n, [[id, status]]), 2);
  if (left === 'fix') history.add('tree.revised', revision({ kind: 'fix', key, workerId: worker(81 + 2 * n) }, [id]), 2);
  history.add('worktree.checked', endCheck('answer', n), 5).finish('answer', 'completed', n).start('answer-checks', n);
  for (const kind of ['build', 'lint', 'test']) history.add('check.ran', checkRun('answer-checks', kind, 'passed', n), 2);
  return history.finish('answer-checks', 'completed', n)
    .start('report', n + 1)
    .add('report.written', { report: reference(String(n), 4096 + n), statistics, patches: Array.from({ length: patches }, (_, index) => reference(String.fromCharCode(97 + index))) }, 5)
    .finish('report', 'completed', n + 1);
}

const rippleFix = { ...decisions[0], departure } as unknown as RecordedDecision;
const plainFix = decisions[0] as unknown as RecordedDecision;
const leave = decisions[1] as unknown as RecordedDecision;
const keepingAsk = askDecision('SWEEP-1', false) as unknown as RecordedDecision;

describe('admits (R3 of answers)', () => {
  it('admits an option among an ask\'s, and accept or reject on a fix that departs from a rule', () => {
    assert.equal(admits(keepingAsk, { kind: 'option', option: 0 }), true);
    assert.equal(admits(keepingAsk, { kind: 'option', option: 1 }), true);
    assert.equal(admits(rippleFix, { kind: 'accept' }), true);
    assert.equal(admits(rippleFix, { kind: 'reject' }), true);
  });

  it('admits nothing on a leave or a fix that departs from nothing, no option past the ask\'s and no option on a departure, nor accept on an ask', () => {
    for (const given of [{ kind: 'option', option: 0 }, { kind: 'accept' }, { kind: 'reject' }] as const) {
      assert.equal(admits(leave, given), false, `a leave, ${given.kind}`);
      assert.equal(admits(plainFix, given), false, `a fix without a departure, ${given.kind}`);
    }
    assert.equal(admits(keepingAsk, { kind: 'option', option: 2 }), false, 'past the two options');
    assert.equal(admits(rippleFix, { kind: 'option', option: 0 }), false);
    assert.equal(admits(keepingAsk, { kind: 'accept' }), false);
    assert.equal(admits(keepingAsk, { kind: 'reject' }), false);
  });
});

describe('answer.recorded (R1, R3 of answers)', () => {
  it('records an answer on a complete run with when it was recorded, and moves nothing', () => {
    const before = fixRun();
    const after = before.clone().add('answer.recorded', answer('SWEEP-1', 1, 'the empty input is real'));
    const was = before.review();
    const review = after.review();
    assert.deepEqual(review.answers, [{ id: 'SWEEP-1', answer: { kind: 'option', option: 1 }, note: 'the empty input is real', at: after.events.at(-1)!.recordedAt, appliedBy: null }]);
    assert.deepEqual(review.phases, was.phases, 'no phase moves');
    assert.deepEqual(review.report, was.report, 'the report stands');
    assert.equal(reviewStatus(after.fold()), 'complete', 'the run is still complete');
    assert.deepEqual(standingAnswer(review, 'SWEEP-1')?.answer, { kind: 'option', option: 1 });
    assert.equal(standingAnswer(review, 'RIPPLE-1'), null);
  });

  it('keeps every answer, the last one of a finding standing', () => {
    const review = fixRun().add('answer.recorded', answer('SWEEP-1', 1)).add('answer.recorded', answer('RIPPLE-1', 'reject')).add('answer.recorded', answer('SWEEP-1', 0)).review();
    assert.equal(review.answers.length, 3);
    assert.deepEqual(standingAnswer(review, 'SWEEP-1')?.answer, { kind: 'option', option: 0 });
    assert.deepEqual(owedAnswers(review).map((owed) => owed.id), ['RIPPLE-1'], 'option 0, the default that keeps the code, owes nothing; the rejection does');
  });

  it('records an answer on a read-only run, whose continuation applies it', () => {
    const review = readOnlyReported(answerableDecisions()).add('answer.recorded', answer('SWEEP-1', 1)).review();
    assert.equal(review.fix, null);
    assert.equal(review.answers.length, 1);
  });

  const refusals: [name: string, build: () => History, message: RegExp][] = [
    ['an answer before the report', () => {
      const history = fixRun();
      history.events.splice(history.events.findIndex((event) => event.kind === 'report.written'));
      return history.add('answer.recorded', answer('SWEEP-1', 1));
    }, /records an answer while its report is not written/],
    ['an answer to a finding the run did not decide', () => fixRun().add('answer.recorded', answer('SCAN-9', 0)), /answers SCAN-9, which the run did not decide/],
    ['an answer on a run configured before the decision step', () => reported().add('answer.recorded', answer('SWEEP-1', 0)), /answers SWEEP-1, which the run did not decide/],
    ['an answer to a leave', () => decidedFixRun([{ ...decisions[0], departure }, decisions[1]]).add('answer.recorded', answer('SWEEP-1', 'accept')), /answers SWEEP-1 accepted, which its leave decision does not admit/],
    ['an acceptance of a fix that departs from nothing', () => decidedFixRun(answerableDecisions(decisions[0] as Record<string, unknown>)).add('answer.recorded', answer('RIPPLE-1', 'accept')), /answers RIPPLE-1 accepted, which its fix decision does not admit/],
    ['an option on a departure', () => fixRun().add('answer.recorded', answer('RIPPLE-1', 0)), /answers RIPPLE-1 option 1, which its fix decision does not admit/],
    ['an acceptance of an ask', () => fixRun().add('answer.recorded', answer('SWEEP-1', 'accept')), /answers SWEEP-1 accepted, which its ask decision does not admit/],
    ['an option past the ask\'s', () => fixRun().add('answer.recorded', answer('SWEEP-1', 2)), /answers SWEEP-1 option 3, which its ask decision does not admit/],
    ['the standing answer again', () => fixRun().add('answer.recorded', answer('SWEEP-1', 1)).add('answer.recorded', answer('SWEEP-1', 1, 'again, with a note')), /answers SWEEP-1 option 2, its standing answer, again/],
  ];
  for (const [name, build, message] of refusals) {
    it(`refuses ${name}`, () => refuses(build(), message));
  }

  it('refuses an answer on an abandoned run', () => {
    const state = fixRun().add('run.abandoned', { reason: 'done' }).fold();
    const event: DecodedEvent = { sequence: state.lastSequence + 1, runId: state.id, kind: 'answer.recorded', version: 1, payload: answer('SWEEP-1', 1), recordedAt: '2026-10-12T00:00:00.000Z', engine: '0.0.0' };
    assert.throws(() => applyEvent(state, event), (error: unknown) => error instanceof InvalidHistoryError && /records an answer on a run that is abandoned/.test(error.message));
  });
});

describe('what the tree holds when an answer is recorded (R3 of answers, PD6, PD12)', () => {
  const appliedBy = (history: History, id: string): unknown => standingAnswer(history.review(), id)?.appliedBy;

  it('holds the default an ask applied when it keeps the code, and no other option', () => {
    assert.equal(appliedBy(fixRun().add('answer.recorded', answer('SWEEP-1', 0)), 'SWEEP-1'), 'tree');
    assert.equal(appliedBy(fixRun().add('answer.recorded', answer('SWEEP-1', 1)), 'SWEEP-1'), null);
    assert.equal(appliedBy(readOnlyReported(answerableDecisions()).add('answer.recorded', answer('SWEEP-1', 0)), 'SWEEP-1'), 'tree', 'a read-only run holds a default that keeps the code too');
  });

  it('holds an editing default only once a fixes-phase fixer made its edit', () => {
    assert.equal(appliedBy(editingAskRun('applied').add('answer.recorded', answer('RIPPLE-1', 0)), 'RIPPLE-1'), 'tree');
    assert.equal(appliedBy(editingAskRun('deferred').add('answer.recorded', answer('RIPPLE-1', 0)), 'RIPPLE-1'), null, 'a fixer that deferred made no edit');
    assert.equal(appliedBy(readOnlyReported(answerableDecisions(askDecision('RIPPLE-1', true))).add('answer.recorded', answer('RIPPLE-1', 0)), 'RIPPLE-1'), null, 'a read-only run has not applied it');
    assert.equal(appliedBy(editingAskRun('applied').add('answer.recorded', answer('RIPPLE-1', 1)), 'RIPPLE-1'), null);
  });

  it('holds no option but the default, even one that keeps the code where no fixer edited the finding', () => {
    const editing = askDecision('RIPPLE-1', true) as { ask: { options: Record<string, unknown>[] } };
    const keepingOther = { ...editing, ask: { ...editing.ask, options: [editing.ask.options[0], { ...editing.ask.options[1], edits: false }] } } as unknown as RecordedDecision;
    const keeps = { kind: 'option', option: 1 } as const;
    assert.equal(treeHolds(readOnlyReported(answerableDecisions(askDecision('RIPPLE-1', true))).review(), keepingOther, keeps), false, 'a read-only run');
    assert.equal(treeHolds(editingAskRun('deferred').review(), keepingOther, keeps), false, 'a fix run whose fixer deferred the default');
  });

  it('holds an acceptance once a fixes-phase fixer made the departing fix, and never a rejection', () => {
    assert.equal(appliedBy(fixRun().add('answer.recorded', answer('RIPPLE-1', 'accept')), 'RIPPLE-1'), 'tree');
    assert.equal(appliedBy(decidedFixRun(answerableDecisions(), 'blocked').add('answer.recorded', answer('RIPPLE-1', 'accept')), 'RIPPLE-1'), null, 'a blocked fixer made no fix');
    assert.equal(appliedBy(readOnlyReported(answerableDecisions()).add('answer.recorded', answer('RIPPLE-1', 'accept')), 'RIPPLE-1'), null, 'a read-only run made no fix');
    assert.equal(appliedBy(fixRun().add('answer.recorded', answer('RIPPLE-1', 'reject')), 'RIPPLE-1'), null);
  });

  it('holds, after a pass applied an answer, that answer alone: an acceptance after an applied rejection owes an edit', () => {
    const rejected = passToReport(fixRun().add('answer.recorded', answer('RIPPLE-1', 'reject')).add('answer.pass', { ids: ['RIPPLE-1'] }), 1, [['RIPPLE-1', 'applied']], 2);
    assert.deepEqual(appliedBy(rejected, 'RIPPLE-1'), { phase: 'answer', key: 'pass-1' });
    assert.equal(appliedBy(rejected.clone().add('answer.recorded', answer('RIPPLE-1', 'accept')), 'RIPPLE-1'), null, 'the tree holds the rejection now');
  });

  it('holds, after a pass applied another option, that option again but no longer the default', () => {
    const chosen = passToReport(fixRun().add('answer.recorded', answer('SWEEP-1', 1)).add('answer.pass', { ids: ['SWEEP-1'] }), 1, [['SWEEP-1', 'applied']], 2);
    const back = chosen.clone().add('answer.recorded', answer('SWEEP-1', 0));
    assert.equal(appliedBy(back, 'SWEEP-1'), null, 'the default it applied first is in the tree no more');
    assert.equal(appliedBy(back.clone().add('answer.recorded', answer('SWEEP-1', 1)), 'SWEEP-1'), 'tree', 'the option the pass applied is what the tree holds');
  });

  it('holds nothing an answer pass left edits for without applying its answer: the default and an applied answer owe an edit again', () => {
    const open = editingAskRun('applied').add('answer.recorded', answer('RIPPLE-1', 1)).add('answer.pass', { ids: ['RIPPLE-1'] });
    for (const left of ['attempt', 'unnamed', 'fix'] as const) {
      const partial = editsLeft(open.clone(), 1, 'RIPPLE-1', left, 'deferred', 2);
      assert.equal(appliedBy(partial.add('answer.recorded', answer('RIPPLE-1', 0)), 'RIPPLE-1'), null, `the default the fixes phase applied, after the pass's ${left} edits`);
    }
    const chosen = passToReport(fixRun().add('answer.recorded', answer('SWEEP-1', 1)).add('answer.pass', { ids: ['SWEEP-1'] }), 1, [['SWEEP-1', 'applied']], 2);
    const partial = editsLeft(chosen.add('answer.recorded', answer('SWEEP-1', 0)).add('answer.pass', { ids: ['SWEEP-1'] }), 2, 'SWEEP-1', 'attempt', 'blocked', 3);
    assert.equal(appliedBy(partial.add('answer.recorded', answer('SWEEP-1', 1)), 'SWEEP-1'), null, 'the option pass-1 applied, after pass-2 left edits for the default');
  });

  it('holds an answer again once a later pass made its edit over what an earlier pass left', () => {
    const partial = editsLeft(editingAskRun('applied').add('answer.recorded', answer('RIPPLE-1', 1)).add('answer.pass', { ids: ['RIPPLE-1'] }), 1, 'RIPPLE-1', 'attempt', 'deferred', 2);
    const verified = passToReport(partial.add('answer.pass', { ids: ['RIPPLE-1'] }), 2, [['RIPPLE-1', 'already-applied']], 2);
    assert.deepEqual(appliedBy(verified, 'RIPPLE-1'), { phase: 'answer', key: 'pass-2' });
    const back = verified.add('answer.recorded', answer('RIPPLE-1', 0));
    assert.equal(appliedBy(back, 'RIPPLE-1'), null);
    assert.equal(appliedBy(back.add('answer.recorded', answer('RIPPLE-1', 1)), 'RIPPLE-1'), 'tree', 'the option pass-2 found applied');
  });

  it('reads the same through treeHolds as the fold records it', () => {
    const review = fixRun().review();
    assert.equal(treeHolds(review, keepingAsk, { kind: 'option', option: 0 }), true);
    assert.equal(treeHolds(review, keepingAsk, { kind: 'option', option: 1 }), false);
    assert.equal(treeHolds(review, rippleFix, { kind: 'accept' }), true);
    assert.equal(treeHolds(review, rippleFix, { kind: 'reject' }), false);
  });
});

describe('answer.pass (R5 of answers)', () => {
  const answered = (): History => fixRun().add('answer.recorded', answer('SWEEP-1', 1)).add('answer.recorded', answer('RIPPLE-1', 'reject'));

  it('opens the answer pass\'s phases and the report again, each at its attempt, and keeps the report it replaces', () => {
    const before = answered();
    const was = before.review();
    const history = before.clone().add('answer.pass', { ids: ['RIPPLE-1', 'SWEEP-1'] });
    const review = history.review();
    assert.deepEqual(review.phases.answer, { status: 'pending', attempt: 0 });
    assert.deepEqual(review.phases['answer-checks'], { status: 'pending', attempt: 0 });
    assert.deepEqual(review.phases.report, { status: 'pending', attempt: 1 }, 'the report starts its next attempt');
    assert.equal(review.report, null);
    assert.equal(review.reportSetAsideBy, 'answer-pass');
    assert.deepEqual(review.answerPasses, [{ ids: ['RIPPLE-1', 'SWEEP-1'], at: history.events.at(-1)!.recordedAt, reportBefore: was.report, openedAt: { answer: 0, checks: 0 } }]);
    assert.equal(reviewStatus(history.fold()), 'active', 'the run is active again, so review resumes it');
    for (const phase of ['fixes', 'checks', 'repair', 'decision'] as const) assert.deepEqual(review.phases[phase], was.phases[phase], `${phase} stays as it finished`);
    assert.doesNotThrow(() => history.clone().start('answer').fold(), 'the answer phase starts at its next attempt');
  });

  it('records the pass\'s fixer under its key, marks each answer it applied, and is complete again after the next report', () => {
    const history = passToReport(answered().add('answer.pass', { ids: ['RIPPLE-1', 'SWEEP-1'] }), 1, [['RIPPLE-1', 'applied'], ['SWEEP-1', 'deferred']], 2);
    const review = history.review();
    assert.equal(reviewStatus(history.fold()), 'complete');
    assert.equal(review.reportSetAsideBy, null, 'the next report is current');
    assert.deepEqual(standingAnswer(review, 'RIPPLE-1')?.appliedBy, { phase: 'answer', key: passKey(1) });
    assert.equal(standingAnswer(review, 'SWEEP-1')?.appliedBy, null, 'a deferred answer is still owed, for the next pass');
    assert.equal(review.fix?.answers.answer['pass-1']?.findings.length, 2);
    assert.equal(review.fix?.revisions.at(-1)?.phase, 'answer');
    assert.deepEqual(review.phases.report, { status: 'completed', attempt: 2 });
    assert.equal(review.fix?.checks.runs['answer-checks'].length, 3);
  });

  it('opens a second pass after the first one\'s report, at the attempts the first left, and runs every check once more', () => {
    const first = passToReport(answered().add('answer.pass', { ids: ['RIPPLE-1', 'SWEEP-1'] }), 1, [['RIPPLE-1', 'applied'], ['SWEEP-1', 'deferred']], 2);
    const second = first.clone().add('answer.pass', { ids: ['SWEEP-1'] });
    assert.deepEqual(second.review().answerPasses[1]?.openedAt, { answer: 1, checks: 1 });
    const done = passToReport(second, 2, [['SWEEP-1', 'applied']], 3);
    const review = done.review();
    assert.deepEqual(standingAnswer(review, 'SWEEP-1')?.appliedBy, { phase: 'answer', key: 'pass-2' });
    assert.equal(review.fix?.checks.runs['answer-checks'].length, 6, 'each pass ran the three checks');
    assert.equal(review.answerPasses.length, 2);
    assert.deepEqual(review.answerPasses[1]?.reportBefore.report, reference('1', 4097), 'the second pass keeps the first pass\'s report');
  });

  it('refuses a check run twice in one pass', () => {
    const open = answered().add('answer.pass', { ids: ['RIPPLE-1', 'SWEEP-1'] }).start('answer').add('answer.recorded', answer('SWEEP-1', 0));
    refuses(open, /records an answer while its report is not written/);
    const checks = answered().add('answer.pass', { ids: ['RIPPLE-1'] }).start('answer').finish('answer').start('answer-checks').add('check.ran', checkRun('answer-checks', 'build'), 2);
    refuses(checks.add('check.ran', checkRun('answer-checks', 'build'), 2), /runs the build check twice in answer-checks for one answer pass/);
  });

  const refusals: [name: string, build: () => History, message: RegExp][] = [
    ['a pass on a read-only run', () => readOnlyReported(answerableDecisions()).add('answer.recorded', answer('SWEEP-1', 1)).add('answer.pass', { ids: ['SWEEP-1'] }), /opens an answer pass on a run that does not fix/],
    ['a pass before the report', () => {
      const history = fixRun();
      history.events.splice(history.events.findIndex((event) => event.kind === 'report.written'));
      return history.add('answer.pass', { ids: ['SWEEP-1'] });
    }, /opens an answer pass while its report is not written/],
    ['a pass over an unanswered finding', () => fixRun().add('answer.pass', { ids: ['SWEEP-1'] }), /opens an answer pass over SWEEP-1, which has no answer/],
    ['a pass over an answer the tree held', () => fixRun().add('answer.recorded', answer('SWEEP-1', 0)).add('answer.pass', { ids: ['SWEEP-1'] }), /over SWEEP-1, whose answer the tree held when it was recorded/],
    ['a pass over an answer a pass applied', () => passToReport(answered().add('answer.pass', { ids: ['RIPPLE-1'] }), 1, [['RIPPLE-1', 'applied']], 2).add('answer.pass', { ids: ['RIPPLE-1'] }), /over RIPPLE-1, whose answer answer:pass-1 applied/],
    ['a second pass while the first is open', () => answered().add('answer.pass', { ids: ['RIPPLE-1'] }).add('answer.pass', { ids: ['SWEEP-1'] }), /opens an answer pass while its report is not written/],
  ];
  for (const [name, build, message] of refusals) {
    it(`refuses ${name}`, () => refuses(build(), message));
  }

  it('refuses a fixer answer under a key no pass has, and a report with too few patches', () => {
    const open = answered().add('answer.pass', { ids: ['RIPPLE-1'] }).start('answer').worker(71, 'fixer answer:pass-2');
    refuses(open.add('fix.recorded', { phase: 'answer', key: 'pass-2', workerId: worker(71), findings: [], drift: [], tests: [], suite: { result: 'pass', command: '', failures: '' }, violations: [] }, 2), /records an answer for answer:pass-2, which the phase does not have/);
    const done = answered().add('answer.pass', { ids: ['RIPPLE-1'] });
    const short = passToReport(done, 1, [['RIPPLE-1', 'applied']], 1);
    refuses(short, /writes 1 patches for 2 revisions/);
  });
});
