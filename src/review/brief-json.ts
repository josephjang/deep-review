/**
 * The JSON form of the brief of a run (R16, PD11, TD8 of the brief of a
 * run), which `report --json` prints for a program: the loop of an author
 * agent, or a check a pull request must pass. Its shape is a contract, so
 * `briefJsonV1` states it as a schema with a version, and a change of the
 * shape is a new version, as for an event of the ledger, and the engine
 * writes the newest alone, version 5 since the report for the person.
 * Beside the brief it carries the local facts of the run, which the brief
 * itself never names: the paths of the copy and of the record, the
 * repository, the evidence store, and the command that continues a
 * stopped fix pass; and the later runs `report` passed over.
 */
import { z } from 'zod';
import { briefFates, findingStatuses, gapKinds, lookConditions, type Brief, type BriefAnswer } from './brief.ts';
import { checkFaults, lastMoments, notComparedReasons, validationStrengths, type ValidationStrength } from './brief-checks.ts';
import { leftReasonKinds } from './documents.ts';
import type { PassedOver } from './report-choice.ts';
import { needConditions } from './needs.ts';
import { baseReadings, checkKinds, severities, validationMethods } from './vocabulary.ts';

const text = z.string();
const ids = z.array(z.string());
const condition = z.strictObject({ holds: z.boolean(), what: text.nullable(), files: z.array(text) });
const answer = z.strictObject({ kind: z.enum(['option', 'accept', 'reject']), option: z.number().int().min(1).nullable(), words: text, at: text, applied: z.boolean() });

/**
 * The kinds of gap version 1 holds, frozen as an event's vocabulary is:
 * the kind `documentation` widened the brief's, so a program that reads
 * version 1 never meets a kind it does not know (TD7 of the documentation
 * step). A test holds them to today's kinds but the new one.
 */
export const gapKindsV1 = ['angle', 'unverified', 'excluded', 'oversized', 'check', 'fix', 'budget', 'stop'] as const;

/** The core of the change as versions 1 and 2 hold it. */
const changeV1 = z.strictObject({ what: text, why: text.nullable(), whyFrom: z.array(text), restsOn: z.array(text), publicInterface: condition, wideEffect: condition });

/** Version 1 of the JSON form of the brief. */
export const briefJsonV1 = z.strictObject({
  version: z.literal(1),
  run: text,
  title: text,
  headline: z.strictObject({ text, questions: z.number().int().min(0), departures: z.number().int().min(0) }),
  /** Whether the triage gave the core of the change, gave none, or recorded none, as an engine before the account did. */
  changeState: z.enum(['given', 'none', 'unrecorded']),
  change: changeV1.nullable(),
  questions: z.array(z.strictObject({
    id: text,
    question: text,
    default: z.number().int().min(1),
    defaultApplied: z.boolean(),
    choice: z.number().int().min(1),
    options: z.array(z.strictObject({ option: text, cost: text, rule: text, edits: z.boolean() })),
    lookedIn: z.array(text),
    grounds: text,
    answer: answer.nullable(),
    command: text,
  })),
  departures: z.array(z.strictObject({
    id: text,
    rule: text,
    source: text,
    fact: text,
    fix: text,
    fate: z.enum(briefFates),
    review: answer.nullable(),
    accept: text,
    reject: text,
  })),
  notCovered: z.array(z.strictObject({ kind: z.enum(gapKindsV1), text })),
  covered: text.nullable(),
  look: z.array(z.strictObject({ condition: z.enum(lookConditions), findings: ids, text })),
  changed: z.strictObject({
    fixed: z.boolean(),
    decided: z.boolean(),
    applied: ids,
    alreadyInTree: ids,
    deferred: ids,
    blocked: ids,
    notAttempted: ids,
    toFix: ids,
    commits: z.strictObject({ shas: ids, uncommittedPatches: z.number().int().min(0) }).nullable(),
    patches: z.number().int().min(0),
    left: ids,
    checks: z.array(z.strictObject({ kind: z.enum(checkKinds), before: text.nullable(), after: text.nullable() })),
  }),
  local: z.strictObject({ copy: text.nullable(), record: text, repository: text, store: text, continueCommand: text.nullable() }),
});
export type BriefJsonV1 = z.infer<typeof briefJsonV1>;

/**
 * Version 2 of the JSON form of the brief (R7, TD7 of the documentation
 * step): version 1 with the count of the documents the run left out of
 * date in the headline, those documents, each with its facts and who
 * reported each and its reasons, and the kind of gap `documentation`.
 */
export const briefJsonV2 = z.strictObject({
  ...briefJsonV1.shape,
  version: z.literal(2),
  headline: z.strictObject({ text, questions: z.number().int().min(0), departures: z.number().int().min(0), documents: z.number().int().min(0) }),
  documents: z.array(z.strictObject({
    file: text,
    facts: z.array(z.strictObject({ what: text, by: text })),
    reasons: z.array(z.strictObject({ kind: z.enum(leftReasonKinds), text })),
  })),
  notCovered: z.array(z.strictObject({ kind: z.enum(gapKinds), text })),
});
export type BriefJsonV2 = z.infer<typeof briefJsonV2>;

/**
 * Version 3 of the JSON form of the brief (R5, R8 of the questions in the
 * chat): version 2 with `notShown`, each later run of the worktree that
 * `report` passed over because it has no report, with its id and why, so
 * that a program does not take an older result for the current one; empty
 * when `--run` named the run. Its `change` also holds `beforeEdits`, the
 * mark the text forms give an account written before the fixes and the
 * answers of the run.
 */
export const briefJsonV3 = z.strictObject({
  ...briefJsonV2.shape,
  version: z.literal(3),
  change: z.strictObject({ ...changeV1.shape, beforeEdits: z.boolean() }).nullable(),
  notShown: z.array(z.strictObject({ run: text, state: text })),
});
export type BriefJsonV3 = z.infer<typeof briefJsonV3>;

/**
 * Version 4 of the JSON form of the brief (R9, TD10 of the facts before a
 * merge): version 3 with the count of the checks the edits of the run
 * made fail in the headline; each check with `last`, its last run and
 * when it ran, in place of `after`, which read a failure after the
 * answers as one after the fixes (#78), with what its base says and its
 * fault; and the applied fixes under the strongest validation of each.
 */
export const briefJsonV4 = z.strictObject({
  ...briefJsonV3.shape,
  version: z.literal(4),
  headline: z.strictObject({ text, questions: z.number().int().min(0), departures: z.number().int().min(0), documents: z.number().int().min(0), checks: z.number().int().min(0) }),
  changed: z.strictObject({
    ...briefJsonV3.shape.changed.shape,
    checks: z.array(z.strictObject({
      kind: z.enum(checkKinds),
      before: text.nullable(),
      last: z.strictObject({ outcome: text, when: z.enum(lastMoments) }).nullable(),
      base: z.strictObject({ commit: text, name: text, outcome: text.nullable(), reading: z.enum(baseReadings).nullable(), reason: z.enum(notComparedReasons).nullable() }).nullable(),
      fault: z.enum(checkFaults).nullable(),
    })),
    validation: z.strictObject(Object.fromEntries(validationStrengths.map((strength) => [strength, ids])) as Record<ValidationStrength, typeof ids>),
  }),
});
export type BriefJsonV4 = z.infer<typeof briefJsonV4>;

/** A question as version 5 gives it: version 4's, with the number of its finding. */
const questionV5 = z.strictObject({ ...briefJsonV1.shape.questions.element.shape, finding: z.number().int().min(1) });
/** A fix that goes against a written rule as version 5 gives it: version 4's, with the number of its finding. */
const departureV5 = z.strictObject({ ...briefJsonV1.shape.departures.element.shape, finding: z.number().int().min(1) });
const count = z.number().int().min(0);

/**
 * Version 5 of the JSON form of the brief (R13, TD8 of the report for the
 * person), a schema of its own: the run, the title, the state and the
 * account of the change, the questions, the departures, the documents,
 * the local facts and the runs passed over as version 4 has them, each
 * question and departure with the number of its finding; and in place of
 * the headline, the gaps, what was covered, where to look and what
 * changed: the status line with its counts, each finding with its number,
 * its ids, its verdict and its status, the items of "What needs you" with
 * their rank and condition and their count line, each check with its
 * results, its meaning and who compared it, each fix with the kinds of its
 * validations and its patches, what the run did not examine, and the
 * findings left as is.
 */
export const briefJsonV5 = z.strictObject({
  version: z.literal(5),
  run: text,
  title: text,
  changeState: briefJsonV4.shape.changeState,
  change: briefJsonV4.shape.change,
  status: z.strictObject({
    kind: z.enum(['fix', 'review']),
    findings: count,
    fixed: count,
    againstRule: count,
    alreadyInTree: count,
    notFixed: count,
    questions: count,
    answered: z.array(z.number().int().min(1)),
    left: count,
    toFix: count,
    committed: z.enum(['none', 'some', 'all']),
    text,
  }),
  findings: z.array(z.strictObject({ number: z.number().int().min(1), id: text, merged: ids, severity: z.enum(severities), verdict: z.enum(['CONFIRMED', 'PLAUSIBLE']), status: z.enum(findingStatuses), summary: text })),
  needs: z.array(z.strictObject({
    rank: z.number().int().min(1).max(8),
    condition: z.enum(needConditions),
    finding: z.number().int().min(1).nullable(),
    check: z.enum(checkKinds).nullable(),
    document: text.nullable(),
    patch: z.number().int().min(1).nullable(),
    lines: z.array(text),
  })),
  needsLine: text,
  checks: z.array(z.strictObject({
    ...briefJsonV4.shape.changed.shape.checks.element.shape,
    meaning: text,
    comparedBy: z.enum(['engine', 'model']).nullable(),
  })),
  baseChecks: z.boolean(),
  base: text,
  fixes: z.array(z.strictObject({
    finding: z.number().int().min(1).nullable(),
    severity: z.enum(severities).nullable(),
    plausible: z.boolean(),
    againstRule: z.boolean(),
    subject: text,
    kinds: z.array(z.enum(validationMethods)),
    patches: z.array(z.number().int().min(1)),
  })),
  notExamined: z.array(text),
  leftAs: text.nullable(),
  questions: z.array(questionV5),
  departures: z.array(departureV5),
  documents: briefJsonV4.shape.documents,
  local: briefJsonV4.shape.local,
  notShown: briefJsonV4.shape.notShown,
});
export type BriefJsonV5 = z.infer<typeof briefJsonV5>;

/** The local facts the JSON form carries beside the brief: the copy's path, or null when it could not be written, the record's, the repository, the store and the continue command or null. */
export type BriefLocal = BriefJsonV5['local'];

const answerJson = (given: BriefAnswer | null): BriefJsonV5['questions'][number]['answer'] => (given === null ? null : { kind: given.kind, option: given.option, words: given.words, at: given.at, applied: given.applied });

/** The brief as version 5 of its JSON form, with the run's local facts and the later runs `report` passed over (R13 of the report for the person). */
export function briefJson(brief: Brief, local: BriefLocal, notShown: readonly PassedOver[]): BriefJsonV5 {
  const { change } = brief;
  return {
    version: 5,
    run: brief.run,
    title: brief.title,
    changeState: change.state,
    change: change.state !== 'given' ? null : { what: change.what, why: change.why, whyFrom: [...change.whyFrom], restsOn: [...change.restsOn], publicInterface: { ...change.publicInterface, files: [...change.publicInterface.files] }, wideEffect: { ...change.wideEffect, files: [...change.wideEffect.files] }, beforeEdits: change.beforeEdits },
    status: { ...brief.status, answered: [...brief.status.answered] },
    findings: brief.findings.map((finding) => ({ ...finding, merged: [...finding.merged] })),
    needs: brief.needs.map((need) => ({ ...need, lines: [...need.lines] })),
    needsLine: brief.needsLine,
    // When a check passed and failed before its last run is for the words of the brief; its fault and meaning say what a program needs of it.
    checks: brief.checks.map((check) => ({ kind: check.kind, before: check.before, last: check.last === null ? null : { ...check.last }, base: check.base === null ? null : { ...check.base }, fault: check.fault, meaning: check.meaning, comparedBy: check.comparedBy })),
    baseChecks: brief.baseChecks,
    base: brief.base,
    fixes: brief.fixes.map((fix) => ({ ...fix, kinds: [...fix.kinds], patches: [...fix.patches] })),
    notExamined: [...brief.notExamined],
    leftAs: brief.leftAs,
    questions: brief.questions.map((question) => ({
      id: question.id,
      finding: question.finding,
      question: question.question,
      default: question.default,
      defaultApplied: question.defaultApplied,
      choice: question.choice,
      options: question.options.map((option) => ({ option: option.option, cost: option.cost, rule: option.rule, edits: option.edits })),
      lookedIn: [...question.lookedIn],
      grounds: question.grounds,
      answer: answerJson(question.answer),
      command: question.command,
    })),
    departures: brief.departures.map((departure) => ({ id: departure.id, rule: departure.rule, source: departure.source, fact: departure.fact, fix: departure.fix, fate: departure.fate, review: answerJson(departure.review), accept: departure.accept, reject: departure.reject, finding: departure.finding })),
    documents: brief.documents.map((document) => ({ file: document.file, facts: document.facts.map((fact) => ({ ...fact })), reasons: document.reasons.map((reason) => ({ ...reason })) })),
    local: { ...local },
    notShown: notShown.map((entry) => ({ run: entry.run, state: entry.state })),
  };
}
