/**
 * The report (R9, PD8 of the read-only review): Markdown rendered by the
 * engine from the fold alone, so two engines render the same report from
 * the same ledger and no model rewrites a finding. Sections in order: the
 * header, Angles, Findings, Refuted at verification, Statistics and
 * Limitations.
 */
import type { Spend } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import type { CandidateState, ReviewState } from '../checkpoint/review-fold.ts';
import { rankedFindings, refuted, type ReportFinding } from './state.ts';

import { angles, phases, type Angle, type Phase } from './vocabulary.ts';
export interface ReportInput {
  /** The identity of the engine writing the report. */
  readonly engine: string;
  readonly statistics: { readonly phases: readonly (Spend & { readonly phase: Phase })[]; readonly total: Spend; readonly budgetApplied: boolean };
}

const usd = (value: number | null): string => (value === null ? '-' : value.toFixed(2));
const count = (value: number | null): string => (value === null ? '-' : String(value));
const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');

/** The marks a candidate carries after its location. */
function marks(candidate: CandidateState, unverified: boolean): string {
  const list = [...(candidate.located ? [] : [`unlocated: ${candidate.rawFile}:${String(candidate.rawLine)}`]), ...(unverified ? ['unverified'] : [])];
  return list.length === 0 ? '' : ` (${list.join('; ')})`;
}

/** The location a finding prints: the scope path and line, or the raw one for an unlocated candidate. */
const shortLocation = (candidate: CandidateState): string => (candidate.located && candidate.file !== null && candidate.line !== null ? `${candidate.file}:${String(candidate.line)}` : `${candidate.rawFile}:${String(candidate.rawLine)}`);

function angleRow(review: ReviewState, angle: Angle): string {
  if (angle === 'SCAN') {
    const ran = review.units['triage:SCAN']?.answeredBy !== null && review.units['triage:SCAN']?.answeredBy !== undefined;
    return `| SCAN | ${ran ? 'run (as the triage)' : 'not run'} | - |`;
  }
  const notRun = review.anglesNotRun[angle];
  const lead = review.leads?.find((entry) => entry.angle === angle)?.lead ?? null;
  const ran = review.units[`finders:${angle}`]?.answeredBy !== null && review.units[`finders:${angle}`]?.answeredBy !== undefined;
  const status = notRun !== undefined ? `not run (${cell(notRun)})` : ran ? 'run' : 'not run';
  return `| ${angle} | ${status} | ${lead === null ? 'none' : cell(lead)} |`;
}

function findingBlock(position: number, entry: ReportFinding): string {
  const { finding, primary, members, resolution } = entry;
  const also = members.length === 0 ? '' : ` (also ${members.map((member) => member.id).join(', ')})`;
  const lines = [
    `### ${String(position)}. [${finding.severity}] ${resolution.verdict}  ${finding.id}${also}  ${shortLocation(primary)}${marks(primary, resolution.unverified)}`,
    '',
    finding.summary,
    '',
    `Reason: ${finding.reason}`,
    `Evidence: ${resolution.evidence ?? 'none; the verifier of this group failed twice'}`,
    `Angle: ${[primary, ...members].map((candidate) => candidate.angle).filter((angle, index, all) => all.indexOf(angle) === index).join(', ')}`,
  ];
  if (members.length > 0) lines.push(`Also at: ${members.map((member) => `${member.id} ${shortLocation(member)}${marks(member, false)}`).join('; ')}`);
  return lines.join('\n');
}

function statisticsTable(input: ReportInput): string {
  const row = (name: string, spend: Spend): string =>
    `| ${name} | ${String(spend.workers)} | ${spend.seconds.toFixed(1)} | ${usd(spend.costUsd)} | ${count(spend.inputTokens)} | ${count(spend.cachedInputTokens)} | ${count(spend.outputTokens)} |`;
  return [
    '| Phase | Workers | Wall seconds | Cost (USD) | Input tokens | Cached input | Output tokens |',
    '|---|---|---|---|---|---|---|',
    ...phases.map((phase) => row(phase, input.statistics.phases.find((entry) => entry.phase === phase) ?? { workers: 0, seconds: 0, costUsd: null, inputTokens: null, cachedInputTokens: null, outputTokens: null })),
    row('Total', input.statistics.total),
  ].join('\n');
}

function limitations(state: RunState, review: ReviewState, input: ReportInput): string[] {
  const lines: string[] = [];
  for (const [angle, reason] of Object.entries(review.anglesNotRun)) lines.push(`- Angle ${angle} did not run: ${reason}. The sweep was told to cover its territory.`);
  for (const [unit, reason] of Object.entries(review.unverifiedGroups)) {
    const [phase, groupId] = unit.split(':');
    const ids = review.plans[phase as 'verification' | 'sweep-verification']?.find((group) => group.id === groupId)?.candidateIds ?? [];
    lines.push(`- Group ${String(groupId)} of ${String(phase)} was not verified: ${reason}. Its candidates (${ids.join(', ')}) carry PLAUSIBLE with the unverified mark.`);
  }
  const drifted = review.checks.filter((check) => check.drifted);
  lines.push(`- Worktree checks: ${String(review.checks.length)}, ${drifted.length === 0 ? 'none found a difference from the reviewed change' : `${String(drifted.length)} found a difference before ${drifted.map((check) => `${check.phase} (attempt ${String(check.attempt)}: ${check.files.map((file) => `${file.path} ${file.outcome}`).join(', ')})`).join('; ')}; each blocked the run until the tree was restored`}.`);
  const budget = review.configuration.runBudgetUsd;
  lines.push(input.statistics.budgetApplied && budget !== null
    ? `- Run budget: ${usd(budget)} USD, checked before every launch; spent ${usd(input.statistics.total.costUsd)} USD.`
    : `- The run budget did not apply: runtime ${review.configuration.runtime} reports no cost in USD, so only the per-worker timeouts and the worker count bounded this run.`);
  const oversized = (state.scope?.files ?? []).filter((file) => (file.before !== null && 'oversized' in file.before) || (file.after !== null && 'oversized' in file.after)).map((file) => file.path);
  if (oversized.length > 0) lines.push(`- Files too large to freeze, which no worker could be given a frozen state of: ${oversized.join(', ')}.`);
  const unlocated = Object.values(review.candidates).filter((candidate) => !candidate.located && candidate.duplicateOf === null);
  if (unlocated.length > 0) lines.push(`- Unlocated candidates, whose file or line did not match the reviewed change: ${unlocated.map((candidate) => `${candidate.id} (${candidate.rawFile}:${String(candidate.rawLine)})`).join(', ')}.`);
  return lines;
}

/** Render the report from the fold. The run must be configured for review and have its scope. */
export function renderReport(state: RunState, input: ReportInput): string {
  const review = state.review;
  const scope = state.scope;
  if (review === null || scope === null) throw new Error(`Run ${state.id} has no review to report on`);
  const findings = rankedFindings(review);
  const confirmed = findings.filter((entry) => entry.resolution.verdict === 'CONFIRMED').length;
  const refutedList = refuted(review);
  const { configuration } = review;
  const header = [
    '# Deep review report',
    '',
    `Repository: ${state.worktree}`,
    `Base: ${scope.base}`,
    `Head: ${scope.head}`,
    `Mode: ${scope.mode}`,
    `Run: ${state.id}`,
    `Engine: ${input.engine}${state.engine === input.engine ? '' : ` (run created by ${state.engine})`}`,
    `Runtime: ${configuration.runtime} ${configuration.version} at ${configuration.executable}`,
    `Models: strong ${configuration.models.strong}, fast ${configuration.models.fast}`,
    `Roles digest: ${configuration.rolesDigest}`,
    `Findings: ${String(findings.length)} (${String(confirmed)} CONFIRMED, ${String(findings.length - confirmed)} PLAUSIBLE); ${String(refutedList.length)} refuted at verification`,
  ];
  const anglesSection = ['## Angles', '', '| Angle | Ran | Lead from SCAN |', '|---|---|---|', ...angles.map((angle) => angleRow(review, angle))];
  const findingsSection = [
    '## Findings',
    '',
    ...(findings.length === 0 ? ['No finding survived verification.'] : findings.flatMap((entry, index) => [findingBlock(index + 1, entry), ''])),
  ];
  const refutedSection = [
    '## Refuted at verification',
    '',
    ...(refutedList.length === 0 ? ['None.'] : refutedList.map(({ candidate, evidence }) => `- ${candidate.id} (${candidate.angle})  ${shortLocation(candidate)}${marks(candidate, false)}  ${candidate.summary}\n  Evidence: ${evidence}`)),
  ];
  const statisticsSection = ['## Statistics', '', statisticsTable(input)];
  const limitationsSection = ['## Limitations', '', ...limitations(state, review, input)];
  return [header, anglesSection, findingsSection, refutedSection, statisticsSection, limitationsSection].map((section) => section.join('\n').replace(/\n+$/, '')).join('\n\n') + '\n';
}

