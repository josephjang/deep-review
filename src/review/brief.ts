/**
 * The brief of a run (R1, R2 of the brief of a run): the part of its
 * result a person reads first, as one value computed from the fold alone.
 * It holds the core of the change, the questions only a person can
 * answer, the fixes that go against a written rule, what the run did not
 * cover, where a person must look, and what deep-review changed. Nothing
 * records it: each command computes it again, so it is current after an
 * answer or a commit, and the same engine computes the same brief from
 * the same ledger. The report, the output of a command and the JSON form
 * each render this one value.
 */
import { answerWords, standingAnswer, type RecordedAnswer } from '../checkpoint/answer-state.ts';
import type { ChangeCondition, RecordedDecision } from '../checkpoint/events.ts';
import { allBatches, budgetStoppedUnits, committedRevisions, lastCurrentRun, lastRecordedRun, type CheckRunState, type FixState } from '../checkpoint/fix-state.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { unverifiedGroupsOf, type ReviewState, type TriageAccount } from '../checkpoint/review-fold.ts';
import { endedByKill } from '../runtime/kill-marks.ts';
import { answerArguments, defaultInPlace } from './decision-report.ts';
import { findingOutcomes, type FindingOutcome, type FindingOutcomes } from './fix-report.ts';
import { findingLink, inlineText, paragraphText, sentenceText, tableCell } from './markdown.ts';
import { rankedFindings, type ReportFinding } from './state.ts';
import { droppedByOperator } from './survey-report.ts';
import type { CheckKind } from './vocabulary.ts';

/** The most characters of a title, of what the change does and of why, that the brief shows; the evidence holds the whole account. */
export const briefLimits = { title: 80, what: 600, why: 400 } as const;

/** The core of the change: the triage's account, or why the run has none. */
export type BriefChange =
  | {
      readonly state: 'given';
      /** What the change does, cut at a word to `briefLimits.what`. */
      readonly what: string;
      /** Why, in the change's own words, cut at a word to `briefLimits.why`, or null when the change states none. */
      readonly why: string | null;
      readonly whyFrom: readonly string[];
      readonly restsOn: readonly string[];
      /** The triage's two judgments of principle 8, which `look` names when they hold. */
      readonly publicInterface: ChangeCondition;
      readonly wideEffect: ChangeCondition;
      /** Whether `what` or `why` was cut, so the brief points at the whole account in the evidence. */
      readonly cut: boolean;
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
  readonly inPlace: number;
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
export type BriefFate = 'applied' | 'already-in-tree' | 'deferred' | 'blocked' | 'not-attempted' | 'not-fixed';

/** A fix that goes against a written rule (R9 of the brief of a run). */
export interface BriefDeparture {
  readonly id: string;
  readonly rule: string;
  readonly source: string;
  /** The fact against the rule, as the decider gave it. */
  readonly fact: string;
  /** The fix deep-review decided instead. */
  readonly fix: string;
  readonly fate: BriefFate;
  readonly review: BriefAnswer | null;
  readonly accept: string;
  readonly reject: string;
}

/** The kinds of gap of R10: what the run did not examine, and what it did not finish. */
export const gapKinds = ['angle', 'unverified', 'excluded', 'oversized', 'check', 'fix', 'budget', 'stop'] as const;
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

/** One check's outcome before the fixes and after them, by its current run, else the run that checked the newest tree, or null where it did not run. */
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
}

export interface Brief {
  readonly run: string;
  readonly title: string;
  /** How many open questions and unreviewed departures wait for an answer, and the sentence that says so. */
  readonly headline: { readonly questions: number; readonly departures: number; readonly text: string };
  readonly change: BriefChange;
  readonly questions: readonly BriefQuestion[];
  readonly departures: readonly BriefDeparture[];
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

/** A count and the noun it counts, singular for one. */
export const counted = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** The command that answers `id` with `choice`, such as `--option 2` or `--accept`, as the brief names it: with no path, since no executable named deep-review is installed (R8). */
export const answerCommandOf = (id: string, choice: string): string => `deep-review ${answerArguments(id, choice)}`;

/** The title of a run whose triage gave no account: the change from its base to its head, or the uncommitted change on its head. */
function scopeTitle(state: RunState): string {
  const scope = state.scope!;
  const short = (commit: string): string => commit.slice(0, 8);
  return scope.base === scope.head ? `The uncommitted change on ${short(scope.head)}` : `The change from ${short(scope.base)} to ${short(scope.head)}`;
}


/** An answer as the brief says it: its words, when, and whether the tree holds it. */
const answerOf = (answer: RecordedAnswer): BriefAnswer => ({ kind: answer.answer.kind, option: answer.answer.kind === 'option' ? answer.answer.option + 1 : null, words: answerWords(answer.answer), at: answer.at, applied: answer.appliedBy !== null });

/** A fix pass's outcome of a finding in the brief's vocabulary; a finding no fixer was given has none. */
const fateWordsOf: Readonly<Partial<Record<FindingOutcome, BriefFate>>> = {
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
}

function contextOf(state: RunState, review: ReviewState): BriefContext {
  const byId = new Map((review.decisions ?? []).map((decision) => [decision.id, decision]));
  const findings = rankedFindings(review).map((entry) => ({ entry, decision: byId.get(entry.finding.id) ?? null }));
  const fix = review.fix;
  const outcomes = new Map(fix === null ? [] : findings.map(({ entry }) => [entry.finding.id, findingOutcomes(review, fix, entry.finding.id)] as const));
  return { state, review, findings, outcomes };
}

/** The decisions of a kind, in rank order. */
function decisionsOf<K extends RecordedDecision['decision']>(context: BriefContext, kind: K): Extract<RecordedDecision, { decision: K }>[] {
  return context.findings.flatMap(({ decision }) => (decision !== null && decision.decision === kind ? [decision as Extract<RecordedDecision, { decision: K }>] : []));
}

/** The ids of the findings a fix run left with `outcome` as Fixes names it, the last pass's, in rank order. */
const withOutcome = (context: BriefContext, outcome: FindingOutcome): string[] => [...context.outcomes].filter(([, found]) => found.last === outcome).map(([id]) => id);

function questionsOf(context: BriefContext): BriefQuestion[] {
  return decisionsOf(context, 'ask').map((decision) => {
    const { ask } = decision;
    const standing = standingAnswer(context.review, decision.id);
    return {
      id: decision.id,
      question: ask.question,
      inPlace: ask.applied + 1,
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

/** The ids of a list as words: each of them, joined. */
const idList = (ids: readonly string[]): string => ids.join(', ');

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

/** What an unfinished check did, in plain words, or null for one that ran to an outcome. */
const unfinishedWords = (outcome: string | null): string | null => (outcome === 'timeout' ? 'timed out' : outcome === 'skipped' ? 'was skipped' : outcome === 'not-started' ? 'did not start' : null);

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
  const unapplied: readonly [FindingOutcome, string][] = [['deferred', 'its fixer put it off'], ['blocked', 'its fixer could not apply it'], ['not attempted', 'no fixer attempted it']];
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
  for (const [outcome, words] of unapplied) {
    for (const id of withOutcome(context, outcome)) gaps.push({ kind: 'fix', text: `${wentToFixer(id)}, and ${words}.` });
  }
  const stopped = budgetStoppedUnits(fix);
  if (stopped.length > 0) {
    // In plain words, the findings the stopped batches hold, since the brief names no batch (R12).
    const keys = new Set(stopped.filter((unit) => unit.phase === 'fixes').map((unit) => unit.key));
    const findings = allBatches(fix).filter((batch) => keys.has(batch.key)).flatMap((batch) => batch.findingIds).length;
    const parts = [...(keys.size === 0 ? [] : [findings === 0 ? 'some of the fixes' : counted(findings, 'finding', 'findings')]), ...(stopped.some((unit) => unit.phase === 'repair') ? ['the repair of the checks'] : [])];
    const verb = parts.length === 1 && (findings === 1 || keys.size === 0) ? 'was' : 'were';
    gaps.push({ kind: 'budget', text: `The run budget stopped the fixes before ${parts.join(' and ')} ${verb} attempted. The facts of the run at the end of the report give the command that continues them.` });
  }
  if (fix.openSeries !== null) gaps.push({ kind: 'stop', text: 'A stop cut `deep-review commit` short; the next command completes the commits or drops them.' });
  return gaps;
}

/** What the run did not cover (R10 of the brief of a run), in plain words, each gap with its kind. */
function gapsOf(context: BriefContext): BriefGap[] {
  const { state, review } = context;
  const scope = state.scope!;
  const gaps: BriefGap[] = [];
  for (const [angle, reason] of Object.entries(review.anglesNotRun)) gaps.push({ kind: 'angle', text: `The ${angle} angle did not run (${reason}). A later pass looked for what it would have found.` });
  for (const group of unverifiedGroupsOf(review)) gaps.push({ kind: 'unverified', text: `No verifier examined ${idList(group.candidateIds)} (${group.reason}); each counts as PLAUSIBLE.` });
  if (scope.excluded.count > 0) gaps.push({ kind: 'excluded', text: `${counted(scope.excluded.count, 'changed path', 'changed paths')} under ${scope.request.exclude.join(', ')}, which the settings leave out.` });
  const oversized = scope.files.filter((file) => (file.before !== null && 'oversized' in file.before) || (file.after !== null && 'oversized' in file.after)).map((file) => file.path);
  if (oversized.length > 0) gaps.push({ kind: 'oversized', text: `${counted(oversized.length, 'file', 'files')} too large to freeze, which no worker was given: ${oversized.join(', ')}.` });
  if (review.fix !== null) gaps.push(...fixGaps(context, review.fix));
  // A worker a stop ended, by a kill or with its engine, whose unit no later worker of the same label ran again.
  const workers = Object.values(state.workers);
  const stopped = workers.filter((worker) => (worker.status === 'lost' || (worker.status === 'finished' && endedByKill(worker.finish))) && !workers.some((other) => other.launch.label !== null && other.launch.label === worker.launch.label && other.launchedAt > worker.launchedAt));
  if (stopped.length > 0) gaps.push({ kind: 'stop', text: `A stop ended ${counted(stopped.length, 'worker', 'workers')} whose work did not run again; the notes of the run name ${stopped.length === 1 ? 'it' : 'them'}.` });
  return gaps;
}

/** A judgment of the triage as the text of its condition: what, and the files that show it. */
const judgedWords = (condition: ChangeCondition): string => `${condition.what === null ? '' : `: ${condition.what.trim().replace(/[.]+$/, '')}`}${condition.files.length === 0 ? '' : ` (${condition.files.join(', ')})`}`;

/**
 * The conditions of principle 8 that hold (R11 of the brief of a run),
 * each with its findings: the fixes that go against a written rule; the
 * fixes a fixer applied on a verdict that is only PLAUSIBLE, or in a run
 * that only reviewed, the findings decided as fixes on one; and the two
 * judgments of the triage, marked as its own.
 */
function lookOf(context: BriefContext, departures: readonly BriefDeparture[]): BriefLook[] {
  const { review } = context;
  const look: BriefLook[] = [];
  if (departures.length > 0) look.push({ condition: 'departure', findings: departures.map((departure) => departure.id), text: `${counted(departures.length, 'fix goes', 'fixes go')} against a written rule` });
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
    return { fixed: false, decided: context.review.decisions !== null, applied: [], alreadyInTree: [], deferred: [], blocked: [], notAttempted: [], toFix, commits: null, patches: 0, left, checks: [] };
  }
  const shas = fix.commits.flatMap((series) => series.commits.map((commit) => commit.sha));
  return {
    fixed: true,
    decided: context.review.decisions !== null,
    applied: withOutcome(context, 'applied'),
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
  };
}

/** The headline's sentence: how many things need the person, and that nothing waits. */
function headlineText(questions: number, departures: number, defaultsInPlace: boolean): string {
  const total = questions + departures;
  if (total === 0) return 'Nothing needs you: no question is open, and no fix that goes against a written rule waits for your review.';
  const parts = [...(questions === 0 ? [] : [counted(questions, 'question', 'questions')]), ...(departures === 0 ? [] : [counted(departures, 'fix that goes against a written rule', 'fixes that go against a written rule')])];
  const waits = questions === 0 ? 'Nothing waits for you: the run went on as it decided.' : `Nothing waits for you: each question has a default${defaultsInPlace ? ' in place' : ''}.`;
  return `${counted(total, 'thing needs', 'things need')} you: ${parts.join(' and ')}. ${waits}`;
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

/** The core of the change from the triage's account: cut to what the brief shows, or why the run has none. */
function changeOf(account: TriageAccount): BriefChange {
  if (account.kind !== 'given') return { state: account.kind };
  const { reading } = account;
  const what = cutAtWord(reading.what, briefLimits.what);
  const why = reading.why === null ? null : cutAtWord(reading.why, briefLimits.why);
  return { state: 'given', what, why, whyFrom: reading.whyFrom, restsOn: reading.restsOn, publicInterface: reading.publicInterface, wideEffect: reading.wideEffect, cut: what !== reading.what || why !== reading.why };
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
  return {
    run: state.id,
    title: review.change.kind === 'given' ? cutAtWord(review.change.reading.title, briefLimits.title) : scopeTitle(state),
    headline: { questions: openQuestions, departures: openDepartures, text: headlineText(openQuestions, openDepartures, questions.every((question) => question.answer !== null || question.defaultApplied)) },
    change: changeOf(review.change),
    questions,
    departures,
    notCovered,
    covered: notCovered.length === 0 ? coveredText(review) : null,
    look: lookOf(context, departures),
    changed: changedOf(context),
  };
}

/** The most ids a list of the brief shows; it counts the rest (R13 of the brief of a run). */
export const shownIds = 8;

/** Ids as the brief lists them: the first `shownIds`, each as `show` gives it, then how many more. */
export function idWords(ids: readonly string[], show: (id: string) => string = (id) => id): string {
  const named = ids.slice(0, shownIds).map(show);
  const more = ids.length - named.length;
  if (more > 0) return `${named.join(', ')} and ${String(more)} more`;
  return named.length <= 1 ? named.join('') : `${named.slice(0, -1).join(', ')} and ${named.at(-1)!}`;
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

/** How a person runs a command the brief gives, said once, with no path (R8 of the brief of a run). */
export const howToAnswer = 'To answer, ask your agent with the deep-review skill, or type the command at a terminal as the end of this report shows.';

/** An answer a person gave, as a line of the brief. */
const answeredWords = (given: BriefAnswer): string => `Answered: ${given.words} on ${given.at}; ${given.applied ? 'the tree holds it' : 'not yet applied'}.`;

/** The part "The change": the core of the change, marked as the triage's unverified account, or why the run has none. */
function changePart(change: BriefChange): string[] {
  const lines = ['## The change', ''];
  switch (change.state) {
    case 'unrecorded':
      return [...lines, 'The triage of this run did not record the core of the change, because an engine before this change reviewed it.'];
    case 'none':
      return [...lines, 'The triage of this run gave no account of the change.'];
    case 'given': {
      const sources = (list: readonly string[]): string => list.map(inlineText).join(', ');
      const why = change.why === null
        ? 'The change states no reason.'
        : `Why, in the change's own words: ${inlineText(change.why)} (${change.whyFrom.length === 0 ? 'the triage named no source' : `from ${sources(change.whyFrom)}`}).`;
      const restsOn = change.restsOn.length === 0 ? '' : ` It rests on ${sources(change.restsOn)}.`;
      const whole = change.cut ? ' The whole account is under [The change, in full](#the-change-in-full).' : '';
      return [...lines, paragraphText(change.what), '', paragraphText(why), '', `This is the triage's account of the change, which no verifier examined.${restsOn}${whole}`];
    }
  }
}

/** One question as a block of the brief: its words, the option in place now and deep-review's choice, the options, the command, and the details one step below. */
function questionBlock(question: BriefQuestion, position: number, fixed: boolean): string[] {
  const { answer } = question;
  // What stands: the answer a person gave, else the default, in place or, when it edits the code and no fixer applied it, only the default.
  const answered = answer?.option ?? null;
  const standing = answer !== null
    ? `${answeredWords(answer)} deep-review's choice was option ${String(question.choice)}.`
    : question.defaultApplied
      ? question.inPlace === question.choice
        ? `In place now: option ${String(question.inPlace)}, which is also deep-review's choice, because it is the easiest to take back.`
        : `In place now: option ${String(question.inPlace)}, because it is the easiest to take back. deep-review's choice: option ${String(question.choice)}.`
      : `The default: option ${String(question.inPlace)}, because it is the easiest to take back; ${fixed ? 'its fixer did not apply it' : 'this run only reviewed, so `review --fix` applies it'}. deep-review's choice: option ${String(question.choice)}.`;
  const inPlaceLabel = question.defaultApplied ? 'in place now' : 'the default';
  const label = (option: BriefOption): string => [
    String(option.number),
    ...(answer === null && option.number === question.inPlace ? [inPlaceLabel] : []),
    ...(option.number === answered ? ['your answer'] : []),
    ...(option.number === question.choice ? ['deep-review\'s choice'] : []),
  ].join(', ');
  return [
    `### ${String(position)}. ${inlineText(question.question)} (${findingLink(question.id)})`,
    '',
    standing,
    '',
    '| Option | What it does | What it costs |',
    '|---|---|---|',
    ...question.options.map((option) => `| ${label(option)} | ${tableCell(option.option)} | ${tableCell(option.cost)} |`),
    ...(answer === null ? ['', `To take deep-review's choice: \`${question.command}\`. For another option, give its number.`] : []),
    '',
    '<details><summary>The rule that each option makes, where deep-review looked, and why it asks</summary>',
    '',
    ...question.options.map((option) => `- Option ${String(option.number)} makes this rule: ${inlineText(option.rule)}`),
    `- Where deep-review looked: ${question.lookedIn.map(inlineText).join('; ')}`,
    `- Why it asks: ${inlineText(question.grounds)}`,
    '',
    '</details>',
  ];
}

/** One fix that goes against a written rule as a block of the brief: the rule, the fact against it, the fix and its fate, and the commands that review it. */
function departureBlock(departure: BriefDeparture, position: number, fixed: boolean): string[] {
  const { review } = departure;
  const reviewLine = review === null
    ? `To keep the fix and change the rule: \`${departure.accept}\`. To follow the rule: \`${departure.reject}\`.`
    : answeredWords(review);
  // A rejection replaces the departing fix with one that follows the rule, so the fate of the departing fix no longer stands.
  const fate = review?.kind !== 'reject'
    ? fateWords[departure.fate]
    : `You chose to follow the rule instead; ${review.applied ? 'the tree holds the fix that follows it' : fixed ? 'no fixer has applied the fix that follows it yet' : '`review --fix` applies the fix that follows it'}.`;
  return [
    `### ${String(position)}. ${findingLink(departure.id)}`,
    '',
    `The rule: ${inlineText(departure.rule)} (${inlineText(departure.source)}).`,
    '',
    `The fact against it: ${sentenceText(departure.fact)}`,
    '',
    `What the fix does: ${sentenceText(departure.fix)} ${fate}`,
    '',
    reviewLine,
  ];
}

/** The part "Where to look": each condition of principle 8 that holds, with its findings linked, or one line that none does. */
function lookPart(brief: Brief): string[] {
  const lines = ['## Where to look', ''];
  if (brief.look.length > 0) return [...lines, ...brief.look.map((entry) => `- ${inlineText(entry.text)}${entry.findings.length === 0 ? '' : `: ${idWords(entry.findings, findingLink)}`}.`)];
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

/** The paragraph "What deep-review changed" (R2 of the brief of a run). */
function changedPart(changed: BriefChanged): string[] {
  const lines = ['## What deep-review changed', ''];
  const left = changed.left.length === 0 ? '' : ` It left ${counted(changed.left.length, 'finding', 'findings')}: ${idWords(changed.left, findingLink)}.`;
  if (!changed.fixed) {
    const toFix = !changed.decided ? '' : changed.toFix.length === 0 ? ' It decided to fix no finding.' : ` It decided to fix ${counted(changed.toFix.length, 'finding', 'findings')}, which \`review --fix\` applies: ${idWords(changed.toFix, findingLink)}.`;
    return [...lines, `This run only reviewed: it changed nothing.${toFix}${left}`];
  }
  const part = (ids: readonly string[], words: string): string[] => (ids.length === 0 ? [] : [`${words} ${String(ids.length)} (${idWords(ids, findingLink)})`]);
  const outcomes = [
    `deep-review applied ${counted(changed.applied.length, 'fix', 'fixes')}${changed.applied.length === 0 ? '' : ` (${idWords(changed.applied, findingLink)})`}`,
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
  return [...lines, `${outcomes.join('; ')}. ${commits}${left} ${checksWords(changed.checks)}`];
}

/**
 * The Markdown form of the brief (R8 to R12, R15 of the brief of a run):
 * the title, the headline, and the parts in the order of principle 5,
 * then what deep-review changed. It names no local path; it says once,
 * in the first part that gives a command, how a person runs one.
 */
export function briefMarkdown(brief: Brief): string[] {
  const questions = brief.questions.length === 0 ? [] : [
    `## Questions for you (${String(brief.questions.length)})`,
    '',
    `Each question has a default, the option that is the easiest to take back. Answer only to choose another one. ${howToAnswer}`,
    ...brief.questions.flatMap((question, index) => ['', ...questionBlock(question, index + 1, brief.changed.fixed)]),
  ];
  const departures = brief.departures.length === 0 ? [] : [
    `## Fixes that go against a written rule (${String(brief.departures.length)})`,
    ...(brief.questions.length === 0 ? ['', `Each fix below went ahead as deep-review decided. Review it only to go another way. ${howToAnswer}`] : []),
    ...brief.departures.flatMap((departure, index) => ['', ...departureBlock(departure, index + 1, brief.changed.fixed)]),
  ];
  const notCovered = ['## What the review did not cover', '', ...(brief.covered === null ? brief.notCovered.map((gap) => `- ${inlineText(gap.text)}`) : [brief.covered])];
  const parts = [changePart(brief.change), questions, departures, notCovered, lookPart(brief), changedPart(brief.changed)].filter((part) => part.length > 0);
  return [`# ${inlineText(brief.title)}`, '', brief.headline.text, ...parts.flatMap((part) => ['', ...part])];
}

/** The most characters of a line of the short form; the path that ends it has no limit, since a path cannot be cut (R13 of the brief of a run). */
export const shortLineLimit = 200;

/** The first sentence of a text, or the whole text when it has no sentence end. */
const firstSentence = (text: string): string => /^.*?[.!?](?=\s|$)/.exec(inlineText(text))?.[0] ?? inlineText(text);

/** A condition of principle 8 in a few words, for the short form. */
const lookWords = (entry: BriefLook): string => {
  switch (entry.condition) {
    case 'departure':
      return counted(entry.findings.length, 'departure', 'departures');
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

/**
 * The short form of the brief (R13, PD12 of the brief of a run): at most
 * seven lines of at most `shortLineLimit` characters, whatever the number
 * of findings, each naming its subject in its first words so it keeps its
 * sense when a model rewords it; a list shows at most `shownIds` ids and
 * counts the rest, and a line with nothing to say says so. The caller
 * prints the path of the report after them, the last line.
 */
export function briefShortForm(brief: Brief): string[] {
  const openQuestions = brief.questions.filter((question) => question.answer === null).map((question) => question.id);
  const openDepartures = brief.departures.filter((departure) => departure.review === null).map((departure) => departure.id);
  const change = brief.change.state === 'given' ? firstSentence(brief.change.what) : brief.change.state === 'none' ? 'the triage gave no account of it' : 'not recorded; an engine before the account reviewed this run';
  const gaps = brief.notCovered;
  const notCovered = gaps.length === 0 ? 'nothing' : gaps.length === 1 ? inlineText(gaps[0]!.text) : `${String(gaps.length)} gaps, the first: ${inlineText(gaps[0]!.text)}`;
  const lines = [
    `${inlineText(brief.title)} (run ${brief.run.slice(0, 8)})`,
    `The change: ${change}`,
    openQuestions.length === 0 ? `Questions: ${brief.questions.length === 0 ? 'none' : 'none open; each is answered'}` : `Questions: ${String(openQuestions.length)}, each with a default in place: ${idWords(openQuestions)}`,
    openDepartures.length === 0 ? `Against a written rule: ${brief.departures.length === 0 ? 'no fix' : 'no fix left to review'}` : `Against a written rule: ${counted(openDepartures.length, 'fix', 'fixes')}: ${idWords(openDepartures)}`,
    `Not covered: ${notCovered}`,
    `Look at: ${brief.look.length === 0 ? 'nothing' : brief.look.map(lookWords).join(', ')}`,
    `Changed: ${changedWords(brief.changed)}`,
  ];
  return lines.map((line) => cutAtWord(line, shortLineLimit));
}
