/**
 * The brief of a run (R1, R2 of the brief of a run; R1 to R5 of the report
 * for the person): the part of its result a person reads first, as one
 * value computed from the fold alone. It holds the account of the change
 * as submitted, a status line, what needs the person before a merge from
 * the table of needs (needs.ts), each check with its meaning, and the
 * fixes with how their fixers report checking them. Nothing records it:
 * each command computes it again, so it is current after an answer or a
 * commit, and the same engine computes the same brief from the same
 * ledger. The report, the chat form of a command and the JSON form each
 * render this one value, as version 5 of the JSON form; the shapes of the
 * versions before it are frozen in brief-json.ts.
 */
import { answerWords, owedAnswers, standingAnswer, type RecordedAnswer } from '../checkpoint/answer-state.ts';
import type { ChangeCondition, RecordedDecision, ScopeMode, ScopeState, TreeRevised } from '../checkpoint/events.ts';
import { budgetStoppedUnits, committedRevisions, type FixState } from '../checkpoint/fix-state.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { isAnswered, unverifiedGroupsOf, type ReviewState, type TriageAccount } from '../checkpoint/review-fold.ts';
import { endedByKill } from '../runtime/kill-marks.ts';
import { baseNameOf } from '../scope/scope-line.ts';
import { defaultInPlace, leaveWords } from './decision-report.ts';
import { leftDocumentsOf, stepNotRunCause, stepNotRunSentence, type LeftDocument } from './documents.ts';
import { baseWords, briefChecksOf, meaningRowOf, validationKindsOf, validationWords, type BriefCheck, type ComparedBy } from './brief-checks.ts';
import type { GapKind } from './brief-json.ts';
import { findingOutcomes, lastFixAnswer, scratchSpellings, type FindingOutcome, type FindingOutcomes } from './fix-report.ts';
import { capitalized, checkAnchor, codeSpan, counted, findingAnchor, findingWords, inlineText, listed, paragraphText, quoted, tableCell } from './markdown.ts';
import { answerCommand, lastMomentWords, needsCountLine, needsOf, shownDecisions, shownUnfinished, type BriefNeed, type NeedDeparture, type NeedQuestion, type NeedsFacts } from './needs.ts';
import { shortRunId } from './runs.ts';
import { findingNumbers, ranAgain, rankedFindings, type ReportFinding } from './state.ts';
import { droppedByOperator } from './survey-report.ts';
import { documentationUnitKey, triageUnitKey, type Angle, type CheckOutcome, type EditingPhase, type Severity, type ValidationMethod } from './vocabulary.ts';

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
  /** The number of its finding. */
  readonly finding: number;
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
  /** The number of its finding. */
  readonly finding: number;
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

/** A document the edits of the run left out of date (R7 of the documentation step), as `leftDocumentsOf` gives it. */
export type BriefDocument = LeftDocument;

/** What became of a finding, as the first line of its block and the status line count it (R1, R6 of the report for the person). */
export const findingStatuses = ['question', 'fixed', 'fixed-against-rule', 'not-fixed', 'left', 'planned', 'planned-against-rule'] as const;
export type FindingStatus = (typeof findingStatuses)[number];

/** A finding as the brief names it: its number, its rank from 1, the ids of the engine it stands for, and what became of it (R6 of the report for the person). */
export interface BriefFinding {
  readonly number: number;
  readonly id: string;
  /** The ids of the candidates merged into it, which name it too. */
  readonly merged: readonly string[];
  readonly severity: Severity;
  /** The verdict as the verifier gave it; a finding that survived verification is never refuted. */
  readonly verdict: 'CONFIRMED' | 'PLAUSIBLE';
  readonly status: FindingStatus;
  /** The first sentence of its summary, as the finder wrote it. */
  readonly summary: string;
}

/** The status line (R1, R14 of the report for the person): the kind of run and the counts of its findings by what became of them, and the sentence. */
export interface BriefStatus {
  readonly kind: 'fix' | 'review';
  readonly findings: number;
  readonly fixed: number;
  readonly againstRule: number;
  readonly alreadyInTree: number;
  readonly notFixed: number;
  readonly questions: number;
  /** The findings whose answer the run follows, by number: in a fix run, those whose answer the tree holds. */
  readonly answered: readonly number[];
  readonly left: number;
  readonly toFix: number;
  /** Whether the patches are committed: none, some, or all of them. */
  readonly committed: 'none' | 'some' | 'all';
  readonly text: string;
}

/** A check as "Before you merge" gives it: its facts, its meaning from `checkMeanings`, the rank that meaning gives it in "What needs you", and who compared its failures (R4 of the report for the person). */
export interface BriefMergeCheck extends BriefCheck {
  readonly meaning: string;
  readonly rank: 1 | 2 | 3 | null;
  readonly comparedBy: ComparedBy | null;
}

/** One row of "What deep-review fixed" (R5 of the report for the person): the finding by its number, or null for a documentation update, the subject of the fix, the kinds of the validations its fixer reports, and its patches. */
export interface BriefFix {
  readonly finding: number | null;
  readonly severity: Severity | null;
  readonly plausible: boolean;
  readonly againstRule: boolean;
  readonly subject: string;
  readonly kinds: readonly ValidationMethod[];
  readonly patches: readonly number[];
}

/** A gap of what the run did not examine (R10 of the brief of a run), with its kind, so a reader of the brief tells gaps apart without reading their words. */
export interface BriefGap {
  readonly kind: GapKind;
  readonly text: string;
}

export interface Brief {
  readonly run: string;
  readonly title: string;
  /** Each finding in rank order, by its number. */
  readonly findings: readonly BriefFinding[];
  /** The number of each finding by its id and its merged ids, as `findingNumbers` gives it. */
  readonly numbers: ReadonlyMap<string, number>;
  /** The scratch directories of the run's workers, which each quote writes `<scratch>` (`scratchSpellings`). */
  readonly scratch: readonly string[];
  readonly status: BriefStatus;
  /** The items of "What needs you", in the order of its table, and the line that counts them (R2 of the report for the person). */
  readonly needs: readonly BriefNeed[];
  readonly needsLine: string;
  /** Each check with a command with its meaning; none in a run that only reviewed. */
  readonly checks: readonly BriefMergeCheck[];
  /** Whether the run takes its checks to the base, and the base as the brief names it (R10 of the facts before a merge). */
  readonly baseChecks: boolean;
  readonly base: string;
  /** The rows of "What deep-review fixed", or in a run that only reviewed, of what it would fix. */
  readonly fixes: readonly BriefFix[];
  /** What the run did not examine, each gap of R10 of the brief of a run that is not an item of "What needs you", with its kind and in plain words. */
  readonly notExamined: readonly BriefGap[];
  /** The findings left as is, by their reason, as one sentence, or null for none. */
  readonly leftAs: string | null;
  readonly change: BriefChange;
  readonly questions: readonly BriefQuestion[];
  readonly departures: readonly BriefDeparture[];
  /** The documents the edits of a fix run left out of date, none in a run that only reviewed (R7 of the documentation step). */
  readonly documents: readonly BriefDocument[];
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

/** The flag of the answer command that gives an answer again: its option, numbered from 1, or the acceptance or rejection. */
const choiceFlag = (answer: RecordedAnswer): string => (answer.answer.kind === 'option' ? `--option ${String(answer.answer.option + 1)}` : `--${answer.answer.kind}`);

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
  /** Each check with a command, none in a run that only reviewed (R3 to R5 of the facts before a merge). */
  readonly checks: readonly BriefCheck[];
  /** The number of each finding by its id and its merged ids. */
  readonly numbers: ReadonlyMap<string, number>;
  /** The scratch directories of the run's workers, which each quote writes `<scratch>` (`scratchSpellings`). */
  readonly scratch: readonly string[];
}

function contextOf(state: RunState, review: ReviewState): BriefContext {
  const byId = new Map((review.decisions ?? []).map((decision) => [decision.id, decision]));
  const findings = rankedFindings(review).map((entry) => ({ entry, decision: byId.get(entry.finding.id) ?? null }));
  const fix = review.fix;
  const outcomes = new Map(fix === null ? [] : findings.map(({ entry }) => [entry.finding.id, findingOutcomes(review, fix, entry.finding.id)] as const));
  const checks = fix === null ? [] : briefChecksOf({ ...review, fix }, state.scope!);
  return { state, review, findings, outcomes, documents: leftDocumentsOf(review), checks, numbers: findingNumbers(review), scratch: scratchSpellings(state.workers) };
}

/** The decisions of a kind, in rank order. */
function decisionsOf<K extends RecordedDecision['decision']>(context: BriefContext, kind: K): Extract<RecordedDecision, { decision: K }>[] {
  return context.findings.flatMap(({ decision }) => (decision !== null && decision.decision === kind ? [decision as Extract<RecordedDecision, { decision: K }>] : []));
}

function questionsOf(context: BriefContext): BriefQuestion[] {
  return decisionsOf(context, 'ask').map((decision) => {
    const { ask } = decision;
    const standing = standingAnswer(context.review, decision.id);
    const finding = context.numbers.get(decision.id)!;
    return {
      id: decision.id,
      finding,
      question: ask.question,
      default: ask.applied + 1,
      defaultApplied: defaultInPlace(context.review, decision),
      choice: ask.recommended + 1,
      options: ask.options.map((option, index) => ({ number: index + 1, option: option.option, cost: option.cost, rule: option.rule, edits: option.edits })),
      lookedIn: ask.searched,
      grounds: decision.grounds,
      answer: standing === null ? null : answerOf(standing),
      command: answerCommand(context.state.id, finding, `--option ${String(ask.recommended + 1)}`),
    };
  });
}

function departuresOf(context: BriefContext): BriefDeparture[] {
  return decisionsOf(context, 'fix').flatMap((decision) => {
    if (decision.departure === null) return [];
    const standing = standingAnswer(context.review, decision.id);
    // The fate of the decided fix is the fix pass's: an answer pass after it worked the person's answer, not the fix.
    const outcome = context.outcomes.get(decision.id)?.fixPass;
    const finding = context.numbers.get(decision.id)!;
    return [{
      id: decision.id,
      finding,
      rule: decision.departure.rule,
      source: decision.departure.source,
      fact: decision.departure.reason,
      fix: decision.fix.approach,
      // A decided fix is given to a fixer, so its outcome is a fixer's or not attempted; a run that only reviewed has none.
      fate: context.review.fix === null ? 'not-fixed' : (outcome === undefined ? undefined : fateWordsOf[outcome]) ?? 'not-attempted',
      review: standing === null ? null : answerOf(standing),
      accept: answerCommand(context.state.id, finding, '--accept'),
      reject: answerCommand(context.state.id, finding, '--reject'),
    }];
  });
}

/** A judgment of the triage as the text of its condition: what, and the files that show it. */
const judgedWords = (condition: ChangeCondition): string => `${condition.what === null ? '' : `: ${condition.what.trim().replace(/[.]+$/, '')}`}${condition.files.length === 0 ? '' : ` (${condition.files.join(', ')})`}`;

/** Whether the option a person chose for a question edits the code; false for a decision that is no question or an answer that is no option. */
const chosenEdits = (decision: RecordedDecision | null, standing: RecordedAnswer | null): boolean => decision?.decision === 'ask' && standing?.answer.kind === 'option' && decision.ask.options[standing.answer.option]?.edits === true;

/** What became of a finding (R6 of the report for the person): a question still open, fixed or not, left, or in a run that only reviewed, planned. */
function findingStatusOf(context: BriefContext, id: string, decision: RecordedDecision | null): FindingStatus {
  const standing = standingAnswer(context.review, id);
  if (decision?.decision === 'ask' && standing === null) return 'question';
  const departs = decision?.decision === 'fix' && decision.departure !== null && standing?.answer.kind !== 'reject';
  if (context.review.fix === null) {
    // An answered question is planned when the option the person chose edits the code; one that keeps it leaves the finding as it is.
    if (decision?.decision === 'fix' || chosenEdits(decision, standing)) return departs ? 'planned-against-rule' : 'planned';
    return 'left';
  }
  const outcome = context.outcomes.get(id)?.last;
  if (outcome === 'applied' || outcome === 'already applied') return departs ? 'fixed-against-rule' : 'fixed';
  if (outcome === 'deferred' || outcome === 'blocked' || outcome === 'not attempted') return 'not-fixed';
  // An answer recorded only, or whose pass was refused, still owes its edit, so the finding is not left as the person asked.
  if (standing !== null && standing.appliedBy === null) return 'not-fixed';
  return 'left';
}

/** The numbers of the findings whose fix a revision holds, from the ids it names. */
const revisionFindings = (context: BriefContext, findings: readonly string[]): number[] => findings.flatMap((id) => {
  const number = context.numbers.get(id);
  return number === undefined ? [] : [number];
});

/** The patches, numbered from 1, whose revisions hold the edits of a finding or an item of the documentation step. */
const patchesHolding = (fix: FixState, id: string): number[] => fix.revisions.flatMap((revision, index) => (revision.change.findings.includes(id) ? [index + 1] : []));

/** Whether the unit of a revision of an unfinished attempt answered later, so a later attempt of the same work finished it (R20 of the fix pass). */
const answeredLater = (fix: FixState, revision: TreeRevised): boolean => revision.source.kind === 'attempt' && (fix.answers[revision.phase as EditingPhase] as Readonly<Record<string, unknown>> | undefined)?.[revision.source.key] !== undefined;

/**
 * Why a fix no fixer applied was not, as the clause of its item: its fixer
 * put it off or could not apply it, the run budget stopped it, its fixer
 * failed twice, or no fixer attempted it. `started` says a fixer left
 * unfinished edits for it, so a fixer did start on it and the clause says
 * what stopped another attempt instead.
 */
function unappliedWhy(outcomes: FindingOutcomes, started: boolean): string {
  switch (outcomes.last) {
    case 'deferred':
      return 'its fixer put it off';
    case 'blocked':
      return 'its fixer could not apply it';
    default:
      if (started) {
        if (outcomes.unattempted === 'budget') return 'its fixer did not finish, and the run budget stopped another attempt; the end of the report gives the command that continues the fixes';
        if (outcomes.unattempted === 'failures') return 'its fixer did not finish, and a second failure stopped another attempt';
        return 'its fixer did not finish';
      }
      if (outcomes.unattempted === 'budget') return 'the run budget stopped the fixes before it, and the end of the report gives the command that continues them';
      if (outcomes.unattempted === 'failures') return 'its fixer failed twice and gave no answer';
      return 'no fixer attempted it';
  }
}

/** The facts the table of needs reads, each computed once from the context (R2 of the report for the person). */
function needsFactsOf(context: BriefContext, questions: readonly BriefQuestion[], departures: readonly BriefDeparture[], checks: readonly BriefMergeCheck[], base: string, findings: readonly BriefFinding[]): NeedsFacts {
  const { review } = context;
  const fix = review.fix;
  const number = (id: string): number => context.numbers.get(id)!;
  const committed = fix === null ? 0 : committedRevisions(fix);
  const allCommitted = fix !== null && fix.revisions.length > 0 && committed >= fix.revisions.length;
  const openDepartures = departures.filter((departure) => departure.review === null);
  const departing = new Set(openDepartures.map((departure) => departure.id));
  const decisionOf = new Map(context.findings.map(({ entry, decision }) => [entry.finding.id, decision]));
  const owed = new Map(owedAnswers(review).map((answer) => [answer.id, answer]));
  const unfinished = fix === null ? [] : fix.revisions.flatMap((revision, index) => (revision.source.kind === 'attempt' && !answeredLater(fix, revision) ? [{ revision, patch: index + 1 }] : []));
  const unfinishedEdits = unfinished.map(({ revision, patch }) => ({ patch, finding: revisionFindings(context, revision.change.findings)[0] ?? null }));
  // A finding whose fixer left unfinished edits was started on, so its own item says what stopped another attempt.
  const started = new Set(unfinished.flatMap(({ revision }) => revision.change.findings));
  const unapplied = fix === null ? [] : [...context.outcomes].flatMap(([id, outcomes]) => {
    if (departing.has(id)) return [];
    // A question whose default no fixer applied says so in its own item; an answer an answer pass did not apply is unfinished work.
    if (['deferred', 'blocked', 'not attempted'].includes(outcomes.last) && (decisionOf.get(id)?.decision !== 'ask' || outcomes.byAnswerPass)) return [{ finding: number(id), why: unappliedWhy(outcomes, started.has(id)), answer: outcomes.byAnswerPass }];
    // An answer recorded only, or whose pass was refused, owes its edit until the same answer is given again without `--record-only`.
    const answer = owed.get(id);
    return answer === undefined ? [] : [{ finding: number(id), why: `no answer pass applied it yet, and ${codeSpan(answerCommand(context.state.id, number(id), choiceFlag(answer)))} applies it`, answer: true }];
  });
  const plausible = new Set(findings.filter((finding) => finding.verdict === 'PLAUSIBLE').map((finding) => finding.id));
  const readFirst = fix === null ? [] : fix.revisions.flatMap((revision, index) => {
    if (index < committed) return [];
    if (revision.source.kind === 'attempt') return answeredLater(fix, revision) ? [`patch ${String(index + 1)}, edits of a fixer that did not finish, which a later fixer of the same work completed`] : [];
    if (revision.source.kind !== 'fix') return [];
    const unconfirmed = revision.change.findings.filter((id) => plausible.has(id)).map(number);
    return unconfirmed.length === 0 ? [] : [`patch ${String(index + 1)}, the fix of ${findingWords(unconfirmed)}, which the verifier did not confirm`];
  });
  const uncommitted = fix === null ? 0 : fix.revisions.length - committed;
  const departureFate = (departure: BriefDeparture): NeedDeparture['fate'] => {
    switch (departure.fate) {
      case 'not-fixed':
        return { kind: 'review-only' };
      case 'already-in-tree':
        return { kind: 'already-in-tree' };
      case 'applied': {
        // A fixer can report a fix applied that changed no file, so no revision holds it, and nothing of it was committed.
        const holding = fix === null ? [] : patchesHolding(fix, departure.id);
        return holding.length > 0 && holding.every((patch) => patch <= committed) ? { kind: 'committed' } : { kind: 'applied' };
      }
      default: {
        // Why its fixer did not apply it, the run budget among the reasons, as a fix that goes against no rule says it.
        const outcomes = context.outcomes.get(departure.id);
        return { kind: 'not-applied', why: outcomes === undefined ? fateClause(departure.fate) : unappliedWhy(outcomes, started.has(departure.id)) };
      }
    }
  };
  return {
    run: context.state.id,
    fixed: fix !== null,
    committed: allCommitted,
    base,
    checks,
    unfinishedEdits,
    unapplied,
    documents: context.documents,
    departures: openDepartures.map((departure) => ({ finding: departure.finding, rule: departure.rule, source: departure.source, reason: departure.fact, fate: departureFate(departure) })),
    questions: questions.filter((question) => question.answer === null).map((question) => needQuestionOf(question, fix !== null)),
    uncommitted: fix === null || uncommitted === 0 ? null : { patches: uncommitted, readFirst },
    toFix: fix === null ? findings.filter(isPlanned).length : 0,
    numbers: context.numbers,
    scratch: context.scratch,
  };
}

/** A question of the brief as its item of "What needs you" takes it. */
export function needQuestionOf(question: BriefQuestion, fixed: boolean): NeedQuestion {
  return {
    finding: question.finding,
    question: question.question,
    default: question.default,
    defaultHeld: question.defaultApplied ? 'held' : fixed ? 'not-applied' : 'review-only',
    choice: question.choice,
    options: question.options.map((option) => ({ number: option.number, option: option.option, cost: option.cost, rule: option.rule })),
  };
}

/** Whether a finding of a run that only reviewed is one the fix pass would fix: a decided fix, or a question whose chosen option edits the code. */
const isPlanned = (finding: BriefFinding): boolean => finding.status === 'planned' || finding.status === 'planned-against-rule';

/** The status line (R1, R14 of the report for the person): the kind of run and its id, and its findings counted by what became of them. */
function statusOf(context: BriefContext, findings: readonly BriefFinding[]): BriefStatus {
  const fix = context.review.fix;
  // A fixed finding whose fixer found its fix already in the tree is counted apart from the fixes deep-review made, against a written rule or not; an open question is never one.
  const inTree = new Set(findings.filter((finding) => (finding.status === 'fixed' || finding.status === 'fixed-against-rule') && context.outcomes.get(finding.id)?.last === 'already applied').map((finding) => finding.id));
  const count = (...statuses: FindingStatus[]): number => findings.filter((finding) => statuses.includes(finding.status) && !inTree.has(finding.id)).length;
  // A fix run follows an answer the tree holds; one recorded only, or whose pass was refused, still owes its edit. A run that only reviewed plans every answer.
  const standing = findings.flatMap((finding) => {
    const answer = standingAnswer(context.review, finding.id);
    return answer === null ? [] : [{ number: finding.number, owed: fix !== null && answer.appliedBy === null }];
  });
  const answered = standing.filter((answer) => !answer.owed).map((answer) => answer.number);
  const owed = standing.filter((answer) => answer.owed).map((answer) => answer.number);
  const committed = fix === null ? 0 : committedRevisions(fix);
  const counts = {
    kind: fix === null ? ('review' as const) : ('fix' as const),
    findings: findings.length,
    fixed: count('fixed', 'fixed-against-rule'),
    againstRule: count('fixed-against-rule', 'planned-against-rule'),
    alreadyInTree: inTree.size,
    notFixed: count('not-fixed'),
    questions: count('question'),
    answered,
    left: count('left'),
    toFix: count('planned', 'planned-against-rule'),
    committed: fix === null || committed === 0 ? ('none' as const) : committed >= fix.revisions.length ? ('all' as const) : ('some' as const),
  };
  const run = `deep-review's ${counts.kind} run ${shortRunId(context.state.id)}`;
  if (counts.findings === 0) return { ...counts, text: `${run} has no finding.${fix === null ? ' It changed no file and ran no check.' : ''}` };
  const done = fix === null ? counts.toFix : counts.fixed;
  const ofThem = counts.againstRule === 0 ? '' : counts.againstRule === done ? `, ${done === 1 ? 'against a written rule' : 'each against a written rule'}` : `, ${counts.againstRule === 1 ? 'one' : String(counts.againstRule)} of them against a written rule`;
  // The default a fixer applied to an open question is in a patch, though the finding counts as a question, not a fix.
  const defaults = findings.filter((finding) => appliedDefault(context, finding)).map((finding) => finding.number);
  const rest = [
    ...(counts.questions === 0 ? [] : [`asks you ${counted(counts.questions, 'question', 'questions')}`]),
    ...(defaults.length === 0 ? [] : [`applied the default of ${findingWords(defaults)}`]),
    ...(answered.length === 0 ? [] : [`follows your answers to ${findingWords(answered)}`]),
    ...(owed.length === 0 ? [] : [`has not yet applied your answers to ${findingWords(owed)}`]),
    ...(counts.alreadyInTree === 0 ? [] : [`found ${String(counts.alreadyInTree)} already fixed in the tree`]),
    ...(counts.notFixed === 0 ? [] : [`did not fix ${String(counts.notFixed)}`]),
    ...(counts.left === 0 ? [] : [`left ${counted(counts.left, 'finding', 'findings')} as is`]),
  ];
  let fixedWords: string;
  if (fix === null) fixedWords = `It changed no file and ran no check.${counts.toFix === 0 ? '' : ` It would fix ${String(counts.toFix)}${ofThem}.`}`;
  else if (counts.fixed === 0) fixedWords = 'It fixed no finding.';
  else if (counts.committed === 'none') fixedWords = `It fixed ${String(counts.fixed)} in your working tree${ofThem}.`;
  else if (counts.committed === 'all') fixedWords = `It fixed ${String(counts.fixed)}${ofThem}, and the fixes are committed.`;
  else fixedWords = `It fixed ${String(counts.fixed)}${ofThem}; ${String(fix.revisions.length - committed)} of its ${String(fix.revisions.length)} patches are not committed yet.`;
  return { ...counts, text: `${run} has ${counted(counts.findings, 'finding', 'findings')}. ${fixedWords}${rest.length === 0 ? '' : ` It ${listed(rest)}.`}` };
}

/** Whether a finding is an open question whose default, which edits the code, a fixer applied, so a patch holds it while the question stays open. */
const appliedDefault = (context: BriefContext, finding: BriefFinding): boolean => finding.status === 'question' && context.outcomes.get(finding.id)?.last === 'applied';

/** The rows of "What deep-review fixed" (R5 of the report for the person): each applied fix in rank order, the applied default of an open question among them, then each update of the documentation step; in a run that only reviewed, each planned fix, a decided fix or an answered question whose chosen option edits, with its plan. */
function fixesOf(context: BriefContext, findings: readonly BriefFinding[]): BriefFix[] {
  const { review } = context;
  const fix = review.fix;
  if (fix === null) {
    // A question the person answered with an option that edits is planned as a decided fix is, with the option they chose as its plan.
    const decided = new Map(context.findings.map(({ entry, decision }) => [entry.finding.id, decision]));
    return findings.filter(isPlanned).map((finding) => {
      const decision = decided.get(finding.id)!;
      const standing = standingAnswer(review, finding.id);
      const plan = decision.decision === 'fix' ? decision.fix.approach : decision.decision === 'ask' && standing?.answer.kind === 'option' ? decision.ask.options[standing.answer.option]!.option : '';
      return { finding: finding.number, severity: finding.severity, plausible: finding.verdict === 'PLAUSIBLE', againstRule: finding.status === 'planned-against-rule', subject: firstSentence(plan), kinds: [], patches: [] };
    });
  }
  const fixed = findings.filter((finding) => finding.status === 'fixed' || finding.status === 'fixed-against-rule' || appliedDefault(context, finding)).map((finding) => {
    const answer = lastFixAnswer(review, fix, finding.id).answer;
    return {
      finding: finding.number,
      severity: finding.severity,
      plausible: finding.verdict === 'PLAUSIBLE',
      againstRule: finding.status === 'fixed-against-rule',
      subject: answer === null ? '' : answer.message?.subject ?? firstSentence(answer.note),
      kinds: validationKindsOf((answer?.validation ?? []).map((entry) => entry.method)),
      patches: patchesHolding(fix, finding.id),
    };
  });
  const documentation = (fix.answers.documentation[documentationUnitKey]?.findings ?? []).filter((item) => (item.status === 'applied' || item.status === 'already-applied') && item.files.length > 0).map((item) => ({
    finding: null,
    severity: null,
    plausible: false,
    againstRule: false,
    subject: item.message?.subject ?? firstSentence(item.note),
    kinds: validationKindsOf(item.validation.map((entry) => entry.method)),
    patches: patchesHolding(fix, item.id),
  }));
  return [...fixed, ...documentation];
}

/** The plain name of each review pass, which the brief names a pass by (R10 of the report for the person). */
export const passNames: Readonly<Record<Angle, string>> = { SCAN: 'first', REMOVALS: 'removals', RIPPLE: 'ripple effects', FOOTGUNS: 'footguns', WRAPPERS: 'wrappers', EFFICIENCY: 'efficiency', DESIGN: 'design', DUPLICATION: 'duplication', ALTITUDE: 'altitude', CONVENTIONS: 'conventions' };

/** Whether a review pass ran: the first through the triage, any other as a finder the run did not mark as not run, which the report and `report --stats` both read. */
export function angleRan(review: ReviewState, angle: Angle): boolean {
  return angle === 'SCAN' ? isAnswered(review, 'triage', triageUnitKey) : review.anglesNotRun[angle] === undefined && isAnswered(review, 'finders', angle);
}

/**
 * What the run did not examine, each gap with its kind and in plain words
 * (R4, R10 of the report for the person; R10 of the brief of a run): the
 * review passes that did not run, the findings no verifier examined, the
 * paths the settings left out, the files too large to freeze, the checks
 * with no command, the work a stop ended, the steps the run budget
 * stopped, and a documentation step that did not run. What needs the
 * person is an item of "What needs you", not a gap.
 */
function notExaminedOf(context: BriefContext): BriefGap[] {
  const { state, review } = context;
  const scope = state.scope!;
  const gaps: BriefGap[] = [];
  const gap = (kind: GapKind, text: string): void => {
    gaps.push({ kind, text });
  };
  for (const angle of Object.keys(review.anglesNotRun) as Angle[]) gap('angle', `The ${passNames[angle]} review pass did not run, and a later pass looked for what it would have found.`);
  // A candidate of a group no verifier examined is a finding of its own, or merged into one whose verdict another candidate may give.
  const primaries = new Set(context.findings.map(({ entry }) => entry.finding.id));
  for (const group of unverifiedGroupsOf(review)) {
    const own = group.candidateIds.filter((id) => primaries.has(id)).map((id) => context.numbers.get(id)!);
    const merged = group.candidateIds.filter((id) => !primaries.has(id) && context.numbers.has(id)).map((id) => context.numbers.get(id)!);
    const others = group.candidateIds.length - own.length - merged.length;
    const parts = [
      ...(own.length === 0 ? [] : [findingWords(own)]),
      ...(merged.length === 0 ? [] : [`${merged.length === 1 ? 'a candidate' : 'candidates'} merged into ${findingWords(merged)}`]),
      ...(others === 0 ? [] : [counted(others, 'candidate', 'candidates')]),
    ];
    gap('unverified', `No verifier examined ${listed(parts)}${own.length === 0 ? '' : `; ${own.length === 1 ? 'it counts' : 'each counts'} as plausible`}.`);
  }
  if (scope.excluded.count > 0) gap('excluded', `${capitalized(counted(scope.excluded.count, 'changed path', 'changed paths'))} under ${scope.request.exclude.join(', ')}, which the settings leave out.`);
  const oversized = scope.files.filter((file) => (file.before !== null && 'oversized' in file.before) || (file.after !== null && 'oversized' in file.after)).map((file) => file.path);
  if (oversized.length > 0) gap('oversized', `${capitalized(counted(oversized.length, 'file', 'files'))} too large to freeze, which no worker was given: ${oversized.join(', ')}.`);
  const fix = review.fix;
  if (fix !== null) {
    for (const check of fix.checks.planned?.checks ?? []) {
      if (check.command === null) gap('check', `No ${check.kind} check ran: ${droppedByOperator(review.survey, check) ?? check.reason ?? 'the run has no command for it'}.`);
    }
    const stopped = budgetStoppedUnits(fix);
    const steps = [...(stopped.some((unit) => unit.phase === 'documentation') ? ['the documentation step'] : []), ...(stopped.some((unit) => unit.phase === 'repair') ? ['the fixes for the checks'] : [])];
    if (steps.length > 0) gap('budget', `The run budget stopped the fix pass before ${listed(steps)}, and the end of the report gives the command that continues it.`);
    if (fix.openSeries !== null) gap('stop', 'A stop cut `deep-review commit` short; the next command completes the commits or drops them.');
    const cause = stepNotRunCause(review);
    if (review.documentationStep && cause !== null && cause !== 'no-edits') gap('documentation', stepNotRunSentence(cause));
  }
  const workers = Object.values(state.workers);
  const ended = workers.filter((worker) => (worker.status === 'lost' || (worker.status === 'finished' && endedByKill(worker.finish))) && !ranAgain(workers, worker));
  if (ended.length > 0) gap('stop', `A stop ended ${counted(ended.length, 'worker', 'workers')} whose work did not run again; the end of the report names ${ended.length === 1 ? 'it' : 'them'}.`);
  return gaps;
}

/** Why the findings left as is were left, as one sentence: each reason with its findings; null when the run left none. */
function leftAsOf(context: BriefContext, findings: readonly BriefFinding[]): string | null {
  const reasons = new Map<string, number[]>();
  const add = (reason: string, number: number): void => {
    reasons.set(reason, [...(reasons.get(reason) ?? []), number]);
  };
  const decided = new Map(context.findings.map(({ entry, decision }) => [entry.finding.id, decision]));
  for (const finding of findings.filter((entry) => entry.status === 'left')) {
    const decision = decided.get(finding.id) ?? null;
    if (decision?.decision === 'leave') add(leaveWords(decision.leave, context.numbers), finding.number);
    else if (decision?.decision === 'ask' && !chosenEdits(decision, standingAnswer(context.review, finding.id))) add('your answer keeps the code as it is', finding.number);
    // A run configured before the decision step held a finding for the author when it fixed, and decided nothing when it only reviewed.
    else add(context.review.fix === null && context.review.decisions === null ? 'with no decision, since an engine before the decision step reviewed this run' : 'held for the author', finding.number);
  }
  if (reasons.size === 0) return null;
  return `Left as is: ${[...reasons].map(([reason, numbers]) => `${findingWords(numbers)}, ${reason}`).join('; ')}.`;
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
  // A fixer applied a fix, or an answer pass applied an answer, after the triage wrote its account (R5 of the questions in the chat).
  const edited = [...context.outcomes.values()].some((outcomes) => outcomes.last === 'applied') || review.answers.some((answer) => answer.appliedBy !== null && answer.appliedBy !== 'tree');
  const findings = context.findings.map(({ entry, decision }, index): BriefFinding => ({
    number: index + 1,
    id: entry.finding.id,
    merged: entry.members.map((member) => member.id),
    severity: entry.finding.severity,
    verdict: entry.resolution.verdict === 'CONFIRMED' ? 'CONFIRMED' : 'PLAUSIBLE',
    status: findingStatusOf(context, entry.finding.id, decision),
    summary: firstSentence(entry.finding.summary),
  }));
  const base = baseWords({ commit: state.scope.base, name: baseNameOf(state.scope.mode, state.scope.request) });
  const checks = context.checks.map((check) => {
    const row = meaningRowOf(check, review);
    return { ...check, meaning: row.meaning(check), rank: row.rank, comparedBy: row.comparedBy };
  });
  const facts = needsFactsOf(context, questions, departures, checks, base, findings);
  const needs = needsOf(facts);
  return {
    run: state.id,
    title: review.change.kind === 'given' ? review.change.reading.title : scopeTitle(state),
    findings,
    numbers: context.numbers,
    scratch: context.scratch,
    status: statusOf(context, findings),
    needs,
    needsLine: needsCountLine(needs, facts),
    checks,
    baseChecks: review.baseChecksStep,
    base,
    fixes: fixesOf(context, findings),
    notExamined: notExaminedOf(context),
    leftAs: leftAsOf(context, findings),
    change: changeOf(review.change, edited),
    questions,
    departures,
    documents: context.documents,
  };
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

/**
 * Where the brief is read (R12 of the report for the person): in the
 * report, a file, where the table of the fixes links each finding to its
 * block; or in a chat, as `report --brief` prints it, where a finding is
 * plain text, since no evidence follows to link to.
 */
export type BriefForm = 'report' | 'chat';

/** Why a run has no account of the change, by the state of the account: the one sentence of the account in the brief. */
export const missingAccountWords: Readonly<Record<'unrecorded' | 'none', string>> = {
  unrecorded: 'deep-review recorded no account of this change, because an engine before this change reviewed it.',
  none: 'deep-review gave no account of this change.',
};

/**
 * The account of the change as submitted (R1 of the report for the
 * person; R3 of the brief of a run): what it does, why in its own words,
 * then deep-review's judgments of it, whose account it is and what it
 * rests on, each a paragraph of one line; or why the run has none.
 */
function accountPart(brief: Brief): string[] {
  const { change } = brief;
  if (change.state !== 'given') return [missingAccountWords[change.state]];
  const said = (text: string): string => inlineText(quoted(text, { numbers: brief.numbers, scratch: brief.scratch }));
  const sources = (list: readonly string[]): string => list.map(inlineText).join(', ');
  const why = change.why === null ? 'The change states no reason.' : `Why, in the change's own words: ${said(change.why)} (${change.whyFrom.length === 0 ? 'it names no source' : `from ${sources(change.whyFrom)}`}).`;
  const judged = [
    ...(change.publicInterface.holds ? [`It changes a public interface, in deep-review's judgment${judgedWords(change.publicInterface)}.`] : []),
    ...(change.wideEffect.holds ? [`It affects many files beyond those it changes, in deep-review's judgment${judgedWords(change.wideEffect)}.`] : []),
  ];
  const judgments = judged.length === 0 ? ['In deep-review\'s judgment, it changes no public interface and affects no file beyond its own.'] : judged;
  const whose = `deep-review wrote this account of the change as submitted${change.beforeEdits ? ', before its fixes' : ''}, and no verifier examined it.${change.restsOn.length === 0 ? '' : ` It rests on ${sources(change.restsOn)}.`}`;
  return [paragraphText(said(change.what)), '', paragraphText(why), '', [...judgments, whose].join(' ')];
}

/** An item as a list item of its number: its lead, then each line after it as a line of a list under it, indented by the width of the item's marker, so it stays inside item 10 and later. */
const itemLines = (number: number, lines: readonly string[]): string[] => {
  const marker = `${String(number)}. `;
  return [`${marker}${lines[0]!}`, ...lines.slice(1).map((line) => `${' '.repeat(marker.length)}- ${line}`)];
};

/**
 * The items of "What needs you" as the brief shows them (R2, R3, TD9 of the
 * report for the person): every item of ranks 1 to 3 and 8, at most
 * `shownUnfinished` of rank 4 and `shownDecisions` of ranks 5 to 7, each
 * cap with one more item that names the others.
 */
function shownNeeds(brief: Brief): (readonly string[])[] {
  const shown: (readonly string[])[] = [];
  const unfinished = brief.needs.filter((need) => need.rank === 4);
  const decisions = brief.needs.filter((need) => need.rank >= 5 && need.rank <= 7);
  const name = (need: BriefNeed): string => (need.document !== null ? codeSpan(need.document) : need.finding !== null ? `finding ${String(need.finding)}` : `patch ${String(need.patch)}`);
  for (const need of brief.needs) {
    if (need.rank === 4) {
      const index = unfinished.indexOf(need);
      if (index < shownUnfinished) shown.push(need.lines);
      if (index === shownUnfinished) {
        const others = unfinished.slice(shownUnfinished);
        // A finding whose fixer left unfinished edits and whose fix is not applied has an item of each, and is named once.
        shown.push([`**${String(others.length)} more:** ${listed([...new Set(others.map(name))])}.`]);
      }
    } else if (need.rank >= 5 && need.rank <= 7) {
      const index = decisions.indexOf(need);
      if (index < shownDecisions) shown.push(need.lines);
      if (index === shownDecisions) {
        const others = decisions.slice(shownDecisions);
        shown.push([`**${counted(others.length, 'more decision', 'more decisions')}:** ${findingWords(others.map((other) => other.finding!))}. \`deep-review report --run ${shortRunId(brief.run)} --finding <number>\` prints each with its options and commands.`]);
      }
    } else shown.push(need.lines);
  }
  return shown;
}

/** The part "What needs you" (R2, R3 of the report for the person): the count line, the items, and the line that says how to act on them. */
function needsPart(brief: Brief): string[] {
  const lines = ['## What needs you', '', brief.needsLine];
  if (brief.needs.length === 0) return lines;
  const asks = brief.needs.some((need) => need.condition === 'question-other' || need.condition === 'question-choice');
  const how = `${asks ? 'Each question has a default, the option that is the easiest to reverse, so no item here holds up the run. ' : ''}Ask your agent with the deep-review skill to run a command, or type it at a terminal as the end of the report shows. \`deep-review report --run ${shortRunId(brief.run)} --finding <number>\` prints any finding.`;
  return [...lines, '', ...shownNeeds(brief).flatMap((item, index) => itemLines(index + 1, item)), '', how];
}

/** How a run of a check ended, as a cell of "Before you merge". */
const outcomeCells: Readonly<Record<CheckOutcome, string>> = { passed: 'passed', failed: 'failed', timeout: 'timed out', 'not-started': 'did not start', skipped: 'skipped', cut: 'cut short' };

/**
 * The paragraph under the table of the checks (R4 of the report for the
 * person): the base, the fixed sentence on a failure the base shares and
 * who compares, what the run did not examine or that it examined all, and
 * the findings left as is.
 */
function mergeParagraph(brief: Brief): string {
  const shared = brief.checks.some((check) => check.fault === 'base-has');
  const byModel = brief.checks.some((check) => check.comparedBy === 'model');
  const ranAfter = brief.checks.every((check) => check.last !== null);
  const covered = brief.status.kind === 'review' || brief.checks.length === 0
    ? 'Every review pass ran, and a verifier examined each candidate.'
    : ranAfter ? 'Every review pass ran, a verifier examined each candidate, and each check ran as submitted and after the fixes.' : 'Every review pass ran, a verifier examined each candidate, and each check ran as submitted; no fix changed a file, so none ran after the fixes.';
  return [
    ...(brief.baseChecks && brief.status.kind === 'fix' && brief.checks.length > 0 ? [`The base is ${brief.base}.`] : []),
    ...(shared ? ['A check that fails the same way on the base has no failure that the change adds.'] : []),
    ...(byModel ? ['A model\'s comparison is the reading of the worker that compared the failures of the change with those of the base.'] : []),
    ...(brief.notExamined.length === 0 ? [covered] : brief.notExamined.map((gap) => gap.text)),
    ...(brief.leftAs === null ? [] : [brief.leftAs]),
  ].join(' ');
}

/**
 * The part "Before you merge" (R4 of the report for the person): one row
 * per check with its result on the base, as submitted and in its last
 * run with when it ran, and its meaning, then the paragraph; a run that
 * only reviewed says that no check ran and names its major findings.
 */
function mergePart(brief: Brief, form: BriefForm): string[] {
  const lines = ['## Before you merge', ''];
  if (brief.status.kind === 'review') {
    const major = brief.findings.filter((finding) => finding.severity !== 'minor').map((finding) => finding.number);
    return [...lines, ['No check ran: this run only reviewed.', ...(major.length === 0 ? [] : [`The major findings stay open: ${findingWords(major)}.`]), mergeParagraph(brief)].join(' ')];
  }
  if (brief.checks.length === 0) return [...lines, `No check ran, since the run has no check command. ${mergeParagraph(brief)}`];
  const columns = ['Check', ...(brief.baseChecks ? ['On the base'] : []), 'As submitted', 'Last run', 'What it means'];
  const rows = brief.checks.map((check) => {
    const base = check.base === null || check.base.outcome === null ? 'not run' : outcomeCells[check.base.outcome];
    const last = check.last === null ? 'did not run' : `${outcomeCells[check.last.outcome]}, ${lastMomentWords[check.last.when]}`;
    // The report links each check to its block under Checks (R4 of the report for the person); the chat has no link.
    const name = form === 'report' ? `[${check.kind}](#${checkAnchor(check.kind)})` : check.kind;
    return `| ${[name, ...(brief.baseChecks ? [base] : []), check.before === null ? 'did not run' : outcomeCells[check.before], last, check.meaning].join(' | ')} |`;
  });
  return [...lines, `| ${columns.join(' | ')} |`, `|${columns.map(() => '---').join('|')}|`, ...rows, '', mergeParagraph(brief)];
}

/** The most rows of the table of the fixes; one more row names the others (R5, TD9 of the report for the person). */
export const shownFixes = 10;

/**
 * The part "What deep-review fixed" (R5 of the report for the person): a
 * row per fix with its finding, severity and marks, the subject of its
 * commit message, how its fixer reports checking it and its patches, at
 * most `shownFixes` and a row of the others; in a run that only reviewed,
 * what it would fix, with each plan.
 */
function fixesPart(brief: Brief, form: BriefForm): string[] {
  const planned = brief.status.kind === 'review';
  const lines = [planned ? '## What deep-review would fix' : '## What deep-review fixed', ''];
  if (brief.fixes.length === 0) return [...lines, planned ? 'deep-review decided to fix no finding.' : 'deep-review fixed no finding.'];
  const said = (text: string, own: number | null): string => tableCell(inlineText(quoted(text, { numbers: brief.numbers, own, scratch: brief.scratch })));
  // A row of a finding still a question is the default a fixer applied, which the question's answer may change.
  const asked = new Set(brief.findings.filter((finding) => finding.status === 'question').map((finding) => finding.number));
  const marks = (fix: BriefFix): string => [...(fix.againstRule ? ['against a written rule'] : []), ...(fix.finding !== null && asked.has(fix.finding) ? ['the default of a question'] : []), ...(fix.plausible ? ['plausible'] : [])].map((mark) => `, ${mark}`).join('');
  const name = (fix: BriefFix): string => (fix.finding === null ? 'Documentation' : `${form === 'report' ? `[${String(fix.finding)}](#${findingAnchor(fix.finding)})` : String(fix.finding)}, ${fix.severity!}${marks(fix)}`);
  const shown = brief.fixes.slice(0, shownFixes);
  const others = brief.fixes.slice(shownFixes);
  const otherFindings = others.flatMap((fix) => (fix.finding === null ? [] : [fix.finding]));
  const otherDocuments = others.length - otherFindings.length;
  const otherMarks = others.flatMap((fix) => (fix.finding === null || marks(fix) === '' ? [] : [`finding ${String(fix.finding)}${marks(fix)}`])).join('; ');
  const othersName = [...(otherFindings.length === 0 ? [] : [findingWords(otherFindings)]), ...(otherDocuments === 0 ? [] : [counted(otherDocuments, 'documentation update', 'documentation updates')])].join(' and ');
  const table = planned
    ? ['| Finding | The planned fix |', '|---|---|', ...shown.map((fix) => `| ${name(fix)} | ${said(fix.subject, fix.finding)} |`), ...(others.length === 0 ? [] : [`| ${String(others.length)} more: ${othersName} | ${otherMarks} |`])]
    : ['| Finding | The fix | How its fixer reports checking it | Patch |', '|---|---|---|---|', ...shown.map((fix) => `| ${name(fix)} | ${said(fix.subject, fix.finding)} | ${validationWords(fix.kinds)} | ${fix.patches.length === 0 ? 'none' : fix.patches.join(', ')} |`), ...(others.length === 0 ? [] : [`| ${String(others.length)} more: ${othersName} | ${otherMarks} | | |`])];
  const plausible = brief.fixes.some((fix) => fix.plausible) ? ['', 'A plausible finding is one that the verifier did not confirm.'] : [];
  return [...lines, ...table, ...plausible];
}

/**
 * The Markdown form of the brief (R1 to R5 of the report for the person):
 * the title and the account of the change as submitted, the status line,
 * "What needs you", "Before you merge" and "What deep-review fixed". It
 * names no local path. In the chat form, which `report --brief` prints, a
 * finding of the table of the fixes is plain text.
 */
export function briefMarkdown(brief: Brief, form: BriefForm = 'report'): string[] {
  return [`# ${inlineText(brief.title)}`, '', ...accountPart(brief), '', brief.status.text, '', ...needsPart(brief), '', ...mergePart(brief, form), '', ...fixesPart(brief, form)];
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

/**
 * The chat form of the brief (R12, TD1 of the report for the person),
 * which `review` and `answer` print after a run and `report` prints with
 * no flag: the title with the run, the line of the change with its mark
 * (R4, R5 of the questions in the chat), then the status line, "What needs
 * you" and "Before you merge" as the brief has them, made by the same
 * functions, and one line that names `report --fixes`. A finding is plain
 * text. The caller prints the path of the report after them, the last
 * line. The caps of the lists hold it to `chatLineLimit` lines.
 */
export function briefChatForm(brief: Brief): string[] {
  const change = brief.change.state === 'given' ? firstSentence(brief.change.what) : brief.change.state === 'none' ? 'deep-review gave no account of it' : 'not recorded; an engine before the account reviewed this run';
  const run = shortRunId(brief.run);
  return [
    cutAtWord(`${inlineText(brief.title)} (run ${run})`, shortLineLimit),
    // The title line stays as it is, and the line of the change carries the mark (R5 of the questions in the chat); the limit counts the sentence, not the mark (R4).
    `${brief.change.state === 'given' && brief.change.beforeEdits ? 'The change before the fixes' : 'The change'}: ${cutAtWord(change, changeLineLimit)}`,
    '',
    brief.status.text,
    '',
    ...needsPart(brief),
    '',
    ...mergePart(brief, 'chat'),
    '',
    `${brief.status.kind === 'review' ? 'What deep-review would fix' : 'What deep-review fixed'}: deep-review report --fixes --run ${run}`,
  ];
}

/**
 * The most lines of the chat form before the path, and of the brief, for
 * any number of findings (R1, R12, TD9 of the report for the person): the
 * caps of the lists, the shapes of the items and the four kinds of check
 * set them, and the report puts a blank line after the brief.
 */
export const chatLineLimit = 52;
export const briefLineLimit = 73;
