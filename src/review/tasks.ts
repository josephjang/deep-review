/**
 * The task text each role receives (R7 of the read-only review; R4, R11 of
 * the fix pass). Every task numbers what it hands over `[0]`, `[1]`, ...
 * (candidates, findings, failing checks) so the worker refers to them by
 * index (TD4), and describes the same fields its output schema demands
 * (R4). The closing sentence is appended by the prompt composer.
 */
import { rawLocation, repositoryLocation, type CandidateState } from '../checkpoint/review-fold.ts';
import type { Lead } from '../checkpoint/events.ts';
import type { PlannedCheck } from './checks/discover.ts';
import { fenceFor } from './prompts.ts';
import { finderAngles, type CheckKind, type FinderAngle, type Severity, type Verdict } from './vocabulary.ts';

/**
 * Where a candidate points, as a worker reads it: its repository location,
 * marked when the file is outside the change, or the finder's own location
 * with the unlocated mark.
 */
export function describeLocation(candidate: Pick<CandidateState, 'file' | 'line' | 'located' | 'inScope' | 'rawFile' | 'rawLine'>): string {
  const location = repositoryLocation(candidate);
  if (location === null) return `${rawLocation(candidate)} (unlocated: no file of the repository has this path and line)`;
  return candidate.inScope ? location : `${location} (outside the change: an unchanged file of the repository)`;
}

/** One candidate as a numbered item of a task, with the fields the worker judges by. */
function candidateItem(index: number, candidate: CandidateState, extra: readonly string[] = []): string {
  return [
    `[${String(index)}] ${candidate.id} (${candidate.angle}) at ${describeLocation(candidate)}`,
    `    summary: ${candidate.summary}`,
    `    detail: ${candidate.detail}`,
    ...extra.map((line) => `    ${line}`),
  ].join('\n');
}

const fieldNote =
  'In your JSON, each candidate has `file`, `line`, `summary` and `detail`; `detail` is the fourth field of the finder output contract, the `failure_scenario` or the `value_statement` your angle asks for. Do not invent an id: the engine assigns one to each candidate you return.';

/** The triage's task: the `SCAN` review and one lead per other angle. */
export function triageTask(): string {
  return [
    'Run the `SCAN` angle over every hunk of the patch below and the enclosing function of each. Return your candidates, up to 12.',
    '',
    `Then, for EACH of the nine other angles, in this order (${finderAngles.join(', ')}), return one lead: a concrete file, symbol or mechanism the finder of that angle should inspect first, grounded in what you read, or null when the diff supports none. A lead is never a skip; every angle runs whatever you return, so name what you saw and nothing more.`,
    '',
    fieldNote,
  ].join('\n');
}

/** A finder's task: its angle and the lead the triage gave it. */
export function finderTask(angle: FinderAngle, lead: Lead | null): string {
  const leadLine = lead === null || lead.lead === null ? 'Lead: none' : `SCAN lead: ${lead.lead}`;
  return [
    `Angle: ${angle}`,
    leadLine,
    '',
    `Run the ${angle} angle as your role prompt defines it, over the whole change below. Check the lead first when there is one, then complete the full search of your angle; a lead is neither a finding nor a boundary. Return your candidates, up to 12; an empty list is a valid answer.`,
    '',
    fieldNote,
  ].join('\n');
}

/** The deduplication worker's task over a numbered pool. */
export function deduplicationTask(candidates: readonly CandidateState[]): string {
  const list = candidates.map((candidate, index) => candidateItem(index, candidate)).join('\n');
  return [
    `Below are ${String(candidates.length)} candidates, numbered [0] to [${String(candidates.length - 1)}]. Group the ones that describe the same defect at the same location for the same reason; a group has two or more members, named by their indexes, and one \`keep\`, the member whose fourth field is the most concrete, which stays on the working list. A candidate in no group stands alone; leave it out of \`groups\`. Two candidates at one line for different reasons are not duplicates. Return \`groups\` empty when nothing repeats.`,
    '',
    list,
  ].join('\n');
}

/** A verifier's task over one group. */
export function verifierTask(groupId: string, candidates: readonly CandidateState[]): string {
  const list = candidates.map((candidate, index) => candidateItem(index, candidate)).join('\n');
  return [
    `Group ${groupId}: ${String(candidates.length)} candidate${candidates.length === 1 ? '' : 's'}, numbered [0] to [${String(candidates.length - 1)}], each with the angle it came from. Read the code each points at, then return exactly one verdict per index, CONFIRMED, PLAUSIBLE or REFUTED by the rubric of that candidate's angle, with one \`evidence\` line quoting or citing the lines that justify it. An answer that misses an index is discarded whole and the group is run again. Judge each candidate on its own claim; a candidate marked unlocated still gets a verdict, from whatever code you can find for it.`,
    '',
    list,
  ].join('\n');
}

/** What the sweep is told about a candidate that survived or was refuted. */
export interface SweepInputs {
  readonly verified: readonly { candidate: CandidateState; verdict: Verdict; unverified: boolean }[];
  readonly refuted: readonly { candidate: CandidateState; evidence: string }[];
  readonly anglesNotRun: Readonly<Record<string, string>>;
}

/** The sweep's task: the verified list, the refuted list and the angles that did not run. */
export function sweepTask(inputs: SweepInputs): string {
  const verified = inputs.verified.length === 0
    ? '(none)'
    : inputs.verified.map(({ candidate, verdict, unverified }) => `- ${candidate.id} (${candidate.angle}) at ${describeLocation(candidate)}: ${candidate.summary} [${verdict}${unverified ? ', unverified' : ''}]`).join('\n');
  const refuted = inputs.refuted.length === 0
    ? '(none)'
    : inputs.refuted.map(({ candidate, evidence }) => `- ${candidate.id} (${candidate.angle}) at ${describeLocation(candidate)}: ${candidate.summary}; refuted because: ${evidence}`).join('\n');
  const notRun = Object.entries(inputs.anglesNotRun);
  const angles = notRun.length === 0
    ? 'Every angle ran.'
    : `These angles did not run, so their territory is yours to cover: ${notRun.map(([angle, reason]) => `${angle} (${reason})`).join('; ')}.`;
  return [
    'Re-read the diff and the enclosing functions looking ONLY for gaps: candidates no angle below already lists. Do not re-derive or re-confirm anything already there.',
    '',
    angles,
    '',
    'Verified candidates (already on the working list):',
    verified,
    '',
    'Refuted candidates (already judged; do not resurface them):',
    refuted,
    '',
    'Return your gap candidates, up to 12, each naming in `angle` the angle whose territory it sits in; its `detail` is that angle\'s fourth field. An empty list is the correct answer when there is nothing new.',
  ].join('\n');
}

/** The placeholder a task's snapshot command holds for the index of the finding just finished. */
export const snapshotIndexPlaceholder = '<index>';

/** The checks as a fixer reads them: each kind's command, or why it has none. */
/** A check that failed before any fixer edited the tree, with where its frozen output is (R24 of the fix pass). */
export interface BaselineFailure {
  readonly kind: CheckKind;
  readonly stdout: string;
  readonly stderr: string;
}

function checksBlock(checks: readonly PlannedCheck[], failing: readonly BaselineFailure[] = []): string {
  if (checks.every((check) => check.command === null)) return 'No check is available: the repository names no build, typecheck, lint or test command the engine can run, so validate your fixes with what you can run yourself.';
  return [
    'The engine runs these checks, in this order, before any fixer edits and again after every fixer returns:',
    ...checks.map((check) => (check.command === null ? `- ${check.kind}: not available (${check.reason ?? 'no command'})` : `- ${check.kind}: ${check.command}`)),
    'Run the ones that cover your change before you return, and report the suite you ran in `suite`.',
    ...(failing.length === 0
      ? []
      : [
          'These failed before any fixer edited the tree; their output then is at the paths given. A failure that output does not show is yours, even when an earlier batch\'s tree already had it:',
          ...failing.map((check) => `- ${check.kind}: ${check.stdout}, ${check.stderr}`),
        ]),
  ].join('\n');
}

/** The snapshot rule, with the command quoted as the fixer must run it. */
function snapshotBlock(command: string, unit: 'finding' | 'check'): string {
  return [
    `After finishing each ${unit}, and before starting the next, run this from the repository root with that ${unit}'s index in place of ${snapshotIndexPlaceholder}:`,
    '',
    `    ${command}`,
    '',
    `It copies what you changed into your scratch directory, so the engine can tell each ${unit}'s edits apart and commit them one by one; a ${unit} you do not snapshot is folded into the next one's commit.`,
  ].join('\n');
}

/** The answer's fields, as both fixer tasks describe them. */
const answerFields = (unit: 'finding' | 'check'): string =>
  `For each ${unit}, by index, return: \`status\` (\`applied\`, \`already-applied\`, \`deferred\` or \`blocked\`); the \`file\` and \`line\` of the fix, \`line\` null when there is none; a one-sentence \`note\`; the \`files\` you edited or created for it; a \`message\` for an applied ${unit}, a \`subject\` of at most 72 characters with no trailing period and a \`body\` that says why, in the style \`git log\` shows for this repository, null for a deferred or blocked one, and null for an already-applied one unless this task asks for its message; any \`corrections\` to the brief; your \`validation\` lines; and \`requiredFiles\`, the files you were not allowed to edit that a blocked ${unit} needs, empty otherwise. Return \`drift\`, \`tests\` and \`suite\` once for the whole answer. Every index appears exactly once. Every file you own whose bytes you changed must appear in some ${unit}'s \`files\`; an answer that leaves one out is discarded and the work given to a fresh worker.`;

const scratchRule = 'Write logs and every other temporary file under your scratch directory, never in the repository.';

/**
 * The warning a fixer gets when the tree may already hold part of its
 * work, naming the ids an earlier attempt of the unit left recorded edits
 * for (R20 of the fix pass), whose commits take the message the fixer
 * gives when it verifies them.
 */
function earlierWork(unit: 'finding' | 'check', unfinished: readonly string[]): string {
  const warning = `The tree may already hold part of this work: an earlier worker on it did not finish. Verify each ${unit} against the code before applying it, report one already resolved as \`already-applied\` with the files that hold its fix, and never apply a change on top of itself.`;
  if (unfinished.length === 0) return warning;
  return `${warning} An earlier attempt left edits for ${unfinished.join(', ')}, recorded as that attempt's work; for each of these you report \`already-applied\`, give the \`message\` its commit will carry, as for an applied ${unit}.`;
}

/** A finding as a fixer's task gives it. */
export interface FixerTaskFinding {
  readonly id: string;
  readonly severity: Severity;
  readonly verdict: Verdict;
  readonly unverified: boolean;
  readonly angle: string;
  /** Where it points, as `describeLocation` writes it. */
  readonly location: string;
  readonly summary: string;
  readonly detail: string;
  /** The verifier's evidence line, or null when its group went unverified. */
  readonly evidence: string | null;
  /** Merge-rank's reason for the finding. */
  readonly reason: string;
  /** The candidates merged into it, each as `<id> at <location>`. */
  readonly also: readonly string[];
  /** For a second-round finding, what the first round said: its blocked note and the files it needed (R21 of the fix pass); null in the first round. */
  readonly firstRound: { readonly note: string; readonly requiredFiles: readonly string[] } | null;
}

/** A finding an earlier batch of the same cluster worked, as a later batch is told it. */
export interface FixerTaskEarlier {
  readonly batch: string;
  readonly id: string;
  /** The answer's status, or `not attempted` when the batch failed twice. */
  readonly outcome: string;
  readonly note: string | null;
}

export interface FixerTaskInput {
  readonly cluster: string;
  /** The batch of the cluster this fixer works (R18 of the fix pass). */
  readonly batch: string;
  /** Whether the batch belongs to the second round, whose findings were blocked in the first on files they now own (R21). */
  readonly secondRound: boolean;
  readonly findings: readonly FixerTaskFinding[];
  /** The findings the cluster's earlier batches worked, whose edits are in the tree. */
  readonly earlier: readonly FixerTaskEarlier[];
  readonly owned: readonly string[];
  /** The files every other cluster of the pass owns, cluster by cluster. */
  readonly othersOwned: readonly { readonly cluster: string; readonly files: readonly string[] }[];
  readonly checks: readonly PlannedCheck[];
  /** The snapshot command, holding `snapshotIndexPlaceholder` for the index. */
  readonly snapshotCommand: string;
  /** Whether an earlier worker on this cluster may have left part of its work in the tree. */
  readonly mayHoldWork: boolean;
  /** The findings an earlier attempt of this batch left recorded edits for, whose message a verifying fixer gives. */
  readonly unfinished: readonly string[];
  /** The checks that failed before any fixer edited the tree (R24). */
  readonly baselineFailures: readonly BaselineFailure[];
}

const fileList = (files: readonly string[]): string => (files.length === 0 ? '(none)' : files.map((file) => `- ${file}`).join('\n'));

/** A fixer's task (R4, R18 of the fix pass): its batch's findings numbered in rank order, what the cluster's earlier batches did, the ownership rule with both file lists, the checks, the snapshot command and the answer it returns. */
export function fixerTask(input: FixerTaskInput): string {
  const count = input.findings.length;
  const findings = input.findings.map((finding, index) => [
    `[${String(index)}] ${finding.id} [${finding.severity}] ${finding.verdict}${finding.unverified ? ' (unverified)' : ''} (${finding.angle}) at ${finding.location}`,
    `    summary: ${finding.summary}`,
    `    detail: ${finding.detail}`,
    `    evidence: ${finding.evidence ?? 'none; the verifier of its group failed twice'}`,
    `    reason: ${finding.reason}`,
    ...(finding.also.length === 0 ? [] : [`    also at: ${finding.also.join('; ')}`]),
    ...(finding.firstRound === null ? [] : [`    first round: blocked, needing ${finding.firstRound.requiredFiles.join(', ')}: ${finding.firstRound.note}`]),
  ].join('\n'));
  const others = input.othersOwned.filter((cluster) => cluster.files.length > 0);
  return [
    `Cluster ${input.cluster}, batch ${input.batch}${input.secondRound ? ', in the second round' : ''}: ${String(count)} finding${count === 1 ? '' : 's'}, numbered [0] to [${String(count - 1)}], in the order to apply them.`,
    '',
    ...findings,
    '',
    ...(input.secondRound ? ['Each of these was blocked in the first round on files another cluster owned. Every first-round fixer has finished, and those files are now yours: apply the fix the finding needs there, its tests included.', ''] : []),
    ...(input.earlier.length === 0
      ? []
      : [
          input.secondRound
            ? 'Findings the first round worked in your files, and this cluster\'s earlier batches; their edits are already in the tree, so build on them and neither redo nor undo them:'
            : 'Findings of this cluster that earlier batches worked, one after another before yours; their edits are already in the tree, so build on them and neither redo nor undo them:',
          input.earlier.map((entry) => `- ${entry.batch} ${entry.id} ${entry.outcome}${entry.note === null ? '' : `: ${entry.note}`}`).join('\n'),
          '',
        ]),
    'Files you own while this batch runs, which no other worker edits:',
    fileList(input.owned),
    '',
    'Files other clusters own, which you must not edit; a fix that needs one is `blocked`, naming it in `requiredFiles`:',
    others.length === 0 ? '(none)' : others.flatMap((cluster) => cluster.files.map((file) => `- ${file} (${cluster.cluster})`)).join('\n'),
    '',
    'You may edit any other file of the repository, existing or new, when a fix or its tests need it; report every file you edit or create under the finding it served.',
    '',
    checksBlock(input.checks, input.baselineFailures),
    '',
    snapshotBlock(input.snapshotCommand, 'finding'),
    '',
    ...(input.mayHoldWork ? [earlierWork('finding', input.unfinished), ''] : []),
    answerFields('finding'),
    '',
    scratchRule,
  ].join('\n');
}

/** The most bytes of a failing check's stdout and of its stderr a repair task carries inline; the whole is frozen at the path given. */
export const repairTailBytes = 16 * 1024;

/** A failing check as the repair worker is told it. */
export interface RepairTaskCheck {
  readonly kind: CheckKind;
  readonly command: string;
  readonly outcome: 'failed' | 'timeout';
  readonly exitCode: number | null;
  /** The output's last `repairTailBytes` bytes, and the path of the whole, frozen. */
  readonly stdout: { readonly tail: Buffer; readonly path: string };
  readonly stderr: { readonly tail: Buffer; readonly path: string };
  /** For a check that failed before any fixer edited the tree too, its output then (R24); null for one that passed. */
  readonly baseline: { readonly stdout: { readonly tail: Buffer; readonly path: string }; readonly stderr: { readonly tail: Buffer; readonly path: string } } | null;
}

export interface RepairTaskInput {
  readonly checks: readonly RepairTaskCheck[];
  /** Every file the fixers changed, which the repair owns. */
  readonly owned: readonly string[];
  /** What each fixer did, one line per finding, under the batch that answered it. */
  readonly answers: readonly { readonly batch: string; readonly id: string; readonly status: string; readonly note: string }[];
  readonly allChecks: readonly PlannedCheck[];
  readonly snapshotCommand: string;
  readonly mayHoldWork: boolean;
  /** The checks an earlier attempt of the repair left recorded edits for. */
  readonly unfinished: readonly string[];
}

/** One stream's tail, fenced so the output cannot close the fence. */
function outputTail(name: string, tail: Buffer, path: string): string {
  const text = tail.toString('utf8');
  if (text.trim() === '') return `    ${name}: empty (frozen at ${path})`;
  const fence = fenceFor(text);
  return [`    ${name}, its last ${String(tail.length)} bytes (the whole is at ${path}):`, `${fence}text`, text.endsWith('\n') ? text.slice(0, -1) : text, fence].join('\n');
}

/** The repair worker's task (R11, R24 of the fix pass): every check failing after the fixes with its output, and its output before them when it failed then too, the files it owns, what each fixer did, and the same answer as a fixer's with the checks as its findings. */
export function repairTask(input: RepairTaskInput): string {
  const count = input.checks.length;
  const checks = input.checks.map((check, index) => [
    `[${String(index)}] ${check.kind}: ${check.command}`,
    `    ${check.outcome === 'timeout' ? 'ran past its timeout and was killed' : `exited with code ${check.exitCode === null ? 'none (ended by a signal)' : String(check.exitCode)}`}`,
    outputTail('stdout', check.stdout.tail, check.stdout.path),
    outputTail('stderr', check.stderr.tail, check.stderr.path),
    ...(check.baseline === null
      ? ['    It passed before any fixer edited the tree.']
      : [
          '    It failed before any fixer edited the tree too: fix only the failures its output then does not show, and answer `deferred` naming them when every failure was there before. Its output then:',
          outputTail('stdout', check.baseline.stdout.tail, check.baseline.stdout.path),
          outputTail('stderr', check.baseline.stderr.tail, check.baseline.stderr.path),
        ]),
  ].join('\n'));
  return [
    `Repair: ${String(count)} check${count === 1 ? '' : 's'}, numbered [0] to [${String(count - 1)}], fail${count === 1 ? 's' : ''} after the fixers' edits. Make each pass again without undoing an applied fix: read its output, find what the fixers' edits broke, and fix that. A check is \`applied\` when it passes after your change, \`deferred\` with the reason when it cannot be made to pass here, and \`blocked\` when it needs a file outside the repository or one you were told not to edit, named in \`requiredFiles\`.`,
    '',
    ...checks,
    '',
    'Files you own: every file the fixers changed.',
    fileList(input.owned),
    '',
    'You may edit any other file of the repository when a repair needs it; report every file you edit or create under the check it served.',
    '',
    'What each fixer did:',
    input.answers.length === 0 ? '(nothing recorded)' : input.answers.map((answer) => `- ${answer.batch} ${answer.id} ${answer.status}: ${answer.note}`).join('\n'),
    '',
    checksBlock(input.allChecks),
    '',
    snapshotBlock(input.snapshotCommand, 'check'),
    '',
    ...(input.mayHoldWork ? [earlierWork('check', input.unfinished), ''] : []),
    `${answerFields('check')} The \`message\` of an applied check describes what the repair changed.`,
    '',
    scratchRule,
  ].join('\n');
}

/** What merge-rank is told about a candidate of the working list. */
export interface RankInput {
  readonly candidate: CandidateState;
  readonly verdict: Verdict;
  readonly unverified: boolean;
  readonly evidence: string | null;
}

/** The merge-rank task over the numbered working list. */
export function mergeRankTask(inputs: readonly RankInput[]): string {
  const list = inputs.map(({ candidate, verdict, unverified, evidence }, index) =>
    candidateItem(index, candidate, [`verdict: ${verdict}${unverified ? ' (unverified)' : ''}`, `evidence: ${evidence ?? 'none; the group\'s verifier failed twice'}`]),
  ).join('\n');
  return [
    `The working list holds ${String(inputs.length)} finding${inputs.length === 1 ? '' : 's'}, numbered [0] to [${String(inputs.length - 1)}], every one CONFIRMED or PLAUSIBLE. Fold findings that share one root cause across locations into one: name the best-described as \`primary\` and the others as its \`members\`, by index. Merge only on a genuinely shared root cause; two defects that merely look alike stay separate, each a finding with no members. Every index appears exactly once, as a primary or as a member. Give each finding a \`severity\` (critical, major or minor), a \`summary\` that names the other sites when there are any, and a \`reason\`; a \`CONVENTIONS\` violation takes the severity of the rule it breaks. The engine orders the findings itself: by severity, then CONFIRMED before PLAUSIBLE, then the correctness angles and \`CONVENTIONS\` before \`DESIGN\`, \`DUPLICATION\` and \`ALTITUDE\`, then by primary id. The order you return them in is not kept.`,
    '',
    list,
  ].join('\n');
}
