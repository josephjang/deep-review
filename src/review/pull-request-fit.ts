/**
 * The order in which a review on the pull request that is longer than
 * GitHub takes leaves out its pieces (R2 to R5, TD1, TD2 of the review
 * that always posts). `fitOrder` builds the order of a run as a list of
 * steps, each a piece to leave out; the form takes a prefix of it, one
 * step more at a time, until the body fits, and `leftOutOf` folds such a
 * prefix into what each section of the body reads. Pure: it renders
 * nothing.
 */
import { acts, inFull, isMinor, leftAsIs, majorActing, minorActing, type FindingView, type FormView } from './pull-request-view.ts';
import { choicesShown } from './state.ts';

/**
 * One piece of the body to leave out (R2): the table of the minor
 * findings; the record of the decision of a finding; the refuted
 * candidates; a finding left as is; the diagrams of the areas and of the
 * core of the change; the text of a finding in full; the line of a minor
 * finding in full; or everything but the floor.
 */
export type FitStep =
  | { readonly piece: 'minor-table' }
  | { readonly piece: 'record'; readonly finding: string }
  | { readonly piece: 'refuted' }
  | { readonly piece: 'left'; readonly finding: string }
  | { readonly piece: 'diagrams' }
  | { readonly piece: 'text'; readonly finding: string }
  | { readonly piece: 'line'; readonly finding: string }
  | { readonly piece: 'floor' };

/** The pieces that one finding loses, from the least to the most. */
export type FindingPiece = 'record' | 'text' | 'line' | 'left';

/** How much of a finding a piece takes: a piece takes every piece before it in this order from the finding too. */
const pieceRank: Readonly<Record<FindingPiece, number>> = { record: 1, text: 2, line: 3, left: 4 };

/**
 * Whether a finding waits on a person (R4, the term of the requirements):
 * its question has no answer with an option, its fix against a written
 * rule has no review, or, for any decision but a question, which settles
 * no choice by rule, a verifier named a choice that no settled choice of
 * the decision answers.
 */
export function waitsOnPerson(finding: FindingView): boolean {
  const { question, departure, decision } = finding;
  if (question !== null && (question.answer === null || question.answer.option === null)) return true;
  if (departure !== null && departure.review === null) return true;
  if (decision?.decision === 'ask') return false;
  return choicesShown(finding.choices, decision?.settled ?? []).some((shown) => shown.settled === null);
}

/** The choices that no one settled of a finding: each verifier's choice that no settled choice of its decision answers, none for a question. */
export function unsettledChoices(finding: FindingView): number {
  if (finding.decision?.decision === 'ask') return 0;
  return choicesShown(finding.choices, finding.decision?.settled ?? []).filter((shown) => shown.settled === null).length;
}

/**
 * Whether the block of a finding holds the fold of a record ("The order as
 * data" of the design): a finding with a decision, and, for one left as is,
 * with the writer's text of it. A finding left as is with no writer's text
 * shows its choices in view with no fold, and a finding with no decision
 * shows nothing, so neither has a record to take.
 */
const hasRecord = (finding: FindingView): boolean => finding.decision !== null && (acts(finding) || finding.left !== null);

/** The findings in the order a row takes them: the last-ranked first (R3, TD2). */
const lastRankedFirst = (findings: readonly FindingView[]): FindingView[] => [...findings].sort((a, b) => b.finding.number - a.finding.number);

/**
 * The order of R2 for a run, as its steps (TD1): only the steps that name
 * a piece the run has, each row's findings the last-ranked first, a
 * finding that waits on a person skipped by rows 2, 4, 6 and 7 and taken
 * by rows 8 and 9, and the floor last.
 */
export function fitOrder(view: FormView): FitStep[] {
  const left = lastRankedFirst(leftAsIs(view));
  const full = lastRankedFirst(view.findings.filter(inFull));
  const waiting = (finding: FindingView): boolean => waitsOnPerson(finding);
  const free = (finding: FindingView): boolean => !waiting(finding);
  const record = (finding: FindingView): FitStep => ({ piece: 'record', finding: finding.finding.id });
  const diagrams = (majorActing(view).length > 0 && view.areas !== null && view.areas.some((area) => area.diagram !== null)) || (view.core.kind === 'writer' && view.core.core.diagram !== null);
  const freeFull = full.filter(free);
  return [
    ...(minorActing(view).length > 0 ? [{ piece: 'minor-table' } as const] : []),
    ...left.filter((finding) => free(finding) && hasRecord(finding)).map(record),
    ...freeFull.filter(hasRecord).map(record),
    ...(view.refuted.length > 0 ? [{ piece: 'refuted' } as const] : []),
    ...left.filter(free).map((finding): FitStep => ({ piece: 'left', finding: finding.finding.id })),
    ...(diagrams ? [{ piece: 'diagrams' } as const] : []),
    ...freeFull.map((finding): FitStep => ({ piece: 'text', finding: finding.finding.id })),
    ...freeFull.filter(isMinor).map((finding): FitStep => ({ piece: 'line', finding: finding.finding.id })),
    ...lastRankedFirst([...leftAsIs(view), ...view.findings.filter(inFull)]).filter((finding) => waiting(finding) && hasRecord(finding)).map(record),
    ...left.filter(waiting).map((finding): FitStep => ({ piece: 'left', finding: finding.finding.id })),
    { piece: 'floor' },
  ];
}

/** What a prefix of the order leaves out, as the sections of the body read it. */
export interface LeftOut {
  readonly minorTable: boolean;
  readonly refuted: boolean;
  readonly diagrams: boolean;
  readonly floor: boolean;
  /** For each finding of the body a step took a piece from, the most it took. */
  readonly findings: ReadonlyMap<string, FindingPiece>;
}

/** Nothing left out, as a body that fits renders. */
export const nothingLeftOut: LeftOut = { minorTable: false, refuted: false, diagrams: false, floor: false, findings: new Map() };

/** A prefix of the order folded into what the sections read ("The body with pieces left out" of the design). */
export function leftOutOf(steps: readonly FitStep[]): LeftOut {
  const findings = new Map<string, FindingPiece>();
  let minorTable = false;
  let refuted = false;
  let diagrams = false;
  let floor = false;
  for (const step of steps) {
    switch (step.piece) {
      case 'minor-table':
        minorTable = true;
        break;
      case 'refuted':
        refuted = true;
        break;
      case 'diagrams':
        diagrams = true;
        break;
      case 'floor':
        floor = true;
        break;
      default: {
        const known = findings.get(step.finding);
        if (known === undefined || pieceRank[step.piece] > pieceRank[known]) findings.set(step.finding, step.piece);
      }
    }
  }
  return { minorTable, refuted, diagrams, floor, findings };
}

/** Whether what is left out takes `piece` from a finding: the piece itself, or one that takes more. */
export function takes(leftOut: LeftOut, finding: string, piece: FindingPiece): boolean {
  const known = leftOut.findings.get(finding);
  return known !== undefined && pieceRank[known] >= pieceRank[piece];
}
