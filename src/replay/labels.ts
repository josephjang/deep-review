/**
 * Labels for a replay's candidates, and how each sample scores against
 * them. A label is what a careful reading of the code, with a probe where
 * one can run, says of one candidate: whether what it claims is real, and
 * when it is, whether fixing it needs a decision from the author. The
 * labels are written by whoever adjudicates the candidates, never by the
 * engine; this module reads them, holds them to the results they name, and
 * counts where each sample's verdict led a candidate somewhere the label
 * does not. Pure over the results and the labels.
 */
import { z } from 'zod';
import { inlineText, tableCell } from '../review/markdown.ts';
import { angleClasses, candidateIdSchema, type AngleClass } from '../review/vocabulary.ts';
import { ReplayRefusedError } from './errors.ts';
import { judgedVerdict, type Outcome, type ReplayCandidate, type ReplayResults } from './samples.ts';

/**
 * Whether a candidate's claim holds. `yes`: the failure it describes can
 * occur, or the improvement it names is real and the change it proposes
 * would deliver it. `no`: it does not, for a reason confirmed in the code
 * or by a probe. `unsure`: the evidence at hand does not settle it; such a
 * label scores no sample.
 */
export const realities = ['yes', 'no', 'unsure'] as const;
export type Reality = (typeof realities)[number];

/**
 * What a real candidate asks of the author. `apply`: nothing; it fixes a
 * defect of the change or cleans up code the change touches, with no
 * choice of behavior or scope in it. `ask`: a decision the author owns,
 * such as a choice between two defensible behaviors, a public interface,
 * a restructuring beyond what the change touches, or taste.
 */
export const dispositions = ['apply', 'ask'] as const;
export type Disposition = (typeof dispositions)[number];

const labelSchema = z.strictObject({
  id: candidateIdSchema,
  real: z.enum(realities),
  /** Set exactly when the candidate is real. */
  disposition: z.enum(dispositions).nullable(),
  /** Why: the lines read or the probe run, and what it showed. */
  basis: z.string().min(1),
}).superRefine((label, context) => {
  if ((label.real === 'yes') !== (label.disposition !== null)) context.addIssue({ code: 'custom', message: 'a disposition is given exactly when the candidate is real', path: ['disposition'] });
});
export type Label = z.infer<typeof labelSchema>;

const labelsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** The run whose candidates the labels name; candidate ids mean nothing outside their run. */
  runId: z.string().min(1),
  labels: z.array(labelSchema),
}).superRefine((file, context) => {
  const ids = file.labels.map((label) => label.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'each candidate is labeled once', path: ['labels'] });
});
export type Labels = z.infer<typeof labelsSchema>;

/** Labels read from their file; refused by name when the text is not a labels file. */
export function parseLabels(text: string): Labels {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ReplayRefusedError(`The labels are not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = labelsSchema.safeParse(value);
  if (!parsed.success) throw new ReplayRefusedError(`The labels are not a replay's labels: ${parsed.error.message}`);
  return parsed.data;
}

/** The outcome a label asks for: a candidate that is not real dropped, a real one fixed or held as its disposition says; null for one labeled unsure. */
export function labeledOutcome(label: Pick<Label, 'real' | 'disposition'>): Outcome | null {
  if (label.real === 'unsure') return null;
  if (label.real === 'no') return 'dropped';
  return label.disposition === 'ask' ? 'held' : 'fixer';
}

/** How one sample's verdicts stand against the labels. */
export interface SampleScore {
  /** The labeled candidates the sample judged, those labeled unsure or unverified under the sample left out. */
  readonly scored: number;
  /** Of those, the ones labeled not real, and how many of them the sample kept. */
  readonly unreal: number;
  readonly keptUnreal: number;
  /** The ones labeled real, and how many of them the sample refuted. */
  readonly real: number;
  readonly droppedReal: number;
  /** Real ones the sample sent to a fixer though the label says to ask the author. */
  readonly fixedUnasked: number;
  /** Real ones the sample held for the author though the label says to apply. */
  readonly heldNeedlessly: number;
  /** The ones whose outcome under the sample is the labeled one. */
  readonly rightOutcome: number;
}

/** Each labeled candidate of the results with its label; labels of another run, or for a candidate the results do not hold, are refused. */
function labeledCandidates(results: Pick<ReplayResults, 'source' | 'candidates'>, labels: Labels): { readonly candidate: ReplayCandidate; readonly label: Label }[] {
  if (labels.runId !== results.source.runId) throw new ReplayRefusedError(`The labels name the candidates of run ${labels.runId}, not of ${results.source.runId}`);
  const candidates = new Map(results.candidates.map((candidate) => [candidate.id, candidate]));
  const unknown = labels.labels.filter((label) => !candidates.has(label.id)).map((label) => label.id);
  if (unknown.length > 0) throw new ReplayRefusedError(`The labels name ${unknown.join(', ')}, which the results do not hold`);
  return labels.labels.map((label) => ({ candidate: candidates.get(label.id)!, label }));
}

/** A sample's score over the labeled candidates of one class of angle, or of both when none is named. */
export function scoreOf(results: Pick<ReplayResults, 'source' | 'candidates'>, labels: Labels, sample: string, angleClass: AngleClass | null = null): SampleScore {
  const score = { scored: 0, unreal: 0, keptUnreal: 0, real: 0, droppedReal: 0, fixedUnasked: 0, heldNeedlessly: 0, rightOutcome: 0 };
  for (const { candidate, label } of labeledCandidates(results, labels)) {
    const given = judgedVerdict(candidate, sample);
    const wanted = labeledOutcome(label);
    if (given === undefined || wanted === null || (angleClass !== null && angleClasses[candidate.angle] !== angleClass)) continue;
    score.scored += 1;
    if (given.outcome === wanted) score.rightOutcome += 1;
    if (label.real === 'no') {
      score.unreal += 1;
      if (given.outcome !== 'dropped') score.keptUnreal += 1;
      continue;
    }
    score.real += 1;
    if (given.outcome === 'dropped') score.droppedReal += 1;
    else if (wanted === 'held' && given.outcome === 'fixer') score.fixedUnasked += 1;
    else if (wanted === 'fixer' && given.outcome === 'held') score.heldNeedlessly += 1;
  }
  return score;
}

const outcomeWords: Readonly<Record<Outcome, string>> = { fixer: 'to a fixer', held: 'held', dropped: 'dropped' };

/** One table of every sample's score over the labeled candidates of a class of angle, or of both. */
function scoreTable(results: ReplayResults, labels: Labels, angleClass: AngleClass | null): string[] {
  return [
    '| Sample | Scored | Kept though not real | Dropped though real | To a fixer though the author should be asked | Held though it should be applied | Labeled outcome |',
    '|---|---|---|---|---|---|---|',
    ...results.samples.map((sample) => {
      const score = scoreOf(results, labels, sample.name, angleClass);
      const cells = [sample.name, String(score.scored), `${String(score.keptUnreal)} of ${String(score.unreal)}`, `${String(score.droppedReal)} of ${String(score.real)}`, String(score.fixedUnasked), String(score.heldNeedlessly), `${String(score.rightOutcome)} of ${String(score.scored)}`];
      return `| ${cells.map(tableCell).join(' | ')} |`;
    }),
  ];
}

/**
 * The scores as Markdown: how many candidates are labeled and how, one
 * table of every sample's score over all of them and one per class of
 * angle, then each label with its basis and the samples whose outcome is
 * not the labeled one.
 */
export function renderScores(results: ReplayResults, labels: Labels): string {
  const labeled = labeledCandidates(results, labels);
  const count = (reality: Reality): number => labeled.filter(({ label }) => label.real === reality).length;
  const lines: string[] = [
    `# Samples against the labels of run ${results.source.runId}`,
    '',
    `Labeled: ${String(labeled.length)} of ${String(results.candidates.length)} candidates; ${String(count('yes'))} real, ${String(count('no'))} not real, ${String(count('unsure'))} unsure and not scored.`,
    '',
    'A label asks for an outcome: a candidate that is not real dropped, a real one sent to a fixer when it needs no decision, held when the author should be asked. An outcome is what a sample\'s verdict does to the candidate taken alone. A candidate whose verifier failed twice under a sample carries PLAUSIBLE with no judgment and is not scored for that sample.',
    '',
    '## Every labeled candidate',
    '',
    ...scoreTable(results, labels, null),
  ];
  for (const angleClass of ['correctness', 'design'] as const) {
    if (!labeled.some(({ candidate }) => angleClasses[candidate.angle] === angleClass)) continue;
    lines.push('', `## The ${angleClass} angles`, '', ...scoreTable(results, labels, angleClass));
  }
  lines.push('', '## Labels');
  for (const { candidate, label } of labeled) {
    const wanted = labeledOutcome(label);
    const reading = label.real === 'unsure' ? 'unsure' : label.real === 'no' ? 'not real' : `real, ${label.disposition === 'ask' ? 'ask the author' : 'apply'}`;
    lines.push('', `### ${candidate.id} (${candidate.angle}): ${reading}`, '', inlineText(label.basis), '');
    for (const sample of results.samples) {
      const given = candidate.samples[sample.name];
      if (given === undefined) continue;
      const mark = given.unverified ? ': its verifier failed twice, not scored' : wanted === null || given.outcome === wanted ? '' : ' (not the labeled outcome)';
      lines.push(`- ${sample.name}: ${given.verdict}, ${outcomeWords[given.outcome]}${mark}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
