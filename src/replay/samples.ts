/**
 * What a verifier replay keeps and reports: for every candidate of a
 * recorded run's verification groups, the verdict each sample gave it. A
 * sample is one pass of a verifier over every group: the pass the run
 * recorded, or one a replay made. Pure over the results; the summary is
 * rendered from them alone, so it can be rendered again from the file.
 */
import { z } from 'zod';
import type { RunState } from '../checkpoint/fold.ts';
import type { CandidateState } from '../checkpoint/review-fold.ts';
import { routeOf } from '../review/fixes.ts';
import { inlineText, paragraphText, tableCell } from '../review/markdown.ts';
import { resolutionOf, type Resolution } from '../review/state.ts';
import { describeLocation } from '../review/tasks.ts';
import { angleSchema, candidateIdSchema, groupIdSchema, verdicts, verdictSchema, verificationPhaseSchema, type Verdict } from '../review/vocabulary.ts';
import { ReplayRefusedError } from './errors.ts';
import type { ReplayableGroup } from './recorded.ts';

/**
 * What a verdict does to a candidate judged alone: refuted and dropped
 * from the working list, sent to a fixer, or held for the author
 * (`routeOf`). A run routes merged findings, so this is the route a
 * candidate would take if no other were merged with it.
 */
export const outcomes = ['fixer', 'held', 'dropped'] as const;
export type Outcome = (typeof outcomes)[number];

const outcomeWords: Readonly<Record<Outcome, string>> = { fixer: 'to a fixer', held: 'held', dropped: 'dropped' };

/** Which role prompt a sample's verifiers were given: the one the run recorded, or the one in the roles directory now. */
export const roleTextChoices = ['recorded', 'current'] as const;
export type RoleTextChoice = (typeof roleTextChoices)[number];

/** The name of the sample every results file starts with: what the run itself recorded. */
export const recordedSampleName = 'recorded';

const spendSchema = z.strictObject({
  /** The verifier workers that finished. */
  workers: z.number().int().min(0),
  /** The wall time those workers ran, counting workers that ran at once once. */
  seconds: z.number().min(0),
  /** What they reported costing, or null on a runtime that reports no cost. */
  costUsd: z.number().min(0).nullable(),
});
export type SampleSpend = z.infer<typeof spendSchema>;

const sampleSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  origin: z.enum(['recorded', 'replay']),
  runtime: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().min(1),
  roleText: z.enum(roleTextChoices),
  /** The SHA-256 of the role prompt the sample's verifiers were sent, which tells two samples under different prompts apart; null in results written before it was kept. */
  rolePromptSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  /** The version of the runtime's CLI that the sample's workers were launched on, or null until one has been. */
  version: z.string().min(1).nullable(),
  /** What the sample's workers spent, or null until they have all settled. */
  spend: spendSchema.nullable(),
});
export type ReplaySample = z.infer<typeof sampleSchema>;

const sampledVerdictSchema = z.strictObject({
  verdict: verdictSchema,
  /** The group's verifier failed twice, so the candidate carries PLAUSIBLE unjudged, as a run records it. */
  unverified: z.boolean(),
  evidence: z.string().nullable(),
  outcome: z.enum(outcomes),
  /** The worker that gave the verdict, in the checkpoint that recorded the sample; null for an unverified candidate. */
  workerId: z.string().min(1).nullable(),
});
export type SampledVerdict = z.infer<typeof sampledVerdictSchema>;

const candidateSchema = z.strictObject({
  id: candidateIdSchema,
  angle: angleSchema,
  phase: verificationPhaseSchema,
  group: groupIdSchema,
  location: z.string().min(1),
  summary: z.string().min(1),
  /** The verdict each sample gave, by sample name; a sample that has not judged the candidate has no entry. */
  samples: z.record(z.string(), sampledVerdictSchema),
});
export type ReplayCandidate = z.infer<typeof candidateSchema>;

const sourceSchema = z.strictObject({
  runId: z.string().min(1),
  runtime: z.string().min(1),
  engine: z.string().min(1),
  head: z.string().min(1),
  mode: z.string().min(1),
  /** The worktree the run reviewed, as it recorded it. */
  worktree: z.string().min(1),
});

const resultsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: sourceSchema,
  samples: z.array(sampleSchema).min(1),
  candidates: z.array(candidateSchema),
}).superRefine((results, context) => {
  const names = results.samples.map((sample) => sample.name);
  if (new Set(names).size !== names.length) context.addIssue({ code: 'custom', message: 'sample names are unique', path: ['samples'] });
  for (const [index, candidate] of results.candidates.entries()) {
    const unknown = Object.keys(candidate.samples).filter((name) => !names.includes(name));
    if (unknown.length > 0) context.addIssue({ code: 'custom', message: `a verdict names the sample ${unknown.join(', ')}, which the results do not list`, path: ['candidates', index, 'samples'] });
  }
});
export type ReplayResults = z.infer<typeof resultsSchema>;

/** What a verdict does to the candidate it judges, taken alone. */
export function outcomeOf(candidate: CandidateState, resolution: Resolution): Outcome {
  return resolution.verdict === 'REFUTED' ? 'dropped' : routeOf({ primary: candidate, resolution });
}

/** A candidate's verdict as a sample holds it. */
export function sampledVerdict(candidate: CandidateState, resolution: Resolution, workerId: string | null): SampledVerdict {
  return { verdict: resolution.verdict, unverified: resolution.unverified, evidence: resolution.evidence, outcome: outcomeOf(candidate, resolution), workerId };
}

/**
 * The results a replay of a run starts from: every candidate of the groups
 * it can replay, in their order, each with the verdict the run recorded
 * for it as the `recorded` sample, whose settings are the recorded
 * verifiers' and whose spend and role prompt the caller read from the run. A candidate the run recorded no verdict for, because it
 * stopped first, has no entry there.
 */
export function recordedResults(state: RunState, groups: readonly ReplayableGroup[], recorded: Pick<ReplaySample, 'spend' | 'rolePromptSha256'>): ReplayResults {
  const first = groups[0];
  const { review, scope } = state;
  if (review === null || scope === null || first === undefined) throw new ReplayRefusedError(`Run ${state.id} launched no verifier, so it has no verification to replay`);
  const sample: ReplaySample = { name: recordedSampleName, origin: 'recorded', runtime: first.launch.runtime, model: first.launch.model, effort: first.launch.effort, roleText: 'recorded', rolePromptSha256: recorded.rolePromptSha256, version: first.launch.version, spend: recorded.spend };
  const candidates = groups.flatMap((group) => group.candidates.map((candidate): ReplayCandidate => {
    const resolution = resolutionOf(candidate);
    return {
      id: candidate.id,
      angle: candidate.angle,
      phase: group.phase,
      group: group.id,
      location: describeLocation(candidate),
      summary: candidate.summary,
      samples: resolution === null ? {} : { [recordedSampleName]: sampledVerdict(candidate, resolution, resolution.unverified ? null : review.units[group.phase][group.id]?.answeredBy ?? null) },
    };
  }));
  return {
    schemaVersion: 1,
    source: { runId: state.id, runtime: review.configuration.runtime, engine: state.engine, head: scope.head, mode: scope.mode, worktree: state.worktree },
    samples: [sample],
    candidates,
  };
}

/** The name a new sample of `runtime` takes: the runtime, a dash and the next number no sample of the results has. */
export function nextSampleName(results: Pick<ReplayResults, 'samples'>, runtime: string): string {
  const taken = results.samples.map((sample) => new RegExp(`^${RegExp.escape(runtime)}-([1-9][0-9]*)$`).exec(sample.name)?.[1]).filter((number) => number !== undefined).map(Number);
  return `${runtime}-${String(Math.max(0, ...taken) + 1)}`;
}

/** The results with one more sample, which no candidate has a verdict from yet. */
export function withSample(results: ReplayResults, sample: ReplaySample): ReplayResults {
  if (results.samples.some((existing) => existing.name === sample.name)) throw new ReplayRefusedError(`The results already hold a sample named ${sample.name}`);
  return { ...results, samples: [...results.samples, sample] };
}

/** The results with the verdicts a sample gave, by candidate id; a verdict for a candidate the results do not hold is refused. */
export function withVerdicts(results: ReplayResults, sample: string, given: ReadonlyMap<string, SampledVerdict>): ReplayResults {
  if (!results.samples.some((existing) => existing.name === sample)) throw new ReplayRefusedError(`The results hold no sample named ${sample}`);
  const unknown = [...given.keys()].filter((id) => !results.candidates.some((candidate) => candidate.id === id));
  if (unknown.length > 0) throw new ReplayRefusedError(`The results hold no candidate ${unknown.join(', ')}`);
  return { ...results, candidates: results.candidates.map((candidate) => (given.has(candidate.id) ? { ...candidate, samples: { ...candidate.samples, [sample]: given.get(candidate.id)! } } : candidate)) };
}

/** The results with what a sample's workers spent and the CLI version they were launched on, which is null when none was launched. */
export function withSpend(results: ReplayResults, sample: string, spend: SampleSpend, version: string | null): ReplayResults {
  if (!results.samples.some((existing) => existing.name === sample)) throw new ReplayRefusedError(`The results hold no sample named ${sample}`);
  return { ...results, samples: results.samples.map((existing) => (existing.name === sample ? { ...existing, spend, version } : existing)) };
}

/**
 * The verdict a sample's verifier gave a candidate, or undefined when the
 * sample did not reach it or its verifier failed twice: the PLAUSIBLE a
 * run records then is no judgment, so it neither agrees nor disagrees
 * with another sample and scores against no label.
 */
export function judgedVerdict(candidate: Pick<ReplayCandidate, 'samples'>, sample: string): SampledVerdict | undefined {
  const given = candidate.samples[sample];
  return given === undefined || given.unverified ? undefined : given;
}

/** Results read back from their file; refused by name when the text is not results this engine wrote. */
export function parseResults(text: string): ReplayResults {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ReplayRefusedError(`The results are not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = resultsSchema.safeParse(value);
  if (!parsed.success) throw new ReplayRefusedError(`The results are not a verifier replay's: ${parsed.error.message}`);
  return parsed.data;
}

/** How one sample judged the candidates it reached. */
export interface SampleCounts {
  /** The candidates the sample gave a verdict, the unverified ones included. */
  readonly judged: number;
  readonly verdicts: Readonly<Record<Verdict, number>>;
  readonly unverified: number;
  readonly outcomes: Readonly<Record<Outcome, number>>;
}

const zeroOf = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;

export function countsOf(results: Pick<ReplayResults, 'candidates'>, sample: string): SampleCounts {
  const given = results.candidates.map((candidate) => candidate.samples[sample]).filter((verdict) => verdict !== undefined);
  const byVerdict = zeroOf(verdicts);
  const byOutcome = zeroOf(outcomes);
  for (const verdict of given) {
    byVerdict[verdict.verdict] += 1;
    byOutcome[verdict.outcome] += 1;
  }
  return { judged: given.length, verdicts: byVerdict, unverified: given.filter((verdict) => verdict.unverified).length, outcomes: byOutcome };
}

/** How two samples agree over the candidates both judged. */
export interface Agreement {
  /** The candidates both samples gave a verdict, an unverified one not counting as one. */
  readonly compared: number;
  readonly sameVerdict: number;
  readonly sameOutcome: number;
  /** Candidates by the first sample's verdict, then by the second's. */
  readonly matrix: Readonly<Record<Verdict, Readonly<Record<Verdict, number>>>>;
}

export function agreementOf(results: Pick<ReplayResults, 'candidates'>, first: string, second: string): Agreement {
  const matrix = Object.fromEntries(verdicts.map((verdict) => [verdict, zeroOf(verdicts)])) as Record<Verdict, Record<Verdict, number>>;
  let compared = 0;
  let sameVerdict = 0;
  let sameOutcome = 0;
  for (const candidate of results.candidates) {
    const [a, b] = [judgedVerdict(candidate, first), judgedVerdict(candidate, second)];
    if (a === undefined || b === undefined) continue;
    compared += 1;
    matrix[a.verdict][b.verdict] += 1;
    if (a.verdict === b.verdict) sameVerdict += 1;
    if (a.outcome === b.outcome) sameOutcome += 1;
  }
  return { compared, sameVerdict, sameOutcome, matrix };
}

/** The candidates at least two samples gave different verdicts, unverified ones left out, in the results' order. */
export function disagreements(results: Pick<ReplayResults, 'candidates'>): ReplayCandidate[] {
  return results.candidates.filter((candidate) => new Set(Object.keys(candidate.samples).map((sample) => judgedVerdict(candidate, sample)?.verdict).filter((verdict) => verdict !== undefined)).size > 1);
}

/** A share of a whole as text: `7 of 9 (78%)`, or `none` of an empty whole. */
const share = (part: number, whole: number): string => (whole === 0 ? 'none' : `${String(part)} of ${String(whole)} (${String(Math.round((part / whole) * 100))}%)`);

/** Every pair of the samples, each sample before the ones listed after it. */
function pairsOf<T>(items: readonly T[]): [T, T][] {
  return items.flatMap((first, index) => items.slice(index + 1).map((second): [T, T] => [first, second]));
}

/** The summary of a replay's results as Markdown: the samples, how each judged, how every pair agrees, and the candidates they disagree on with each sample's evidence. */
export function renderSummary(results: ReplayResults): string {
  const { source, samples } = results;
  const lines: string[] = [
    `# Verifier replay of run ${source.runId}`,
    '',
    `Source: a ${source.runtime} run recorded by engine ${inlineText(source.engine)}, mode ${source.mode} at head ${source.head}, in ${inlineText(source.worktree)}.`,
    `Candidates: ${String(results.candidates.length)} in ${String(new Set(results.candidates.map((candidate) => `${candidate.phase}:${candidate.group}`)).size)} verification groups.`,
    '',
    'An outcome is what a verdict does to the candidate taken alone: refuted and dropped, sent to a fixer, or held for the author. A run routes merged findings, so a merged candidate may take another route there. An unverified candidate carries PLAUSIBLE with no verifier\'s judgment, so it is counted below but compared with no other sample.',
    '',
    '## Samples',
    '',
    '| Sample | Runtime | Model | Effort | Role prompt | CLI | Workers | Seconds | USD |',
    '|---|---|---|---|---|---|---|---|---|',
    ...samples.map((sample) => {
      const spend = sample.spend;
      const cells = [sample.name, sample.runtime, sample.model, sample.effort, sample.rolePromptSha256 === null ? sample.roleText : `${sample.roleText} ${sample.rolePromptSha256.slice(0, 8)}`, sample.version ?? 'not launched', spend === null ? 'unfinished' : String(spend.workers), spend === null ? '' : String(spend.seconds), spend === null || spend.costUsd === null ? '' : spend.costUsd.toFixed(2)];
      return `| ${cells.map(tableCell).join(' | ')} |`;
    }),
    '',
    '## Verdicts',
    '',
    '| Sample | Judged | CONFIRMED | PLAUSIBLE | REFUTED | Unverified | To a fixer | Held | Dropped |',
    '|---|---|---|---|---|---|---|---|---|',
    ...samples.map((sample) => {
      const counts = countsOf(results, sample.name);
      const cells = [sample.name, `${String(counts.judged)} of ${String(results.candidates.length)}`, ...verdicts.map((verdict) => String(counts.verdicts[verdict])), String(counts.unverified), ...outcomes.map((outcome) => String(counts.outcomes[outcome]))];
      return `| ${cells.map(tableCell).join(' | ')} |`;
    }),
    '',
    '## Agreement',
  ];
  const pairs = pairsOf(samples.map((sample) => sample.name));
  if (pairs.length === 0) lines.push('', 'One sample has nothing to agree with.');
  for (const [first, second] of pairs) {
    const agreement = agreementOf(results, first, second);
    lines.push(
      '',
      `### ${first} and ${second}`,
      '',
      `Same verdict: ${share(agreement.sameVerdict, agreement.compared)}. Same outcome: ${share(agreement.sameOutcome, agreement.compared)}.`,
      '',
      `| ${first} \\ ${second} | ${verdicts.join(' | ')} |`,
      `|---|${verdicts.map(() => '---').join('|')}|`,
      ...verdicts.map((row) => `| ${row} | ${verdicts.map((column) => String(agreement.matrix[row][column])).join(' | ')} |`),
    );
  }
  const disputed = disagreements(results);
  lines.push('', '## Candidates the samples disagree on', '', disputed.length === 0 ? 'None: every sample gave every candidate it judged the same verdict.' : `${String(disputed.length)} of ${String(results.candidates.length)} candidates.`);
  for (const candidate of disputed) {
    lines.push('', `### ${candidate.id} (${candidate.angle}) at ${inlineText(candidate.location)}`, '', paragraphText(candidate.summary), '');
    for (const sample of samples) {
      const verdict = candidate.samples[sample.name];
      if (verdict === undefined) continue;
      const evidence = verdict.unverified ? 'its verifier failed twice' : inlineText(verdict.evidence ?? 'no evidence recorded');
      lines.push(`- ${sample.name}: ${verdict.verdict}, ${outcomeWords[verdict.outcome]}: ${evidence}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
