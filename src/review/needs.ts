/**
 * What needs the person before a merge (R2, R3, TD2 of the report for the
 * person): a closed table of conditions in the order of what doing
 * nothing costs, read in order, so the items of "What needs you" come
 * from this table alone and in its order. Each row holds its condition, a
 * pure function of the facts of the brief that gives its items, and the
 * words of its part of the count line. An item names its check or its
 * finding and its condition in its first words, says what happens if the
 * person does nothing, and gives the command that acts when one exists.
 */
import type { BriefCheck, CheckMeaningRow, CheckMoment, LastMoment } from './brief-checks.ts';
import { notComparedPlainWords } from './brief-checks.ts';
import type { LeftDocument } from './documents.ts';
import { capitalized, codeSpan, counted, inlineText, listed, quoted, sentenceText } from './markdown.ts';
import { shortRunId } from './runs.ts';
import type { CheckKind } from './vocabulary.ts';

/** The conditions of "What needs you", each with its rank; rank 4 has three, which the count line names apart. */
export const needConditions = ['edits', 'change-breaks', 'not-compared', 'unfinished-edits', 'unapplied-fix', 'document', 'departure', 'question-other', 'question-choice', 'uncommitted'] as const;
export type NeedCondition = (typeof needConditions)[number];

export type NeedRank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** One item of "What needs you". */
export interface BriefNeed {
  readonly rank: NeedRank;
  readonly condition: NeedCondition;
  /** The finding it names by its number, or null. */
  readonly finding: number | null;
  /** The kind of check it names, or null. */
  readonly check: CheckKind | null;
  /** The document it names, or null. */
  readonly document: string | null;
  /** The patch it names, for edits that name no finding, or null. */
  readonly patch: number | null;
  /** Its lines, the lead first; each line after the lead is a line of a list under it. */
  readonly lines: readonly string[];
}

/** One option of a question, as an item of a question names it. */
export interface NeedOption {
  readonly number: number;
  readonly option: string;
  readonly cost: string;
  readonly rule: string;
}

/** An open question, as its item needs it. */
export interface NeedQuestion {
  readonly finding: number;
  readonly question: string;
  readonly default: number;
  /** Whether the tree holds the default; why not, when it does not. */
  readonly defaultHeld: 'held' | 'review-only' | 'not-applied';
  readonly choice: number;
  readonly options: readonly NeedOption[];
}

/** An open fix against a written rule, as its item needs it. */
export interface NeedDeparture {
  readonly finding: number;
  readonly rule: string;
  readonly source: string;
  readonly reason: string;
  /** Where the fix is: in the working tree, committed, already in the tree, not applied with why, or to come with the fix pass. */
  readonly fate: { readonly kind: 'applied' | 'committed' | 'already-in-tree' | 'review-only' } | { readonly kind: 'not-applied'; readonly why: string };
}

/** What the table reads: the facts of the brief, each computed once by `briefOf`. */
export interface NeedsFacts {
  readonly run: string;
  /** Whether the run fixed; a run that only reviewed edits nothing and runs no check. */
  readonly fixed: boolean;
  /** Whether every patch of the run is committed, and there is at least one. */
  readonly committed: boolean;
  /** The base as the brief names it. */
  readonly base: string;
  /** Each check with the rank its meaning gives it, or null for none, from the one row `briefOf` read its meaning from. */
  readonly checks: readonly (BriefCheck & Pick<CheckMeaningRow, 'rank'>)[];
  /** The edits of a fixer that did not finish and that no later fixer of the same work answered for (R20 of the fix pass). */
  readonly unfinishedEdits: readonly { readonly patch: number; readonly finding: number | null }[];
  /** Each fix no fixer applied, with why in a clause, and whether the run budget stopped it or it was a person's answer. */
  readonly unapplied: readonly { readonly finding: number; readonly why: string; readonly answer: boolean }[];
  readonly documents: readonly LeftDocument[];
  readonly departures: readonly NeedDeparture[];
  readonly questions: readonly NeedQuestion[];
  /** The patches no commit holds yet, and the ones to read first with why; null when none is uncommitted. */
  readonly uncommitted: { readonly patches: number; readonly readFirst: readonly string[] } | null;
  /** In a run that only reviewed, how many findings it decided to fix; 0 in a fix run. */
  readonly toFix: number;
  /** The number of each finding by its id, for the aliases of a quote. */
  readonly numbers: ReadonlyMap<string, number>;
  /** The scratch directories of the run's workers, which each quote writes `<scratch>`. */
  readonly scratch: readonly string[];
}

/** The answer command's arguments after the program, for a run, a finding and a choice such as `--accept`: the one spelling of its flags, which each answer command of the report is built from (R3, R7 of the report for the person). */
export const answerArguments = (run: string, finding: string, choice: string): string => `answer --run ${shortRunId(run)} --finding ${finding} ${choice}`;

/** The answer command of a finding, naming its run (R3, R7 of the report for the person). */
export const answerCommand = (run: string, finding: number, choice: string): string => `deep-review ${answerArguments(run, String(finding), choice)}`;

/** What an item needs to name its commands and quote a worker: the run, the number of each finding and the scratch directories of the run's workers. */
export type ItemFacts = Pick<NeedsFacts, 'run' | 'numbers' | 'scratch'>;

/** A text of a worker, quoted on one line. */
const said = (facts: ItemFacts, text: string, own: number | null = null): string => inlineText(quoted(text, { numbers: facts.numbers, own, scratch: facts.scratch }));

/** When a check's last run ran, in the words of the brief (R3 of the facts before a merge). */
export const lastMomentWords: Readonly<Record<LastMoment, string>> = { fixes: 'after the fixes', repair: 'after the fixes for the checks', answers: 'after your answers' };

/** When an earlier run of a check ran, before its last. */
const earlierMomentWords: Readonly<Record<CheckMoment, string>> = { before: 'as submitted', fixes: 'after the fixes', repair: 'after the fixes for the checks', answers: 'after earlier answers' };

/** An item as its row's `items` gives it; the row stamps its own rank and condition on it, so the two cannot disagree. */
export type NeedItem = Omit<BriefNeed, 'rank' | 'condition'>;

/** An item of its lines, naming the finding, check, document or patch it is given and null for the others. */
const need = (lines: readonly string[], names: Partial<Pick<BriefNeed, 'finding' | 'check' | 'document' | 'patch'>> = {}): NeedItem => ({ finding: null, check: null, document: null, patch: null, ...names, lines });

const checkItem = (check: BriefCheck, lead: string, rest: string): NeedItem => need([`**${lead}** ${rest}`], { check: check.kind });

/** What a check that the edits of the run made fail costs if the person does nothing: the commit of a tree in which it fails, or the commits that hold one. */
const editsCost = (facts: NeedsFacts): string => (facts.committed ? 'the commits of this run hold a tree in which it fails' : '`deep-review commit` commits a tree in which it fails');

/**
 * The line of an option of a question, as its item and its finding's block
 * both give it: its number, `the default` with `held` when it is the
 * default, whether it is deep-review's choice, then the option, its cost
 * and its rule, each text already quoted.
 */
export const optionLine = (number: number, held: string | null, choice: boolean, texts: { readonly option: string; readonly cost: string; readonly rule: string }): string => {
  const marks = [`Option ${String(number)}`, ...(held === null ? [] : [`the default, ${held}`]), ...(choice ? ['deep-review\'s choice'] : [])];
  return `${marks.join(', ')}: ${sentenceText(texts.option)} Cost: ${sentenceText(texts.cost)} Rule: ${sentenceText(texts.rule)}`;
};

/** The item of a question (R3): its lead and question, a line per option with its marks, and what happens if the person does nothing with the commands. */
export function questionItem(facts: ItemFacts, question: NeedQuestion): NeedItem {
  const own = question.finding;
  const choiceIsDefault = question.default === question.choice;
  const lead = choiceIsDefault ? `Finding ${String(own)} asks you a question, and its default is deep-review's choice.` : `Finding ${String(own)} asks you a question, and deep-review's choice is not its default.`;
  const held = question.defaultHeld === 'held' ? 'in place now' : question.defaultHeld === 'review-only' ? 'which this run did not apply, since it only reviewed' : 'which no fixer applied';
  const options = question.options.map((option) => optionLine(option.number, option.number === question.default ? held : null, option.number === question.choice, { option: said(facts, option.option, own), cost: said(facts, option.cost, own), rule: said(facts, option.rule, own) }));
  const stays = question.defaultHeld === 'review-only' ? `the fix pass applies option ${String(question.default)}` : `option ${String(question.default)} stays`;
  const another = `To take another option: ${codeSpan(answerCommand(facts.run, own, '--option <n>'))}, with its number.`;
  const nothing = choiceIsDefault
    ? `If you do nothing, ${stays}, and it is deep-review's choice. ${another}`
    : `If you do nothing, ${stays}, and deep-review's choice is option ${String(question.choice)}. To take it: ${codeSpan(answerCommand(facts.run, own, `--option ${String(question.choice)}`))}.`;
  return need([`**${lead}** ${said(facts, question.question, own)}`, ...options, nothing], { finding: own });
}

/** Where a fix against a written rule is, as the sentence after the lead of its item. */
function departureFateWords(fate: NeedDeparture['fate']): string {
  switch (fate.kind) {
    case 'applied':
      return 'The fix is in your working tree.';
    case 'committed':
      return 'The fix is committed.';
    case 'already-in-tree':
      return 'The tree already held the fix.';
    case 'review-only':
      return 'This run only reviewed, so the fix pass applies it.';
    case 'not-applied':
      return `${capitalized(fate.why)}.`;
  }
}

/** The item of a fix against a written rule (R3): its lead, the rule, where it is written, why deep-review went against it, and the two commands. */
export function departureItem(facts: ItemFacts, departure: NeedDeparture): NeedItem {
  const own = departure.finding;
  const inTree = departure.fate.kind === 'applied' || departure.fate.kind === 'committed' || departure.fate.kind === 'already-in-tree';
  const lead = departure.fate.kind === 'review-only' ? `Finding ${String(own)} would be fixed against a written rule.` : inTree ? `Finding ${String(own)} is fixed against a written rule.` : `The fix of finding ${String(own)} goes against a written rule, and no fixer applied it.`;
  const stays = inTree ? 'the fix stays, and the rule stays as it is written' : departure.fate.kind === 'review-only' ? 'the fix pass applies the fix, and the rule stays as it is written' : 'the rule stays as it is written';
  return need([
    `**${lead}** ${departureFateWords(departure.fate)}`,
    `The rule: ${said(facts, departure.rule, own)}`,
    `Where it is written: ${said(facts, departure.source, own)}`,
    `Why deep-review went against it: ${said(facts, departure.reason, own)}`,
    `If you do nothing, ${stays}. To keep the fix and change the rule: ${codeSpan(answerCommand(facts.run, own, '--accept'))}. To follow the rule: ${codeSpan(answerCommand(facts.run, own, '--reject'))}.`,
  ], { finding: own });
}

/** A document left out of date, as its item says it: the facts with who reported each, and the reasons. */
function documentItem(facts: ItemFacts, document: LeftDocument): NeedItem {
  const reported = document.facts.length === 0 ? '' : ` ${capitalized(document.facts.map((fact) => `${said(facts, fact.what).replace(/[.]+$/, '')} (${fact.by})`).join('; '))}.`;
  const reasons = document.reasons.length === 0 ? '' : ` ${document.reasons.map((reason) => inlineText(reason.text)).join(' ')}`;
  return need([`**${codeSpan(document.file)} is out of date.**${reported}${reasons} If you do nothing, the document stays out of date.`], { document: document.file });
}

/** One row of the table: its rank and condition, which it stamps on each of its items, its items, and its part of the count line, for one item and for several. */
interface NeedRow {
  readonly rank: NeedRank;
  readonly condition: NeedCondition;
  readonly items: (facts: NeedsFacts) => NeedItem[];
  readonly count: readonly [one: string, many: string];
}

/** The checks whose meaning gives them a rank, in the order of the checks. */
const ranked = (facts: NeedsFacts, rank: 1 | 2 | 3): BriefCheck[] => facts.checks.filter((check) => check.rank === rank);

/**
 * The table of R2, in the order of what doing nothing costs. A check has
 * one meaning, so it gives at most one item; a question has one rank, by
 * whether its default is deep-review's choice; a fix against a written
 * rule is rank 5 whatever became of its fix, which its item says.
 */
export const needTable: readonly NeedRow[] = [
  {
    rank: 1,
    condition: 'edits',
    items: (facts) => ranked(facts, 1).map((check) => checkItem(check, `The ${check.kind} check fails ${check.last === null ? '' : lastMomentWords[check.last.when]}, and passed ${check.earlier.passed === null ? 'before' : earlierMomentWords[check.earlier.passed]}.`, `The edits of this run made it fail. If you do nothing, ${editsCost(facts)}.`)),
    count: ['check that the edits of this run made fail', 'checks that the edits of this run made fail'],
  },
  {
    rank: 2,
    condition: 'change-breaks',
    items: (facts) => ranked(facts, 2).map((check) => check.fault === 'change-breaks'
      ? checkItem(check, `The ${check.kind} check fails because of the change.`, `It passes on the base, ${facts.base}. If you do nothing, the check keeps failing, since no step of the run fixes a failure that the change brings.`)
      : checkItem(check, `The ${check.kind} check has failures that the base does not have, by a model's comparison.`, `The base is ${facts.base}. If you do nothing, the check keeps failing, since no step of the run fixes a failure that the change brings.`)),
    count: ['check fails because of the change', 'checks fail because of the change'],
  },
  {
    rank: 3,
    condition: 'not-compared',
    items: (facts) => ranked(facts, 3).map((check) => check.last === null
      ? checkItem(check, `The ${check.kind} check fails as submitted, and the run did not compare it with the base.`, 'No fix changed a file, so no check ran after the fixes and none ran on the base. If you do nothing, nobody knows whether the change causes the failure.')
      : checkItem(check, `The ${check.kind} check fails, and the run did not compare it with the base.`, `${capitalized(notComparedPlainWords[check.base?.reason ?? 'not-run'])}. If you do nothing, nobody knows whether the change causes the failure.`)),
    count: ['check not compared with the base', 'checks not compared with the base'],
  },
  {
    rank: 4,
    condition: 'unfinished-edits',
    items: (facts) => facts.unfinishedEdits.map((edit) => need([`**Patch ${String(edit.patch)} holds edits of a fixer that did not finish${edit.finding === null ? '' : `, for finding ${String(edit.finding)}`}.** No later fixer of the same work answered. If you do nothing, ${facts.committed ? 'the commits hold the edits as they are' : '`deep-review commit` commits the edits as they are'}.`], { finding: edit.finding, patch: edit.patch })),
    count: ['piece of work not finished', 'pieces of work not finished'],
  },
  {
    rank: 4,
    condition: 'unapplied-fix',
    items: (facts) => facts.unapplied.map((fix) => need([`**${fix.answer ? `Your answer to finding ${String(fix.finding)} is not applied` : `Finding ${String(fix.finding)} is not fixed`}: ${fix.why}.** If you do nothing, the finding stays as it is.`], { finding: fix.finding })),
    count: ['piece of work not finished', 'pieces of work not finished'],
  },
  {
    rank: 4,
    condition: 'document',
    items: (facts) => facts.documents.map((document) => documentItem(facts, document)),
    count: ['document out of date', 'documents out of date'],
  },
  {
    rank: 5,
    condition: 'departure',
    items: (facts) => facts.departures.map((departure) => departureItem(facts, departure)),
    count: ['fix against a written rule to review', 'fixes against a written rule to review'],
  },
  {
    rank: 6,
    condition: 'question-other',
    items: (facts) => facts.questions.filter((question) => question.default !== question.choice).map((question) => questionItem(facts, question)),
    count: ['question whose default is not deep-review\'s choice', 'questions whose default is not deep-review\'s choice'],
  },
  {
    rank: 7,
    condition: 'question-choice',
    items: (facts) => facts.questions.filter((question) => question.default === question.choice).map((question) => questionItem(facts, question)),
    count: ['question whose default is deep-review\'s choice', 'questions whose default is deep-review\'s choice'],
  },
  {
    rank: 8,
    condition: 'uncommitted',
    items: (facts) => {
      if (facts.fixed) {
        if (facts.uncommitted === null) return [];
        const { patches, readFirst } = facts.uncommitted;
        const first = readFirst.length === 0 ? '' : ` Read first ${listed(readFirst)}.`;
        return [need([`**Review the ${counted(patches, 'uncommitted patch, then commit it', 'uncommitted patches, then commit them')}.**${first} If you do nothing, the fixes stay uncommitted in your working tree. To commit them: ${codeSpan(`deep-review commit --run ${shortRunId(facts.run)}`)}.`])];
      }
      if (facts.toFix === 0) return [];
      return [need([`**Apply the ${counted(facts.toFix, 'fix', 'fixes')} that deep-review decided.** This run only reviewed. If you do nothing, the change stays as it is. To fix, ask your agent to continue this review with fixes, or run \`deep-review review --fix\` on the same change with the same runtime.`])];
    },
    count: ['patch to commit', 'patches to commit'],
  },
];

/** The items of "What needs you", in the order of the table, each with its row's rank and condition. */
export const needsOf = (facts: NeedsFacts): BriefNeed[] => needTable.flatMap((row) => row.items(facts).map((item) => ({ rank: row.rank, condition: row.condition, ...item })));

/** The most items of unfinished work, and the most decisions (questions and fixes against a written rule together), that the brief shows in full; one more line names the others (R2, R3, TD9 of the report for the person). */
export const shownUnfinished = 3;
export const shownDecisions = 3;

/**
 * The count line of "What needs you" (R2): one part for each condition that
 * holds, with the number of its items, or for the uncommitted fixes of its
 * patches, then in a fix run a sentence that names each of rank 1 and rank
 * 4 that does not hold; or "Nothing needs you" with the conditions it
 * checked.
 */
export function needsCountLine(needs: readonly BriefNeed[], facts: NeedsFacts): string {
  const of = (condition: NeedCondition): BriefNeed[] => needs.filter((need) => need.condition === condition);
  const work = of('unfinished-edits').length + of('unapplied-fix').length;
  const parts = needTable.flatMap((row) => {
    if (row.condition === 'unapplied-fix') return [];
    const n = row.condition === 'unfinished-edits' ? work : row.condition === 'uncommitted' ? (facts.fixed ? (facts.uncommitted?.patches ?? 0) : facts.toFix) : of(row.condition).length;
    if (n === 0) return [];
    const words = row.condition === 'uncommitted' && !facts.fixed ? (['fix to apply', 'fixes to apply'] as const) : row.count;
    return [counted(n, words[0], words[1])];
  });
  const notHeld = [
    ...(of('edits').length === 0 ? ['the edits of this run made no check fail'] : []),
    ...((): string[] => {
      const left = [...(work === 0 ? ['no work unfinished'] : []), ...(of('document').length === 0 ? ['no document out of date'] : [])];
      return left.length === 0 ? [] : [`the run left ${listed(left)}`];
    })(),
  ];
  const none = notHeld.length === 0 ? '' : ` ${capitalized(notHeld.join(', and '))}.`;
  if (parts.length > 0) return `Before a merge: ${listed(parts)}.${facts.fixed ? none : ''}`;
  if (!facts.fixed) return 'Nothing needs you. No fix against a written rule waits for your review, no question is open, and deep-review decided no fix.';
  return 'Nothing needs you. The edits of this run made no check fail, no check fails because of the change or is left without a comparison with the base, the run left no work unfinished and no document out of date, no fix against a written rule waits for your review, no question is open, and every fix is committed.';
}
