/**
 * What `deep-review report --stats` prints (R9, TD7 of the report for the
 * person): the parts of a run that serve a maintainer of deep-review and
 * that the report no longer holds, rendered from the fold alone like the
 * report. The statistics of each phase, the angles with their leads, the
 * digest of the roles, the verdicts by basis and the runs the validations
 * cite (R8 of runs on the record), and for a fix run the clusters and
 * batches that held
 * each finding, who held each path a revision changed, and the files a
 * finding was first blocked on.
 */
import type { Spend } from '../checkpoint/events.ts';
import { allBatches, clusterOf, exactPath, holdersKeyedBy, lastClaimOf, planOfRound, type FixState } from '../checkpoint/fix-state.ts';
import type { RunState } from '../checkpoint/fold.ts';
import type { ReviewState } from '../checkpoint/review-fold.ts';
import { angleRan } from './brief.ts';
import { counted, inlineText, tableCell } from './markdown.ts';
import { usd, type ReportInput } from './report.ts';
import { rankedFindings } from './state.ts';
import { angles, editingPhases, phases, verdictBases, verdicts, type Angle } from './vocabulary.ts';

const count = (value: number | null): string => (value === null ? '-' : String(value));
/** A cost cell: the reported sum, and how many workers' cost it leaves out. */
const costCell = (spend: Spend): string => `${usd(spend.costUsd)}${spend.costUnreported === null || spend.costUnreported === 0 ? '' : ` (${counted(spend.costUnreported, 'worker', 'workers')} unreported)`}`;

/** The table of the statistics: every phase the run did not skip, in phase order, and the total. */
function statisticsTable(review: ReviewState, statistics: ReportInput['statistics']): string[] {
  const row = (name: string, spend: Spend): string =>
    `| ${name} | ${String(spend.workers)} | ${spend.seconds.toFixed(1)} | ${costCell(spend)} | ${count(spend.inputTokens)} | ${count(spend.cachedInputTokens)} | ${count(spend.outputTokens)} |`;
  return [
    '| Phase | Workers | Wall seconds | Cost (USD) | Input tokens | Cached input | Output tokens |',
    '|---|---|---|---|---|---|---|',
    // A phase the statistics have no row for ran no worker.
    ...phases.filter((phase) => review.phases[phase].status !== 'skipped').map((phase) => row(phase, statistics.phases.find((entry) => entry.phase === phase) ?? { workers: 0, seconds: 0, costUsd: null, costUnreported: null, inputTokens: null, cachedInputTokens: null, outputTokens: null })),
    row('Total', statistics.total),
  ];
}

function angleRow(review: ReviewState, angle: Angle): string {
  if (angle === 'SCAN') return `| SCAN | ${angleRan(review, angle) ? 'run (as the triage)' : 'not run'} | - |`;
  const notRun = review.anglesNotRun[angle];
  const lead = review.leads?.find((entry) => entry.angle === angle)?.lead ?? null;
  const status = angleRan(review, angle) ? 'run' : notRun === undefined ? 'not run' : `not run (${tableCell(notRun)})`;
  return `| ${angle} | ${status} | ${lead === null ? 'none' : tableCell(lead)} |`;
}

/**
 * Which clusters held a path in the fixes phase, round by round (R1, R3 of
 * commit series integrity), from each planned round's holders as
 * `holdersKeyedBy` gives them, built once for every path: its owner by the
 * plan, or else the cluster that claimed it last in that round, marked as
 * a claim or a late claim; `nobody` for a path no cluster held, such as one
 * only a check wrote.
 */
function heldBy(fix: FixState): (path: string) => string {
  const rounds = ([1, 2] as const).flatMap((round) => (planOfRound(fix, round) === null ? [] : [{ round, held: holdersKeyedBy(fix, round, exactPath) }]));
  return (path) => {
    const holders = rounds.flatMap(({ round, held }) => {
      const holder = held.get(path);
      if (holder === undefined) return [];
      if (holder.by === 'plan') return [holder.cluster];
      return [`${holder.cluster} (${lastClaimOf(fix, round, path)?.claimedAt === null ? 'claimed late' : 'claimed'})`];
    });
    return holders.length === 0 ? 'nobody' : [...new Set(holders)].join(', ');
  };
}

/**
 * The part of the fix pass: the cluster and the batch of each ranked
 * finding a fixer was given, with the files its cluster owned and, for one
 * the second round took, the files it was first blocked on (R18, R21 of
 * the fix pass); then who held each path a revision changed.
 */
function fixPassPart(review: ReviewState, fix: FixState): string[] {
  const batches = allBatches(fix);
  const findings = rankedFindings(review).flatMap((entry, index) => {
    const id = entry.finding.id;
    const held = batches.filter((batch) => batch.findingIds.includes(id));
    if (held.length === 0) return [];
    const words = held.map((batch) => {
      const files = clusterOf(fix, batch.cluster)?.files ?? [];
      return `cluster ${batch.cluster}, batch ${batch.key}${files.length === 0 ? ', owning no file' : ` (${files.map(inlineText).join(', ')})`}`;
    });
    const blocked = fix.secondRound?.blocked.find((entry) => entry.id === id)?.requiredFiles ?? null;
    return [`- ${String(index + 1)}. ${id}: ${words.join('; then ')}${blocked === null ? '' : `; first blocked on ${blocked.map(inlineText).join(', ')}, which the second round gave it`}`];
  });
  const holderOf = heldBy(fix);
  const paths = [...new Set(fix.revisions.flatMap((revision) => revision.files.map((file) => file.path)))].sort();
  return [
    '## Fix pass',
    '',
    ...(findings.length === 0 ? ['No finding went to a fixer.'] : ['The cluster and the batch that held each finding a fixer was given:', '', ...findings]),
    ...(paths.length === 0 ? [] : ['', '| Path | Held by |', '|---|---|', ...paths.map((path) => `| ${tableCell(path)} | ${tableCell(holderOf(path))} |`)]),
  ];
}

/**
 * The part of runs on the record (R8 of runs on the record), for a run
 * configured with it: the verdicts of each grade by how the verifier
 * established each, and in a fix run the runs the validations of each
 * editing phase cite, by whether the worker's record holds each. Its rows
 * are phases and not roles, since the repair and an answer pass share the
 * fixer's role.
 */
function citedRunsPart(review: ReviewState): string[] {
  const recorded = Object.values(review.candidates).flatMap((candidate) => (candidate.verdict === null ? [] : [candidate.verdict]));
  const lines = [
    '## Runs on the record',
    '',
    'The verdicts of each grade, by how the verifier established each:',
    '',
    `| Verdict | ${verdictBases.join(' | ')} |`,
    `|---|${verdictBases.map(() => '---|').join('')}`,
    ...verdicts.map((verdict) => `| ${verdict} | ${verdictBases.map((basis) => String(recorded.filter((entry) => entry.verdict === verdict && entry.basis === basis).length)).join(' | ')} |`),
  ];
  const fix = review.fix;
  if (fix === null) return lines;
  const rows = editingPhases.filter((phase) => review.phases[phase].status !== 'skipped').map((phase) => {
    const runs = Object.values(fix.answers[phase]).flatMap((answer) => answer.findings.flatMap((finding) => finding.validation.flatMap((entry) => entry.runs)));
    const found = runs.filter((run) => run.found !== null).length;
    return `| ${phase} | ${String(found)} | ${String(runs.length - found)} |`;
  });
  return [...lines, '', 'The runs the validations of the editing workers cite, by whether the worker\'s record holds each:', '', '| Phase | Found | Not found |', '|---|---|---|', ...rows];
}

/** The Markdown of `report --stats`: the statistics, the angles, the digest of the roles, for a run with runs on the record its runs, and for a fix run its fix pass. The run must be configured for review. */
export function renderStats(state: RunState, statistics: ReportInput['statistics']): string[] {
  const review = state.review;
  if (review === null) throw new Error(`Run ${state.id} has no review to report on`);
  const parts = [
    [`# Statistics of run ${state.id}`],
    ['## Statistics', '', ...statisticsTable(review, statistics)],
    ['## Angles', '', '| Angle | Ran | Lead from SCAN |', '|---|---|---|', ...angles.map((angle) => angleRow(review, angle))],
    ['## Roles', '', `Roles digest: ${review.configuration.rolesDigest}`],
    // A run configured before runs on the record says nothing of runs (R9 of runs on the record).
    ...(review.citedRuns ? [citedRunsPart(review)] : []),
    ...(review.fix === null ? [] : [fixPassPart(review, review.fix)]),
  ];
  return parts.flatMap((part, index) => (index === 0 ? part : ['', ...part]));
}
