// Run the contract test of resumable runs at every point (R2 of resumable
// runs): in each scenario of the contract, each step of a fix run on the
// fakes (an append, or git making or removing a worktree of the base) in
// the three ways that apply between two steps, each child of the run in
// each of the four ways, and `commit` before and after it moves the
// branch, each against the same run of the scenario with no stop
// (test/helpers/resume-contract.ts). It prints one row per scenario, point
// and way, with each part of the contract the stop broke, and exits
// with 1 on a result the marks of the known failures
// (test/helpers/resume-marks.ts) do not expect: a broken part with no mark,
// a mark whose part held, or a point the run did not reach. The gate runs it; `npm run test:contract` runs a
// fixed set of the points (test/review/resumable-runs.contract.ts):
//   npm run resume-test -- [--scenario fixes|base] [--point <text>]... [--way signal|kill|tree|child] [--concurrency <n>] [--json <file>]
// --scenario keeps one scenario, --point the points whose name holds the
// text, --way one way; a selection that keeps no case exits with 2 before
// it runs anything.
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { parseArgs } from 'node:util';
import { brokenParts, everyPoint, reference, scenarios, stopAndResume, stopWays, waysAt, type ContractPart, type Point, type Reference, type Scenario, type StopWay } from '../test/helpers/resume-contract.ts';
import { unexpected } from '../test/helpers/resume-marks.ts';

const { values } = parseArgs({
  options: {
    scenario: { type: 'string' },
    point: { type: 'string', multiple: true },
    way: { type: 'string' },
    concurrency: { type: 'string', default: String(Math.max(1, Math.floor(availableParallelism() / 4))) },
    json: { type: 'string' },
  },
  strict: true,
});
const way = values.way;
if (way !== undefined && !(stopWays as readonly string[]).includes(way)) throw new Error(`--way must be one of ${stopWays.join(', ')}`);
const concurrency = Number(values.concurrency);
if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a whole number from 1');
const chosen = scenarios.filter((scenario) => values.scenario === undefined || scenario.name === values.scenario);
if (chosen.length === 0) throw new Error(`--scenario must be one of ${scenarios.map((scenario) => scenario.name).join(', ')}`);

const started = Date.now();
const cases: { readonly scenario: Scenario; readonly expected: Reference; readonly point: Point; readonly way: StopWay }[] = [];
for (const scenario of chosen) {
  const expected = await reference(scenario);
  cases.push(...everyPoint(expected)
    .filter((point) => values.point === undefined || values.point.some((text) => point.name.includes(text)))
    .flatMap((point) => waysAt(point).filter((candidate) => way === undefined || candidate === way).map((candidate) => ({ scenario, expected, point, way: candidate }))));
}
if (cases.length === 0) {
  // A selection that runs nothing proves nothing, so it must not pass as a run that kept the contract.
  const filters = [...(values.scenario === undefined ? [] : [`--scenario ${values.scenario}`]), ...(values.point ?? []).map((text) => `--point ${text}`), ...(way === undefined ? [] : [`--way ${way}`])];
  process.stderr.write(`resume-test: ${filters.length === 0 ? 'no case to run' : `no case matches ${filters.join(', ')}`}\n`);
  process.exit(2);
}
process.stderr.write(`resume-test: ${String(cases.length)} cases at ${String(concurrency)} at once, on ${process.platform}\n`);

/** What one case came to: the parts it broke, or the error that ended it, and what the marks say of it. */
interface Row {
  readonly scenario: string;
  readonly point: string;
  readonly way: StopWay;
  readonly reached: boolean;
  readonly broken: Readonly<Partial<Record<ContractPart, string>>>;
  readonly error: string | null;
  readonly unexpected: readonly string[];
  readonly seconds: number;
}

async function runCase({ scenario, expected, point, way: stopWay }: (typeof cases)[number]): Promise<Row> {
  const at = Date.now();
  const row = { scenario: scenario.name, point: point.name, way: stopWay };
  try {
    const stopped = await stopAndResume(point, stopWay, scenario);
    // A point the run did not reach stopped nothing, so it fails as the suite fails it, rather than pass as kept.
    if (!stopped.reached) return { ...row, reached: false, broken: {}, error: null, unexpected: ['not reached'], seconds: (Date.now() - at) / 1000 };
    const broken = brokenParts(stopped, expected);
    return { ...row, reached: true, broken: Object.fromEntries(broken), error: null, unexpected: unexpected(point.name, stopWay, process.platform, broken), seconds: (Date.now() - at) / 1000 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...row, reached: false, broken: {}, error: message, unexpected: [`error: ${message}`], seconds: (Date.now() - at) / 1000 };
  }
}

const rows: Row[] = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
  while (next < cases.length) {
    const item = cases[next]!;
    next += 1;
    const row = await runCase(item);
    rows.push(row);
    const parts = Object.keys(row.broken);
    process.stderr.write(`${row.unexpected.length === 0 ? 'ok  ' : 'FAIL'} ${row.scenario}: ${row.point} (${row.way}): ${row.error ?? (!row.reached ? 'not reached' : parts.length === 0 ? 'kept the contract' : `broke ${parts.join(', ')}`)}\n`);
  }
}));

const key = (scenario: string, point: string, stopWay: string): string => [scenario, point, stopWay].join('\u0000');
const order = new Map(cases.map((item, index) => [key(item.scenario.name, item.point.name, item.way), index]));
rows.sort((a, b) => order.get(key(a.scenario, a.point, a.way))! - order.get(key(b.scenario, b.point, b.way))!);
const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
const lines = [
  '| Scenario | Point | Way | Result | Unexpected |',
  '|---|---|---|---|---|',
  ...rows.map((row) => `| ${row.scenario} | ${cell(row.point)} | ${row.way} | ${cell(row.error ?? (!row.reached ? 'not reached' : Object.keys(row.broken).length === 0 ? 'kept' : Object.entries(row.broken).map(([part, why]) => `${part}: ${why}`).join('; ')))} | ${cell(row.unexpected.join('; '))} |`),
];
process.stdout.write(`${lines.join('\n')}\n`);
const failing = rows.filter((row) => row.unexpected.length > 0);
const breaking = rows.filter((row) => Object.keys(row.broken).length > 0).length;
process.stdout.write(`\n${String(rows.length)} cases, ${String(breaking)} broke the contract, ${String(failing.length)} unexpected; ${((Date.now() - started) / 60_000).toFixed(1)} min on ${process.platform}\n`);
if (values.json !== undefined) writeFileSync(values.json, `${JSON.stringify(rows, null, 2)}\n`);
process.exitCode = failing.length === 0 ? 0 : 1;
