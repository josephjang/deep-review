import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { briefOf, type Brief } from '../../src/review/brief.ts';
import { shortRunId } from '../../src/review/runs.ts';
import { answer, answerableDecisions, decidedFixRun, readOnlyReported } from '../helpers/review-history.ts';

/** The run with no revision of the fix pass: a fixer reported its fix applied, and the tree held no change of it. */
const withoutRevisions = (state: RunState): RunState => ({ ...state, review: { ...state.review!, fix: { ...state.review!.fix!, revisions: [] } } });

describe('the status of a fix in the brief', () => {
  it('says a fix against a written rule is committed only when a committed patch holds it', () => {
    const departure = (state: RunState): string => briefOf(state).needs.find((need) => need.condition === 'departure')!.lines[0]!;
    assert.equal(departure(withoutRevisions(decidedFixRun().fold())), '**Finding 1 is fixed against a written rule.** The fix is in your working tree.');
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
