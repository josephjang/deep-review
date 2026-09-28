/**
 * The planner (TD1, TD2 of the read-only review): from the folded state,
 * which holds the concurrency and the run budget in force, and what the
 * controller knows only at run time (the workers in flight and the spend so
 * far), the one next step. Pure, so a resumed run and a running run take
 * the same path, and every resume test is a fold test.
 */
import type { Blocker } from '../checkpoint/events.ts';
import { isAnswered, isUnverified, poolCandidates, type ReviewState, type UnitState } from '../checkpoint/review-fold.ts';
import { planGroups, type PlannedGroup } from './grouping.ts';
import { currentPhase, mergeRankInput, nextPendingPhase, workingList } from './state.ts';
import { blockerActions, finderAngles, maxRecordedTextLength, roleOfAngle, singleUnitKey, unitName, type Phase, type ReviewRole, type VerificationPhase } from './vocabulary.ts';

/** How many times a unit is tried before its role's rule decides (R5, PD6). */
export const maxAttempts = 2;

/** One worker's task within a phase. */
export interface Unit {
  readonly phase: Phase;
  readonly key: string;
  readonly role: ReviewRole;
}

/** What the controller knows that the ledger does not. */
export interface Live {
  /** The unit names (`phase:key`) whose worker this engine has in flight, launched or about to be. */
  readonly running: ReadonlySet<string>;
  /** The run's spend in USD so far, or null when the runtime reports no cost. */
  readonly spendUsd: number | null;
}

/** What a degrading role records for a unit that failed twice: its angle not run, or its group unverified. */
type DegradationTarget =
  | { readonly kind: 'angle.failed'; readonly angle: string }
  | { readonly kind: 'group.unverified'; readonly phase: VerificationPhase; readonly groupId: string };

/** A degradation the planner asks for: the event that records a unit exhausted under a degrading role, with the reason. */
export type Degradation = DegradationTarget & { readonly reason: string };

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
  const single = (role: ReviewRole): Unit[] => [{ phase, key: singleUnitKey(phase), role }];
  switch (phase) {
    case 'triage':
      return single('triage');
    case 'finders':
      return finderAngles.map((angle) => ({ phase, key: angle, role: roleOfAngle(angle) }));
    case 'deduplication':
    case 'sweep-deduplication':
      return poolCandidates(review, phase).length >= 2 ? single('deduplication') : [];
    case 'verification':
    case 'sweep-verification':
      return groupsOf(review, phase).map((group) => ({ phase, key: group.id, role: 'verifier' }));
    case 'sweep':
      return single('sweep');
    case 'merge-rank':
      return mergeRankInput(review).length > 0 ? single('merge-rank') : [];
    case 'report':
      return [];
  }
}

/** Whether a unit has failed as many times as it may without contributing. */
const exhausted = (review: ReviewState, unit: Unit, state: UnitState | undefined): boolean => !isAnswered(review, unit.phase, unit.key) && (state?.failures.length ?? 0) >= maxAttempts;

const truncationMark = ' [truncated]';

/**
 * Text cut to at most `limit` characters, marked `[truncated]` when it was
 * cut and there is room for the mark, and never cut between the two halves
 * of a surrogate pair.
 */
export function truncated(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const room = Math.max(0, limit);
  const kept = room > truncationMark.length ? room - truncationMark.length : room;
  const last = text.charCodeAt(kept - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? kept - 1 : kept;
  return `${text.slice(0, end)}${room > truncationMark.length ? truncationMark : ''}`;
}

/**
 * The reason a degraded or blocked unit records: how many attempts failed
 * and every failure's reason, in order. Each reason gets an equal share of
 * `limit` and is truncated to it, so the whole fits the ledger's cap and
 * still quotes every failure.
 */
function failureReason(state: UnitState | undefined, limit: number = maxRecordedTextLength): string {
  const reasons = (state?.failures ?? []).map((failure) => failure.reason);
  const header = `${String(reasons.length)} attempts did not complete: `;
  const separator = '; ';
  const share = Math.floor((limit - header.length - separator.length * Math.max(0, reasons.length - 1)) / Math.max(1, reasons.length));
  return truncated(`${header}${reasons.map((reason) => truncated(reason, share)).join(separator)}`, limit);
}

/**
 * Items joined with commas within `limit` characters: all of them when
 * they fit, else as many as fit in order and the count of the rest. A first
 * item too long to fit on its own is truncated.
 */
function listWithin(items: readonly string[], limit: number): string {
  const all = items.join(', ');
  if (all.length <= limit) return all;
  const more = (count: number): string => (count > 0 ? `, and ${String(count)} more` : '');
  const reserve = more(items.length).length;
  let text = '';
  let shown = 0;
  for (const item of items) {
    const next = shown === 0 ? item : `${text}, ${item}`;
    if (next.length + reserve > limit) break;
    text = next;
    shown += 1;
  }
  if (shown > 0) return `${text}${more(items.length - shown)}`;
  const rest = more(items.length - 1);
  return `${truncated(items[0] ?? '', limit - rest.length)}${rest}`;
}

/**
 * What a unit's role records once the unit has failed twice (R5, PD6): a
 * finder's angle is not run, a verifier's group is unverified. Null for
 * every other role, whose second failure blocks the run instead. The one
 * place the role's rule lives: a unit degrades exactly when this names
 * what it records and no worker of it was lost (`exhaustedOutcome`), and a
 * phase added to the review does not compile until it is given a rule here.
 */
function degradationOf(unit: Unit): DegradationTarget | null {
  switch (unit.phase) {
    case 'finders':
      return { kind: 'angle.failed', angle: unit.key };
    case 'verification':
    case 'sweep-verification':
      return { kind: 'group.unverified', phase: unit.phase, groupId: unit.key };
    case 'triage':
    case 'deduplication':
    case 'sweep':
    case 'sweep-deduplication':
    case 'merge-rank':
    case 'report':
      return null;
  }
}

/**
 * Whether a unit's degradation is already on the ledger: an angle recorded
 * as not run, or a group marked unverified. A degraded unit is settled for
 * the rest of the run; the fold refuses any later contribution from it, so
 * it is never launched again, even when a re-entered phase gives its units
 * fresh attempts.
 */
function degraded(review: ReviewState, unit: Unit): boolean {
  const target = degradationOf(unit);
  if (target === null) return false;
  switch (target.kind) {
    case 'angle.failed':
      return Object.hasOwn(review.anglesNotRun, target.angle);
    case 'group.unverified':
      return isUnverified(review, target.phase, target.groupId);
  }
}

/** Whether a worker lost with its engine is among a unit's failures: an interruption, which nothing observed failing. */
const interrupted = (state: UnitState | undefined): boolean => state?.failures.some((failure) => failure.lost) ?? false;

/**
 * What a unit out of attempts records, or null when it blocks its phase
 * instead: its role's degradation (`degradationOf`), unless a worker lost
 * with its engine is among its failures. An interruption is not the unit
 * failing, so it never costs coverage: such a unit blocks with
 * `worker-failed` whatever its role, and the operator's next run gives it
 * fresh attempts.
 */
function exhaustedOutcome(unit: Unit, state: UnitState | undefined): DegradationTarget | null {
  return interrupted(state) ? null : degradationOf(unit);
}

/** Whether a unit may be given a worker: not answered, not degraded, and with an attempt left. */
const launchableUnit = (review: ReviewState, unit: Unit, state: UnitState | undefined): boolean => !isAnswered(review, unit.phase, unit.key) && !degraded(review, unit) && !exhausted(review, unit, state);

const usd = (value: number): string => value.toFixed(2);

/** The blocker a phase finishes with when a unit failed twice under a blocking role, or with a worker lost with its engine among its failures. */
export function workerFailedBlocker(unit: Unit, state: UnitState | undefined): Blocker {
  const prefix = `the ${unit.role} worker for ${unitName(unit.phase, unit.key)} failed twice${interrupted(state) ? ', a worker lost with its engine among the failures' : ''}: `;
  return { code: 'worker-failed', detail: truncated(`${prefix}${failureReason(state, maxRecordedTextLength - prefix.length)}`, maxRecordedTextLength), action: blockerActions['worker-failed'] };
}

/** The blocker a phase finishes with when the spend reached the run budget. */
export function budgetBlocker(spendUsd: number, budgetUsd: number): Blocker {
  return { code: 'budget', detail: `spent ${usd(spendUsd)} USD of the ${usd(budgetUsd)} USD run budget`, action: `run the command again with --budget-usd above ${usd(spendUsd)}, or abandon the run` };
}

/** The blocker a phase finishes with when the worktree drifted from the scope: the drifted files, as many as the detail holds, and the count of the rest. */
export function driftBlocker(files: readonly { path: string; outcome: string }[]): Blocker {
  const prefix = 'the worktree differs from the reviewed change: ';
  const listed = listWithin(files.map((file) => `${file.path} (${file.outcome})`), maxRecordedTextLength - prefix.length);
  return { code: 'drift', detail: `${prefix}${listed}`, action: blockerActions.drift };
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
  const states = review.units[phase];
  // The units out of attempts whose outcome is not yet on the ledger: a degrading role's are degraded, unless interrupted; the rest block the phase.
  const spent = units.filter((unit) => exhausted(review, unit, states[unit.key]) && !degraded(review, unit));
  const degradations = spent.flatMap((unit): Degradation[] => {
    const target = exhaustedOutcome(unit, states[unit.key]);
    return target === null ? [] : [{ ...target, reason: failureReason(states[unit.key]) }];
  });
  if (degradations.length > 0) return { kind: 'degrade', phase, degradations };
  const running = units.filter((unit) => live.running.has(unitName(phase, unit.key)));
  const blocking = spent.find((unit) => exhaustedOutcome(unit, states[unit.key]) === null);
  if (blocking !== undefined) return running.length > 0 ? { kind: 'await' } : { kind: 'finish-phase', phase, attempt, outcome: 'blocked', blocker: workerFailedBlocker(blocking, states[blocking.key]) };
  const launchable = units.filter((unit) => launchableUnit(review, unit, states[unit.key]) && !live.running.has(unitName(phase, unit.key)));
  if (launchable.length > 0) {
    const { concurrency, runBudgetUsd } = review.limits;
    if (runBudgetUsd !== null && live.spendUsd !== null && live.spendUsd >= runBudgetUsd) {
      return running.length > 0 ? { kind: 'await' } : { kind: 'finish-phase', phase, attempt, outcome: 'blocked', blocker: budgetBlocker(live.spendUsd, runBudgetUsd) };
    }
    const capacity = concurrency - live.running.size;
    return capacity > 0 ? { kind: 'launch', units: launchable.slice(0, capacity) } : { kind: 'await' };
  }
  if (running.length > 0) return { kind: 'await' };
  const outcome = units.some((unit) => degraded(review, unit)) ? 'degraded' : 'completed';
  return { kind: 'finish-phase', phase, attempt, outcome, blocker: null };
}
