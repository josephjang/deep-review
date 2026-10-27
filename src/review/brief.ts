/**
 * The brief of a run (R1, R2 of the brief of a run): the part of its
 * result a person reads first, as one value computed from the fold alone.
 * It holds the core of the change, the questions only a person can
 * answer, the fixes that go against a written rule, the documents the
 * run left out of date (R7 of the documentation step), what the run did
 * not cover, where a person must look, and what deep-review changed. Nothing
 * records it: each command computes it again, so it is current after an
 * answer or a commit, and the same engine computes the same brief from
 * the same ledger. The report, the output of a command and the JSON form
 * each render this one value.
 */
import { answerWords, standingAnswer, type RecordedAnswer } from '../checkpoint/answer-state.ts';
import type { ChangeCondition, RecordedDecision, ScopeMode, ScopeState } from '../checkpoint/events.ts';
import { allBatches, budgetStoppedUnits, committedRevisions, lastCurrentRun, lastRecordedRun, type CheckRunState, type FixState } from '../checkpoint/fix-state.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { unverifiedGroupsOf, type ReviewState, type TriageAccount } from '../checkpoint/review-fold.ts';
import { endedByKill } from '../runtime/kill-marks.ts';
import { answerCommandOf, defaultInPlace } from './decision-report.ts';
import { leftByStep, leftDocumentsOf, stepNotRunCause, stepNotRunSentence, type LeftDocument } from './documents.ts';
import { validationOf, validationSentence, type BriefValidation } from './brief-checks.ts';
import { findingOutcomes, lastFixAnswer, type FindingOutcome, type FindingOutcomes } from './fix-report.ts';
import { codeSpan, counted, findingLink, inlineText, listed, paragraphText, sentenceText, tableCell } from './markdown.ts';
import { shortRunId } from './runs.ts';
import { ranAgain, rankedFindings, type ReportFinding } from './state.ts';
import { droppedByOperator } from './survey-report.ts';
import { documentationUnitKey, type CheckKind } from './vocabulary.ts';

/** The core of the change: the triage's whole account, uncut (R3), or why the run has none. */
export type BriefChange =
  | {
      readonly state: 'given';
      /** What the change does, as the triage wrote it. */
      readonly what: string;
      /** Why, in the change's own words, as the triage wrote it, or null when the change states none. */
      readonly why: string | null;
      readonly whyFrom: readonly string[];
      readonly restsOn: readonly string[];
      /** The triage's two judgments of principle 8, which `look` names when they hold. */
      readonly publicInterface: ChangeCondition;
      readonly wideEffect: ChangeCondition;
      /**
       * Whether a fixer or an answer pass applied a fix, so the account,
       * written before any fix, describes the change before the fixes
       * (R5 of the questions in the chat). A rewrite by a check or an
       * edit of the documentation step changes no behavior the account
       * describes, so it does not count.
       */
      readonly beforeEdits: boolean;
    }
  /** The triage gave no account. */
  | { readonly state: 'none' }
  /** An engine before the account reviewed the run, so its triage recorded none. */
  | { readonly state: 'unrecorded' };

/** One option of a question, numbered from 1 as the answer command takes it. */
export interface BriefOption {
  readonly number: number;
  readonly option: string;
  readonly cost: string;
  readonly rule: string;
  readonly edits: boolean;
}

/** An answer a person gave, as the brief says it. */
export interface BriefAnswer {
  /** What the person gave: an option, or an acceptance or a rejection of a departure. */
  readonly kind: 'option' | 'accept' | 'reject';
  /** The option chosen, numbered from 1, or null for an acceptance or a rejection. */
  readonly option: number | null;
  /** The answer as the engine words it, such as `option 2` or `accepted`. */
  readonly words: string;
  readonly at: string;
  /** Whether the tree holds it: applied by a pass or the tree already. */
  readonly applied: boolean;
}

/** A question only a person can answer (R7, R8 of the brief of a run). */
export interface BriefQuestion {
  readonly id: string;
  readonly question: string;
  /** The default, the option that is the easiest to take back. */
  readonly default: number;
  /**
   * Whether the default is in place: one that keeps the code is; one that
   * edits it is once a fixer applied it, and never in a run that only
   * reviewed.
   */
  readonly defaultApplied: boolean;
  /** The option deep-review thinks best. */
  readonly choice: number;
  readonly options: readonly BriefOption[];
  readonly lookedIn: readonly string[];
  readonly grounds: string;
  readonly answer: BriefAnswer | null;
  /** The command that takes deep-review's choice. */
  readonly command: string;
}

/**
 * What became of a decided fix: as the fix pass left it, or `not-fixed`
 * in a run that only reviewed. The brief's plain words for each are in
 * the table of the design (`fateWords`).
 */
export const briefFates = ['applied', 'already-in-tree', 'deferred', 'blocked', 'not-attempted', 'not-fixed'] as const;
export type BriefFate = (typeof briefFates)[number];

/** A fix that goes against a written rule (R9 of the brief of a run). */
export interface BriefDeparture {
  readonly id: string;
  readonly rule: string;
  readonly source: string;
  /** The decider's reason, in plain words: why the rule does not reach this case, and what the fix does instead. */
  readonly fact: string;
  /** The approach the decider gave the fixer, which the JSON form keeps for a program; the Markdown leaves it to the evidence (R9). */
  readonly fix: string;
  readonly fate: BriefFate;
  readonly review: BriefAnswer | null;
  readonly accept: string;
  readonly reject: string;
}

/** The kinds of gap of R10: what the run did not examine, and what it did not finish, the documentation step among it (R7 of the documentation step). */
export const gapKinds = ['angle', 'unverified', 'excluded', 'oversized', 'check', 'fix', 'budget', 'stop', 'documentation'] as const;
export type GapKind = (typeof gapKinds)[number];

/** One thing the run did not cover, in plain words. */
export interface BriefGap {
  readonly kind: GapKind;
  readonly text: string;
}

/** The conditions of principle 8 that the brief names (R11 of the brief of a run). */
export const lookConditions = ['departure', 'plausible', 'public-interface', 'wide-effect'] as const;
export type LookCondition = (typeof lookConditions)[number];

/** A condition of principle 8 that holds, with its findings and its words. */
export interface BriefLook {
  readonly condition: LookCondition;
  readonly findings: readonly string[];
  readonly text: string;
}

/**
 * One check's outcome before the fixes and after them, by its current run, else the run that checked the newest tree, or null where it did not run.
 * After an answer pass that newest run is the answer pass's check, which `after` then words as after the fixes: https://github.com/josephjang/deep-review/issues/78
 */
export interface BriefCheck {
  readonly kind: CheckKind;
  readonly before: string | null;
  readonly after: string | null;
}

/** What deep-review changed (R2 of the brief of a run). */
export interface BriefChanged {
  /** Whether the run fixed; a run that only reviewed changed nothing. */
  readonly fixed: boolean;
  /** Whether the run decided its findings: false for a run configured before the decision step, and for one that ranked none. */
  readonly decided: boolean;
  readonly applied: readonly string[];
  readonly alreadyInTree: readonly string[];
  readonly deferred: readonly string[];
  readonly blocked: readonly string[];
  readonly notAttempted: readonly string[];
  /** The findings decided to fix in a run that only reviewed, which `review --fix` applies; empty in a run that fixed. */
  readonly toFix: readonly string[];
  /** The commits that hold the edits, oldest first, and how many patches no commit holds yet; null before any commit. */
  readonly commits: { readonly shas: readonly string[]; readonly uncommittedPatches: number } | null;
  /** How many patches the run made; 0 in a run that only reviewed. */
  readonly patches: number;
  readonly left: readonly string[];
  readonly checks: readonly BriefCheck[];
  /** What the documentation step did, as one sentence, or null in a run that only reviewed or that an engine before the step configured (R10 of the documentation step). */
  readonly documentation: string | null;
  /** The applied fixes under the strongest validation the answer that applied each reported (R7 of the facts before a merge); each list empty in a run that only reviewed. */
  readonly validation: BriefValidation;
}

/** A document the edits of the run left out of date (R7 of the documentation step), as `leftDocumentsOf` gives it. */
export type BriefDocument = LeftDocument;

export interface Brief {
  readonly run: string;
  readonly title: string;
  /** How many open questions, unreviewed departures and documents left out of date need the person, and the sentence that says so. */
  readonly headline: { readonly questions: number; readonly departures: number; readonly documents: number; readonly text: string };
  readonly change: BriefChange;
  readonly questions: readonly BriefQuestion[];
  readonly departures: readonly BriefDeparture[];
  /** The documents the edits of a fix run left out of date, none in a run that only reviewed (R7 of the documentation step). */
  readonly documents: readonly BriefDocument[];
  readonly notCovered: readonly BriefGap[];
  /** The sentence that says the run covered everything R10 names, or null when a gap is listed. */
  readonly covered: string | null;
  readonly look: readonly BriefLook[];
  readonly changed: BriefChanged;
}

/**
 * `text` cut at a word to at most `max` characters, three periods
 * included, or as it is when it fits. A text with no space early enough
 * is cut where the limit falls, short of a character the limit would
 * split in two, so the result stays well formed.
 */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  // The limit counts UTF-16 units, as every limit here does; a cut after a high surrogate drops it rather than leave half a character.
  const room = text.slice(0, max - 3).replace(/[\uD800-\uDBFF]$/, '');
  const space = room.lastIndexOf(' ');
  const kept = (space > max / 2 ? room.slice(0, space) : room).replace(/[\s,;:.]+$/, '');
  return `${kept}...`;
}

/**
 * What a change is made of, which the mode of its scope settles: the
 * working tree alone (`worktree`, whose base is HEAD); one commit
 * (`last-commit`, its head against its parent, or the empty tree for a
 * root commit); or the commits from its base to HEAD with whatever the
 * working tree holds uncommitted (`ref` and `range`, which diff the base
 * against the working tree).
 */
export type ChangeShape = 'working-tree' | 'commit' | 'commits-and-tree';

const shapeOfMode: Record<ScopeMode, ChangeShape> = { worktree: 'working-tree', 'last-commit': 'commit', ref: 'commits-and-tree', range: 'commits-and-tree' };

/** The shape of a scope's change, from its mode alone. */
export const changeShapeOf = (scope: Pick<ScopeState, 'mode'>): ChangeShape => shapeOfMode[scope.mode];

/** The title of a run whose triage gave no account, by the shape of its change: the uncommitted change on its head, the commit, or the change from its base to its head with the working tree. */
function scopeTitle(state: RunState): string {
  const scope = state.scope!;
  const short = (commit: string): string => commit.slice(0, 8);
  switch (changeShapeOf(scope)) {
    case 'working-tree':
      return `The uncommitted change on ${short(scope.head)}`;
    case 'commit':
      // A root commit's base is the empty tree, which is no commit to name.
      return `The commit ${short(scope.head)}`;
    case 'commits-and-tree':
      return `The change from ${short(scope.base)} to ${short(scope.head)}, with the working tree`;
  }
}


/** An answer as the brief says it: its words, when, and whether the tree holds it. */
const answerOf = (answer: RecordedAnswer): BriefAnswer => ({ kind: answer.answer.kind, option: answer.answer.kind === 'option' ? answer.answer.option + 1 : null, words: answerWords(answer.answer), at: answer.at, applied: answer.appliedBy !== null });

/** A fix pass's outcome of a finding in the brief's vocabulary; a finding no fixer was given has none. */
export const fateWordsOf: Readonly<Partial<Record<FindingOutcome, Exclude<BriefFate, 'not-fixed'>>>> = {
  applied: 'applied',
  'already applied': 'already-in-tree',
  deferred: 'deferred',
  blocked: 'blocked',
  'not attempted': 'not-attempted',
};

/** What every part of the brief reads of the fold, each computed once: the ranked findings with their decisions, and in a fix run what became of each. */
interface BriefContext {
  readonly state: RunState;
  readonly review: ReviewState;
  /** The ranked findings in rank order, each with its decision, or null in a run configured before the decision step. */
  readonly findings: readonly { readonly entry: ReportFinding; readonly decision: RecordedDecision | null }[];
  /** In a fix run, each ranked finding's outcomes by its id, the last pass's and the fix pass's; empty in a run that only reviewed. */
  readonly outcomes: ReadonlyMap<string, FindingOutcomes>;
  /** The documents the run left out of date, none in a run that only reviewed. */
  readonly documents: readonly BriefDocument[];
}

function contextOf(state: RunState, review: ReviewState): BriefContext {
  const byId = new Map((review.decisions ?? []).map((decision) => [decision.id, decision]));
  const findings = rankedFindings(review).map((entry) => ({ entry, decision: byId.get(entry.finding.id) ?? null }));
  const fix = review.fix;
  const outcomes = new Map(fix === null ? [] : findings.map(({ entry }) => [entry.finding.id, findingOutcomes(review, fix, entry.finding.id)] as const));
  return { state, review, findings, outcomes, documents: leftDocumentsOf(review) };
}

/** The decisions of a kind, in rank order. */
function decisionsOf<K extends RecordedDecision['decision']>(context: BriefContext, kind: K): Extract<RecordedDecision, { decision: K }>[] {
  return context.findings.flatMap(({ decision }) => (decision !== null && decision.decision === kind ? [decision as Extract<RecordedDecision, { decision: K }>] : []));
}

/** The ids of the findings a fix run left with `outcome` as Fixes names it, the last pass's, in rank order. */
const withOutcome = (context: BriefContext, outcome: FindingOutcome): string[] => [...context.outcomes].filter(([, found]) => found.last === outcome).map(([id]) => id);

/** The ids of the findings whose last outcome is `fate` in the brief's vocabulary, in rank order. */
const withFate = (context: BriefContext, fate: BriefFate): string[] => [...context.outcomes].filter(([, found]) => fateWordsOf[found.last] === fate).map(([id]) => id);

function questionsOf(context: BriefContext): BriefQuestion[] {
  return decisionsOf(context, 'ask').map((decision) => {
    const { ask } = decision;
    const standing = standingAnswer(context.review, decision.id);
    return {
      id: decision.id,
      question: ask.question,
      default: ask.applied + 1,
      defaultApplied: defaultInPlace(context.review, decision),
      choice: ask.recommended + 1,
      options: ask.options.map((option, index) => ({ number: index + 1, option: option.option, cost: option.cost, rule: option.rule, edits: option.edits })),
      lookedIn: ask.searched,
      grounds: decision.grounds,
      answer: standing === null ? null : answerOf(standing),
      command: answerCommandOf(decision.id, `--option ${String(ask.recommended + 1)}`),
    };
  });
}

function departuresOf(context: BriefContext): BriefDeparture[] {
  return decisionsOf(context, 'fix').flatMap((decision) => {
    if (decision.departure === null) return [];
    const standing = standingAnswer(context.review, decision.id);
    // The fate of the decided fix is the fix pass's: an answer pass after it worked the person's answer, not the fix.
    const outcome = context.outcomes.get(decision.id)?.fixPass;
    return [{
      id: decision.id,
      rule: decision.departure.rule,
      source: decision.departure.source,
      fact: decision.departure.reason,
      fix: decision.fix.approach,
      // A decided fix is given to a fixer, so its outcome is a fixer's or not attempted; a run that only reviewed has none.
      fate: context.review.fix === null ? 'not-fixed' : (outcome === undefined ? undefined : fateWordsOf[outcome]) ?? 'not-attempted',
      review: standing === null ? null : answerOf(standing),
      accept: answerCommandOf(decision.id, '--accept'),
      reject: answerCommandOf(decision.id, '--reject'),
    }];
  });
}

/** The checks phases after the fixes, the latest first. */
const afterPhases = ['answer-checks', 'repair-checks', 'checks'] as const;

/**
 * Each check with a command, its outcome before the fixes and after them:
 * the current run (`lastCurrentRun`) of the latest phase that has one, so
 * no run a later revision made old stands for the tree; or when none is
 * current, the run that checked the newest tree.
 */
function checksOf(review: Pick<ReviewState, 'answerPasses'> & { readonly fix: FixState }): BriefCheck[] {
  const { fix } = review;
  return (fix.checks.planned?.checks ?? []).filter((check) => check.command !== null).map((check) => {
    const before = lastRecordedRun(fix, 'baseline-checks', check.kind)?.outcome ?? null;
    const current = afterPhases.map((phase) => lastCurrentRun(review, phase, check.kind)).find((run) => run !== null);
    const newest = afterPhases.map((phase) => lastRecordedRun(fix, phase, check.kind)).reduce<CheckRunState | null>((found, run) => (run !== null && (found === null || run.revisionsBefore > found.revisionsBefore) ? run : found), null);
    return { kind: check.kind, before, after: (current ?? newest)?.outcome ?? null };
  });
}

/** What an unfinished check did, in plain words, by its outcome. */
const unfinishedOutcomeWords: Readonly<Record<string, string>> = {
  timeout: 'timed out',
  skipped: 'was skipped',
  'not-started': 'did not start',
};

/** What an unfinished check did, in plain words, or null for one that ran to an outcome. */
const unfinishedWords = (outcome: string | null): string | null => (outcome !== null && Object.hasOwn(unfinishedOutcomeWords, outcome) ? unfinishedOutcomeWords[outcome]! : null);

/** The gaps of a fix run: each check that did not run or finish, each fix no fixer applied, the work the run budget did not start, and a commit a stop cut short. */
function fixGaps(context: BriefContext, fix: FixState): BriefGap[] {
  const gaps: BriefGap[] = [];
  for (const check of fix.checks.planned?.checks ?? []) {
    // A check the project defines that the operator dropped says so, with the tool this machine lacked (R15 of the repository survey).
    if (check.command === null) gaps.push({ kind: 'check', text: `No ${check.kind} check ran: ${droppedByOperator(context.review.survey, check) ?? check.reason ?? 'the run has no command for it'}.` });
  }
  for (const check of checksOf({ answerPasses: context.review.answerPasses, fix })) {
    const unfinished = [check.before, check.after].map(unfinishedWords).filter((words) => words !== null);
    if (unfinished.length > 0) gaps.push({ kind: 'check', text: `The ${check.kind} check did not finish: it ${unfinished.join(', then ')}.` });
  }
  // A fix not attempted says why, as the fold records it, in plain words that name no batch (R12); a deferred or blocked one says its fate.
  const unappliedWords = (fate: BriefFate, id: string): string => {
    if (fate !== 'not-attempted') return fateClause(fate);
    switch (context.outcomes.get(id)?.unattempted) {
      case 'budget':
        return `${fateClause(fate)} before the run budget was reached`;
      case 'failures':
        return 'its fixer failed twice and gave no answer';
      default:
        return fateClause(fate);
    }
  };
  // What went to a fixer: a person's answer, when an answer pass gave the outcome; else by its decision, a fix, the default of a question that edits the code, or for a run configured before the decision step, a finding the run routed.
  const decidedOf = new Map(context.findings.map(({ entry, decision }) => [entry.finding.id, decision?.decision ?? null]));
  const wentToFixer = (id: string): string => {
    if (context.outcomes.get(id)?.byAnswerPass === true) return `The answer on ${id} went to a fixer`;
    switch (decidedOf.get(id)) {
      case 'ask':
        return `The default of the question on ${id} went to a fixer`;
      case 'fix':
        return `${id} was decided as a fix`;
      default:
        return `${id} went to a fixer`;
    }
  };
  for (const fate of ['deferred', 'blocked', 'not-attempted'] as const) {
    for (const id of withFate(context, fate)) gaps.push({ kind: 'fix', text: `${wentToFixer(id)}, and ${unappliedWords(fate, id)}.` });
  }
  const stopped = budgetStoppedUnits(fix);
  if (stopped.length > 0) {
    // In plain words, the findings the stopped batches hold, since the brief names no batch (R12): those left not attempted, as the gaps above list them, not a second-round batch's that the first round answered.
    const keys = new Set(stopped.filter((unit) => unit.phase === 'fixes').map((unit) => unit.key));
    const findings = new Set(allBatches(fix).filter((batch) => keys.has(batch.key)).flatMap((batch) => batch.findingIds).filter((id) => context.outcomes.get(id)?.last === 'not attempted')).size;
    const parts = [
      ...(keys.size === 0 ? [] : [findings === 0 ? 'some of the fixes' : counted(findings, 'finding', 'findings')]),
      ...(stopped.some((unit) => unit.phase === 'documentation') ? ['the documentation step'] : []),
      ...(stopped.some((unit) => unit.phase === 'repair') ? ['the repair of the checks'] : []),
    ];
    const verb = parts.length === 1 && (findings === 1 || keys.size === 0) ? 'was' : 'were';
    gaps.push({ kind: 'budget', text: `The run budget stopped the fixes before ${listed(parts)} ${verb} attempted. The facts of the run at the end of the report give the command that continues them.` });
  }
  if (fix.openSeries !== null) gaps.push({ kind: 'stop', text: 'A stop cut `deep-review commit` short; the next command completes the commits or drops them.' });
  // A step that did not answer brought no document in line; one whose fixes changed no file had nothing to do, and a run an engine before the step configured never had one, though its brief counts its lines (R7, R8, R11 of the documentation step).
  const cause = stepNotRunCause(context.review);
  if (context.review.documentationStep && cause !== null && cause !== 'no-edits') gaps.push({ kind: 'documentation', text: `${stepNotRunSentence(cause)}${context.documents.length === 0 ? '' : ' The documents left are in Documents left out of date.'}` });
  return gaps;
}

/** What the run did not cover (R10 of the brief of a run), in plain words, each gap with its kind. */
function gapsOf(context: BriefContext): BriefGap[] {
  const { state, review } = context;
  const scope = state.scope!;
  const gaps: BriefGap[] = [];
  for (const [angle, reason] of Object.entries(review.anglesNotRun)) gaps.push({ kind: 'angle', text: `The ${angle} angle did not run (${reason}). A later pass looked for what it would have found.` });
  for (const group of unverifiedGroupsOf(review)) gaps.push({ kind: 'unverified', text: `No verifier examined ${group.candidateIds.join(', ')} (${group.reason}); each counts as PLAUSIBLE.` });
  if (scope.excluded.count > 0) gaps.push({ kind: 'excluded', text: `${counted(scope.excluded.count, 'changed path', 'changed paths')} under ${scope.request.exclude.join(', ')}, which the settings leave out.` });
  const oversized = scope.files.filter((file) => (file.before !== null && 'oversized' in file.before) || (file.after !== null && 'oversized' in file.after)).map((file) => file.path);
  if (oversized.length > 0) gaps.push({ kind: 'oversized', text: `${counted(oversized.length, 'file', 'files')} too large to freeze, which no worker was given: ${oversized.join(', ')}.` });
  if (review.fix !== null) gaps.push(...fixGaps(context, review.fix));
  // A worker a stop ended, by a kill or with its engine, whose unit no later worker of the same label ran again.
  const workers = Object.values(state.workers);
  const stopped = workers.filter((worker) => (worker.status === 'lost' || (worker.status === 'finished' && endedByKill(worker.finish))) && !ranAgain(workers, worker));
  if (stopped.length > 0) gaps.push({ kind: 'stop', text: `A stop ended ${counted(stopped.length, 'worker', 'workers')} whose work did not run again; the notes of the run name ${stopped.length === 1 ? 'it' : 'them'}.` });
  return gaps;
}

/** A judgment of the triage as the text of its condition: what, and the files that show it. */
const judgedWords = (condition: ChangeCondition): string => `${condition.what === null ? '' : `: ${condition.what.trim().replace(/[.]+$/, '')}`}${condition.files.length === 0 ? '' : ` (${condition.files.join(', ')})`}`;

/**
 * The conditions of principle 8 that hold (R11 of the brief of a run),
 * each with its findings: the fixes that go against a written rule and
 * that no person has accepted or rejected yet; the fixes a fixer applied
 * on a verdict that is only PLAUSIBLE, or in a run that only reviewed,
 * the findings decided as fixes on one; and the two judgments of the
 * triage, marked as its own.
 */
function lookOf(context: BriefContext, departures: readonly BriefDeparture[]): BriefLook[] {
  const { review } = context;
  const look: BriefLook[] = [];
  // A departure a person reviewed has been looked at; the departures part says what they decided.
  const unreviewed = departures.filter((departure) => departure.review === null);
  if (unreviewed.length > 0) look.push({ condition: 'departure', findings: unreviewed.map((departure) => departure.id), text: `${counted(unreviewed.length, 'fix goes', 'fixes go')} against a written rule` });
  const plausible = context.findings
    .filter(({ entry, decision }) => entry.resolution.verdict === 'PLAUSIBLE' && (review.fix === null ? decision?.decision === 'fix' : context.outcomes.get(entry.finding.id)?.last === 'applied'))
    .map(({ entry }) => entry.finding.id);
  if (plausible.length > 0) {
    const what = review.fix === null ? counted(plausible.length, 'finding decided as a fix rests', 'findings decided as fixes rest') : counted(plausible.length, 'fix rests', 'fixes rest');
    look.push({ condition: 'plausible', findings: plausible, text: `${what} on a verdict that is only PLAUSIBLE` });
  }
  if (review.change.kind === 'given') {
    const { publicInterface, wideEffect } = review.change.reading;
    if (publicInterface.holds) look.push({ condition: 'public-interface', findings: [], text: `The change alters a public interface, in the triage's judgment${judgedWords(publicInterface)}` });
    if (wideEffect.holds) look.push({ condition: 'wide-effect', findings: [], text: `The change affects many files beyond the ones it changes, in the triage's judgment${judgedWords(wideEffect)}` });
  }
  return look;
}

function changedOf(context: BriefContext): BriefChanged {
  const fix = context.review.fix;
  const left = decisionsOf(context, 'leave').map((decision) => decision.id);
  if (fix === null) {
    const toFix = decisionsOf(context, 'fix').map((decision) => decision.id);
    return { fixed: false, decided: context.review.decisions !== null, applied: [], alreadyInTree: [], deferred: [], blocked: [], notAttempted: [], toFix, commits: null, patches: 0, left, checks: [], documentation: null, validation: validationOf([]) };
  }
  const shas = fix.commits.flatMap((series) => series.commits.map((commit) => commit.sha));
  const applied = withOutcome(context, 'applied');
  return {
    fixed: true,
    decided: context.review.decisions !== null,
    applied,
    alreadyInTree: withOutcome(context, 'already applied'),
    deferred: withOutcome(context, 'deferred'),
    blocked: withOutcome(context, 'blocked'),
    notAttempted: withOutcome(context, 'not attempted'),
    toFix: [],
    commits: shas.length === 0 ? null : { shas, uncommittedPatches: fix.revisions.length - committedRevisions(fix) },
    patches: fix.revisions.length,
    // A finding a run configured before the decision step held for the author was left by no decision, and counts with those left.
    left: [...left, ...withOutcome(context, 'held for the author')],
    checks: checksOf({ answerPasses: context.review.answerPasses, fix }),
    documentation: context.review.documentationStep ? documentationWords(context.review, fix) : null,
    // The answer that gave each fix its last outcome applied it: the fix pass's, or an answer pass's.
    validation: validationOf(applied.map((id) => ({ id, methods: (lastFixAnswer(context.review, fix, id).answer?.validation ?? []).map((entry) => entry.method) }))),
  };
}

/**
 * What the documentation step did, as the one sentence of what
 * deep-review changed (R10 of the documentation step): how many documents
 * it updated and how many it left, which its answer says, or why it did
 * not run.
 */
function documentationWords(review: ReviewState, fix: FixState): string {
  const cause = stepNotRunCause(review);
  if (cause !== null) return stepNotRunSentence(cause);
  // A fix run's step with no cause answered.
  const answer = fix.answers.documentation[documentationUnitKey]!;
  // What it updated: every file an item edited, whatever its status, since a deferred item may hold a partial change.
  const updated = new Set(answer.findings.flatMap((finding) => finding.files)).size;
  // What it left, by the identity the list of documents left groups it by, so two spellings of one document count once and two documents twice.
  const leftFiles = new Set(leftByStep(fix).map((left) => left.key)).size;
  if (updated === 0 && leftFiles === 0) return 'The documentation step found no document out of date.';
  if (updated === 0) return `The documentation step left ${counted(leftFiles, 'document', 'documents')} out of date.`;
  return `The documentation step updated ${counted(updated, 'document', 'documents')}${leftFiles === 0 ? '' : ` and left ${String(leftFiles)}`}.`;
}

/**
 * The headline's sentence: how many things need the person, the documents
 * the run left out of date among them (PD6 of the documentation step), and
 * that nothing waits. A fix run with nothing to count says too that it
 * left no document out of date that it knows of; a run that only reviewed
 * edits nothing, so its sentence says nothing of documents.
 */
function headlineText(counts: { readonly questions: number; readonly departures: number; readonly documents: number }, defaultsInPlace: boolean, fixed: boolean): string {
  const { questions, departures, documents } = counts;
  const total = questions + departures + documents;
  if (total === 0) {
    return fixed
      ? 'Nothing needs you: no question is open, no fix that goes against a written rule waits for your review, and the run left no document out of date that it knows of.'
      : 'Nothing needs you: no question is open, and no fix that goes against a written rule waits for your review.';
  }
  const parts = [
    ...(questions === 0 ? [] : [counted(questions, 'question', 'questions')]),
    ...(departures === 0 ? [] : [counted(departures, 'fix that goes against a written rule', 'fixes that go against a written rule')]),
    ...(documents === 0 ? [] : [counted(documents, 'document that the edits of the run left out of date', 'documents that the edits of the run left out of date')]),
  ];
  const waits = questions === 0 ? 'Nothing waits for you: the run went on as it decided.' : `Nothing waits for you: ${questions === 1 ? 'the' : 'each'} question has a default${defaultsInPlace ? ' in place' : ''}.`;
  return `${counted(total, 'thing needs', 'things need')} you: ${listed(parts)}. ${waits}`;
}

/**
 * The sentence that says the run covered everything R10 names, for a run
 * with no gap: the checks of a fix run ran before the fixes, and after
 * them unless no fix changed a file, when no check runs again.
 */
function coveredText(review: ReviewState): string {
  const { fix } = review;
  if (fix === null) return 'Each angle ran, and a verifier examined each candidate.';
  const after = checksOf({ answerPasses: review.answerPasses, fix }).every((check) => check.after !== null);
  return after
    ? 'Each angle ran, a verifier examined each candidate, and each check ran before and after the fixes.'
    : 'Each angle ran, a verifier examined each candidate, and each check ran before the fixes; no fix changed a file, so they did not run after them.';
}

/** The core of the change from the triage's whole account, or why the run has none; `beforeEdits` says whether a fixer or an answer pass applied a fix since the account was written. */
function changeOf(account: TriageAccount, beforeEdits: boolean): BriefChange {
  if (account.kind !== 'given') return { state: account.kind };
  const { reading } = account;
  return { state: 'given', what: reading.what, why: reading.why, whyFrom: reading.whyFrom, restsOn: reading.restsOn, publicInterface: reading.publicInterface, wideEffect: reading.wideEffect, beforeEdits };
}

/** The brief of a run, from its fold alone (R1). The run must be configured for review and have its scope. */
export function briefOf(state: RunState): Brief {
  const review = state.review;
  if (review === null || state.scope === null) throw new Error(`Run ${state.id} has no review to brief`);
  const context = contextOf(state, review);
  const questions = questionsOf(context);
  const departures = departuresOf(context);
  const openQuestions = questions.filter((question) => question.answer === null).length;
  const openDepartures = departures.filter((departure) => departure.review === null).length;
  const notCovered = gapsOf(context);
  const counts = { questions: openQuestions, departures: openDepartures, documents: context.documents.length };
  const changed = changedOf(context);
  // A fixer applied a fix, or an answer pass applied an answer, after the triage wrote its account (R5 of the questions in the chat).
  const edited = changed.applied.length > 0 || review.answers.some((answer) => answer.appliedBy !== null && answer.appliedBy !== 'tree');
  return {
    run: state.id,
    title: review.change.kind === 'given' ? review.change.reading.title : scopeTitle(state),
    headline: { ...counts, text: headlineText(counts, questions.every((question) => question.answer !== null || question.defaultApplied), review.fix !== null) },
    change: changeOf(review.change, edited),
    questions,
    departures,
    documents: context.documents,
    notCovered,
    covered: notCovered.length === 0 ? coveredText(review) : null,
    look: lookOf(context, departures),
    changed,
  };
}

/** The most ids a list of the brief shows; it counts the rest (R13 of the brief of a run). */
export const shownIds = 8;

/** Ids as the brief lists them: the first `shownIds`, each as `show` gives it, then how many more. */
export function idWords(ids: readonly string[], show: (id: string) => string = (id) => id): string {
  const named = ids.slice(0, shownIds).map(show);
  const more = ids.length - named.length;
  if (more > 0) return `${named.join(', ')} and ${String(more)} more`;
  return listed(named);
}

/** What became of a decided fix, in the brief's plain words (the table of plain words of the design). */
export const fateWords: Readonly<Record<BriefFate, string>> = {
  applied: 'A fixer applied it.',
  'already-in-tree': 'It was already in the tree.',
  deferred: 'Its fixer put it off.',
  blocked: 'Its fixer could not apply it.',
  'not-attempted': 'No fixer attempted it.',
  'not-fixed': 'This run only reviewed, so no fixer applied it; `review --fix` applies it.',
};

/** What became of a fix of a fix run in the words a line of `report --fixes` names it with (R6 of the questions in the chat), beside `fateWords`. */
export const fixFateWords: Readonly<Record<Exclude<BriefFate, 'not-fixed'>, string>> = {
  applied: 'applied',
  'already-in-tree': 'already in the tree',
  deferred: 'put off by its fixer',
  blocked: 'not applied by its fixer',
  'not-attempted': 'not attempted',
};

/** What became of a decided fix as a clause that ends a sentence: its words of `fateWords` with a lower-case first letter and no period. */
const fateClause = (fate: BriefFate): string => {
  const words = fateWords[fate];
  return `${words.charAt(0).toLowerCase()}${words.slice(1).replace(/[.]$/, '')}`;
};

/** How a person runs a command the brief gives, said once, with no path (R8 of the brief of a run). */
export const howToAnswer = 'To answer, ask your agent with the deep-review skill, or type the command at a terminal as the end of this report shows.';

/** How a person answers in a chat, where no end of a report follows (R7 of the questions in the chat). */
export const howToAnswerInChat = 'To answer, ask your agent with the deep-review skill.';

/**
 * Where the brief is read (R7 of the questions in the chat): in the
 * report, a file, or in a chat, as `report --brief` and
 * `report --finding` print it. In a chat an id is plain text, since no
 * evidence follows to link to; the details the report folds under a
 * `<details>` tag follow a bold label; and the person answers by asking
 * the agent.
 */
export type BriefForm = 'report' | 'chat';

/** What a form changes in the words of the brief. */
interface FormWords {
  readonly link: (id: string) => string;
  readonly details: (summary: string, lines: readonly string[]) => string[];
  readonly howToAnswer: string;
}

const formWords: Readonly<Record<BriefForm, FormWords>> = {
  report: { link: findingLink, details: (summary, lines) => [`<details><summary>${summary}</summary>`, '', ...lines, '', '</details>'], howToAnswer },
  chat: { link: (id) => id, details: (_summary, lines) => ['**Details.**', '', ...lines], howToAnswer: howToAnswerInChat },
};

/** An answer a person gave, as a line of the brief. */
const answeredWords = (given: BriefAnswer): string => `Answered: ${given.words} on ${given.at}; ${given.applied ? 'the tree holds it' : 'not yet applied'}.`;

/** Why a run has no account of the change, by the state of the account: the one sentence of the brief's part "The change" and of the evidence's "The change, in full". */
export const missingAccountWords: Readonly<Record<'unrecorded' | 'none', string>> = {
  unrecorded: 'The triage of this run did not record the core of the change, because an engine before this change reviewed it.',
  none: 'The triage of this run gave no account of the change.',
};

/** The sentence that ends the part "The change" of a run whose fixes or answers changed the code after the account was written (R5 of the questions in the chat). */
export const beforeEditsSentence = 'The title and this account describe the change before the fixes and the answers of this run; What deep-review changed names the fixes.';

/** The part "The change": the core of the change, marked as the triage's unverified account, and as the change before the fixes when a fix was applied, or why the run has none. */
function changePart(change: BriefChange): string[] {
  const lines = ['## The change', ''];
  switch (change.state) {
    case 'unrecorded':
    case 'none':
      return [...lines, missingAccountWords[change.state]];
    case 'given': {
      const sources = (list: readonly string[]): string => list.map(inlineText).join(', ');
      const why = change.why === null
        ? 'The change states no reason.'
        : `Why, in the change's own words: ${inlineText(change.why)} (${change.whyFrom.length === 0 ? 'the triage named no source' : `from ${sources(change.whyFrom)}`}).`;
      const restsOn = change.restsOn.length === 0 ? '' : ` It rests on ${sources(change.restsOn)}.`;
      return [...lines, paragraphText(change.what), '', paragraphText(why), '', `This is the triage's account of the change, which no verifier examined.${restsOn}`, ...(change.beforeEdits ? ['', beforeEditsSentence] : [])];
    }
  }
}

/** One question as a block of the brief: its words, the option in place now and deep-review's choice, the options, the command, and the details one step below. */
function questionBlock(question: BriefQuestion, position: number, fixed: boolean, words: FormWords): string[] {
  const { answer } = question;
  // What stands: the answer a person gave, else the default, in place or, when it edits the code and no fixer applied it, only the default.
  const answered = answer?.option ?? null;
  const standing = answer !== null
    ? `${answeredWords(answer)} deep-review's choice was option ${String(question.choice)}.`
    : question.defaultApplied
      ? question.default === question.choice
        ? `In place now: option ${String(question.default)}, which is also deep-review's choice, because it is the easiest to take back.`
        : `In place now: option ${String(question.default)}, because it is the easiest to take back. deep-review's choice: option ${String(question.choice)}.`
      : `The default: option ${String(question.default)}, because it is the easiest to take back; ${fixed ? 'its fixer did not apply it' : 'this run only reviewed, so `review --fix` applies it'}. deep-review's choice: option ${String(question.choice)}.`;
  const defaultLabel = question.defaultApplied ? 'in place now' : 'the default';
  const label = (option: BriefOption): string => [
    String(option.number),
    ...(answer === null && option.number === question.default ? [defaultLabel] : []),
    ...(option.number === answered ? ['your answer'] : []),
    ...(option.number === question.choice ? ['deep-review\'s choice'] : []),
  ].join(', ');
  return [
    `### ${String(position)}. ${inlineText(question.question)} (${words.link(question.id)})`,
    '',
    standing,
    '',
    '| Option | What it does | What it costs |',
    '|---|---|---|',
    ...question.options.map((option) => `| ${label(option)} | ${tableCell(option.option)} | ${tableCell(option.cost)} |`),
    ...(answer === null ? ['', `To take deep-review's choice: \`${question.command}\`. For another option, give its number.`] : []),
    '',
    ...words.details('The rule that each option makes, where deep-review looked, and why it asks', [
      ...question.options.map((option) => `- Option ${String(option.number)} makes this rule: ${inlineText(option.rule)}`),
      `- Where deep-review looked: ${question.lookedIn.map(inlineText).join('; ')}`,
      `- Why it asks: ${inlineText(question.grounds)}`,
    ]),
  ];
}

/**
 * One fix that goes against a written rule as a block of the brief: the
 * rule and where it is written, the decider's reason with what the fix does
 * instead, its fate, and the commands that review it. The approach the
 * fixer was given is in the evidence's Decisions, not here (R9).
 */
function departureBlock(departure: BriefDeparture, position: number, fixed: boolean, words: FormWords): string[] {
  const { review } = departure;
  const reviewLine = review === null
    ? `To keep the fix and change the rule: \`${departure.accept}\`. To follow the rule: \`${departure.reject}\`.`
    : answeredWords(review);
  // A rejection replaces the departing fix with one that follows the rule, so the fate of the departing fix no longer stands.
  const fate = review?.kind !== 'reject'
    ? fateWords[departure.fate]
    : `You chose to follow the rule instead; ${review.applied ? 'the tree holds the fix that follows it' : fixed ? 'no fixer has applied the fix that follows it yet' : '`review --fix` applies the fix that follows it'}.`;
  return [
    `### ${String(position)}. ${words.link(departure.id)}`,
    '',
    `The rule: ${inlineText(departure.rule)} (${inlineText(departure.source)}).`,
    '',
    `Why deep-review went against it: ${sentenceText(departure.fact)} ${fate}`,
    '',
    reviewLine,
  ];
}

/** The part "Where to look": each condition of principle 8 that holds, with its findings linked, or one line that none does. */
function lookPart(brief: Brief, words: FormWords): string[] {
  const lines = ['## Where to look', ''];
  if (brief.look.length > 0) return [...lines, ...brief.look.map((entry) => `- ${inlineText(entry.text)}${entry.findings.length === 0 ? '' : `: ${idWords(entry.findings, words.link)}`}.`)];
  const judged = brief.change.state === 'given' ? ' The triage judged that the change alters no public interface and affects no file beyond its own.' : '';
  return [...lines, `No fix goes against a written rule or rests on a verdict that is only PLAUSIBLE.${judged}`];
}

/** How the checks ended, as one sentence of what deep-review changed. */
function checksWords(checks: readonly BriefCheck[]): string {
  if (checks.length === 0) return 'No check ran.';
  if (checks.every((check) => check.before === 'passed' && check.after === 'passed')) return 'The checks passed before and after the fixes.';
  const at = (outcome: string | null, when: string): string => (outcome === null ? `did not run ${when}` : `${outcome} ${when}`);
  const words = (check: BriefCheck): string => (check.before !== null && check.before === check.after ? `${check.before} before and after the fixes` : `${at(check.before, 'before the fixes')} and ${at(check.after, 'after them')}`);
  return `The checks: ${checks.map((check) => `${check.kind} ${words(check)}`).join('; ')}.`;
}

/** The sentence of what deep-review changed that names the findings a run left, each id as `show` gives it, with a space before it; none when it left none. */
const leftSentence = (changed: BriefChanged, show: (id: string) => string): string =>
  (changed.left.length === 0 ? '' : ` It left ${counted(changed.left.length, 'finding', 'findings')}: ${idWords(changed.left, show)}.`);

/** What a run that only reviewed changed, as the one sentence of the part "What deep-review changed": nothing, what it decided to fix, which `review --fix` applies, and what it left, each id as `show` gives it. */
export function readOnlyChangedSentence(changed: BriefChanged, show: (id: string) => string): string {
  const toFix = !changed.decided ? '' : changed.toFix.length === 0 ? ' It decided to fix no finding.' : ` It decided to fix ${counted(changed.toFix.length, 'finding', 'findings')}, which \`review --fix\` applies: ${idWords(changed.toFix, show)}.`;
  return `This run only reviewed: it changed nothing.${toFix}${leftSentence(changed, show)}`;
}

/** The paragraph "What deep-review changed" (R2 of the brief of a run). */
function changedPart(changed: BriefChanged, { link }: FormWords): string[] {
  const lines = ['## What deep-review changed', ''];
  if (!changed.fixed) return [...lines, readOnlyChangedSentence(changed, link)];
  const part = (ids: readonly string[], words: string): string[] => (ids.length === 0 ? [] : [`${words} ${String(ids.length)} (${idWords(ids, link)})`]);
  const outcomes = [
    `deep-review applied ${counted(changed.applied.length, 'fix', 'fixes')}${changed.applied.length === 0 ? '' : ` (${idWords(changed.applied, link)})`}`,
    ...part(changed.alreadyInTree, 'found already in the tree'),
    ...part(changed.deferred, 'its fixers put off'),
    ...part(changed.blocked, 'its fixers could not apply'),
    ...part(changed.notAttempted, 'no fixer attempted'),
  ];
  const commits = changed.patches === 0
    ? 'No fix changed a file.'
    : changed.commits === null
      ? (changed.patches === 1 ? 'Its patch is not committed: `deep-review commit` commits it.' : `Its ${String(changed.patches)} patches are not committed: \`deep-review commit\` commits them.`)
      : `They are in ${counted(changed.commits.shas.length, 'commit', 'commits')}${changed.commits.uncommittedPatches === 0 ? '' : `, and ${counted(changed.commits.uncommittedPatches, 'later patch is', 'later patches are')} not committed yet`}.`;
  const validation = validationSentence(changed.validation, (ids) => idWords(ids, link));
  return [...lines, `${outcomes.join('; ')}. ${commits}${leftSentence(changed, link)}${validation === null ? '' : ` ${validation}`} ${checksWords(changed.checks)}${changed.documentation === null ? '' : ` ${changed.documentation}`}`];
}

/**
 * The part "Documents left out of date" (R7 of the documentation step):
 * after the departures, one sentence, then each document with its facts,
 * each with who reported it, and its reasons; none when the run left none.
 */
function documentsPart(documents: readonly BriefDocument[]): string[] {
  if (documents.length === 0) return [];
  const line = (document: BriefDocument): string => {
    const facts = document.facts.length === 0 ? '' : `: ${document.facts.map((fact) => `${inlineText(fact.what).replace(/[.]+$/, '')} (${fact.by})`).join('; ')}`;
    return `- ${codeSpan(document.file)}${facts}. ${document.reasons.map((reason) => inlineText(reason.text)).join(' ')}`;
  };
  return [
    `## Documents left out of date (${String(documents.length)})`,
    '',
    'The edits of this run made each document below out of date, and the run did not bring it in line. Bring each in line before a merge.',
    '',
    ...documents.map(line),
  ];
}

/** The heading of the part of the questions, and the sentence under it that says what a default is and how to answer. */
const questionsHeading = (brief: Brief, words: FormWords): string[] => [
  `## Questions for you (${String(brief.questions.length)})`,
  '',
  `Each question has a default, the option that is the easiest to take back. Answer only to choose another one. ${words.howToAnswer}`,
];

/** The heading of the part of the fixes that go against a written rule, and the sentence under it when no part of questions said how to answer. */
const departuresHeading = (brief: Brief, words: FormWords, alone: boolean): string[] => [
  `## Fixes that go against a written rule (${String(brief.departures.length)})`,
  ...(alone ? ['', `Each fix below went ahead as deep-review decided. Review it only to go another way. ${words.howToAnswer}`] : []),
];

/**
 * The Markdown form of the brief (R8 to R12, R15 of the brief of a run):
 * the title, the headline, and the parts in the order of principle 5,
 * then what deep-review changed. It names no local path; it says once,
 * in the first part that gives a command, how a person runs one. In the
 * chat form, which `report --brief` prints, an id is plain text and the
 * details follow a bold label (R7 of the questions in the chat).
 */
export function briefMarkdown(brief: Brief, form: BriefForm = 'report'): string[] {
  const words = formWords[form];
  const questions = brief.questions.length === 0 ? [] : [
    ...questionsHeading(brief, words),
    ...brief.questions.flatMap((question, index) => ['', ...questionBlock(question, index + 1, brief.changed.fixed, words)]),
  ];
  const departures = brief.departures.length === 0 ? [] : [
    ...departuresHeading(brief, words, brief.questions.length === 0),
    ...brief.departures.flatMap((departure, index) => ['', ...departureBlock(departure, index + 1, brief.changed.fixed, words)]),
  ];
  const notCovered = ['## What the review did not cover', '', ...(brief.covered === null ? brief.notCovered.map((gap) => `- ${inlineText(gap.text)}`) : [brief.covered])];
  const parts = [changePart(brief.change), questions, departures, documentsPart(brief.documents), notCovered, lookPart(brief, words), changedPart(brief.changed, words)].filter((part) => part.length > 0);
  return [`# ${inlineText(brief.title)}`, '', brief.headline.text, ...parts.flatMap((part) => ['', ...part])];
}

/**
 * The block of one finding of the brief, under the heading of its part
 * and the sentence that says how to answer (R7 of the questions in the
 * chat): a question, open or answered, or a fix that goes against a
 * written rule, numbered as the brief numbers it; null for an id that
 * names neither, a fix that goes against no rule among them. The chat
 * form by default, which `report --finding` prints.
 */
export function briefBlock(brief: Brief, id: string, form: BriefForm = 'chat'): string[] | null {
  const words = formWords[form];
  const question = brief.questions.findIndex((entry) => entry.id === id);
  if (question !== -1) return [...questionsHeading(brief, words), '', ...questionBlock(brief.questions[question]!, question + 1, brief.changed.fixed, words)];
  const departure = brief.departures.findIndex((entry) => entry.id === id);
  if (departure !== -1) return [...departuresHeading(brief, words, true), '', ...departureBlock(brief.departures[departure]!, departure + 1, brief.changed.fixed, words)];
  return null;
}

/**
 * The most characters of a line of the short form; the path that ends it
 * has no limit, since a path cannot be cut (R13 of the brief of a run).
 * Nor do the lines of an open question, its options and an open
 * departure, which give the words of the decider whole: its schema holds
 * each text to 400 characters (PD12 of the questions in the chat).
 */
export const shortLineLimit = 200;

/**
 * The most characters of the first sentence of the account that the line
 * of the change gives whole; only a longer one is cut at a word (R4 of the
 * questions in the chat). The triage is asked for one of at most
 * `accountLimits.firstSentence`, which a model does not keep exactly.
 */
export const changeLineLimit = 400;

/** The most open questions, and the most open departures, the short form names with their words; it counts the others (PD2 of the questions in the chat). */
export const shownQuestions = 3;
export const shownDepartures = 3;

/**
 * Whether the period that ends `before` ends an abbreviation, not a
 * sentence, given the text `after` it: `e.g.`, `i.e.`, `vs.` and `cf.`
 * always do, `etc.` before a lower-case word, and `No.` before a digit.
 */
const endsAbbreviation = (before: string, after: string): boolean =>
  /(?:^|[^\p{L}\p{N}])(?:e\.g|i\.e|vs|cf)\.$/iu.test(before)
  || (/(?:^|[^\p{L}\p{N}])etc\.$/iu.test(before) && /^\s+\p{Ll}/u.test(after))
  || (/(?:^|[^\p{L}\p{N}])No\.$/u.test(before) && /^\s+\p{N}/u.test(after));

/** The first sentence of a text, or the whole text when it has no sentence end; a line or paragraph separator counts as a space, as a line break does. */
export function firstSentence(text: string): string {
  const inline = inlineText(text).replaceAll(/[ \t]*[\u2028\u2029]+[ \t]*/g, ' ');
  for (const end of inline.matchAll(/[.!?](?=\s|$)/g)) {
    const stop = end.index + 1;
    if (end[0] !== '.' || !endsAbbreviation(inline.slice(0, stop), inline.slice(stop))) return inline.slice(0, stop);
  }
  return inline;
}

/** A condition of principle 8 in a few words, for the short form; a departure in the words of the line `Against a written rule:`, so one thing has one name (R3 of the questions in the chat). */
const lookWords = (entry: BriefLook): string => {
  switch (entry.condition) {
    case 'departure':
      return counted(entry.findings.length, 'fix that goes against a written rule', 'fixes that go against a written rule');
    case 'plausible':
      return `${counted(entry.findings.length, 'fix', 'fixes')} on a PLAUSIBLE verdict`;
    case 'public-interface':
      return 'a change to a public interface';
    case 'wide-effect':
      return 'an effect on many files';
  }
};

/** What deep-review changed, in a few words, for the short form. */
function changedWords(changed: BriefChanged): string {
  if (!changed.fixed) return 'nothing; this run only reviewed';
  const fixes = counted(changed.applied.length, 'fix', 'fixes');
  const unapplied = changed.deferred.length + changed.blocked.length + changed.notAttempted.length;
  const rest = unapplied === 0 ? '' : `, ${counted(unapplied, 'fix', 'fixes')} not applied`;
  const where = changed.patches === 0 ? '' : changed.commits === null ? ', not committed' : `, in ${counted(changed.commits.shas.length, 'commit', 'commits')}${changed.commits.uncommittedPatches === 0 ? '' : `, ${counted(changed.commits.uncommittedPatches, 'patch', 'patches')} not committed`}`;
  return `${fixes}${rest}${where}`;
}

/** An option of a question as a line of the short form names it: its number and its words, whole. */
const optionWords = (question: BriefQuestion, number: number): string => `option ${String(number)}, ${inlineText(question.options[number - 1]?.option ?? '')}`;

/**
 * The lines of one open question in the short form (R1 of the questions
 * in the chat): the question, then the option in place now and
 * deep-review's choice, one line for the two when they are one option.
 * A default that edits the code and that no fixer applied is named as the
 * default, which the tree does not hold. Each line starts with the id of
 * the finding and gives the words of the decider whole.
 */
function questionLines(question: BriefQuestion): string[] {
  const id = `  ${question.id}`;
  const standing = question.defaultApplied ? 'in place now' : 'the default, which the tree does not hold';
  const both = question.defaultApplied ? 'in place now and deep-review\'s choice' : 'the default and deep-review\'s choice, which the tree does not hold';
  return [
    `${id}: ${inlineText(question.question)}`,
    ...(question.default === question.choice
      ? [`${id} ${both}: ${optionWords(question, question.default)}`]
      : [`${id} ${standing}: ${optionWords(question, question.default)}`, `${id} deep-review's choice: ${optionWords(question, question.choice)}`]),
  ];
}

/** The line of one open departure in the short form (R2 of the questions in the chat): where the rule is written, then the rule, whole; a fix no fixer applied, or one of a run that only reviewed, would go against it. */
function departureLine(departure: BriefDeparture): string {
  const goes = departure.fate === 'applied' || departure.fate === 'already-in-tree' ? 'goes against' : 'would go against';
  return `  ${departure.id} ${goes} a rule in ${inlineText(departure.source)}: "${inlineText(departure.rule)}"`;
}

/** The line that counts the open findings a list of the short form does not name with their words, and names their ids, or none. */
const moreLine = (ids: readonly string[], one: string, many: string): string[] => (ids.length === 0 ? [] : [`  ${counted(ids.length, one, many)}: ${idWords(ids)}`]);

/**
 * The short form of the brief (R13, PD12 of the brief of a run): seven
 * lines, whatever the number of findings, and an eighth for a fix run, the
 * documents it left out of date (R7 of the documentation step), each
 * naming its subject in its first words so it keeps its sense when a model
 * rewords it; a list shows at most `shownIds` ids and counts the rest, and
 * a line with nothing to say says so. Under the line `Questions:` come
 * the lines of each open question, at most `shownQuestions`, and under
 * `Against a written rule:` the line of each open departure, at most
 * `shownDepartures`, each list with one more line that counts the others
 * (R1, R2 of the questions in the chat): at most 22 lines in all. A line
 * has at most `shortLineLimit` characters, but the lines of a question, an
 * option and a departure, which give the words of the decider whole, and
 * the line of the change, which gives the first sentence of the account
 * whole up to `changeLineLimit` (R4). The caller prints the path of the
 * report after them, the last line.
 */
export function briefShortForm(brief: Brief): string[] {
  const open = brief.questions.filter((question) => question.answer === null);
  const openQuestions = open.map((question) => question.id);
  // A default is in place only when the tree holds it, as the headline says it (R7 of the brief of a run); one question reads as one.
  const inPlace = open.every((question) => question.defaultApplied);
  const defaults = open.length === 1 ? (inPlace ? 'with its default in place' : 'with a default') : inPlace ? 'each with a default in place' : 'each with a default';
  const openDepartures = brief.departures.filter((departure) => departure.review === null);
  const change = brief.change.state === 'given' ? firstSentence(brief.change.what) : brief.change.state === 'none' ? 'the triage gave no account of it' : 'not recorded; an engine before the account reviewed this run';
  const gaps = brief.notCovered;
  const notCovered = gaps.length === 0 ? 'nothing' : gaps.length === 1 ? inlineText(gaps[0]!.text) : `${String(gaps.length)} gaps, the first: ${inlineText(gaps[0]!.text)}`;
  // The lines that give the words of the decider whole are not cut; every other line is.
  const cut = (line: string): string => cutAtWord(line, shortLineLimit);
  return [
    cut(`${inlineText(brief.title)} (run ${shortRunId(brief.run)})`),
    // The title line stays as it is, and the line of the change carries the mark (R5 of the questions in the chat); the limit counts the sentence, not the mark (R4).
    `${brief.change.state === 'given' && brief.change.beforeEdits ? 'The change before the fixes' : 'The change'}: ${cutAtWord(change, changeLineLimit)}`,
    cut(openQuestions.length === 0 ? `Questions: ${brief.questions.length === 0 ? 'none' : 'none open; each is answered'}` : `Questions: ${String(openQuestions.length)}, ${defaults}`),
    ...open.slice(0, shownQuestions).flatMap(questionLines),
    ...moreLine(openQuestions.slice(shownQuestions), 'more question', 'more questions').map(cut),
    cut(openDepartures.length === 0 ? `Against a written rule: ${brief.departures.length === 0 ? 'no fix' : 'no fix left to review'}` : `Against a written rule: ${counted(openDepartures.length, 'fix', 'fixes')}`),
    ...openDepartures.slice(0, shownDepartures).map(departureLine),
    ...moreLine(openDepartures.slice(shownDepartures).map((departure) => departure.id), 'more fix', 'more fixes').map(cut),
    ...(brief.changed.fixed ? [cut(brief.documents.length === 0 ? 'Documents left out of date: none' : `Documents left out of date: ${String(brief.documents.length)}: ${idWords(brief.documents.map((document) => document.file), inlineText)}`)] : []),
    cut(`Not covered: ${notCovered}`),
    cut(`Look at: ${brief.look.length === 0 ? 'nothing' : brief.look.map(lookWords).join(', ')}`),
    cut(`Changed: ${changedWords(brief.changed)}`),
  ];
}
