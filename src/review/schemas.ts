/**
 * What each role the review runs must return (R4 of the read-only review),
 * as zod schemas the launcher compiles to closed draft-07 JSON Schema and
 * validates every answer against, and the structural checks the schema
 * cannot express, which the engine applies to a validated answer. Workers
 * refer to candidates by the index the engine numbered them with in the
 * prompt (TD4), never by id; ids are assigned by the engine.
 */
import { z } from 'zod';
import { changeConditionFilesCountV1, changeRestsOnCountV1, changeTextLengthV1, changeWhyFromCountV1, citedRunLimitsV1, comparisonWordsLengthV1, settlementFaultsV1, verifierNoteLengthV1, type CandidateChoice, type ChangeCondition, type ChangeReading } from '../checkpoint/events.ts';
import type { ReviewState } from '../checkpoint/review-fold.ts';
import { isBlankCitedLine } from './cited-runs.ts';
import { StructuralCheckError, structuralCheckPrefix } from './errors.ts';
import { truncated } from './steps.ts';
import { angleSchema, baseReadingSchema, checkBaseSchema, checkKinds, checkKindSchema, conventionLevelSchema, decisionKinds, decisionKindSchema, finderAngles, finderAngleSchema, findingKinds, fixStatusSchema, isFinderRole, leaveReasonSchema, maxRecordedTextLength, settleStepSchema, severitySchema, suiteResultSchema, unconfirmedKinds, validationMethodSchema, verdictBasisSchema, verdictSchema, type DecisionKind, type ReviewRole } from './vocabulary.ts';

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

/**
 * A text of the triage's account of the change, at the wide limit the
 * ledger records (R3 of the brief of a run). It has no lower limit: the
 * account must not cost the triage its answer, so an empty text is not
 * refused here, and `normalizeTriageChange` reads it as absent.
 */
const changeOutputText = z.string().max(changeTextLengthV1);
/** A commit or a path the account names; wide, as the texts are, and cut by the normalization to what the ledger records. */
const changeOutputSources = z.array(z.string().max(1000)).max(50);
const changeConditionOutputSchema = z.strictObject({ holds: z.boolean(), what: changeOutputText.nullable(), files: changeOutputSources });

/** The triage's account of the change as it returns it (R3, R4 of the brief of a run), before `normalizeTriageChange`. */
export const changeOutputSchema = z.strictObject({
  title: changeOutputText,
  what: changeOutputText,
  why: changeOutputText.nullable(),
  whyFrom: changeOutputSources,
  restsOn: changeOutputSources,
  publicInterface: changeConditionOutputSchema,
  wideEffect: changeConditionOutputSchema,
});
export type ChangeOutput = z.infer<typeof changeOutputSchema>;

/** The triage returns its `SCAN` candidates, one lead per other angle (a string, or null when the diff supports none), and its account of the change, or null. */
export const triageOutputSchema = z.strictObject({
  candidates: z.array(candidateSchema).max(maxCandidates),
  leads: z.array(leadOutputSchema).length(finderAngles.length),
  change: changeOutputSchema.nullable(),
});
export type TriageOutput = z.infer<typeof triageOutputSchema>;

/** The most sources of `why`, of what the account rests on, and of a condition's files, that the ledger records. */
export const changeSourceLimits = { whyFrom: changeWhyFromCountV1, restsOn: changeRestsOnCountV1, files: changeConditionFilesCountV1 } as const;

/** A text of the account trimmed, or null when nothing is left. */
const presentText = (text: string | null): string | null => {
  const trimmed = text?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};

/** The sources of a list trimmed, without the empty ones and repeats, in their order, up to `limit`. */
const presentSources = (sources: readonly string[], limit: number): string[] => [...new Set(sources.map((source) => source.trim()).filter((source) => source !== ''))].slice(0, limit);

/** A condition as the ledger records it: one that does not hold has no sentence and no files. */
const normalizeCondition = (condition: ChangeOutput['publicInterface']): ChangeCondition =>
  condition.holds ? { holds: true, what: presentText(condition.what), files: presentSources(condition.files, changeSourceLimits.files) } : { holds: false, what: null, files: [] };

/**
 * The triage's account as `candidates.recorded@2` records it (R3 of the
 * brief of a run). It refuses nothing, since the triage has no degraded
 * outcome and a refused answer would lose its candidates and its leads
 * too: each text is trimmed; an account with no title or no `what` left
 * is no account; a reason with nothing left is none, and loses its
 * sources; a condition that does not hold loses its sentence and its
 * files; each list loses its empty entries and repeats and keeps the
 * first entries up to its limit. A reason with no source stays, and the
 * brief says it has none.
 */
export function normalizeTriageChange(change: ChangeOutput | null): ChangeReading | null {
  if (change === null) return null;
  const title = presentText(change.title);
  const what = presentText(change.what);
  if (title === null || what === null) return null;
  const why = presentText(change.why);
  return {
    title,
    what,
    why,
    whyFrom: why === null ? [] : presentSources(change.whyFrom, changeSourceLimits.whyFrom),
    restsOn: presentSources(change.restsOn, changeSourceLimits.restsOn),
    publicInterface: normalizeCondition(change.publicInterface),
    wideEffect: normalizeCondition(change.wideEffect),
  };
}

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

/**
 * A run as a worker cites it (R3 of runs on the record): the command as it
 * ran it, one to five lines of what the run printed that show the result,
 * each copied exactly, and the path of the probe file in its scratch
 * directory, or null for a run that is not of a probe file. The caps are
 * the ones the ledger records (`citedRunLimitsV1`).
 */
export const citedRunSchema = z.strictObject({
  command: z.string().min(1).max(citedRunLimitsV1.command),
  printed: z.array(z.string().min(1).max(citedRunLimitsV1.line)).min(1).max(citedRunLimitsV1.lines),
  probe: z.string().min(1).max(citedRunLimitsV1.probe).nullable(),
});

/**
 * The verifier's answer in a run configured with runs on the record (R2,
 * R3 of runs on the record): each verdict also gives how it was
 * established, and cites the runs it rests on, at most three.
 * `invocationFor` gives it to the verification units of such a run alone
 * (TD5), and `checkVerdicts` holds its basis to its runs.
 */
export const verifierOutputSchemaV2 = z.strictObject({
  verdicts: z.array(z.strictObject({
    index,
    verdict: verdictSchema,
    evidence: z.string().min(1).max(1000),
    basis: verdictBasisSchema,
    runs: z.array(citedRunSchema).max(citedRunLimitsV1.runsPerVerdict),
  })),
});
export type VerifierOutputV2 = z.infer<typeof verifierOutputSchemaV2>;

/** A note of the verifier's beside its evidence line, in one sentence, at the length the ledger records (`verifierNoteLengthV1`). */
const verifierNote = z.string().min(1).max(verifierNoteLengthV1);

/**
 * The verifier's answer in a run whose review reads as a report (R7, R9,
 * TD1 of the review that reads as a report): version 2's, and on each
 * verdict what keeps it from CONFIRMED, a fact not settled or a choice
 * that remains, which a PLAUSIBLE verdict gives and no other does, and
 * the choice between two behaviors the code leaves to the author, or
 * null. `verifierOutputSchemaFor` gives it to the verification units of
 * such a run alone, and `checkVerdicts` holds the first to the verdict.
 */
export const verifierOutputSchemaV3 = z.strictObject({
  verdicts: z.array(z.strictObject({
    ...verifierOutputSchemaV2.shape.verdicts.element.shape,
    unconfirmed: z.strictObject({ kind: z.enum(unconfirmedKinds), text: verifierNote }).nullable(),
    authorChoice: verifierNote.nullable(),
  })),
});
export type VerifierOutputV3 = z.infer<typeof verifierOutputSchemaV3>;

/**
 * The schema a verifier of a run answers in, the one the run was
 * configured with, also when this engine resumes or replays it: version 3
 * in a run whose review reads as a report, version 2 in one with runs on
 * the record, and version 1 before.
 */
export function verifierOutputSchemaFor(review: Pick<ReviewState, 'citedRuns' | 'reportForm'>): typeof verifierOutputSchema | typeof verifierOutputSchemaV2 | typeof verifierOutputSchemaV3 {
  if (review.reportForm) return verifierOutputSchemaV3;
  return review.citedRuns ? verifierOutputSchemaV2 : verifierOutputSchema;
}

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
 * name the rule it departs from. Any decision may give the choices it
 * settles, each with the candidates whose verifiers named it, by id, the
 * step that settles it and its source (R2, PD9 of the settled choice).
 * `checkDecisions` holds the parts to the decision, the settled choices
 * to `settlementRulesV1` and the indexes and ids to the task.
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
    settled: z.array(z.strictObject({ for: z.array(decisionText(40)), choice: decisionText(400), by: settleStepSchema, source: decisionText(400) })),
  })),
});
export type DeciderOutput = z.infer<typeof deciderOutputSchema>;

/**
 * The sides a case of the writer cites lines at (PD11 of the review on the
 * pull request): the head, or the merge base for lines the change removed.
 */
export const citedSides = ['head', 'base'] as const;
export type CitedSide = (typeof citedSides)[number];

/** A text of the writer's: the schema holds its length only, and `checkAnswer` in explanation.ts holds an empty one to its part, so one empty text never costs the whole answer. */
const writerText = (max: number) => z.string().max(max);
/** A diagram of the writer's, its Mermaid text without a fence, or null where the flow is short to say. */
const writerDiagram = z.string().max(8000).nullable();

/**
 * What the writer returns (R18, R19 of the review on the pull request):
 * the conclusion, with its why, a sentence for each action by the id of
 * its finding and a diagram; the account of the pull request, with its
 * terms, the problem before the change and the change, each with a
 * diagram; and for each finding the task lists, its explanation, whose
 * every case cites one range of lines at a side, or the reason it is
 * unexplained, the other null. The ranges are numbers as the writer gives
 * them, and the ids text: `checkAnswer` holds each to the run, part by
 * part, so a part that fails a check is given again or dropped alone.
 */
export const writerOutputSchema = z.strictObject({
  conclusion: z.strictObject({
    why: writerText(2000),
    actions: z.array(z.strictObject({ id: writerText(200), sentence: writerText(800) })).max(200),
    diagram: writerDiagram,
  }),
  account: z.strictObject({
    terms: z.array(z.strictObject({ term: writerText(200), meaning: writerText(800) })).max(40),
    problem: z.strictObject({ text: writerText(4000), diagram: writerDiagram }),
    change: z.strictObject({ text: writerText(4000), diagram: writerDiagram }),
  }),
  findings: z.array(z.strictObject({
    id: writerText(200),
    explanation: z.strictObject({
      title: writerText(400),
      problem: writerText(2000),
      cases: z.array(z.strictObject({
        sentence: writerText(800),
        lines: z.strictObject({ side: z.enum(citedSides), path: writerText(1000), from: z.number().int(), to: z.number().int() }),
      })).max(12),
      diagram: writerDiagram,
      decision: writerText(2000),
    }).nullable(),
    unexplained: writerText(1000).nullable(),
  })).max(200),
});
export type WriterOutput = z.infer<typeof writerOutputSchema>;

/**
 * What the writer returns in a run whose review reads as a report (R4,
 * R6, R10, R11, R13, TD2 of the review that reads as a report): the
 * conclusion, as before; the areas of the major findings that ask a
 * person to act, each with a title, an intro, a diagram and the ids of
 * its findings; for each finding the task lists, its explanation, which
 * also gives one line of how its verifier checked it and, for a minor
 * finding, its kind, or the reason it is unexplained; and one line for
 * each refuted candidate, by its id, with its claim and why it was
 * refuted. It has no account of the pull request. `checkAnswer` holds
 * each part to the run, as it holds the first answer's.
 */
export const writerOutputSchemaV2 = z.strictObject({
  conclusion: writerOutputSchema.shape.conclusion,
  areas: z.array(z.strictObject({
    title: writerText(200),
    intro: writerText(600),
    diagram: writerDiagram,
    findings: z.array(writerText(200)).max(200),
  })).max(12),
  findings: z.array(z.strictObject({
    id: writerText(200),
    explanation: z.strictObject({
      ...writerOutputSchema.shape.findings.element.shape.explanation.unwrap().shape,
      checked: writerText(400),
      kind: z.enum(findingKinds).nullable(),
    }).nullable(),
    unexplained: writerText(1000).nullable(),
  })).max(200),
  refuted: z.array(z.strictObject({ id: writerText(200), claim: writerText(300), why: writerText(300) })).max(200),
});
export type WriterOutputV2 = z.infer<typeof writerOutputSchemaV2>;

/** The schema the writer of a run answers in, the one the run was configured with, also when this engine resumes it: version 2 in a run whose review reads as a report, version 1 before. */
export function writerOutputSchemaFor(review: Pick<ReviewState, 'reportForm'>): typeof writerOutputSchema | typeof writerOutputSchemaV2 {
  return review.reportForm ? writerOutputSchemaV2 : writerOutputSchema;
}

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
    /**
     * Null for a finding with no edits. Otherwise the files edited or
     * created for it, or that hold an earlier attempt's edits for it, and
     * the commit message those edits take, in the repository's own style,
     * whatever the status: a blocked or deferred finding's says the change
     * is partial (R1 of fixer edits; R11 of commit series integrity). One
     * field, so a message without files, or files without a message, is a
     * shape the schema refuses at the worker's boundary.
     */
    edits: z.strictObject({
      files: z.array(reportedPath).min(1).max(200),
      message: z.strictObject({ subject: z.string().min(1).max(72), body: z.string().max(2000) }),
    }).nullable(),
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
 * What the repair of a run with the checks on the base returns (R2, TD6
 * of the facts before a merge): a fixer's answer with the checks as its
 * findings, and its reading of each check that failed or timed out on the
 * base, of the failures before the fixes against those there. Only that
 * repair answers in it, chosen by its unit, so no other worker gets a
 * field it must leave empty. The engine keeps the entries of the kinds it
 * compares, the first of each, and refuses no answer for the others.
 */
export const repairOutputSchema = z.strictObject({
  ...fixerOutputSchema.shape,
  comparisons: z.array(z.strictObject({
    kind: checkKindSchema,
    reading: baseReadingSchema,
    words: z.string().min(1).max(comparisonWordsLengthV1),
  })),
});
export type RepairOutput = z.infer<typeof repairOutputSchema>;

/** A finding of a fixer's answer, as `fixerOutputSchema` gives it. */
const fixerFinding = fixerOutputSchema.shape.findings.element;

/**
 * What an editing worker of a run configured with runs on the record
 * returns (R7 of runs on the record): a fixer's answer whose validation
 * entries each cite the runs they rest on, at most four, each as a
 * verifier cites one. `invocationFor` gives it to the editing units of
 * such a run alone (TD5); the engine looks each run up in the worker's
 * record and refuses no answer for one it does not find (PD4).
 */
export const fixerOutputSchemaV2 = z.strictObject({
  ...fixerOutputSchema.shape,
  findings: z.array(z.strictObject({
    ...fixerFinding.shape,
    validation: z.array(z.strictObject({ ...fixerFinding.shape.validation.element.shape, runs: z.array(citedRunSchema).max(citedRunLimitsV1.runsPerEntry) })).max(20),
  })),
});
export type FixerOutputV2 = z.infer<typeof fixerOutputSchemaV2>;

/** The repair's answer of a run with the checks on the base and runs on the record: `fixerOutputSchemaV2` with the comparisons of `repairOutputSchema`. */
export const repairOutputSchemaV2 = z.strictObject({
  ...fixerOutputSchemaV2.shape,
  comparisons: repairOutputSchema.shape.comparisons,
});

/**
 * Refuse a fixer's answer whose findings do not name each index of the
 * task once, whose subject is not one line without a trailing period,
 * that names required files on a finding that is not blocked, or that
 * blocks a finding when its task offers no `blocked` (`blocks` false), as
 * the repair's and the documentation step's do. That a message goes
 * exactly with files is the shape of `edits`, which the schema holds (R1,
 * R2 of fixer edits; R11 of commit series integrity). The checks that
 * read the paths against the worktree come after these (`fix-answer.ts`).
 */
export function checkFixerAnswer(output: FixerOutput, count: number, blocks = true): void {
  const seen = new Set<number>();
  for (const finding of output.findings) {
    const what = `Finding [${String(finding.index)}]`;
    if (finding.index >= count) throw new StructuralCheckError(`${what} is outside the task, whose findings are numbered [0] to [${String(count - 1)}]`);
    if (seen.has(finding.index)) throw new StructuralCheckError(`${what} is answered twice`);
    seen.add(finding.index);
    const subject = finding.edits?.message.subject;
    if (subject !== undefined && (/[\r\n]/.test(subject) || subject.trimEnd().endsWith('.'))) {
      throw new StructuralCheckError(`${what}'s commit subject must be one line with no trailing period: ${JSON.stringify(subject)}`);
    }
    if (finding.status === 'blocked' && !blocks) throw new StructuralCheckError(`${what} is blocked, a status its task does not offer: nothing holds a file from this worker`);
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
    case 'writer':
      return writerOutputSchema;
    case 'fixer':
    case 'documentation':
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

/**
 * Refuse a verifier answer that gives an index twice, misses one, or names
 * one outside the group; and in an answer that gives each verdict its
 * basis (R2, R3 of runs on the record), a verdict that rests on a run and
 * cites none, one of another basis that cites a run, or a cited line that
 * is blank; and in an answer that gives each verdict its notes (R7, R9 of
 * the review that reads as a report), a PLAUSIBLE verdict that does not
 * say what keeps it from CONFIRMED, another verdict that does, or a note
 * that is blank.
 */
export function checkVerdicts(output: VerifierOutput | VerifierOutputV2 | VerifierOutputV3, count: number): void {
  const seen = new Set<number>();
  for (const verdict of output.verdicts) {
    if (verdict.index >= count) throw outOfRange('A verdict', verdict.index, count);
    if (seen.has(verdict.index)) throw new StructuralCheckError(`Two verdicts name index ${String(verdict.index)}`);
    seen.add(verdict.index);
    if (!('basis' in verdict)) continue;
    const what = `The verdict for index ${String(verdict.index)}`;
    if (verdict.basis === 'ran' && verdict.runs.length === 0) throw new StructuralCheckError(`${what} rests on a run and cites none`);
    if (verdict.basis !== 'ran' && verdict.runs.length > 0) throw new StructuralCheckError(`${what} is ${verdict.basis} and cites a run, which only a verdict that rests on a run does`);
    if (verdict.runs.some((run) => run.printed.some(isBlankCitedLine))) throw new StructuralCheckError(`${what} cites a blank line of what a run printed`);
    if (!('unconfirmed' in verdict)) continue;
    if (verdict.verdict === 'PLAUSIBLE' && verdict.unconfirmed === null) throw new StructuralCheckError(`${what} is PLAUSIBLE and gives no unconfirmed, the fact not settled or the choice that keeps it from CONFIRMED`);
    if (verdict.verdict !== 'PLAUSIBLE' && verdict.unconfirmed !== null) throw new StructuralCheckError(`${what} is ${verdict.verdict} and gives unconfirmed, which only a PLAUSIBLE verdict does`);
    if (verdict.unconfirmed !== null && verdict.unconfirmed.text.trim() === '') throw new StructuralCheckError(`${what} gives a blank unconfirmed`);
    if (verdict.authorChoice !== null && verdict.authorChoice.trim() === '') throw new StructuralCheckError(`${what} gives a blank authorChoice; give null when the code leaves the author no choice`);
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

/** What one decision of a decider's answer breaks, each fault a sentence that names the decision by its index and the rule. */
function decisionFaults(entry: DeciderOutput['decisions'][number], findings: readonly (readonly CandidateChoice[])[], kindOf: ReadonlyMap<number, DecisionKind>): string[] {
  const what = `Decision [${String(entry.index)}]`;
  const count = findings.length;
  if (entry.index >= count) return [`${what} is outside the task, whose findings are numbered [0] to [${String(count - 1)}]`];
  const faults: string[] = [];
  for (const kind of decisionKinds) {
    if ((entry.decision === kind) !== (entry[kind] !== null)) faults.push(entry.decision === kind ? `${what} is ${kind} and has no \`${kind}\`` : `${what} is ${entry.decision} and carries \`${kind}\`, which only a ${kind} decision does`);
  }
  if (entry.departure !== null && entry.decision !== 'fix') faults.push(`${what} is ${entry.decision} and departs from a rule, which only a fix does`);
  if (entry.ask !== null) {
    const options = entry.ask.options.length;
    for (const [name, value] of [['recommends', entry.ask.recommended], ['applies', entry.ask.applied]] as const) {
      if (value >= options) faults.push(`${what} ${name} option ${String(value)}, but its question offers options 0 to ${String(options - 1)}`);
    }
  }
  if (entry.leave !== null) {
    const by = entry.leave.supersededBy;
    if (entry.leave.reason === 'superseded' && by === null) faults.push(`${what} is superseded and names no finding that supersedes it`);
    if (entry.leave.reason !== 'superseded' && by !== null) faults.push(`${what} is left as ${entry.leave.reason} and names a superseding finding, which only a superseded one does`);
    else if (by !== null && (by === entry.index || by >= count || kindOf.get(by) !== 'fix')) faults.push(`${what} is superseded by [${String(by)}], which is not another finding of the task decided fix`);
  }
  // A leave names its case by its reason, so the settled choices of one without its part have no rule to be read against.
  const settlement = entry.decision === 'leave' && entry.leave === null ? [] : settlementFaultsV1(entry, findings[entry.index]!);
  return [...faults, ...settlement.map((fault) => `${what} ${fault}`)];
}

/**
 * The faults of an answer as the message of one refusal, within what a
 * failed attempt records of it after `structuralCheckPrefix`: one fault
 * alone, or each in turn, with the count of those left out when the rest
 * would not fit. A first fault too long to fit on its own is truncated, so
 * the refusal still names the start of what the next attempt must change.
 */
function faultsMessage(faults: readonly string[]): string {
  if (faults.length === 1) return faults[0]!;
  const room = maxRecordedTextLength - structuralCheckPrefix.length;
  const head = `The answer breaks ${String(faults.length)} rules: `;
  const more = (count: number): string => (count === 0 ? '' : `; and ${String(count)} more`);
  const listed: string[] = [];
  for (const [position, fault] of faults.entries()) {
    const tail = more(faults.length - position - 1);
    if ((head + [...listed, fault].join('; ') + tail).length <= room) {
      listed.push(fault);
      continue;
    }
    if (position === 0) return `${head}${truncated(fault, room - head.length - tail.length)}${tail}`;
    return `${head}${listed.join('; ')}${more(faults.length - position)}`;
  }
  return `${head}${listed.join('; ')}`;
}

/**
 * Refuse a decider answer that does not decide each finding of the task
 * once, that gives a decision any part but its own or lacks it, that
 * departs from a rule on anything but a fix, that recommends or applies
 * an option the question does not offer, that leaves a finding as
 * superseded without naming another finding it decides `fix`, or names
 * one for another reason, or whose settled choices break
 * `settlementRulesV1` (R2, R3, PD9 of the settled choice), given for each
 * finding of the task, by its index, its candidates with the choice each
 * verifier left to the author. Every fault of the answer is named in the
 * one refusal, so the next attempt is told all it must change at once.
 */
export function checkDecisions(output: DeciderOutput, findings: readonly (readonly CandidateChoice[])[]): void {
  const count = findings.length;
  const seen = new Set<number>();
  const kindOf = new Map(output.decisions.map((entry) => [entry.index, entry.decision]));
  const faults: string[] = [];
  for (const entry of output.decisions) {
    if (seen.has(entry.index)) {
      faults.push(`Decision [${String(entry.index)}] is given twice`);
      continue;
    }
    seen.add(entry.index);
    faults.push(...decisionFaults(entry, findings, kindOf));
  }
  const missing = missingIndexes(seen, count);
  if (missing.length > 0) faults.push(`The answer leaves out finding ${missing.map((position) => `[${String(position)}]`).join(', ')} of the ${String(count)} the task gave`);
  if (faults.length > 0) throw new StructuralCheckError(faultsMessage(faults));
}
