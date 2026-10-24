/**
 * The JSON form of the brief of a run (R16, PD11, TD8 of the brief of a
 * run), which `report --json` prints for a program: the loop of an author
 * agent, or a check a pull request must pass. Its shape is a contract, so
 * `briefJsonV1` states it as a schema with a version, and a change of the
 * shape is a new version, as for an event of the ledger, and the engine
 * writes the newest alone, version 3 since the questions in the chat.
 * Beside the brief it carries the local facts of the run, which the brief
 * itself never names: the paths of the copy and of the record, the
 * repository, the evidence store, and the command that continues a
 * stopped fix pass; and the later runs `report` passed over.
 */
import { z } from 'zod';
import { briefFates, gapKinds, lookConditions, type Brief, type BriefAnswer } from './brief.ts';
import { leftReasonKinds } from './documents.ts';
import type { PassedOver } from './report-choice.ts';
import { checkKinds } from './vocabulary.ts';

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

/** The local facts the JSON form carries beside the brief: the copy's path, or null when it could not be written, the record's, the repository, the store and the continue command or null. */
export type BriefLocal = BriefJsonV3['local'];

const answerJson = (given: BriefAnswer | null): BriefJsonV3['questions'][number]['answer'] => (given === null ? null : { kind: given.kind, option: given.option, words: given.words, at: given.at, applied: given.applied });

/** The brief as version 3 of its JSON form, with the run's local facts and the later runs `report` passed over; the sentence on the documentation step is the Markdown's, and the documents say what it left. */
export function briefJson(brief: Brief, local: BriefLocal, notShown: readonly PassedOver[]): BriefJsonV3 {
  const { change, changed } = brief;
  return {
    version: 3,
    run: brief.run,
    title: brief.title,
    headline: { ...brief.headline },
    changeState: change.state,
    change: change.state !== 'given' ? null : { what: change.what, why: change.why, whyFrom: [...change.whyFrom], restsOn: [...change.restsOn], publicInterface: { ...change.publicInterface, files: [...change.publicInterface.files] }, wideEffect: { ...change.wideEffect, files: [...change.wideEffect.files] }, beforeEdits: change.beforeEdits },
    questions: brief.questions.map((question) => ({
      id: question.id,
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
    departures: brief.departures.map((departure) => ({ ...departure, review: answerJson(departure.review) })),
    documents: brief.documents.map((document) => ({ file: document.file, facts: document.facts.map((fact) => ({ ...fact })), reasons: document.reasons.map((reason) => ({ ...reason })) })),
    notCovered: brief.notCovered.map((gap) => ({ ...gap })),
    covered: brief.covered,
    look: brief.look.map((entry) => ({ ...entry, findings: [...entry.findings] })),
    changed: {
      fixed: changed.fixed,
      decided: changed.decided,
      applied: [...brief.changed.applied],
      alreadyInTree: [...brief.changed.alreadyInTree],
      deferred: [...brief.changed.deferred],
      blocked: [...brief.changed.blocked],
      notAttempted: [...brief.changed.notAttempted],
      toFix: [...brief.changed.toFix],
      commits: brief.changed.commits === null ? null : { shas: [...brief.changed.commits.shas], uncommittedPatches: brief.changed.commits.uncommittedPatches },
      patches: changed.patches,
      left: [...brief.changed.left],
      checks: brief.changed.checks.map((check) => ({ ...check })),
    },
    local: { ...local },
    notShown: notShown.map((entry) => ({ run: entry.run, state: entry.state })),
  };
}
