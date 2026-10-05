// Score the samples of a verifier replay against labels and print the
// result as Markdown, or write it with --output:
//   npm run replay-score -- --results <results.json> --labels <labels.json> [--output <file>]
// The labels are a file someone who adjudicated the candidates wrote:
//   { "schemaVersion": 1, "runId": "<the replayed run>", "labels": [
//     { "id": "SCAN-1", "real": "yes" | "no" | "unsure", "disposition": "apply" | "ask" | null, "basis": "..." } ] }
// with a disposition exactly when the candidate is real. It calls no model
// and writes nothing but the file --output names.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseLabels, renderScores } from '../src/replay/labels.ts';
import { parseResults } from '../src/replay/samples.ts';

const { values } = parseArgs({
  options: {
    results: { type: 'string' },
    labels: { type: 'string' },
    output: { type: 'string' },
  },
  strict: true,
});
if (values.results === undefined || values.labels === undefined) throw new Error('--results and --labels are required');

const scores = renderScores(parseResults(readFileSync(resolve(values.results), 'utf8')), parseLabels(readFileSync(resolve(values.labels), 'utf8')));
if (values.output === undefined) {
  process.stdout.write(scores);
} else {
  writeFileSync(resolve(values.output), scores);
  console.log(`scores: ${resolve(values.output)}`);
}
