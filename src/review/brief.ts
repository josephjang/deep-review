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
 * render this one value. The headline, the gaps, what was covered, where
 * to look and what changed remain for version 4 of the JSON form alone.
 */
import { answerWords, standingAnswer, type RecordedAnswer } from '../checkpoint/answer-state.ts';
import type { ChangeCondition, RecordedDecision, ScopeMode, ScopeState, TreeRevised } from '../checkpoint/events.ts';
import { allBatches, budgetStoppedUnits, committedRevisions, type FixState } from '../checkpoint/fix-state.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { unverifiedGroupsOf, type ReviewState, type TriageAccount } from '../checkpoint/review-fold.ts';
import { endedByKill } from '../runtime/kill-marks.ts';
import { baseNameOf } from '../scope/scope-line.ts';
import { defaultInPlace, leaveReasonWords } from './decision-report.ts';
import { leftByStep, leftDocumentsOf, stepNotRunCause, stepNotRunSentence, type LeftDocument } from './documents.ts';
import { baseWords, briefChecksOf, checkGap, meaningRowOf, outcomeVerbs, validationKindsOf, validationOf, validationWords, type BriefCheck, type BriefValidation, type ComparedBy } from './brief-checks.ts';
import { findingOutcomes, lastFixAnswer, type FindingOutcome, type FindingOutcomes } from './fix-report.ts';
import { capitalized, codeSpan, counted, findingAnchor, findingWords, inlineText, listed, paragraphText, quoted, tableCell } from './markdown.ts';
import { answerCommand, lastMomentWords, needsCountLine, needsOf, shownDecisions, shownUnfinished, type BriefNeed, type NeedDeparture, type NeedQuestion, type NeedsFacts } from './needs.ts';
import { shortRunId } from './runs.ts';
import { findingNumbers, ranAgain, rankedFindings, type ReportFinding } from './state.ts';
import { droppedByOperator } from './survey-report.ts';
import { documentationUnitKey, type Angle, type CheckKind, type CheckOutcome, type EditingPhase, type Severity, type ValidationMethod, type Verdict } from './vocabulary.ts';

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
  /** Each check with a command: its outcome before the fixes, its last run with when it ran, what its base says, and its fault (R3 to R5 of the facts before a merge); none in a run that only reviewed. */
  readonly checks: readonly BriefCheck[];
  /** The kinds of check the run has no command for, which the line `Checks:` names (R6 of the facts before a merge); none in a run that only reviewed. */
  readonly noCommand: readonly CheckKind[];
  /** What the documentation step did, as one sentence, or null in a run that only reviewed or that an engine before the step configured (R10 of the documentation step). */
  readonly documentation: string | null;
  /** The applied fixes under the strongest validation the answer that applied each reported (R7 of the facts before a merge); each list empty in a run that only reviewed. */
  readonly validation: BriefValidation;
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
  readonly verdict: Verdict;
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
  /** The findings whose answer the run follows, by number. */
  readonly answered: readonly number[];
  readonly left: number;
  readonly toFix: number;
  /** Whether the patches are committed: none, some, or all of them. */
  readonly committed: 'none' | 'some' | 'all';
  readonly text: string;
}

/** A check as "Before you merge" gives it: its facts, its meaning from `checkMeanings`, and who compared its failures (R4 of the report for the person). */
export interface BriefMergeCheck extends BriefCheck {
  readonly meaning: string;
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

export interface Brief {
  readonly run: string;
  readonly title: string;
  /** Each finding in rank order, by its number. */
  readonly findings: readonly BriefFinding[];
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
  /** What the run did not examine, each gap of R10 of the brief of a run that is not an item of "What needs you", in plain words. */
  readonly notExamined: readonly string[];
  /** The findings left as is, by their reason, as one sentence, or null for none. */
  readonly leftAs: string | null;
  /** How many open questions, unreviewed departures, documents left out of date and checks the edits of the run made fail need the person (R4 of the facts before a merge), and the sentence that says so. */
  readonly headline: { readonly questions: number; readonly departures: number; readonly documents: number; readonly checks: number; readonly text: string };
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
  /** Each check with a command, none in a run that only reviewed (R3 to R5 of the facts before a merge). */
  readonly checks: readonly BriefCheck[];
  /** The number of each finding by its id and its merged ids. */
  readonly numbers: ReadonlyMap<string, number>;
}

function contextOf(state: RunState, review: ReviewState): BriefContext {
  const byId = new Map((review.decisions ?? []).map((decision) => [decision.id, decision]));
  const findings = rankedFindings(review).map((entry) => ({ entry, decision: byId.get(entry.finding.id) ?? null }));
  const fix = review.fix;
  const outcomes = new Map(fix === null ? [] : findings.map(({ entry }) => [entry.finding.id, findingOutcomes(review, fix, entry.finding.id)] as const));
  const checks = fix === null ? [] : briefChecksOf({ ...review, fix }, state.scope!);
  return { state, review, findings, outcomes, documents: leftDocumentsOf(review), checks, numbers: findingNumbers(review) };
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
      command: answerCommand(context.state.id, context.numbers.get(decision.id)!, `--option ${String(ask.recommended + 1)}`),
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
      accept: answerCommand(context.state.id, context.numbers.get(decision.id)!, '--accept'),
      reject: answerCommand(context.state.id, context.numbers.get(decision.id)!, '--reject'),
    }];
  });
}

/** The outcomes of a check that did not finish, which the brief names as a gap. */
const unfinishedOutcomes: readonly CheckOutcome[] = ['timeout', 'skipped', 'not-started'];

/** What an unfinished check did, in the brief's verb for its outcome, or null for one that ran to an outcome. */
const unfinishedWords = (outcome: CheckOutcome | null): string | null => (outcome !== null && unfinishedOutcomes.includes(outcome) ? outcomeVerbs[outcome] : null);

/**
 * The gaps of a fix run: each check that did not run or finish, each
 * check the change breaks or that the run took to the base and did not
 * compare (R5 of the facts before a merge), each fix no fixer applied,
 * the work the run budget did not start, and a commit a stop cut short.
 */
function fixGaps(context: BriefContext, fix: FixState): BriefGap[] {
  const gaps: BriefGap[] = [];
  for (const check of fix.checks.planned?.checks ?? []) {
    // A check the project defines that the operator dropped says so, with the tool this machine lacked (R15 of the repository survey).
    if (check.command === null) gaps.push({ kind: 'check', text: `No ${check.kind} check ran: ${droppedByOperator(context.review.survey, check) ?? check.reason ?? 'the run has no command for it'}.` });
  }
  for (const check of context.checks) {
    const unfinished = [check.before, check.last?.outcome ?? null].map(unfinishedWords).filter((words) => words !== null);
    if (unfinished.length > 0) gaps.push({ kind: 'check', text: `The ${check.kind} check did not finish: it ${unfinished.join(', then ')}.` });
  }
  for (const text of context.checks.map(checkGap)) {
    if (text !== null) gaps.push({ kind: 'check', text });
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
    return { fixed: false, decided: context.review.decisions !== null, applied: [], alreadyInTree: [], deferred: [], blocked: [], notAttempted: [], toFix, commits: null, patches: 0, left, checks: [], noCommand: [], documentation: null, validation: validationOf([]) };
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
    checks: context.checks,
    noCommand: (fix.checks.planned?.checks ?? []).filter((check) => check.command === null).map((check) => check.kind),
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
 * the run left out of date (PD6 of the documentation step) and the checks
 * its edits made fail (R4, PD4 of the facts before a merge) among them,
 * and that nothing waits. A fix run with nothing to count says too that
 * it left no document out of date that it knows of and that its edits
 * made no check fail; a run that only reviewed edits nothing, so its
 * sentence says nothing of either.
 */
function headlineText(counts: Omit<Brief['headline'], 'text'>, defaultsInPlace: boolean, fixed: boolean): string {
  const { questions, departures, documents, checks } = counts;
  const total = questions + departures + documents + checks;
  if (total === 0) {
    return fixed
      ? 'Nothing needs you: no question is open, no fix that goes against a written rule waits for your review, the run left no document out of date that it knows of, and its edits made no check fail.'
      : 'Nothing needs you: no question is open, and no fix that goes against a written rule waits for your review.';
  }
  const parts = [
    ...(questions === 0 ? [] : [counted(questions, 'question', 'questions')]),
    ...(departures === 0 ? [] : [counted(departures, 'fix that goes against a written rule', 'fixes that go against a written rule')]),
    ...(documents === 0 ? [] : [counted(documents, 'document that the edits of the run left out of date', 'documents that the edits of the run left out of date')]),
    ...(checks === 0 ? [] : [counted(checks, 'check that the edits of the run made fail', 'checks that the edits of the run made fail')]),
  ];
  const waits = questions === 0 ? 'Nothing waits for you: the run went on as it decided.' : `Nothing waits for you: ${questions === 1 ? 'the' : 'each'} question has a default${defaultsInPlace ? ' in place' : ''}.`;
  return `${counted(total, 'thing needs', 'things need')} you: ${listed(parts)}. ${waits}`;
}

/**
 * The sentence that says the run covered everything R10 names, for a run
 * with no gap: the checks of a fix run ran before the fixes, and after
 * them unless no fix changed a file, when no check runs again.
 */
function coveredText(context: BriefContext): string {
  if (context.review.fix === null) return 'Each angle ran, and a verifier examined each candidate.';
  return context.checks.every((check) => check.last !== null)
    ? 'Each angle ran, a verifier examined each candidate, and each check ran before and after the fixes.'
    : 'Each angle ran, a verifier examined each candidate, and each check ran before the fixes; no fix changed a file, so they did not run after them.';
}

/** The core of the change from the triage's whole account, or why the run has none; `beforeEdits` says whether a fixer or an answer pass applied a fix since the account was written. */
function changeOf(account: TriageAccount, beforeEdits: boolean): BriefChange {
  if (account.kind !== 'given') return { state: account.kind };
  const { reading } = account;
  return { state: 'given', what: reading.what, why: reading.why, whyFrom: reading.whyFrom, restsOn: reading.restsOn, publicInterface: reading.publicInterface, wideEffect: reading.wideEffect, beforeEdits };
}

/** What became of a finding (R6 of the report for the person): a question still open, fixed or not, left, or in a run that only reviewed, planned. */
function findingStatusOf(context: BriefContext, id: string, decision: RecordedDecision | null): FindingStatus {
  const standing = standingAnswer(context.review, id);
  if (decision?.decision === 'ask' && standing === null) return 'question';
  const departs = decision?.decision === 'fix' && decision.departure !== null && standing?.answer.kind !== 'reject';
  if (context.review.fix === null) {
    // An answered question is planned when the option the person chose edits the code; one that keeps it leaves the finding as it is.
    const edits = decision?.decision === 'ask' && standing?.answer.kind === 'option' && decision.ask.options[standing.answer.option]?.edits === true;
    if (decision?.decision === 'fix' || edits) return departs ? 'planned-against-rule' : 'planned';
    return 'left';
  }
  const outcome = context.outcomes.get(id)?.last;
  if (outcome === 'applied' || outcome === 'already applied') return departs ? 'fixed-against-rule' : 'fixed';
  if (outcome === 'deferred' || outcome === 'blocked' || outcome === 'not attempted') return 'not-fixed';
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

/** Why a fix no fixer applied was not, as the clause of its item: its fixer put it off or could not apply it, the run budget stopped it, its fixer failed twice, or no fixer attempted it. */
function unappliedWhy(outcomes: FindingOutcomes): string {
  switch (outcomes.last) {
    case 'deferred':
      return 'its fixer put it off';
    case 'blocked':
      return 'its fixer could not apply it';
    default:
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
  const unapplied = fix === null ? [] : [...context.outcomes].flatMap(([id, outcomes]) => {
    if (!['deferred', 'blocked', 'not attempted'].includes(outcomes.last) || departing.has(id)) return [];
    // A question whose default no fixer applied says so in its own item; an answer an answer pass did not apply is unfinished work.
    if (decisionOf.get(id)?.decision === 'ask' && !outcomes.byAnswerPass) return [];
    return [{ finding: number(id), why: unappliedWhy(outcomes), answer: outcomes.byAnswerPass }];
  });
  const unfinishedEdits = fix === null ? [] : fix.revisions.flatMap((revision, index) => (revision.source.kind === 'attempt' && !answeredLater(fix, revision) ? [{ patch: index + 1, finding: revisionFindings(context, revision.change.findings)[0] ?? null }] : []));
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
      case 'applied':
        return fix !== null && patchesHolding(fix, departure.id).every((patch) => patch <= committed) ? { kind: 'committed' } : { kind: 'applied' };
      default: {
        // Why its fixer did not apply it, the run budget among the reasons, as a fix that goes against no rule says it.
        const outcomes = context.outcomes.get(departure.id);
        return { kind: 'not-applied', why: outcomes === undefined ? fateClause(departure.fate) : unappliedWhy(outcomes) };
      }
    }
  };
  return {
    run: context.state.id,
    fixed: fix !== null,
    committed: allCommitted,
    base,
    checks,
    checkRanks: new Map(checks.map((check) => [check.kind, meaningRowOf(check, review).rank])),
    unfinishedEdits,
    unapplied,
    documents: context.documents,
    departures: openDepartures.map((departure) => ({ finding: number(departure.id), rule: departure.rule, source: departure.source, reason: departure.fact, fate: departureFate(departure) })),
    questions: questions.filter((question) => question.answer === null).map((question) => needQuestionOf(question, number(question.id), fix !== null)),
    uncommitted: fix === null || uncommitted === 0 ? null : { patches: uncommitted, readFirst },
    toFix: fix === null ? decisionsOf(context, 'fix').length : 0,
    numbers: context.numbers,
  };
}

/** A question of the brief as its item of "What needs you" takes it. */
export function needQuestionOf(question: BriefQuestion, number: number, fixed: boolean): NeedQuestion {
  return {
    finding: number,
    question: question.question,
    default: question.default,
    defaultHeld: question.defaultApplied ? 'held' : fixed ? 'not-applied' : 'review-only',
    choice: question.choice,
    options: question.options.map((option) => ({ number: option.number, option: option.option, cost: option.cost, rule: option.rule })),
  };
}

/** The status line (R1, R14 of the report for the person): the kind of run and its id, and its findings counted by what became of them. */
function statusOf(context: BriefContext, findings: readonly BriefFinding[]): BriefStatus {
  const fix = context.review.fix;
  const count = (...statuses: FindingStatus[]): number => findings.filter((finding) => statuses.includes(finding.status)).length;
  const answered = findings.filter((finding) => standingAnswer(context.review, finding.id) !== null).map((finding) => finding.number);
  const alreadyInTree = [...context.outcomes.values()].filter((outcomes) => outcomes.last === 'already applied').length;
  const committed = fix === null ? 0 : committedRevisions(fix);
  const counts = {
    kind: fix === null ? ('review' as const) : ('fix' as const),
    findings: findings.length,
    fixed: count('fixed', 'fixed-against-rule') - alreadyInTree,
    againstRule: count('fixed-against-rule', 'planned-against-rule'),
    alreadyInTree,
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
  const rest = [
    ...(counts.questions === 0 ? [] : [`asks you ${counted(counts.questions, 'question', 'questions')}`]),
    ...(answered.length === 0 ? [] : [`follows your answers to ${findingWords(answered)}`]),
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

/** The rows of "What deep-review fixed" (R5 of the report for the person): each applied fix in rank order, then each update of the documentation step; in a run that only reviewed, each fix it decided, with its plan. */
function fixesOf(context: BriefContext, findings: readonly BriefFinding[]): BriefFix[] {
  const { review } = context;
  const fix = review.fix;
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  if (fix === null) {
    return decisionsOf(context, 'fix').map((decision) => {
      const finding = byId.get(decision.id)!;
      return { finding: finding.number, severity: finding.severity, plausible: finding.verdict === 'PLAUSIBLE', againstRule: decision.departure !== null, subject: firstSentence(decision.fix.approach), kinds: [], patches: [] };
    });
  }
  const fixed = findings.filter((finding) => finding.status === 'fixed' || finding.status === 'fixed-against-rule').map((finding) => {
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

/**
 * What the run did not examine, in plain words (R4, R10 of the report for
 * the person; R10 of the brief of a run): the review passes that did not
 * run, the findings no verifier examined, the paths the settings left out,
 * the files too large to freeze, the checks with no command, the work a
 * stop ended, the steps the run budget stopped, and a documentation step
 * that did not run. What needs the person is an item of "What needs you",
 * not a gap.
 */
function notExaminedOf(context: BriefContext): string[] {
  const { state, review } = context;
  const scope = state.scope!;
  const gaps: string[] = [];
  for (const angle of Object.keys(review.anglesNotRun) as Angle[]) gaps.push(`The ${passNames[angle]} review pass did not run, and a later pass looked for what it would have found.`);
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
    gaps.push(`No verifier examined ${listed(parts)}${own.length === 0 ? '' : `; ${own.length === 1 ? 'it counts' : 'each counts'} as plausible`}.`);
  }
  if (scope.excluded.count > 0) gaps.push(`${capitalized(counted(scope.excluded.count, 'changed path', 'changed paths'))} under ${scope.request.exclude.join(', ')}, which the settings leave out.`);
  const oversized = scope.files.filter((file) => (file.before !== null && 'oversized' in file.before) || (file.after !== null && 'oversized' in file.after)).map((file) => file.path);
  if (oversized.length > 0) gaps.push(`${capitalized(counted(oversized.length, 'file', 'files'))} too large to freeze, which no worker was given: ${oversized.join(', ')}.`);
  const fix = review.fix;
  if (fix !== null) {
    for (const check of fix.checks.planned?.checks ?? []) {
      if (check.command === null) gaps.push(`No ${check.kind} check ran: ${droppedByOperator(review.survey, check) ?? check.reason ?? 'the run has no command for it'}.`);
    }
    const stopped = budgetStoppedUnits(fix);
    const steps = [...(stopped.some((unit) => unit.phase === 'documentation') ? ['the documentation step'] : []), ...(stopped.some((unit) => unit.phase === 'repair') ? ['the fixes for the checks'] : [])];
    if (steps.length > 0) gaps.push(`The run budget stopped the fix pass before ${listed(steps)}, and the end of the report gives the command that continues it.`);
    if (fix.openSeries !== null) gaps.push('A stop cut `deep-review commit` short; the next command completes the commits or drops them.');
    const cause = stepNotRunCause(review);
    if (review.documentationStep && cause !== null && cause !== 'no-edits') gaps.push(stepNotRunSentence(cause));
  }
  const workers = Object.values(state.workers);
  const ended = workers.filter((worker) => (worker.status === 'lost' || (worker.status === 'finished' && endedByKill(worker.finish))) && !ranAgain(workers, worker));
  if (ended.length > 0) gaps.push(`A stop ended ${counted(ended.length, 'worker', 'workers')} whose work did not run again; the end of the report names ${ended.length === 1 ? 'it' : 'them'}.`);
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
    if (decision?.decision === 'leave') add(decision.leave.supersededBy === null ? leaveReasonWords[decision.leave.reason] : `${leaveReasonWords[decision.leave.reason]} by finding ${String(context.numbers.get(decision.leave.supersededBy) ?? decision.leave.supersededBy)}`, finding.number);
    else if (decision?.decision === 'ask') add('your answer keeps the code as it is', finding.number);
    // A run configured before the decision step held a finding for the author when it fixed, and decided nothing when it only reviewed.
    else add(context.review.fix === null && context.review.decisions === null ? 'with no decision, since an engine before the decision step reviewed this run' : 'held for the author', finding.number);
  }
  if (reasons.size === 0) return null;
  return `Left as is: ${[...reasons].map(([reason, numbers]) => `${findingWords(numbers)}, ${reason}`).join('; ')}.`;
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
  const counts = { questions: openQuestions, departures: openDepartures, documents: context.documents.length, checks: context.checks.filter((check) => check.fault === 'edits').length };
  const changed = changedOf(context);
  // A fixer applied a fix, or an answer pass applied an answer, after the triage wrote its account (R5 of the questions in the chat).
  const edited = changed.applied.length > 0 || review.answers.some((answer) => answer.appliedBy !== null && answer.appliedBy !== 'tree');
  const findings = context.findings.map(({ entry, decision }, index): BriefFinding => ({
    number: index + 1,
    id: entry.finding.id,
    merged: entry.members.map((member) => member.id),
    severity: entry.finding.severity,
    verdict: entry.resolution.verdict,
    status: findingStatusOf(context, entry.finding.id, decision),
    summary: firstSentence(entry.finding.summary),
  }));
  const base = baseWords({ commit: state.scope.base, name: baseNameOf(state.scope.mode, state.scope.request) });
  const checks = context.checks.map((check) => {
    const row = meaningRowOf(check, review);
    return { ...check, meaning: row.meaning(check), comparedBy: row.comparedBy };
  });
  const facts = needsFactsOf(context, questions, departures, checks, base, findings);
  const needs = needsOf(facts);
  return {
    run: state.id,
    title: review.change.kind === 'given' ? review.change.reading.title : scopeTitle(state),
    findings,
    status: statusOf(context, findings),
    needs,
    needsLine: needsCountLine(needs, facts),
    checks,
    baseChecks: review.baseChecksStep,
    base,
    fixes: fixesOf(context, findings),
    notExamined: notExaminedOf(context),
    leftAs: leftAsOf(context, findings),
    headline: { ...counts, text: headlineText(counts, questions.every((question) => question.answer !== null || question.defaultApplied), review.fix !== null) },
    change: changeOf(review.change, edited),
    questions,
    departures,
    documents: context.documents,
    notCovered,
    covered: notCovered.length === 0 ? coveredText(context) : null,
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

/** The number of each finding of a brief by its id and its merged ids, for the aliases of a quote. */
const numbersOf = (brief: Pick<Brief, 'findings'>): ReadonlyMap<string, number> => new Map(brief.findings.flatMap((finding) => [finding.id, ...finding.merged].map((id) => [id, finding.number] as const)));

/** The number of the finding an id names in a brief, by its id or a merged one. */
export function numberIn(brief: Pick<Brief, 'findings'>, id: string): number {
  const found = brief.findings.find((finding) => finding.id === id || finding.merged.includes(id));
  if (found === undefined) throw new Error(`The brief names a finding it does not hold: ${id}`);
  return found.number;
}

/**
 * The account of the change as submitted (R1 of the report for the
 * person; R3 of the brief of a run): what it does, why in its own words,
 * then deep-review's judgments of it, whose account it is and what it
 * rests on, each a paragraph of one line; or why the run has none.
 */
function accountPart(brief: Brief): string[] {
  const { change } = brief;
  if (change.state !== 'given') return [missingAccountWords[change.state]];
  const said = (text: string): string => inlineText(quoted(text, { numbers: numbersOf(brief) }));
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

/** An item as a list item of its number: its lead, then each line after it as a line of a list under it. */
const itemLines = (number: number, lines: readonly string[]): string[] => [`${String(number)}. ${lines[0]!}`, ...lines.slice(1).map((line) => `   - ${line}`)];

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
        shown.push([`**${String(others.length)} more:** ${listed(others.map(name))}.`]);
      }
    } else if (need.rank >= 5 && need.rank <= 7) {
      const index = decisions.indexOf(need);
      if (index < shownDecisions) shown.push(need.lines);
      if (index === shownDecisions) {
        const others = decisions.slice(shownDecisions);
        shown.push([`**${counted(others.length, 'more decision', 'more decisions')}:** ${findingWords(others.map((other) => other.finding!))}. \`deep-review report --finding <number>\` prints each with its options and commands.`]);
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
    ...(brief.notExamined.length === 0 ? [covered] : brief.notExamined),
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
    const name = form === 'report' ? `[${check.kind}](#check-${check.kind})` : check.kind;
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
  const said = (text: string, own: number | null): string => tableCell(inlineText(quoted(text, { numbers: numbersOf(brief), own })));
  const marks = (fix: BriefFix): string => [...(fix.againstRule ? ['against a written rule'] : []), ...(fix.plausible ? ['plausible'] : [])].map((mark) => `, ${mark}`).join('');
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
