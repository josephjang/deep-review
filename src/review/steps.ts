/**
 * The planner (TD1, TD2 of the read-only review; Planner steps of the fix
 * pass): from the folded state, which holds the concurrency and the run
 * budget in force, and what the controller knows only at run time (the
 * workers in flight, the spend so far, where evidence lives), the one next
 * step. Pure, so a resumed run and a running run take the same path, and
 * every resume test is a fold test.
 */
import type { ArtifactReference } from '../evidence/store.ts';
import type { Blocker, FrozenFile } from '../checkpoint/events.ts';
import { isNotAttempted, lastRun, repairTargets } from '../checkpoint/fix-state.ts';
import { isAnswered, isUnverified, poolCandidates, type ReviewState, type UnitState, type WorktreeCheckState } from '../checkpoint/review-fold.ts';
import { planFixes, type FixPlan } from './fixes.ts';
import { planGroups, type PlannedGroup } from './grouping.ts';
import { budgetSpendNote, type BudgetSpend } from './spend.ts';
import { currentPhase, mergeRankInput, nextPendingPhase, rankedFindings, workingList } from './state.ts';
import {
  blockerActions,
  finderAngles,
  isCheckPhase,
  isEditingPhase,
  maxRecordedTextLength,
  repairUnitKey,
  roleOfAngle,
  singleUnitKey,
  unitName,
  type CheckKind,
  type CheckPhase,
  type EditingPhase,
  type Phase,
  type ReviewRole,
  type VerificationPhase,
} from './vocabulary.ts';

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
  /** The run's spend so far as the budget check counts it (`budgetSpendOf`); its `usd` is null when the runtime reports no cost. */
  readonly spend: BudgetSpend;
  /** Where a frozen blob lives, so a drift blocker names the bytes to restore (R7 of the fix pass). */
  readonly evidencePath: (reference: ArtifactReference) => string;
}

/** What a degrading role records for a unit that failed twice: its angle not run, its group unverified, or its cluster's findings not attempted. */
type DegradationTarget =
  | { readonly kind: 'angle.failed'; readonly angle: string }
  | { readonly kind: 'group.unverified'; readonly phase: VerificationPhase; readonly groupId: string }
  | { readonly kind: 'cluster.failed'; readonly phase: EditingPhase; readonly key: string };

/** A degradation the planner asks for: the event that records a unit exhausted under a degrading role, with the reason. */
export type Degradation = DegradationTarget & { readonly reason: string };

/** A check due in a checks phase: run it, or record it skipped with the reason when `build` did not pass. */
export interface DueCheck {
  readonly kind: CheckKind;
  readonly command: string;
  readonly skip: string | null;
}

export type Step =
  | { readonly kind: 'blocked'; readonly blocker: Blocker & { readonly phase: Phase } }
  | { readonly kind: 'complete' }
  | { readonly kind: 'start-phase'; readonly phase: Phase; readonly attempt: number }
  | { readonly kind: 'check-worktree'; readonly phase: Phase; readonly attempt: number; readonly moment: 'start' | 'end' }
  | { readonly kind: 'plan-verification'; readonly phase: VerificationPhase; readonly groups: readonly PlannedGroup[] }
  | { readonly kind: 'plan-fixes'; readonly plan: FixPlan }
  | { readonly kind: 'run-check'; readonly phase: CheckPhase; readonly attempt: number; readonly check: DueCheck }
  | { readonly kind: 'launch'; readonly units: readonly Unit[] }
  | { readonly kind: 'await' }
  | { readonly kind: 'degrade'; readonly phase: Phase; readonly degradations: readonly Degradation[] }
  | { readonly kind: 'finish-phase'; readonly phase: Phase; readonly attempt: number; readonly outcome: 'completed' | 'degraded' | 'blocked'; readonly blocker: Blocker | null }
  | { readonly kind: 'write-report' };

/** The groups a verification phase plans: the recorded plan, or the one the working list gives. */
export function groupsOf(review: ReviewState, phase: VerificationPhase): readonly PlannedGroup[] {
  return review.plans[phase] ?? planGroups(workingList(review, phase));
}

/** The fix plan: the recorded one, or the one the ranked findings give. */
export function fixPlanOf(review: ReviewState): FixPlan {
  return review.fix?.plan ?? planFixes(rankedFindings(review));
}

/** The units of a phase (R2; R1, R11 of the fix pass): what its workers are asked, in the order they are launched. */
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
    case 'fixes':
      return fixPlanOf(review).clusters.map((cluster) => ({ phase, key: cluster.id, role: 'fixer' }));
    case 'repair':
      return review.fix !== null && repairTargets(review.fix).length > 0 ? [{ phase, key: repairUnitKey, role: 'fixer' }] : [];
    case 'baseline-checks':
    case 'checks':
    case 'repair-checks':
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
 * What a unit's role records once the unit has failed twice (R5, PD6; R12
 * of the fix pass): a finder's angle is not run, a verifier's group is
 * unverified, a fixer's cluster is not attempted. Null for every other
 * role, whose second failure blocks the run instead. The one place the
 * role's rule lives: a unit degrades exactly when this names what it
 * records and no worker of it was lost (`exhaustedOutcome`), and a phase
 * added to the review does not compile until it is given a rule here.
 */
function degradationOf(unit: Unit): DegradationTarget | null {
  switch (unit.phase) {
    case 'finders':
      return { kind: 'angle.failed', angle: unit.key };
    case 'verification':
    case 'sweep-verification':
      return { kind: 'group.unverified', phase: unit.phase, groupId: unit.key };
    case 'fixes':
    case 'repair':
      return { kind: 'cluster.failed', phase: unit.phase, key: unit.key };
    case 'triage':
    case 'deduplication':
    case 'sweep':
    case 'sweep-deduplication':
    case 'merge-rank':
    case 'baseline-checks':
    case 'checks':
    case 'repair-checks':
    case 'report':
      return null;
  }
}

/**
 * Whether a unit's degradation is already on the ledger: an angle recorded
 * as not run, a group marked unverified, a cluster not attempted. A
 * degraded unit is settled for the rest of the run; the fold refuses any
 * later contribution from it, so it is never launched again, even when a
 * re-entered phase gives its units fresh attempts.
 */
function degraded(review: ReviewState, unit: Unit): boolean {
  const target = degradationOf(unit);
  if (target === null) return false;
  switch (target.kind) {
    case 'angle.failed':
      return Object.hasOwn(review.anglesNotRun, target.angle);
    case 'group.unverified':
      return isUnverified(review, target.phase, target.groupId);
    case 'cluster.failed':
      return review.fix !== null && isNotAttempted(review.fix, target.phase, target.key);
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

/** The blocker a phase finishes with when the spend the budget check counts reached the run budget, naming the workers it counted at their caps and the lost ones it left out. */
export function budgetBlocker(spend: BudgetSpend & { readonly usd: number }, budgetUsd: number): Blocker {
  const note = budgetSpendNote(spend);
  return {
    code: 'budget',
    detail: `spent ${usd(spend.usd)} USD of the ${usd(budgetUsd)} USD run budget${note === null ? '' : `, ${note}`}`,
    action: `run the command again with --budget-usd above ${usd(spend.usd)}, or abandon the run`,
  };
}

/** Where the bytes the run expected at a path are, as a drift blocker names them: the frozen blob's evidence path, or why there is none; nothing for a check recorded before the expected state was. */
function expectedBytes(expected: FrozenFile | null | undefined, evidencePath: Live['evidencePath']): string {
  if (expected === undefined) return '';
  if (expected === null) return '; expected absent';
  if ('blob' in expected) return `; expected at ${evidencePath(expected.blob)}`;
  return `; expected ${expected.oversized.sha256}, ${String(expected.oversized.size)} bytes, too large to have been kept`;
}

/**
 * The blocker a phase finishes with when the worktree drifted from what the
 * run expects (R7 of the fix pass): each drifted file with where the bytes
 * the run expected are, or that it expected none, and the head when it
 * moved, as many as the detail holds, and the count of the rest.
 */
export function driftBlocker(check: Pick<WorktreeCheckState, 'files' | 'head'>, evidencePath: Live['evidencePath']): Blocker {
  const prefix = 'the worktree differs from what the run expects: ';
  const items = [
    ...(check.head === null ? [] : [`HEAD is ${check.head.actual}, the run expects ${check.head.expected}`]),
    ...check.files.map((file) => `${file.path} (${file.outcome}${expectedBytes(file.expected, evidencePath)})`),
  ];
  return { code: 'drift', detail: `${prefix}${listWithin(items, maxRecordedTextLength - prefix.length)}`, action: blockerActions.drift };
}

/**
 * The check a checks phase runs next (R9, R10, PD7 of the fix pass), or
 * null when none is due: the first available kind in the order `build`,
 * `typecheck`, `lint`, `test` that has no run in this phase, one at a time;
 * once `build` ran and did not pass, each later kind is skipped with the
 * reason instead. The three after `build` never wait on one another. The
 * `checks` phase runs only when the fixes changed the tree, and
 * `repair-checks` only when the repair phase had a unit.
 */
export function dueCheck(review: ReviewState, phase: CheckPhase): DueCheck | null {
  const fix = review.fix;
  const planned = fix?.checks.planned ?? null;
  if (fix === null || planned === null) return null;
  if (phase === 'checks' && !fix.revisions.some((revision) => revision.phase === 'fixes')) return null;
  if (phase === 'repair-checks' && repairTargets(fix).length === 0) return null;
  const build = lastRun(fix, phase, 'build');
  for (const check of planned.checks) {
    if (check.command === null || lastRun(fix, phase, check.kind) !== null) continue;
    const skip = check.kind !== 'build' && build !== null && build.outcome !== 'passed' ? `build ${build.outcome === 'failed' ? 'failed' : build.outcome === 'timeout' ? 'timed out' : 'did not start'}` : null;
    return { kind: check.kind, command: check.command, skip };
  }
  return null;
}

/**
 * The next step, in order of precedence: a blocked run returns its blocker;
 * a written report is complete; a phase that is not running starts; a
 * running phase is checked against the worktree once per attempt, and an
 * attempt with a drifted check (at its start, before an answer, or at its
 * end) blocks once no worker is in flight; then a verification phase or
 * the fixes are planned, the report is written, a checks phase runs its
 * checks one at a time, and units are degraded, blocked, launched or
 * awaited; an editing phase whose units have all settled is checked once
 * more, and the phase finishes when nothing is left.
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
  const checks = review.checks.filter((check) => check.phase === phase && check.attempt === attempt);
  if (checks.length === 0) return { kind: 'check-worktree', phase, attempt, moment: 'start' };
  // A drift found at the attempt's start, before an answer was recorded, or at its end, blocks the attempt once every worker in flight has settled; nothing more is launched.
  const drift = checks.find((check) => check.drifted);
  if (drift !== undefined) return live.running.size > 0 ? { kind: 'await' } : { kind: 'finish-phase', phase, attempt, outcome: 'blocked', blocker: driftBlocker(drift, live.evidencePath) };
  if ((phase === 'verification' || phase === 'sweep-verification') && review.plans[phase] === null) return { kind: 'plan-verification', phase, groups: groupsOf(review, phase) };
  if (phase === 'fixes' && review.fix !== null && review.fix.plan === null) return { kind: 'plan-fixes', plan: fixPlanOf(review) };
  if (phase === 'report') return { kind: 'write-report' };
  if (isCheckPhase(phase)) {
    const due = dueCheck(review, phase);
    return due === null ? { kind: 'finish-phase', phase, attempt, outcome: 'completed', blocker: null } : { kind: 'run-check', phase, attempt, check: due };
  }

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
    const countedUsd = live.spend.usd;
    if (runBudgetUsd !== null && countedUsd !== null && countedUsd >= runBudgetUsd) {
      return running.length > 0 ? { kind: 'await' } : { kind: 'finish-phase', phase, attempt, outcome: 'blocked', blocker: budgetBlocker({ ...live.spend, usd: countedUsd }, runBudgetUsd) };
    }
    const capacity = concurrency - live.running.size;
    return capacity > 0 ? { kind: 'launch', units: launchable.slice(0, capacity) } : { kind: 'await' };
  }
  if (running.length > 0) return { kind: 'await' };
  // An editing phase's tree is checked whole once its last unit settled, so a change no answer accounted for blocks it (TD2 of the fix pass).
  if (isEditingPhase(phase) && units.length > 0 && !checks.some((check) => check.moment === 'end')) return { kind: 'check-worktree', phase, attempt, moment: 'end' };
  const outcome = units.some((unit) => degraded(review, unit)) ? 'degraded' : 'completed';
  return { kind: 'finish-phase', phase, attempt, outcome, blocker: null };
}
