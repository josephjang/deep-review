/**
 * The planner (TD1, TD2 of the read-only review): from the folded state and
 * what the controller knows only at run time (the workers in flight, the
 * concurrency and the spend against the budget), the one next step. Pure,
 * so a resumed run and a running run take the same path, and every resume
 * test is a fold test.
 */
import type { Blocker } from '../checkpoint/events.ts';
import { poolCandidates, unitsOfPhase, type ReviewState, type UnitState } from '../checkpoint/review-fold.ts';
import { planGroups, type PlannedGroup } from './grouping.ts';
import { currentPhase, mergeRankInput, nextPendingPhase, workingList } from './state.ts';
import { blockerActions, finderAngles, phases, unitName, type Phase, type VerificationPhase } from './vocabulary.ts';

/** How many times a unit is tried before its role's rule decides (R5, PD6). */
export const maxAttempts = 2;

/** One worker's task within a phase. */
export interface Unit {
  readonly phase: Phase;
  readonly key: string;
  readonly role: string;
  /** Whether two failures degrade the unit (an angle not run, a group unverified) rather than block the run. */
  readonly degrades: boolean;
}

/** What the controller knows that the ledger does not. */
export interface Live {
  /** The unit names (`phase:key`) whose worker this engine has in flight, launched or about to be. */
  readonly running: ReadonlySet<string>;
  readonly concurrency: number;
  /** The run's spend in USD so far, or null when the runtime reports no cost. */
  readonly spendUsd: number | null;
  /** The run budget in force, or null when there is none. */
  readonly budgetUsd: number | null;
}

/** A degradation the planner asks for: the event that records a unit exhausted under a degrading role. */
export type Degradation =
  | { readonly kind: 'angle.failed'; readonly angle: string; readonly reason: string }
  | { readonly kind: 'group.unverified'; readonly phase: VerificationPhase; readonly groupId: string; readonly reason: string };

export type Step =
  | { readonly kind: 'blocked'; readonly blocker: Blocker & { readonly phase: Phase } }
  | { readonly kind: 'complete' }
  | { readonly kind: 'start-phase'; readonly phase: Phase; readonly attempt: number }
  | { readonly kind: 'check-worktree'; readonly phase: Phase; readonly attempt: number }
  | { readonly kind: 'plan-verification'; readonly phase: VerificationPhase; readonly groups: readonly PlannedGroup[] }
  | { readonly kind: 'launch'; readonly units: readonly Unit[] }
  | { readonly kind: 'await' }
  | { readonly kind: 'degrade'; readonly phase: Phase; readonly degradations: readonly Degradation[] }
  | { readonly kind: 'finish-phase'; readonly phase: Phase; readonly attempt: number; readonly outcome: 'completed' | 'degraded' | 'blocked'; readonly blocker: Blocker | null }
  | { readonly kind: 'write-report' };

/** The groups a verification phase plans: the recorded plan, or the one the working list gives. */
export function groupsOf(review: ReviewState, phase: VerificationPhase): readonly PlannedGroup[] {
  return review.plans[phase] ?? planGroups(workingList(review, phase));
}

/** The units of a phase (R2): what its workers are asked, in the order they are launched. */
export function unitsOf(review: ReviewState, phase: Phase): Unit[] {
  const single = (role: string): Unit[] => [{ phase, key: phase === 'triage' ? 'SCAN' : phase, role, degrades: false }];
  switch (phase) {
    case 'triage':
      return single('triage');
    case 'finders':
      return finderAngles.map((angle) => ({ phase, key: angle, role: `finder-${angle}`, degrades: true }));
    case 'deduplication':
    case 'sweep-deduplication':
      return poolCandidates(review, phase).length >= 2 ? single('deduplication') : [];
    case 'verification':
    case 'sweep-verification':
      return groupsOf(review, phase).map((group) => ({ phase, key: group.id, role: 'verifier', degrades: true }));
    case 'sweep':
      return single('sweep');
    case 'merge-rank':
      return mergeRankInput(review).length > 0 ? single('merge-rank') : [];
    case 'report':
      return [];
  }
}

/** Whether a unit has contributed. */
const answered = (state: UnitState | undefined): boolean => state?.answeredBy !== null && state?.answeredBy !== undefined;
/** Whether a unit has failed as many times as it may. */
const exhausted = (state: UnitState | undefined): boolean => !answered(state) && (state?.failures.length ?? 0) >= maxAttempts;

/** The reason a degraded or blocked unit records: every failure's reason, in order. */
function failureReason(state: UnitState | undefined): string {
  const reasons = (state?.failures ?? []).map((failure) => failure.reason);
  return `${String(reasons.length)} attempts did not complete: ${reasons.join('; ')}`;
}

/**
 * Whether a unit's degradation is already on the ledger: an angle recorded
 * as not run, or a group marked unverified. A degraded unit is settled for
 * the rest of the run; the fold refuses any later contribution from it, so
 * it is never launched again, even when a re-entered phase gives its units
 * fresh attempts.
 */
function degraded(review: ReviewState, unit: Unit): boolean {
  switch (unit.phase) {
    case 'finders':
      return Object.hasOwn(review.anglesNotRun, unit.key);
    case 'verification':
    case 'sweep-verification':
      return Object.hasOwn(review.unverifiedGroups, unitName(unit.phase, unit.key));
    default:
      return false;
  }
}

/** The degradation a phase records for an exhausted unit of a degrading role, or null when it is already recorded or the phase has no such rule. */
function degradationOf(review: ReviewState, unit: Unit, state: UnitState | undefined): Degradation | null {
  if (degraded(review, unit)) return null;
  if (unit.phase === 'finders') return { kind: 'angle.failed', angle: unit.key, reason: failureReason(state) };
  if (unit.phase === 'verification' || unit.phase === 'sweep-verification') return { kind: 'group.unverified', phase: unit.phase, groupId: unit.key, reason: failureReason(state) };
  return null;
}

/** Whether a unit may be given a worker: not answered, not degraded, and with an attempt left. */
const launchableUnit = (review: ReviewState, unit: Unit, state: UnitState | undefined): boolean => !answered(state) && !degraded(review, unit) && !exhausted(state);

const usd = (value: number): string => value.toFixed(2);

/** The blocker a phase finishes with when a blocking role's unit failed twice. */
export function workerFailedBlocker(unit: Unit, state: UnitState | undefined): Blocker {
  return { code: 'worker-failed', detail: `the ${unit.role} worker for ${unit.phase}:${unit.key} failed twice: ${failureReason(state)}`, action: blockerActions['worker-failed'] };
}

/** The blocker a phase finishes with when the spend reached the run budget. */
export function budgetBlocker(spendUsd: number, budgetUsd: number): Blocker {
  return { code: 'budget', detail: `spent ${usd(spendUsd)} USD of the ${usd(budgetUsd)} USD run budget`, action: `run the command again with --budget-usd above ${usd(spendUsd)}, or abandon the run` };
}

/** The blocker a phase finishes with when the worktree drifted from the scope. */
export function driftBlocker(files: readonly { path: string; outcome: string }[]): Blocker {
  return { code: 'drift', detail: `the worktree differs from the reviewed change: ${files.map((file) => `${file.path} (${file.outcome})`).join(', ')}`, action: blockerActions.drift };
}

/**
 * The next step, in order of precedence: a blocked run returns its blocker;
 * a written report is complete; a phase that is not running starts; a
 * running phase is checked against the worktree once per attempt, then a
 * verification phase is planned, then units are degraded, blocked,
 * launched or awaited, and the phase finishes when nothing is left.
 */
export function nextStep(review: ReviewState, live: Live): Step {
  if (review.blocker !== null) return { kind: 'blocked', blocker: review.blocker };
  if (review.report !== null) return { kind: 'complete' };
  const phase = currentPhase(review);
  if (phase === null) {
    const pending = nextPendingPhase(review);
    if (pending === null) throw new Error('Every phase has finished but no report was written');
    return { kind: 'start-phase', phase: pending, attempt: review.phases[pending].attempt + 1 };
  }
  const attempt = review.phases[phase].attempt;
  if (!review.checks.some((check) => check.phase === phase && check.attempt === attempt)) return { kind: 'check-worktree', phase, attempt };
  if ((phase === 'verification' || phase === 'sweep-verification') && review.plans[phase] === null) return { kind: 'plan-verification', phase, groups: groupsOf(review, phase) };
  if (phase === 'report') return { kind: 'write-report' };

  const units = unitsOf(review, phase);
  const states = unitsOfPhase(review, phase);
  const degradations = units.filter((unit) => unit.degrades && exhausted(states[unit.key])).map((unit) => degradationOf(review, unit, states[unit.key])).filter((degradation): degradation is Degradation => degradation !== null);
  if (degradations.length > 0) return { kind: 'degrade', phase, degradations };
  const running = units.filter((unit) => live.running.has(unitName(phase, unit.key)));
  const blocking = units.find((unit) => !unit.degrades && exhausted(states[unit.key]));
  if (blocking !== undefined) return running.length > 0 ? { kind: 'await' } : { kind: 'finish-phase', phase, attempt, outcome: 'blocked', blocker: workerFailedBlocker(blocking, states[blocking.key]) };
  const launchable = units.filter((unit) => launchableUnit(review, unit, states[unit.key]) && !live.running.has(unitName(phase, unit.key)));
  if (launchable.length > 0) {
    if (live.budgetUsd !== null && live.spendUsd !== null && live.spendUsd >= live.budgetUsd) {
      return running.length > 0 ? { kind: 'await' } : { kind: 'finish-phase', phase, attempt, outcome: 'blocked', blocker: budgetBlocker(live.spendUsd, live.budgetUsd) };
    }
    const capacity = live.concurrency - live.running.size;
    return capacity > 0 ? { kind: 'launch', units: launchable.slice(0, capacity) } : { kind: 'await' };
  }
  if (running.length > 0) return { kind: 'await' };
  const outcome = units.some((unit) => degraded(review, unit)) ? 'degraded' : 'completed';
  return { kind: 'finish-phase', phase, attempt, outcome, blocker: null };
}

/** The phases in review order, for callers that iterate them. */
export const orderedPhases: readonly Phase[] = phases;
