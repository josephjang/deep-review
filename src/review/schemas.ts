/**
 * What each role the review runs must return (R4 of the read-only review),
 * as zod schemas the launcher compiles to closed draft-07 JSON Schema and
 * validates every answer against, and the structural checks the schema
 * cannot express, which the engine applies to a validated answer. Workers
 * refer to candidates by the index the engine numbered them with in the
 * prompt (TD4), never by id; ids are assigned by the engine.
 */
import { z } from 'zod';
import { StructuralCheckError } from './errors.ts';
import { angleSchema, finderAngles, finderAngleSchema, isFinderRole, severitySchema, verdictSchema, type ReviewRole } from './vocabulary.ts';

/** Every field of a candidate is required, as the runtime contract demands; the fourth field is one name whatever the angle calls it. */
const candidateFields = {
  /** The path as the finder gives it; the engine normalizes it against the scope. */
  file: z.string().min(1).max(1000),
  /** The line in the new version of the file. */
  line: z.number().int().min(1),
  summary: z.string().min(1).max(400),
  /** The `failure_scenario` or `value_statement` of the finder output contract, as the angle decides. */
  detail: z.string().min(1).max(2000),
};

export const candidateSchema = z.strictObject(candidateFields);
export type CandidateOutput = z.infer<typeof candidateSchema>;

/** A sweep candidate also names the angle whose territory it sits in, which decides its rubric and its fourth field. */
export const sweepCandidateSchema = z.strictObject({ ...candidateFields, angle: angleSchema });
export type SweepCandidateOutput = z.infer<typeof sweepCandidateSchema>;

/** The finder output contract's cap. */
export const maxCandidates = 12;

export const leadOutputSchema = z.strictObject({ angle: finderAngleSchema, lead: z.string().min(1).max(1000).nullable() });

/** The triage returns its `SCAN` candidates and one lead per other angle: a string, or null when the diff supports none. */
export const triageOutputSchema = z.strictObject({
  candidates: z.array(candidateSchema).max(maxCandidates),
  leads: z.array(leadOutputSchema).length(finderAngles.length),
});
export type TriageOutput = z.infer<typeof triageOutputSchema>;

export const finderOutputSchema = z.strictObject({ candidates: z.array(candidateSchema).max(maxCandidates) });
export type FinderOutput = z.infer<typeof finderOutputSchema>;

export const sweepOutputSchema = z.strictObject({ candidates: z.array(sweepCandidateSchema).max(maxCandidates) });
export type SweepOutput = z.infer<typeof sweepOutputSchema>;

const index = z.number().int().min(0);

/** Groups of candidates that describe one defect at one location for one reason; `keep` is the member that stays. */
export const deduplicationOutputSchema = z.strictObject({
  groups: z.array(z.strictObject({ members: z.array(index).min(2), keep: index, reason: z.string().min(1).max(1000) })),
});
export type DeduplicationOutput = z.infer<typeof deduplicationOutputSchema>;

/** One verdict per candidate of the group, with one evidence line each. */
export const verifierOutputSchema = z.strictObject({
  verdicts: z.array(z.strictObject({ index, verdict: verdictSchema, evidence: z.string().min(1).max(1000) })),
});
export type VerifierOutput = z.infer<typeof verifierOutputSchema>;

/** The findings after merge and rank: a primary candidate, the candidates folded into it, and a severity. */
export const mergeRankOutputSchema = z.strictObject({
  findings: z.array(z.strictObject({ primary: index, members: z.array(index), severity: severitySchema, summary: z.string().min(1).max(400), reason: z.string().min(1).max(2000) })),
});
export type MergeRankOutput = z.infer<typeof mergeRankOutputSchema>;

/** The output schema of each role the review runs; every finder shares one. A role the review does not run does not compile. */
export function outputSchemaOf(role: ReviewRole): z.ZodType {
  if (isFinderRole(role)) return finderOutputSchema;
  switch (role) {
    case 'triage':
      return triageOutputSchema;
    case 'deduplication':
      return deduplicationOutputSchema;
    case 'verifier':
      return verifierOutputSchema;
    case 'sweep':
      return sweepOutputSchema;
    case 'merge-rank':
      return mergeRankOutputSchema;
  }
}

/** Refuse a triage answer whose leads do not cover the nine finder angles once each. */
export function checkTriageLeads(output: TriageOutput): void {
  const seen = new Set<string>();
  for (const lead of output.leads) {
    if (seen.has(lead.angle)) throw new StructuralCheckError(`The triage returned two leads for angle ${lead.angle}`);
    seen.add(lead.angle);
  }
  const missing = finderAngles.filter((angle) => !seen.has(angle));
  if (missing.length > 0) throw new StructuralCheckError(`The triage returned no lead for ${missing.join(', ')}`);
}

/** The reason an index outside the numbered input is refused, naming the range. */
const outOfRange = (what: string, value: number, count: number): StructuralCheckError =>
  new StructuralCheckError(`${what} names index ${String(value)}, but the candidates are numbered [0] to [${String(count - 1)}]`);

/** The indexes of [0, count) an answer never named, in order. */
const missingIndexes = (seen: ReadonlySet<number>, count: number): number[] => Array.from({ length: count }, (_, position) => position).filter((position) => !seen.has(position));

/** Refuse a deduplication answer that names an index outside the input, groups an index twice, or keeps a non-member. */
export function checkDeduplication(output: DeduplicationOutput, count: number): void {
  const grouped = new Set<number>();
  for (const [position, group] of output.groups.entries()) {
    const what = `Deduplication group ${String(position)}`;
    for (const member of group.members) {
      if (member >= count) throw outOfRange(what, member, count);
      if (grouped.has(member)) throw new StructuralCheckError(`${what} names index ${String(member)}, which another group already names`);
      grouped.add(member);
    }
    if (!group.members.includes(group.keep)) throw new StructuralCheckError(`${what} keeps index ${String(group.keep)}, which is not one of its members`);
  }
}

/** Refuse a verifier answer that gives an index twice, misses one, or names one outside the group. */
export function checkVerdicts(output: VerifierOutput, count: number): void {
  const seen = new Set<number>();
  for (const verdict of output.verdicts) {
    if (verdict.index >= count) throw outOfRange('A verdict', verdict.index, count);
    if (seen.has(verdict.index)) throw new StructuralCheckError(`Two verdicts name index ${String(verdict.index)}`);
    seen.add(verdict.index);
  }
  const missing = missingIndexes(seen, count);
  if (missing.length > 0) throw new StructuralCheckError(`No verdict for index ${missing.map(String).join(', ')} of the ${String(count)} candidates in the group`);
}

/** Refuse a merge-rank answer that names an index outside the working list, names one twice, or leaves one out. */
export function checkMergeRank(output: MergeRankOutput, count: number): void {
  const seen = new Set<number>();
  for (const [position, finding] of output.findings.entries()) {
    const what = `Finding ${String(position)}`;
    for (const value of [finding.primary, ...finding.members]) {
      if (value >= count) throw outOfRange(what, value, count);
      if (seen.has(value)) throw new StructuralCheckError(`${what} names index ${String(value)}, which another finding, or the same one, already names`);
      seen.add(value);
    }
  }
  const missing = missingIndexes(seen, count);
  if (missing.length > 0) throw new StructuralCheckError(`The ranking leaves out index ${missing.map(String).join(', ')} of the ${String(count)} candidates on the working list`);
}
