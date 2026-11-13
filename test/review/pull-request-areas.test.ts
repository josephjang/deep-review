import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import type { PullRequestFile } from '../../src/github/pull-request.ts';
import type { RecordedAnswer } from '../../src/review/explanation.ts';
import { publicationMarker } from '../../src/review/markers.ts';
import { answerWithArea, formOf, pullRequestRun as run, renderedOf, sampleBoundaries, longFindingHistory, paddedAnswer } from '../helpers/pull-request-review.ts';
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

  it('leaves the writer\'s sentence on the areas out of the summary when the checks dropped the areas, and keeps the table of counts and what comes next', () => {
    const form = formOf(reported(['areas']), { ...answerWithArea(null), areas: null });
    const summary = summaryOf(form.body);
    excludes(summary, why);
    includes(summary, '| 2 | 0 | 1 | 1 | 1 | 1 | 0 |');
    includes(summary, '--fix');
    excludes(form.body, 'Parsing an empty input');
  });

  it('counts no secret of an area\'s diagram that cleaning breaks, since the diagram is left out of what is posted', () => {
    // The key's header passes the checks raw, and its replacement leaves the label's quote open.
    const form = formOf(reported([]), answerWithArea('flowchart TD\n  A["reads -----BEGIN RSA PRIVATE KEY----- header"] --> B["parse"]\n  B --> C["done"]'));
    includes(form.body, 'A diagram is left out here');
    excludes(form.body, 'redacted');
    assert.equal(form.secrets, 0);
  });

  it('counts a secret of an area\'s title once, whether the body is cut of the diagrams of the areas or not', () => {
    const state = longFindingHistory().fold();
    const files: PullRequestFile[] = [{ path: 'src/a.ts', status: 'modified', previousPath: null, patch: '@@ -7,1 +7,1 @@\n-old 7\n+new 7' }];
    const token = `ghp_${'a1B2'.repeat(9)}`;
    /** The writer's answer with a long area diagram, its title holding the token when `secret`, and the fix's problem padded with `pad` characters. */
    const answerOf = (pad: number, secret: boolean): RecordedAnswer => {
      const said = paddedAnswer(pad);
      return { ...said, areas: said.areas!.map((area) => ({ ...area, title: secret ? `Parsing ${token}` : area.title })) };
    };
    const limit = 60_000;
    const expectedCuts = [[], ['refuted'], ['refuted', 'left'], ['refuted', 'left', 'minor-table'], ['refuted', 'left', 'minor-table', 'area-diagrams']];
    // Redaction changes the title's length, so calibrate each variant independently at the same literal cut states.
    const variants = [false, true].map((secret) => {
      const boundaries = sampleBoundaries((pad) => renderedOf(state, answerOf(pad, secret), files), limit, expectedCuts);
      for (const { below, at, above } of boundaries) {
        for (const form of [below, at, ...(above.kind === 'rendered' ? [above] : [])]) {
          excludes(form.body, token);
          includes(form.body, '### The major findings');
          includes(form.body, '**Parsing ');
          includes(form.body, 'What parse() does with an empty file.');
          assert.equal(form.body.split('\n').at(-1), `<!-- ${publicationMarker('run-1', 1)} -->`);
        }
      }
      return boundaries;
    });
    for (const [index, cuts] of expectedCuts.entries()) {
      const plain = variants[0]![index]!;
      const secret = variants[1]![index]!;
      assert.equal(secret.below.secrets - plain.below.secrets, 1, `secret count below the limit with ${cuts.join(', ')}`);
      assert.equal(secret.at.secrets - plain.at.secrets, 1, `secret count at the limit with ${cuts.join(', ')}`);
      if (plain.above.kind === 'rendered' && secret.above.kind === 'rendered') assert.equal(secret.above.secrets - plain.above.secrets, 1);
    }
  });
});
