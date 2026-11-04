import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import type { PullRequestFile } from '../../src/github/pull-request.ts';
import type { ExplainedFinding, RecordedAnswer } from '../../src/review/explanation.ts';
import { answerWithArea, formOf, pullRequestRun as run, rewritten } from '../helpers/pull-request-review.ts';
import { answerableDecisions, decisions, explanation, withReportForm, worker } from '../helpers/review-history.ts';

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

  it('counts no secret of an area\'s diagram that cleaning breaks, since the diagram is left out of what is posted', () => {
    // The key's header passes the checks raw, and its replacement leaves the label's quote open.
    const form = formOf(reported([]), answerWithArea('flowchart TD\n  A["reads -----BEGIN RSA PRIVATE KEY----- header"] --> B["parse"]\n  B --> C["done"]'));
    includes(form.body, 'A diagram is left out here');
    excludes(form.body, 'redacted');
    assert.equal(form.secrets, 0);
  });

  it('counts a secret of an area\'s title once, whether the body is cut of the diagrams of the areas or not', () => {
    // RIPPLE-1, the major fix, in full in the body; SWEEP-1, left as is on long grounds; SWEEP-2, a minor fix; and RIPPLE-2, refuted, with a long summary.
    const state = rewritten(run([decisions[0], { ...decisions[1], grounds: 'g'.repeat(1000) }, { ...decisions[0], id: 'SWEEP-2' }]), (kind, payload) => {
      if (kind === 'ranking.recorded') {
        const findings = (payload.findings as Record<string, unknown>[]).map((finding) => (finding.id === 'RIPPLE-1' ? { ...finding, members: [] } : finding));
        return { ...payload, findings: [...findings, { id: 'SWEEP-2', members: [], severity: 'minor', summary: 's'.repeat(400), reason: 'r' }] };
      }
      if (kind === 'candidates.recorded' && payload.key === 'RIPPLE') return { ...payload, candidates: (payload.candidates as Record<string, unknown>[]).map((entry) => (entry.id === 'RIPPLE-2' ? { ...entry, summary: 'c'.repeat(400) } : entry)) };
      return undefined;
    }).fold();
    const files: PullRequestFile[] = [{ path: 'src/a.ts', status: 'modified', previousPath: null, patch: '@@ -7,1 +7,1 @@\n-old 7\n+new 7' }];
    const token = `ghp_${'a1B2'.repeat(9)}`;
    /** The writer's answer with a long area diagram, its title holding the token when `secret`, and the fix's problem padded with `pad` characters. */
    const answerOf = (pad: number, secret: boolean): RecordedAnswer => {
      const said = answerWithArea(`flowchart LR\n  A["${'d'.repeat(1000)}"]`);
      const fix = said.findings[0] as ExplainedFinding;
      return { ...said, areas: said.areas!.map((area) => ({ ...area, title: secret ? `Parsing ${token}` : area.title })), findings: [{ ...fix, problem: `${fix.problem} ${'q'.repeat(pad)}` }] };
    };
    const counted = new Map<string, number>();
    for (let pad = 0; !counted.has('area-diagrams'); pad += 200) {
      const plain = formOf(state, answerOf(pad, false), files);
      const secret = formOf(state, answerOf(pad, true), files);
      excludes(secret.body, token);
      // The token and the words that replace it differ in length, so the two bodies may need different cuts near a limit.
      if (JSON.stringify(secret.cuts) === JSON.stringify(plain.cuts)) counted.set(secret.cuts.at(-1) ?? 'none', secret.secrets - plain.secrets);
    }
    assert.deepEqual(Object.fromEntries(counted), { 'none': 1, 'refuted': 1, 'left': 1, 'minor-table': 1, 'area-diagrams': 1 });
  });
});
