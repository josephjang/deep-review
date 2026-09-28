/**
 * The task text each role receives (R7 of the read-only review). Every task
 * numbers the candidates it hands over `[0]`, `[1]`, ... so the worker refers
 * to them by index (TD4), and describes the same fields its output schema
 * demands (R4). The closing sentence is appended by the prompt composer.
 */
import { rawLocation, scopeLocation, type CandidateState } from '../checkpoint/review-fold.ts';
import type { Lead } from '../checkpoint/events.ts';
import { finderAngles, type FinderAngle, type Verdict } from './vocabulary.ts';

/** Where a candidate points, as a worker reads it: the scope location, or the finder's own with the unlocated mark. */
export function describeLocation(candidate: Pick<CandidateState, 'file' | 'line' | 'located' | 'rawFile' | 'rawLine'>): string {
  return scopeLocation(candidate) ?? `${rawLocation(candidate)} (unlocated: not a changed file and line of the scope; read it if it exists)`;
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
