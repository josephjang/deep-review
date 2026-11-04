import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExplainedFinding } from '../../src/review/explanation.ts';
import { formOf, pullRequestRun as run, writerAnswer } from '../helpers/pull-request-review.ts';

const head = '2'.repeat(40);

describe('a permalink in a Markdown link', () => {
  /** The comment of RIPPLE-1 with its writer's one case on `path`, at lines 3 to 4 of the head. */
  const commentOf = (path: string): string => {
    const said = writerAnswer();
    const fix = said.findings[0] as ExplainedFinding;
    return formOf(run().fold(), { ...said, findings: [{ ...fix, cases: [{ sentence: 'It is read here', lines: { side: 'head', path, from: 3, to: 4 } }] }, said.findings[1]!] }).comments[0]!.body;
  };
  /** Each link destination of a text as Markdown reads it, up to the first `)`. */
  const destinations = (text: string): string[] => [...text.matchAll(/\]\((https?:[^)\s]*)\)/g)].map((match) => match[1]!);

  it('percent-encodes the parentheses of a path, so an unbalanced one does not close the link', () => {
    for (const [path, encoded] of [['src/a).ts', 'src/a%29.ts'], ['src/utils (old)).ts', 'src/utils%20%28old%29%29.ts'], ['src/(x/y.ts', 'src/%28x/y.ts']] as const) {
      const comment = commentOf(path);
      assert.ok(destinations(comment).includes(`https://github.com/octo/parse/blob/${head}/${encoded}#L3-L4`), `${encoded} in:\n${comment}`);
      assert.ok(comment.includes(`](https://github.com/octo/parse/blob/${head}/${encoded}#L3-L4) It is read here.`), comment);
    }
  });
});
