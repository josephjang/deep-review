import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { answerWithArea, formOf, pullRequestRun as run } from '../helpers/pull-request-review.ts';
import { answerableDecisions, explanation, withReportForm, worker } from '../helpers/review-history.ts';

const includes = (text: string, part: string): void => assert.ok(text.includes(part), `${JSON.stringify(part)} in:\n${text}`);
const excludes = (text: string, part: string): void => assert.ok(!text.includes(part), `no ${JSON.stringify(part)} in:\n${text}`);
/** The summary of a body, up to the next heading. */
const summaryOf = (body: string): string => {
  const from = body.indexOf('### Summary\n');
  assert.ok(from !== -1, body);
  return body.slice(from, body.indexOf('\n### ', from + 1));
};

describe('the writer\'s areas in the body', () => {
  const why = 'An empty input still crashes parse(), and the author must choose how parse treats one.';
  /** A run whose review reads as a report, its explanation dropping each part named. */
  const reported = (dropped: readonly string[]): RunState => withReportForm(run(answerableDecisions(), explanation(worker(60), { dropped: dropped.map((part) => ({ part, failures: ['x'] })), unexplained: ['SWEEP-1'] }))).fold();

  it('posts the writer\'s sentence on the areas in the summary when the areas passed the checks', () => {
    const form = formOf(reported([]), answerWithArea(null));
    includes(summaryOf(form.body), why);
    includes(form.body, '**Parsing an empty input.** What parse() does with an empty file.');
  });

  it('leaves the writer\'s sentence on the areas out of the summary when the checks dropped the areas, and keeps the counts and what comes next', () => {
    const form = formOf(reported(['areas']), { ...answerWithArea(null), areas: null });
    const summary = summaryOf(form.body);
    excludes(summary, why);
    includes(summary, '2 findings');
    includes(summary, '--fix');
    excludes(form.body, 'Parsing an empty input');
  });
});
