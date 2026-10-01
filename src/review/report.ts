/**
 * The report (R9, PD8 of the read-only review; R13 of the fix pass):
 * Markdown rendered by the engine from the fold alone, so two engines
 * render the same report from the same ledger and no model rewrites a
 * finding. Sections in order: the header, Angles, Findings, for a fix run
 * Fixes, Checks and Changed files (fix-report.ts), Refuted at
 * verification, Statistics and Limitations.
 */
import type { ScopeState, Spend } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { isAnswered, rawLocation, repositoryLocation, unverifiedGroupsOf, type CandidateState, type ReviewState } from '../checkpoint/review-fold.ts';
import type { ArtifactReference } from '../evidence/store.ts';
import { fixHeaderLine, fixLimitations, fixSections } from './fix-report.ts';
import { matchRepositoryPath, type RepoLookup } from './locations.ts';
import { inlineText, paragraphText, tableCell } from './markdown.ts';
import { rankedFindings, refuted, type ReportFinding } from './state.ts';
import { angles, phases, triageUnitKey, type Angle, type Phase } from './vocabulary.ts';

export interface ReportInput {
  /** The identity of the engine writing the report. */
  readonly engine: string;
  /** One row per phase the run did not skip, and the total. */
  readonly statistics: { readonly phases: readonly (Spend & { readonly phase: Phase })[]; readonly total: Spend; readonly budgetApplied: boolean };
  /** For a fix run: where a frozen blob is, for the checks' output, and the patch series' paths in ledger order. */
  readonly fix?: { readonly evidencePath: (reference: ArtifactReference) => string; readonly patches: readonly string[] };
}

const usd = (value: number | null): string => (value === null ? '-' : value.toFixed(2));
const count = (value: number | null): string => (value === null ? '-' : String(value));
const workersCount = (n: number): string => `${String(n)} worker${n === 1 ? '' : 's'}`;
/** A cost cell: the reported sum, and how many workers' cost it leaves out. */
const costCell = (spend: Spend): string => `${usd(spend.costUsd)}${spend.costUnreported === null || spend.costUnreported === 0 ? '' : ` (${workersCount(spend.costUnreported)} unreported)`}`;

/** The finder's own file and line, as one line of text whatever the file's name holds. */
const rawAt = (candidate: CandidateState): string => inlineText(rawLocation(candidate));

/** Whether a candidate is located on an unchanged file of the repository, outside the reviewed change. */
const outsideChange = (candidate: CandidateState): boolean => repositoryLocation(candidate) !== null && !candidate.inScope;

/** The marks a candidate carries after its location. */
function marks(candidate: CandidateState, unverified: boolean): string {
  const where = repositoryLocation(candidate) === null ? [`unlocated: ${rawAt(candidate)}`] : outsideChange(candidate) ? ['outside the change'] : [];
  const list = [...where, ...(unverified ? ['unverified'] : [])];
  return list.length === 0 ? '' : ` (${list.join('; ')})`;
}

/** The location a finding prints: the repository path and line, or the raw one for an unlocated candidate. */
const shortLocation = (candidate: CandidateState): string => inlineText(repositoryLocation(candidate) ?? rawLocation(candidate));

function angleRow(review: ReviewState, angle: Angle): string {
  if (angle === 'SCAN') return `| SCAN | ${isAnswered(review, 'triage', triageUnitKey) ? 'run (as the triage)' : 'not run'} | - |`;
  const notRun = review.anglesNotRun[angle];
  const lead = review.leads?.find((entry) => entry.angle === angle)?.lead ?? null;
  const status = notRun !== undefined ? `not run (${tableCell(notRun)})` : isAnswered(review, 'finders', angle) ? 'run' : 'not run';
  return `| ${angle} | ${status} | ${lead === null ? 'none' : tableCell(lead)} |`;
}

function findingBlock(position: number, entry: ReportFinding): string {
  const { finding, primary, members, resolution } = entry;
  const also = members.length === 0 ? '' : ` (also ${members.map((member) => member.id).join(', ')})`;
  const lines = [
    `### ${String(position)}. [${finding.severity}] ${resolution.verdict}  ${finding.id}${also}  ${shortLocation(primary)}${marks(primary, resolution.unverified)}`,
    '',
    paragraphText(finding.summary),
    '',
    `Reason: ${inlineText(finding.reason)}`,
    `Evidence: ${resolution.evidence === null ? 'none; the verifier of this group failed twice' : inlineText(resolution.evidence)}`,
    `Angle: ${[primary, ...members].map((candidate) => candidate.angle).filter((angle, index, all) => all.indexOf(angle) === index).join(', ')}`,
  ];
  if (members.length > 0) lines.push(`Also at: ${members.map((member) => `${member.id} ${shortLocation(member)}${marks(member, false)}`).join('; ')}`);
  return lines.join('\n');
}

function statisticsTable(review: ReviewState, input: ReportInput): string {
  const row = (name: string, spend: Spend): string =>
    `| ${name} | ${String(spend.workers)} | ${spend.seconds.toFixed(1)} | ${costCell(spend)} | ${count(spend.inputTokens)} | ${count(spend.cachedInputTokens)} | ${count(spend.outputTokens)} |`;
  return [
    '| Phase | Workers | Wall seconds | Cost (USD) | Input tokens | Cached input | Output tokens |',
    '|---|---|---|---|---|---|---|',
    // Every phase the run did not skip, in phase order; a phase the statistics have no row for ran no worker.
    ...phases.filter((phase) => review.phases[phase].status !== 'skipped').map((phase) => row(phase, input.statistics.phases.find((entry) => entry.phase === phase) ?? { workers: 0, seconds: 0, costUsd: null, costUnreported: null, inputTokens: null, cachedInputTokens: null, outputTokens: null })),
    row('Total', input.statistics.total),
  ].join('\n');
}

/** What bounded the run's spend: the run budget in force at the end, or why there was none. */
function budgetLine(review: ReviewState, statistics: ReportInput['statistics']): string {
  const budget = review.limits.runBudgetUsd;
  const spent = usd(statistics.total.costUsd);
  if (statistics.budgetApplied && budget !== null) return `- Run budget: ${usd(budget)} USD, checked before every launch; spent ${spent} USD.`;
  if (statistics.total.costUnreported === null) {
    return `- The run budget did not apply: runtime ${review.configuration.runtime} reports no cost in USD, so only the per-worker timeouts and the worker count bounded this run.`;
  }
  return `- No run budget was set, so only the per-worker budgets and timeouts bounded this run; spent ${spent} USD.`;
}

/**
 * Why a candidate is unlocated, in the order the report lists them: its
 * path names no changed file, and no file of the repository that has such
 * a line; or it names a changed file the change deletes, or one whose after
 * state has no such line; or it only ends with a changed path, and the
 * ledger alone cannot tell which of the two it named.
 */
const unlocatedReasons = ['absent', 'deleted', 'past-end', 'ends-with-changed'] as const;
type UnlocatedReason = (typeof unlocatedReasons)[number];
const unlocatedWording: Readonly<Record<UnlocatedReason, string>> = {
  absent: 'on a path the repository does not hold, or on a line past the end of an unchanged file',
  deleted: 'on a file the change deletes, which has no after state for a line to point into',
  'past-end': 'on a line past the end of the changed file',
  'ends-with-changed': 'on a path that ends with a changed path, naming either that changed file or an unchanged path of the repository, neither with such a line',
};

/** A repository holding no path: every tail of a finder's path, and its bare name, may still name a changed file. */
const holdsNoPath: RepoLookup = () => [];
/** A repository holding every path: a finder's whole path, past any root, names a changed file or an unchanged one. */
const holdsEveryPath: RepoLookup = (path) => [path];

/**
 * Why an unlocated candidate is unlocated, from the ledger alone, so that
 * two engines give the same reason. `normalizeLocations` matched the raw
 * file with a lookup over the worktree, which the ledger does not record,
 * so the two extreme lookups bound what it found. A path that names no
 * changed path even when the repository holds no path named none, so it
 * named nothing the repository holds, or an unchanged file without such a
 * line. A path that names a changed path even when the repository holds
 * every path named that changed path, which is deleted or too short. A
 * path between the two only ends with a changed path, and named either
 * that changed file or an unchanged path of the repository.
 */
function whyUnlocated(scope: ScopeState, candidate: CandidateState): UnlocatedReason {
  const paths = scope.files.map((file) => file.path);
  if (matchRepositoryPath(paths, candidate.rawFile, holdsNoPath) === null) return 'absent';
  const match = matchRepositoryPath(paths, candidate.rawFile, holdsEveryPath);
  if (match === null || !match.inScope) return 'ends-with-changed';
  return scope.files.find((file) => file.path === match.path)?.after === null ? 'deleted' : 'past-end';
}

function limitations(scope: ScopeState, review: ReviewState, input: ReportInput): string[] {
  const lines: string[] = [];
  for (const [angle, reason] of Object.entries(review.anglesNotRun)) lines.push(`- Angle ${angle} did not run: ${inlineText(reason)}. The sweep was told to cover its territory.`);
  for (const group of unverifiedGroupsOf(review)) {
    lines.push(`- Group ${group.groupId} of ${group.phase} was not verified: ${inlineText(group.reason)}. Its candidates (${group.candidateIds.join(', ')}) carry PLAUSIBLE with the unverified mark.`);
  }
  const drifted = review.checks.filter((check) => check.drifted);
  // A fix run's tree is compared with what the run expected, the change and every revision since; a read-only run's with the change alone.
  const against = review.fix === null ? 'the reviewed change' : 'what the run expected';
  const headMoved = (check: (typeof drifted)[number]): string[] => (check.head === null ? [] : [`HEAD moved to ${check.head.actual}`]);
  lines.push(`- Worktree checks: ${String(review.checks.length)}, ${drifted.length === 0 ? `none found a difference from ${against}` : `${String(drifted.length)} found a difference in ${drifted.map((check) => `${check.phase} (attempt ${String(check.attempt)}: ${[...headMoved(check), ...check.files.map((file) => `${inlineText(file.path)} ${file.outcome}`)].join(', ')})`).join('; ')}; each blocked the run until the tree was restored`}.`);
  lines.push(budgetLine(review, input.statistics));
  const unreported = input.statistics.total.costUnreported;
  if (unreported !== null && unreported > 0) {
    lines.push(`- Workers with no reported cost: ${String(unreported)}. A worker that times out, fails before the runtime prints its usage, or is lost with its engine reports none; the costs above leave such workers out, so the run cost more than the totals show.${input.statistics.budgetApplied ? ' The budget check counted each such worker at its per-worker cap, except a worker lost with its engine, which it could not price and left out.' : ''}`);
  }
  const oversized = scope.files.filter((file) => (file.before !== null && 'oversized' in file.before) || (file.after !== null && 'oversized' in file.after)).map((file) => inlineText(file.path));
  if (oversized.length > 0) lines.push(`- Files too large to freeze, which no worker could be given a frozen state of: ${oversized.join(', ')}.`);
  const standing = Object.values(review.candidates).filter((candidate) => candidate.duplicateOf === null);
  const outside = standing.filter(outsideChange);
  if (outside.length > 0) {
    lines.push(`- Candidates on files outside the reviewed change: ${outside.map((candidate) => `${candidate.id} (${shortLocation(candidate)})`).join(', ')}. Each points at an unchanged file of the repository, its line checked against the file as the worktree held it; no worktree check covers such a file.`);
  }
  const unlocated = standing.filter((candidate) => repositoryLocation(candidate) === null);
  for (const reason of unlocatedReasons) {
    const matching = unlocated.filter((candidate) => whyUnlocated(scope, candidate) === reason);
    if (matching.length > 0) lines.push(`- Unlocated candidates ${unlocatedWording[reason]}: ${matching.map((candidate) => `${candidate.id} (${rawAt(candidate)})`).join(', ')}.`);
  }
  lines.push(...fixLimitations(review));
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
    `Repository: ${inlineText(state.worktree)}`,
    `Base: ${scope.base}`,
    `Head: ${scope.head}`,
    `Mode: ${scope.mode}`,
    `Run: ${state.id}`,
    `Engine: ${input.engine}${state.engine === input.engine ? '' : ` (run created by ${state.engine})`}`,
    `Runtime: ${configuration.runtime} ${inlineText(configuration.version)} at ${inlineText(configuration.executable)}`,
    `Models: strong ${configuration.models.strong}, fast ${configuration.models.fast}`,
    `Roles digest: ${configuration.rolesDigest}`,
    `Findings: ${String(findings.length)} (${String(confirmed)} CONFIRMED, ${String(findings.length - confirmed)} PLAUSIBLE); ${String(refutedList.length)} refuted at verification`,
    ...[fixHeaderLine(review)].filter((line) => line !== null),
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
    ...(refutedList.length === 0 ? ['None.'] : refutedList.map(({ candidate, evidence }) => `- ${candidate.id} (${candidate.angle})  ${shortLocation(candidate)}${marks(candidate, false)}  ${inlineText(candidate.summary)}\n  Evidence: ${inlineText(evidence)}`)),
  ];
  const statisticsSection = ['## Statistics', '', statisticsTable(review, input)];
  const limitationsSection = ['## Limitations', '', ...limitations(scope, review, input)];
  // A fix run's sections follow its findings; a run without the fix pass has none.
  const fixed = input.fix === undefined ? [] : fixSections(state, input.fix.evidencePath, input.fix.patches);
  return [header, anglesSection, findingsSection, ...fixed, refutedSection, statisticsSection, limitationsSection].map((section) => section.join('\n').replace(/\n+$/, '')).join('\n\n') + '\n';
}

