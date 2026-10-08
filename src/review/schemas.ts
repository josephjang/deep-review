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
import { angleSchema, checkBaseSchema, checkKinds, checkKindSchema, conventionLevelSchema, decisionKinds, decisionKindSchema, finderAngles, finderAngleSchema, fixStatusSchema, isFinderRole, leaveReasonSchema, severitySchema, suiteResultSchema, validationMethodSchema, verdictSchema, type ReviewRole } from './vocabulary.ts';

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

/**
 * What the decider returns (R3 of the decision step): per ranked finding,
 * by the index the task gave it, the decision, one sentence of grounds,
 * and the one part its decision names, the other two null: the approach a
 * fixer applies and the options rejected; the reason a finding is left,
 * and the index of the finding that supersedes it; or one question, its
 * options each with its cost, the rule that would settle it for good and
 * whether it edits the code, and the indexes of the option recommended and
 * the default applied, with where the decider looked. A fix alone may
 * name the rule it departs from. `checkDecisions` holds the parts to the
 * decision and the indexes to the task.
 */
const decisionText = (max: number) => z.string().min(1).max(max);
export const deciderOutputSchema = z.strictObject({
  decisions: z.array(z.strictObject({
    index,
    decision: decisionKindSchema,
    grounds: decisionText(1000),
    fix: z.strictObject({ approach: decisionText(2000), rejected: z.array(z.strictObject({ option: decisionText(400), reason: decisionText(400) })).max(4) }).nullable(),
    leave: z.strictObject({ reason: leaveReasonSchema, supersededBy: index.nullable() }).nullable(),
    ask: z.strictObject({
      question: decisionText(400),
      options: z.array(z.strictObject({ option: decisionText(400), cost: decisionText(400), rule: decisionText(400), edits: z.boolean() })).min(2).max(4),
      recommended: index,
      applied: index,
      searched: z.array(decisionText(400)).min(1).max(10),
    }).nullable(),
    departure: z.strictObject({ rule: decisionText(400), source: decisionText(400), reason: decisionText(1000) }).nullable(),
  })),
});
export type DeciderOutput = z.infer<typeof deciderOutputSchema>;

/** A repository path as a fixer reports it; the engine resolves it against the worktree. */
const reportedPath = z.string().min(1).max(1000);

/**
 * What the surveyor returns (R2, R3, R4 of the repository survey): the
 * files that state the conventions a change must follow; a decision on
 * each user-level rules file the task offered; in a fix run one check per
 * kind the task asks for, and null otherwise; and a note. The schema
 * holds the shape; `checkSurveyAnswer` in survey.ts holds the answer to
 * the tree and to what the task offered.
 */
export const surveyorCheckSchema = z.strictObject({
  kind: checkKindSchema,
  /** One command that runs from the repository root through the platform shell, or null when the repository has none for the kind. */
  command: z.string().min(1).max(2000).nullable(),
  /** Whether the command is what the repository states or the engine's hint; null with no command. */
  basis: checkBaseSchema.nullable(),
  /** The file the command was taken from and the text there; null with no command. */
  source: z.strictObject({ path: reportedPath, quote: z.string().min(1).max(2000) }).nullable(),
  /** A tool the command needs that does not resolve on this machine, or null when every one does. */
  missingTool: z.string().min(1).max(400).nullable(),
  /** Why the kind has no command; may also qualify a command. */
  reason: z.string().min(1).max(1000).nullable(),
});
export type SurveyorCheckOutput = z.infer<typeof surveyorCheckSchema>;

export const surveyorOutputSchema = z.strictObject({
  conventions: z.array(z.strictObject({
    /** Repository-relative for a file of the repository; the absolute path the task gave for a user-level one. */
    path: reportedPath,
    level: conventionLevelSchema,
    governs: z.string().min(1).max(1000),
    /** Globs of the paths it applies to when narrower than the repository, or null. */
    appliesTo: z.array(z.string().min(1).max(400)).min(1).max(50).nullable(),
    /** Why a user-level file applies; null for a file of the repository. */
    grounds: z.string().min(1).max(1000).nullable(),
  })).max(50),
  userRules: z.array(z.strictObject({ path: reportedPath, applied: z.boolean(), reason: z.string().min(1).max(1000) })).max(10),
  checks: z.array(surveyorCheckSchema).max(checkKinds.length).nullable(),
  note: z.string().max(2000),
});
export type SurveyorOutput = z.infer<typeof surveyorOutputSchema>;

/**
 * What a fixer returns (R5 of the fix pass), per finding by the index the
 * task gave it and once for the whole answer. The prose return format of
 * the proof of concept is gone: every field is named, so nothing is parsed
 * by convention. A repair worker returns the same shape with the failing
 * checks as its findings.
 */
export const fixerOutputSchema = z.strictObject({
  findings: z.array(z.strictObject({
    index,
    status: fixStatusSchema,
    /** Where the fix is, or where the finding was judged when nothing was edited. */
    file: reportedPath,
    line: z.number().int().min(1).nullable(),
    note: z.string().min(1).max(400),
    /** The commit message of an applied finding, in the repository's own style; also allowed on an already-applied one whose edits an earlier attempt left (R20 of the fix pass); null for the rest. */
    message: z.strictObject({ subject: z.string().min(1).max(72), body: z.string().max(2000) }).nullable(),
    /** Every file edited or created for this finding. */
    files: z.array(reportedPath).max(200),
    corrections: z.array(z.strictObject({
      file: z.string().min(1).max(400),
      anchor: z.string().min(1).max(400),
      claim: z.string().min(1).max(400),
      fact: z.string().min(1).max(400),
      evidence: z.string().min(1).max(400),
    })).max(20),
    validation: z.array(z.strictObject({ method: validationMethodSchema, source: z.string().min(1).max(400), evidence: z.string().min(1).max(1000) })).max(20),
    /** The files another cluster owns that a blocked finding needs; empty for every other status. */
    requiredFiles: z.array(reportedPath).max(50),
  })),
  drift: z.array(z.strictObject({ file: z.string().min(1).max(1000), what: z.string().min(1).max(400) })).max(50),
  tests: z.array(z.strictObject({ file: z.string().min(1).max(1000), covers: z.string().min(1).max(400) })).max(50),
  suite: z.strictObject({ result: suiteResultSchema, command: z.string().max(400), failures: z.string().max(2000) }),
});
export type FixerOutput = z.infer<typeof fixerOutputSchema>;

/**
 * Refuse a fixer's answer whose findings do not name each index of the
 * task once, that has no message on an applied finding or one on a
 * deferred or blocked finding, or
 * whose subject is not one line without a trailing period, or that names
 * required files on a finding that is not blocked. The checks that read
 * the paths against the worktree come after these (`fix-answer.ts`).
 */
export function checkFixerAnswer(output: FixerOutput, count: number): void {
  const seen = new Set<number>();
  for (const finding of output.findings) {
    const what = `Finding [${String(finding.index)}]`;
    if (finding.index >= count) throw new StructuralCheckError(`${what} is outside the task, whose findings are numbered [0] to [${String(count - 1)}]`);
    if (seen.has(finding.index)) throw new StructuralCheckError(`${what} is answered twice`);
    seen.add(finding.index);
    if (finding.status === 'applied' && finding.message === null) throw new StructuralCheckError(`${what} is applied and has no commit message`);
    if ((finding.status === 'deferred' || finding.status === 'blocked') && finding.message !== null) {
      // The output schema allows the message, so this refuses the whole answer after the work: https://github.com/josephjang/deep-review/issues/26
      throw new StructuralCheckError(`${what} is ${finding.status} and has a commit message, which only an applied or already-applied finding carries`);
    }
    if (finding.message !== null && (/[\r\n]/.test(finding.message.subject) || finding.message.subject.trimEnd().endsWith('.'))) {
      throw new StructuralCheckError(`${what}'s commit subject must be one line with no trailing period: ${JSON.stringify(finding.message.subject)}`);
    }
    if (finding.requiredFiles.length > 0 && finding.status !== 'blocked') throw new StructuralCheckError(`${what} is ${finding.status} and names required files, which only a blocked finding does`);
  }
  const missing = missingIndexes(seen, count);
  if (missing.length > 0) throw new StructuralCheckError(`The answer leaves out finding ${missing.map((position) => `[${String(position)}]`).join(', ')} of the ${String(count)} the task gave`);
}

/** The output schema of each role the review runs; every finder shares one. A role the review does not run does not compile. */
export function outputSchemaOf(role: ReviewRole): z.ZodType {
  if (isFinderRole(role)) return finderOutputSchema;
  switch (role) {
    case 'surveyor':
      return surveyorOutputSchema;
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
    case 'decider':
      return deciderOutputSchema;
    case 'fixer':
      return fixerOutputSchema;
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

/**
 * Refuse a decider answer that does not decide each finding of the task
 * once, that gives a decision any part but its own or lacks it, that
 * departs from a rule on anything but a fix, that recommends or applies
 * an option the question does not offer, or that leaves a finding as
 * superseded without naming another finding it decides `fix`, or names
 * one for another reason.
 */
export function checkDecisions(output: DeciderOutput, count: number): void {
  const seen = new Set<number>();
  const kindOf = new Map(output.decisions.map((entry) => [entry.index, entry.decision]));
  for (const entry of output.decisions) {
    const what = `Decision [${String(entry.index)}]`;
    if (entry.index >= count) throw new StructuralCheckError(`${what} is outside the task, whose findings are numbered [0] to [${String(count - 1)}]`);
    if (seen.has(entry.index)) throw new StructuralCheckError(`${what} is given twice`);
    seen.add(entry.index);
    for (const kind of decisionKinds) {
      if ((entry.decision === kind) !== (entry[kind] !== null)) {
        throw new StructuralCheckError(entry.decision === kind ? `${what} is ${kind} and has no \`${kind}\`` : `${what} is ${entry.decision} and carries \`${kind}\`, which only a ${kind} decision does`);
      }
    }
    if (entry.departure !== null && entry.decision !== 'fix') throw new StructuralCheckError(`${what} is ${entry.decision} and departs from a rule, which only a fix does`);
    if (entry.ask !== null) {
      const options = entry.ask.options.length;
      for (const [name, value] of [['recommends', entry.ask.recommended], ['applies', entry.ask.applied]] as const) {
        if (value >= options) throw new StructuralCheckError(`${what} ${name} option ${String(value)}, but its question offers options 0 to ${String(options - 1)}`);
      }
    }
    if (entry.leave !== null) {
      const by = entry.leave.supersededBy;
      if (entry.leave.reason === 'superseded' && by === null) throw new StructuralCheckError(`${what} is superseded and names no finding that supersedes it`);
      if (entry.leave.reason !== 'superseded' && by !== null) throw new StructuralCheckError(`${what} is left as ${entry.leave.reason} and names a superseding finding, which only a superseded one does`);
      if (by !== null && (by === entry.index || by >= count || kindOf.get(by) !== 'fix')) throw new StructuralCheckError(`${what} is superseded by [${String(by)}], which is not another finding of the task decided fix`);
    }
  }
  const missing = missingIndexes(seen, count);
  if (missing.length > 0) throw new StructuralCheckError(`The answer leaves out finding ${missing.map((position) => `[${String(position)}]`).join(', ')} of the ${String(count)} the task gave`);
}
