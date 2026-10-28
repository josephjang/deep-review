// Fix runs that take their checks to the base of the change (the facts
// before a merge), built event by event from the histories of
// review-history.ts, for the brief, its JSON form and the report.
import { repairTargets } from '../../src/checkpoint/fix-state.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import type { BaseSkipReason } from '../../src/review/vocabulary.ts';
import { answer, answerableDecisions, baseSkip, checkRun, checksPhase, decidedOf, decisions, documentationAnswered, endCheck, fixAnswer, fixPlan, fixRevision, mergeRanked, noSecondRound, passAnswer, passRevision, ranOnBase, reference, statistics, withBaseChecks, withDocumentationStep, withFixPass, worker, type History } from './review-history.ts';

/** How the checks of a fix run end in each phase, and what the repair answers. */
export interface ChecksOfRun {
  /** The outcome of each kind before the fixes, passed for a kind not named. */
  readonly before?: Readonly<Record<string, string>>;
  /** The outcome of each kind after the fixes, passed for a kind not named. */
  readonly after?: Readonly<Record<string, string>>;
  /** Each run on the base in order: its kind, its outcome and, for a skipped one, why, with the error after the reason's words, if any. */
  readonly base?: readonly (readonly [kind: string, outcome: string, skip?: BaseSkipReason, detail?: string])[];
  /** The repair's comparisons with the base; null for a repair the run budget stopped, which gives none. */
  readonly comparisons?: readonly { readonly kind: string; readonly reading: string; readonly words: string }[] | null;
  /** The outcome of each kind after a repair that applied one fix, which only then runs the checks again; none by default. */
  readonly repaired?: Readonly<Record<string, string>>;
  /** Whether the run is configured with the checks on the base, at version 8, or before them, at version 7; true by default. */
  readonly compared?: boolean;
}

/** The base of the scope of these runs, as a branch scope names it: the merge base with origin/main. */
export const mergeBase = `2247b35e${'0'.repeat(32)}`;

/**
 * A decided fix run with the documentation step to its report, whose
 * checks end as `checks` says: c1-1 applies RIPPLE-1; the checks run
 * before and after the fixes; in a run configured with the checks on the
 * base, its runs there; the repair defers each kind it takes, or applies
 * one fix when `repaired` names the checks after it, and gives its
 * comparisons; SWEEP-1 is a question whose default keeps the code, and
 * no fix goes against a written rule.
 */
export function checkedRun(checks: ChecksOfRun = {}): History {
  const { before = {}, after = {}, base = [], comparisons = [], repaired, compared = true } = checks;
  const atBaseline = withDocumentationStep(checksPhase(decidedOf(withFixPass(mergeRanked()), answerableDecisions(decisions[0])), 'baseline-checks', before), null);
  const fixed = (compared ? withBaseChecks(atBaseline) : atBaseline)
    .start('fixes').add('fixes.planned', fixPlan).worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50))).add('tree.revised', fixRevision(worker(50)))
    .add('fixes.replanned', noSecondRound).add('worktree.checked', endCheck('fixes'), 2).finish('fixes');
  const history = checksPhase(documentationAnswered(fixed), 'checks', after);
  if (compared) {
    history.start('base-checks');
    for (const [kind, outcome, skip, detail] of base) ranOnBase(history, kind, outcome, 1, null, skip === undefined ? {} : baseSkip(skip, detail));
    history.finish('base-checks');
  }
  history.start('repair');
  const targets = repairTargets(history.review().fix!);
  if (targets.length > 0 && comparisons === null) {
    history.add('unit.unattempted', { phase: 'repair', key: 'repair', cause: 'budget', reason: 'spent 31 USD of 30 USD' }, 2);
  } else if (targets.length > 0) {
    const fixedKind = repaired === undefined ? null : targets[0]!;
    const findings = targets.map((id) => ({
      id, status: id === fixedKind ? 'applied' : 'deferred', file: 'src/a.ts', line: null, note: id === fixedKind ? 'fixed the failure the fixes added' : 'every failure was there before the fixes',
      message: id === fixedKind ? { subject: `fix: Repair the ${id} check`, body: 'Why.' } : null, files: id === fixedKind ? ['src/a.ts'] : [], corrections: [], validation: [], requiredFiles: [],
    }));
    history.worker(60, 'fixer repair:repair').add('fix.recorded', { ...fixAnswer(worker(60)), phase: 'repair', key: 'repair', findings, ...(compared ? { comparisons } : {}) }, compared ? 4 : 2);
    if (fixedKind !== null) history.add('tree.revised', { phase: 'repair', source: { kind: 'fix', key: 'repair', workerId: worker(60) }, change: { findings: [fixedKind], message: { subject: `fix: Repair the ${fixedKind} check`, body: 'Why.' } }, files: [{ path: 'src/a.ts', status: 'modified', before: { blob: reference('f') }, beforeSymlink: false, symlink: false, after: { blob: reference('8') } }] }, 2);
    history.add('worktree.checked', endCheck('repair'), 2);
  }
  history.finish('repair', targets.length > 0 && comparisons === null ? 'degraded' : 'completed').start('repair-checks');
  if (repaired !== undefined) for (const kind of ['build', 'lint', 'test']) history.add('check.ran', checkRun('repair-checks', kind, repaired[kind] ?? 'passed'));
  return history.finish('repair-checks').start('report').add('report.written', { report: reference('e', 2048), statistics, patches: patchesOf(history) }, 2).finish('report');
}

/** A patch for each revision the history holds, as a report records them. */
const patchesOf = (history: History): ReturnType<typeof reference>[] => history.review().fix!.revisions.map((_revision, index) => reference(String(index + 1)));

/**
 * The same run after an answer pass, numbered `n`: a person answers
 * SWEEP-1, with its other option at each pass, the pass's fixer applies
 * it and revises src/a.ts, its checks end as `outcomes` says, passed for
 * a kind not named, and the next report is written.
 */
export function answeredRun(history: History, outcomes: Readonly<Record<string, string>> = {}, n = 1): History {
  const workerId = worker(70 + n);
  history.add('answer.recorded', answer('SWEEP-1', n % 2));
  history.add('answer.pass', { ids: ['SWEEP-1'] });
  history.start('answer', n).worker(70 + n, `fixer answer:pass-${String(n)}`).add('fix.recorded', passAnswer(workerId, n, [['SWEEP-1', 'applied']]), 2)
    .add('tree.revised', passRevision(workerId, n, 'SWEEP-1', reference(String(5 + n))), 2)
    .add('worktree.checked', endCheck('answer', n), 5).finish('answer', 'completed', n)
    .start('answer-checks', n);
  for (const kind of ['build', 'lint', 'test']) history.add('check.ran', checkRun('answer-checks', kind, outcomes[kind] ?? 'passed', n), 2);
  return history.finish('answer-checks', 'completed', n)
    .start('report', n + 1)
    .add('report.written', { report: reference(String(n), 4096 + n), statistics, patches: patchesOf(history) }, 5)
    .finish('report', 'completed', n + 1);
}

/** The run as the fold holds it, its scope a branch's: from the merge base with origin/main (`mergeBase`) to its head. */
export function onBranch(history: History): RunState {
  const state = history.fold();
  const scope = state.scope!;
  return { ...state, scope: { ...scope, mode: 'range', base: mergeBase, request: { ...scope.request, range: { from: 'origin/main', to: 'HEAD', mergeBase: true } } } };
}

/** The run with the error of each skipped run on the base in other words, as a ledger recorded before a phrase of `baseSkipReasons` was reworded holds it; its `skipReason` stays. */
export function rewordedOnBase(state: RunState, error: string): RunState {
  const fix = state.review!.fix!;
  const runs = fix.checks.runs['base-checks'].map((run) => (run.outcome === 'skipped' ? { ...run, error } : run));
  return { ...state, review: { ...state.review!, fix: { ...fix, checks: { ...fix.checks, runs: { ...fix.checks.runs, 'base-checks': runs } } } } };
}
