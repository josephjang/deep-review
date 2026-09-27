// Assemble the installed artifacts into dist/, or with --verify prove that the
// committed dist/ is byte for byte what the sources produce. Exit code 1 means
// verify found a difference; any other failure throws.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { formatOutcome, runBuild } from '../src/build/run.ts';

const { values } = parseArgs({
  options: {
    verify: { type: 'boolean', default: false },
    // The repository to build; defaults to the checkout this script lives in.
    root: { type: 'string' },
  },
  strict: true,
});

const repositoryRoot = values.root === undefined ? resolve(import.meta.dirname, '..') : resolve(values.root);
const outcome = await runBuild({ repositoryRoot, verify: values.verify });
console.log(formatOutcome(outcome));
process.exitCode = outcome.ok ? 0 : 1;
