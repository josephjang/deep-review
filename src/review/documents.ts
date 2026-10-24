/**
 * The documents of the documentation step (R2, R7, TD8 of the
 * documentation step): how the controller reads the path of each `drift`
 * line of the fixes when it plans the step, against the worktree, as it
 * reads every path a worker reports; and the documents a fix run left out
 * of date, which the brief counts.
 */
import { passKey } from '../checkpoint/answer-state.ts';
import { isClaimablePath } from '../checkpoint/events.ts';
import { allBatches, documentationReadiness, documentKey, driftLineKey, unitRevisions, type FixState, type ReopeningState } from '../checkpoint/fix-state.ts';
import type { ReviewState } from '../checkpoint/review-fold.ts';
import { StructuralCheckError } from './errors.ts';
import { resolveReportedPath } from './fix-answer.ts';
import { normalizeFileName, worktreeLookup } from './locations.ts';
import { documentationUnitKey, repairUnitKey, type EditingPhase } from './vocabulary.ts';

/**
 * The resolver of the documentation step's plan: the repository path a
 * `drift` line's file names, as `resolveReportedPath` reads a path a
 * worker reports, in the worktree's own spelling when the worktree holds
 * the file; null for a path it refuses, one outside the worktree, through
 * `..` or into the git directory, and for one no claim could record. A
 * refused path stays an item with no path, which the step can only leave
 * and the brief counts (TD8). A failure that is no refusal of the path is
 * thrown as it is.
 */
export function planPathOf(worktree: string): (file: string) => string | null {
  const lookup = worktreeLookup(worktree);
  return (file) => {
    let path: string;
    try {
      path = resolveReportedPath(worktree, lookup, file);
    } catch (error) {
      if (error instanceof StructuralCheckError) return null;
      throw error;
    }
    return isClaimablePath(path) ? path : null;
  };
}

/** Why a document is left out of date (R7 of the documentation step): the step left it, the step found it at its end, the step did not run, or a worker after the step reported it. */
export const leftReasonKinds = ['left', 'found', 'not-run', 'after'] as const;
export type LeftReasonKind = (typeof leftReasonKinds)[number];

/** One stale fact of a document, with who reported it in the plain words of the brief, which names no batch. */
export interface LeftFact {
  readonly what: string;
  readonly by: string;
}

/** One reason a document is left, by its kind, in its plain words. */
export interface LeftReason {
  readonly kind: LeftReasonKind;
  readonly text: string;
}

/** A document the run knows its edits made out of date and did not bring in line (R7 of the documentation step). */
export interface LeftDocument {
  /** The path as the first report of it gave it: the repository path of a planned document, else the path as its line wrote it. */
  readonly file: string;
  readonly facts: readonly LeftFact[];
  readonly reasons: readonly LeftReason[];
}

/** Who reports a `drift` line from each editing phase, as the brief words it. */
const reporterOf: Readonly<Record<EditingPhase, string>> = {
  fixes: 'a fixer',
  documentation: 'the documentation step',
  repair: 'the repair',
  answer: 'the fixer of an answer pass',
};

/**
 * The key of a `drift` line no item of the plan holds, by the identity the
 * plan gives a document (`documentKey`, TD8): the repository path of an
 * item of the plan when the line spells it, normalized and trimmed, else
 * the line's folded spelling, which groups it with the other lines of it.
 */
function lineKeyOf(plan: FixState['documentation'], file: string): string {
  const spelled = normalizeFileName(file.trim());
  return documentKey({ path: (plan?.items ?? []).some((item) => item.path === spelled) ? spelled : null, file });
}

/** Whether a path a worker gave names the document of `key`: its repository path exactly, or the folded spelling of a document the plan resolved to none (TD8). */
const names = (key: string, file: string): boolean => key === documentKey({ path: normalizeFileName(file.trim()), file }) || key === documentKey({ path: null, file });

/**
 * Why the documentation step of a fix run did not answer, in plain words,
 * or null when it answered or the run has no fix pass: an engine before
 * the step configured the run; the run budget stopped a unit of the fixes
 * or the step's own; its worker failed twice; the fixes changed no file,
 * so nothing of the run can have made a document stale; or it has not run
 * or answered yet, in a run still under way.
 */
export function stepNotRunCause(review: Pick<ReviewState, 'fix' | 'documentationStep'>): string | null {
  const fix = review.fix;
  if (fix === null) return null;
  if (!review.documentationStep) return 'an engine before the documentation step configured this run';
  if (fix.documentation === null) {
    switch (documentationReadiness(fix).kind) {
      case 'budget':
        return 'the run budget was reached first';
      case 'no-fixes-revision':
        return 'the fixes changed no file';
      case 'ready':
        return 'it has not run yet';
    }
  }
  if (fix.answers.documentation[documentationUnitKey] !== undefined) return null;
  const settled = fix.notAttempted.documentation[documentationUnitKey];
  if (settled === undefined) return 'it has not answered yet';
  return settled.cause === 'budget' ? 'the run budget was reached first' : 'its worker failed twice';
}

/** A sentence from a note of a worker, with one period at its end. */
const sentence = (note: string): string => `${note.trim().replace(/[.]+$/, '')}.`;

/** When the lines of each editing unit of the fix pass came, as an answer pass numbers its time (PD10). */
interface FixPassTimes {
  readonly fixes: number;
  readonly documentation: number;
  readonly repair: number;
}

/**
 * The times of the fix pass, by the ledger's order: the answer passes the
 * run held at the last reopening that a unit answered after, 0 for none.
 * The lines of the fixes and the plan's items come after the last
 * reopening that gave back a unit of the fixes, the step's answer after
 * the last that gave back one of the fixes or the step's own, and the
 * repair's after the last before it answered, since it answers once. A
 * reopening of other units does not date them again.
 */
function fixPassTimesOf(fix: Pick<FixState, 'reopenings'>): FixPassTimes {
  const after = (gaveBack: (reopening: ReopeningState) => boolean): number => fix.reopenings.findLast(gaveBack)?.answerPassesBefore ?? 0;
  const gave = (reopening: ReopeningState, phases: readonly EditingPhase[]): boolean => reopening.units.some((unit) => phases.includes(unit.phase));
  return {
    fixes: after((reopening) => gave(reopening, ['fixes'])),
    documentation: after((reopening) => gave(reopening, ['fixes', 'documentation'])),
    repair: after((reopening) => !reopening.repairAnswered),
  };
}

/** A `drift` line of an answer of the run that no item of the documentation step holds, with the unit that reported it and when, as an answer pass numbers its time. */
export interface UnheldLine {
  readonly phase: Exclude<EditingPhase, 'documentation'>;
  readonly key: string;
  readonly file: string;
  readonly what: string;
  /** For a line of the fix pass, the answer passes the run held at the last reopening its unit answered after, 0 for none; n for a line of the answer pass n. */
  readonly time: number;
}

/**
 * Each `drift` line of an answer of the fixes, the repair or an answer
 * pass that no item of the documentation step's plan holds, in the order
 * of the batches, then the repair, then each answer pass: with a plan,
 * the lines of the repair and of an answer pass, which came after it,
 * since the fold holds the plan to every line of the fixes; with none,
 * every line. The brief counts them and the report lists them.
 */
export function unheldDriftLines(review: Pick<ReviewState, 'fix' | 'answerPasses'>): UnheldLine[] {
  const fix = review.fix;
  if (fix === null) return [];
  const times = fixPassTimesOf(fix);
  // How many times the plan holds each line of the fixes.
  const held = new Map<string, number>();
  for (const item of fix.documentation?.items ?? []) for (const line of item.drift) held.set(driftLineKey(line.key, line), (held.get(driftLineKey(line.key, line)) ?? 0) + 1);
  const lines: UnheldLine[] = [];
  const unheld = (phase: UnheldLine['phase'], key: string, time: number): void => {
    for (const line of fix.answers[phase][key]?.drift ?? []) {
      const count = phase === 'fixes' ? (held.get(driftLineKey(key, line)) ?? 0) : 0;
      if (count > 0) held.set(driftLineKey(key, line), count - 1);
      else lines.push({ phase, key, file: line.file, what: line.what, time });
    }
  };
  for (const batch of allBatches(fix)) unheld('fixes', batch.key, times.fixes);
  unheld('repair', repairUnitKey, times.repair);
  review.answerPasses.forEach((_, index) => unheld('answer', passKey(index + 1), index + 1));
  return lines;
}

/** A document the documentation step's answer left, as the step gives it: its identity (`documentKey`), its file, its facts and why. */
export interface StepLeft {
  readonly key: string;
  readonly file: string;
  readonly facts: readonly LeftFact[];
  readonly reason: LeftReason;
}

/**
 * What the documentation step's answer left (R7 of the documentation
 * step): each document item it deferred or found blocked, with its lines
 * and the note of its answer, and each line of its own `drift`, which it
 * found out of date at its end, the documents its search left among them.
 * The search's `file` names the first document it brought in line, so it
 * is none of them. None before the step answered. The list of documents
 * left and the brief's sentence on the step both read it, so the two
 * cannot count the step otherwise.
 */
export function leftByStep(fix: Pick<FixState, 'documentation' | 'answers'>): StepLeft[] {
  const answer = fix.answers.documentation[documentationUnitKey];
  if (fix.documentation === null || answer === undefined) return [];
  const items = fix.documentation.items.flatMap((item): StepLeft[] => {
    const answered = answer.findings.find((finding) => finding.id === item.id);
    if (item.file === null || answered === undefined || (answered.status !== 'deferred' && answered.status !== 'blocked')) return [];
    return [{ key: documentKey({ path: item.path, file: item.file }), file: item.path ?? item.file, facts: item.drift.map((line) => ({ what: line.what, by: reporterOf.fixes })), reason: { kind: 'left', text: `The documentation step left it: ${sentence(answered.note)}` } }];
  });
  const plan = fix.documentation;
  const found = answer.drift.map((line): StepLeft => ({ key: lineKeyOf(plan, line.file), file: line.file, facts: [{ what: line.what, by: reporterOf.documentation }], reason: { kind: 'found', text: 'The documentation step found it out of date at its end.' } }));
  return [...items, ...found];
}

/**
 * The documents a fix run left out of date (R7, PD10, TD6 of the
 * documentation step), computed from the fold alone, grouped by the
 * identity the plan gives a document (`documentKey`, TD8), a line no item
 * holds by `lineKeyOf`, in the order they were first reported. They come from three
 * sources. A plan the step answered gives each document it left, deferred
 * or blocked, with its lines and the note of its answer, and each line of
 * the step's own `drift`, which it found out of date at its end, the
 * documents its search left among them. A plan the step did not answer gives each
 * of its documents, with why the step did not run. And each `drift` line
 * of an answer of the fixes, the repair or an answer pass that no item of
 * the plan holds is left: reported after the step, when a plan exists, or
 * else left because the step did not run. An entry ends when a later
 * answer pass, one that opened after each of its lines, so its task listed
 * the entry, revised its file and did not report the file in its `drift`
 * again (PD10); a revision of the repair ends none, since the repair's
 * task does not list the entries. None in a run without the fix pass.
 */
export function leftDocumentsOf(review: Pick<ReviewState, 'fix' | 'documentationStep' | 'answerPasses'>): LeftDocument[] {
  const fix = review.fix;
  if (fix === null) return [];
  const times = fixPassTimesOf(fix);
  const entries = new Map<string, { file: string; facts: LeftFact[]; reasons: LeftReason[]; time: number }>();
  const add = (key: string, file: string, facts: readonly LeftFact[], reason: LeftReason, time: number): void => {
    const entry = entries.get(key) ?? { file, facts: [], reasons: [], time: 0 };
    for (const fact of facts) if (!entry.facts.some((known) => known.what === fact.what && known.by === fact.by)) entry.facts.push(fact);
    if (!entry.reasons.some((known) => known.kind === reason.kind && known.text === reason.text)) entry.reasons.push(reason);
    entry.time = Math.max(entry.time, time);
    entries.set(key, entry);
  };
  const notRun: LeftReason = { kind: 'not-run', text: `The documentation step did not run: ${stepNotRunCause(review) ?? 'it has not answered yet'}.` };
  const plan = fix.documentation;
  if (plan !== null) {
    if (fix.answers.documentation[documentationUnitKey] === undefined) {
      for (const item of plan.items) if (item.file !== null) add(documentKey({ path: item.path, file: item.file }), item.path ?? item.file, item.drift.map((line) => ({ what: line.what, by: reporterOf.fixes })), notRun, times.fixes);
    } else {
      for (const left of leftByStep(fix)) add(left.key, left.file, left.facts, left.reason, times.documentation);
    }
  }
  // Each line no item holds: with a plan, a line of the repair or an answer pass, reported after the step; with none, any line, since the step did not run.
  for (const line of unheldDriftLines(review)) {
    const by = reporterOf[line.phase];
    add(lineKeyOf(plan, line.file), line.file, [{ what: line.what, by }], plan === null ? notRun : { kind: 'after', text: `${by.charAt(0).toUpperCase()}${by.slice(1)} reported it after the documentation step.` }, line.time);
  }
  // An answer pass that opened after an entry's last line, revised its file and reported no line of it brought it in line (PD10); a document of the repository only by its own path.
  const endedBy = (key: string, time: number): boolean => review.answerPasses.some((_, index) => {
    const n = index + 1;
    const answer = fix.answers.answer[passKey(n)];
    if (n <= time || answer === undefined) return false;
    const revised = unitRevisions(fix, 'answer', passKey(n)).some((revision) => revision.files.some((file) => names(key, file.path)));
    return revised && !answer.drift.some((line) => names(key, line.file));
  });
  return [...entries].filter(([key, entry]) => !endedBy(key, entry.time)).map(([, { file, facts, reasons }]) => ({ file, facts, reasons }));
}
