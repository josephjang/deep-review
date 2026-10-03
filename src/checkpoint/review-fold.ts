/**
 * What the read-only review's events say about a run, and the reducers that
 * fold them (R10 of the read-only review). The state holds facts as the
 * events recorded them: the pinned configuration, each phase's status and
 * attempt, every candidate with its resolution, each unit's contribution
 * and failures, the plans, the ranking and the report. What the run does
 * next is read from these by the planner, never stored.
 */
import {
  candidateIdPrefix,
  deduplicationPhases,
  finderAngles,
  fixPhases,
  phases,
  singleUnitKey,
  unitName,
  verificationPhases,
  type CandidatePhase,
  type DeduplicationPhase,
  type Phase,
  type Verdict,
  type VerificationPhase,
} from '../review/vocabulary.ts';
import { InvalidHistoryError } from './errors.ts';
import type {
  AngleFailed,
  AttemptFailed,
  Blocker,
  CandidatesRecorded,
  DeduplicationRecorded,
  FrozenFile,
  GroupUnverified,
  Lead,
  PhaseFinished,
  PhaseStarted,
  RankedFinding,
  RankingRecorded,
  RecordedCandidate,
  ReportWritten,
  ReportWrittenV1,
  ReviewConfiguration,
  ReviewConfigurationV1,
  ReviewConfigurationV2,
  ReviewLimits,
  VerdictsRecorded,
  VerificationPlanned,
  WorktreeCheckV1,
  WorktreeCheckV3,
} from './events.ts';
import { emptyFixState, type FixState } from './fix-state.ts';
import type { DecodedEvent, FoldDrafts, Reducer, RunState } from './fold.ts';
import { emptySurveyState, type SurveyState } from './survey-state.ts';

/**
 * A phase's status; `skipped` is set at configuration and never started:
 * a fix phase of a run configured without the fix pass (TD9 of the fix
 * pass), and the survey of a run configured before the survey existed.
 */
export type PhaseStatus = 'pending' | 'running' | 'completed' | 'degraded' | 'blocked' | 'skipped';

export interface PhaseState {
  readonly status: PhaseStatus;
  /** How many times the phase was started or re-entered; 0 while pending. */
  readonly attempt: number;
}

/** One unit of a phase: the task one worker does, such as an angle or a verification group. */
export interface UnitState {
  /** The worker whose contribution is recorded, or null while none is. */
  readonly answeredBy: string | null;
  /** Every attempt that did not contribute, in order. Cleared when a blocked phase is re-entered, which gives the unit fresh attempts. */
  readonly failures: readonly UnitFailure[];
}

/** One attempt of a unit that did not contribute: its worker, why, and whether the worker was lost rather than seen to fail. */
export interface UnitFailure {
  readonly workerId: string;
  readonly reason: string;
  /** True for a worker lost with the engine that ran it (`worker.lost`), false for one recorded failing (`attempt.failed`). */
  readonly lost: boolean;
}

/** A candidate as recorded, with the phase and worker it came from and what later phases decided about it. */
export interface CandidateState extends RecordedCandidate {
  readonly phase: CandidatePhase;
  readonly workerId: string;
  /** The candidate deduplication kept in this one's place, or null while this one stands. */
  readonly duplicateOf: string | null;
  readonly verdict: { readonly verdict: Verdict; readonly evidence: string } | null;
  /** Its group's verifier failed twice: the candidate carries PLAUSIBLE with this mark. */
  readonly unverified: boolean;
}

/**
 * Where a located candidate points in the repository, as `file:line`, in
 * the change or outside it, or null for an unlocated one: the one rule
 * every reader of a candidate's location goes by, so a task and the report
 * never disagree on which is located.
 */
export function repositoryLocation(candidate: Pick<RecordedCandidate, 'located' | 'file' | 'line'>): string | null {
  return candidate.located && candidate.file !== null && candidate.line !== null ? `${candidate.file}:${String(candidate.line)}` : null;
}

/** Where the finder said a candidate points, as `file:line`, whether or not it was located. */
export function rawLocation(candidate: Pick<RecordedCandidate, 'rawFile' | 'rawLine'>): string {
  return `${candidate.rawFile}:${String(candidate.rawLine)}`;
}

/**
 * One worktree check as the fold holds it, whichever version recorded it.
 * A version 1 check reads as one at the attempt's start when it was the
 * attempt's first, else before an answer; it recorded no head, no strays
 * and not the expected state of a file, which its files then lack.
 */
export interface WorktreeCheckState extends Omit<WorktreeCheckV3, 'files'> {
  readonly files: readonly { readonly path: string; readonly outcome: WorktreeCheckV3['files'][number]['outcome']; readonly expected?: FrozenFile | null }[];
}

export interface ReviewState {
  readonly configuration: ReviewConfiguration;
  /** The concurrency and the run budget in force: the configuration's, until a `limits.changed` replaces them. */
  readonly limits: ReviewLimits;
  readonly phases: Readonly<Record<Phase, PhaseState>>;
  /** Why the run is blocked and in which phase, or null; cleared by the next `phase.started`. */
  readonly blocker: (Blocker & { readonly phase: Phase }) | null;
  readonly checks: readonly WorktreeCheckState[];
  /** The triage's one lead per finder angle, or null until the triage answers. */
  readonly leads: readonly Lead[] | null;
  /** Every candidate by id, in the order recorded. */
  readonly candidates: Readonly<Record<string, CandidateState>>;
  /** Every unit that contributed or failed, by phase and then by unit key. */
  readonly units: Readonly<Record<Phase, Readonly<Record<string, UnitState>>>>;
  /** The finder angles that failed twice, with the reason. */
  readonly anglesNotRun: Readonly<Record<string, string>>;
  readonly deduplications: Readonly<Record<DeduplicationPhase, DeduplicationRecorded['groups'] | null>>;
  readonly plans: Readonly<Record<VerificationPhase, VerificationPlanned['groups'] | null>>;
  /** The groups whose verifier failed twice, by verification phase and then by group id, with the reason. */
  readonly unverifiedGroups: Readonly<Record<VerificationPhase, Readonly<Record<string, string>>>>;
  readonly ranking: readonly RankedFinding[] | null;
  readonly report: ReportWritten | null;
  /** The fix pass's state, or null for a run configured without it, including every run recorded before it existed. */
  readonly fix: FixState | null;
  /** The survey's state, or null for a run configured before the survey existed, whose survey phase is skipped. */
  readonly survey: SurveyState | null;
}

/** The candidate phases whose candidates a deduplication or verification phase works on. */
export function poolPhases(phase: DeduplicationPhase | VerificationPhase): readonly CandidatePhase[] {
  return phase === 'deduplication' || phase === 'verification' ? ['triage', 'finders'] : ['sweep'];
}

/** The candidates of a pool, in recorded order. */
export function poolCandidates(review: ReviewState, phase: DeduplicationPhase | VerificationPhase): CandidateState[] {
  const included = new Set<string>(poolPhases(phase));
  return Object.values(review.candidates).filter((candidate) => included.has(candidate.phase));
}

/** A unit of a phase: the phase and the unit's key within it. */
export interface UnitRef {
  readonly phase: Phase;
  readonly key: string;
}

/** The unit a lost worker's attempt is counted against, or null when the launch label named no unit. */
export function unitOfLostWorker(phase: Phase | null, key: string | null): UnitRef | null {
  return phase === null || key === null ? null : { phase, key };
}

export const invalid = (event: DecodedEvent, what: string): InvalidHistoryError =>
  new InvalidHistoryError(`Run ${event.runId} ${what}, at sequence ${String(event.sequence)} (${event.kind}@${String(event.version)})`);

/** The run, which must exist and be configured for review. */
export function requireReview(state: RunState | undefined, event: DecodedEvent): { current: RunState; review: ReviewState } {
  if (state === undefined) throw new InvalidHistoryError(`Run ${event.runId} has ${event.kind} at sequence ${String(event.sequence)} before its creation`);
  if (state.review === null) throw invalid(event, `has ${event.kind} before review.configured`);
  return { current: state, review: state.review };
}

/** The phase, which must be running under the given attempt. */
export function requireRunning(review: ReviewState, event: DecodedEvent, phase: Phase, attempt?: number): void {
  const state = review.phases[phase];
  if (state.status !== 'running') throw invalid(event, `has ${event.kind} for phase ${phase} while it is ${state.status}`);
  if (attempt !== undefined && attempt !== state.attempt) throw invalid(event, `has ${event.kind} for phase ${phase} attempt ${String(attempt)} while it is at attempt ${String(state.attempt)}`);
}

/** The unit, which must not have contributed yet. */
export function requireUnanswered(review: ReviewState, event: DecodedEvent, { phase, key }: UnitRef): void {
  const answeredBy = review.units[phase][key]?.answeredBy ?? null;
  if (answeredBy !== null) throw invalid(event, `has ${event.kind} for unit ${unitName(phase, key)}, which worker ${answeredBy} already answered`);
}

export function withReview(current: RunState, review: ReviewState, event: DecodedEvent): RunState {
  return { ...current, review, lastSequence: event.sequence };
}

/** The unit records, and those of `phase` within them, both writable by this fold. */
function writableUnits(review: ReviewState, drafts: FoldDrafts, phase: Phase): { units: Record<Phase, Readonly<Record<string, UnitState>>>; ofPhase: Record<string, UnitState> } {
  const units = drafts.writable(review.units);
  const ofPhase = drafts.writable(units[phase]);
  units[phase] = ofPhase;
  return { units, ofPhase };
}

/** The unit records with `unit` answered by `workerId`. */
export function answered(review: ReviewState, drafts: FoldDrafts, { phase, key }: UnitRef, workerId: string): ReviewState['units'] {
  const { units, ofPhase } = writableUnits(review, drafts, phase);
  ofPhase[key] = { answeredBy: workerId, failures: ofPhase[key]?.failures ?? [] };
  return units;
}

/** Record one failed attempt of `unit`; shared by `attempt.failed`, whose failure is not lost, and a lost worker with a unit, whose failure is. */
export function withFailure(review: ReviewState, drafts: FoldDrafts, { phase, key }: UnitRef, failure: UnitFailure): ReviewState {
  const { units, ofPhase } = writableUnits(review, drafts, phase);
  const state = ofPhase[key] ?? { answeredBy: null, failures: [] };
  ofPhase[key] = { answeredBy: state.answeredBy, failures: [...state.failures, failure] };
  return { ...review, units };
}

/**
 * The run is configured for review. A run without the fix pass records its
 * five phases skipped, and a run configured before the survey existed its
 * survey, so the phase list is one rule for every run (TD9 of the fix
 * pass); a run with either starts its state of it empty.
 */
function configure(state: RunState | undefined, payload: ReviewConfiguration, event: DecodedEvent, surveyed: boolean): RunState {
  if (state === undefined) throw new InvalidHistoryError(`Run ${event.runId} has ${event.kind} at sequence ${String(event.sequence)} before its creation`);
  if (state.scope === null) throw invalid(event, 'is configured for review before its scope is captured');
  if (state.review !== null) throw invalid(event, 'is configured for review twice');
  const skipped = new Set<Phase>([...(payload.fix ? [] : fixPhases), ...(surveyed ? [] : ['survey' as const])]);
  const review: ReviewState = {
    configuration: payload,
    limits: { concurrency: payload.concurrency, runBudgetUsd: payload.runBudgetUsd },
    phases: Object.fromEntries(phases.map((phase) => [phase, { status: skipped.has(phase) ? 'skipped' : 'pending', attempt: 0 }])) as Record<Phase, PhaseState>,
    blocker: null,
    checks: [],
    leads: null,
    candidates: {},
    units: Object.fromEntries(phases.map((phase) => [phase, {}])) as Record<Phase, Record<string, UnitState>>,
    anglesNotRun: {},
    deduplications: Object.fromEntries(deduplicationPhases.map((phase) => [phase, null])) as Record<DeduplicationPhase, null>,
    plans: Object.fromEntries(verificationPhases.map((phase) => [phase, null])) as Record<VerificationPhase, null>,
    unverifiedGroups: Object.fromEntries(verificationPhases.map((phase) => [phase, {}])) as Record<VerificationPhase, Record<string, string>>,
    ranking: null,
    report: null,
    fix: payload.fix ? emptyFixState() : null,
    survey: surveyed ? emptySurveyState() : null,
  };
  return withReview(state, review, event);
}

/** The engine did not yet survey a run whose configuration predates version 3: it applied the user-level rules files it found, which `apply` names. */
const unsurveyed = { survey: { userRules: 'apply' as const } };

/** Version 3 of the configuration: a run that is surveyed. */
const configured: Reducer<ReviewConfiguration> = (state, payload, event) => configure(state, payload, event, true);

/** Version 2 of the configuration, recorded before the survey existed: a run whose survey is skipped. */
const configuredV2: Reducer<ReviewConfigurationV2> = (state, payload, event) => configure(state, { ...payload, ...unsurveyed }, event, false);

/** Version 1 of the configuration, recorded before the fix pass existed: a run without it, and without the survey. */
const configuredV1: Reducer<ReviewConfigurationV1> = (state, payload, event) => configure(state, { ...payload, fix: false, checks: null, fixes: null, ...unsurveyed }, event, false);

/** The limits in force change; a run whose report is written runs nothing more, so it has no limits to change. */
const limitsChanged: Reducer<ReviewLimits> = (state, payload, event) => {
  const { current, review } = requireReview(state, event);
  if (review.report !== null) throw invalid(event, 'changes its limits after its report');
  return withReview(current, { ...review, limits: payload }, event);
};

/** The unit records with the unit `key` of `phase` no longer answered; its failures stay. */
function reopened(review: ReviewState, drafts: FoldDrafts, phase: Phase, key: string): ReviewState['units'] {
  const { units, ofPhase } = writableUnits(review, drafts, phase);
  const unit = ofPhase[key];
  if (unit !== undefined && unit.answeredBy !== null) ofPhase[key] = { answeredBy: null, failures: unit.failures };
  return units;
}

/** The unit records with every failure of `phase`'s units forgotten; what they answered stays. */
function withFreshAttempts(review: ReviewState, drafts: FoldDrafts, phase: Phase): ReviewState['units'] {
  const { units, ofPhase } = writableUnits(review, drafts, phase);
  for (const [key, state] of Object.entries(ofPhase)) {
    if (state.failures.length > 0) ofPhase[key] = { answeredBy: state.answeredBy, failures: [] };
  }
  return units;
}

const phaseStarted: Reducer<PhaseStarted> = (state, payload, event, drafts) => {
  const { current, review } = requireReview(state, event);
  const phase = review.phases[payload.phase];
  if (phase.status === 'completed' || phase.status === 'degraded') throw invalid(event, `starts phase ${payload.phase} again after it ${phase.status}`);
  if (phase.status === 'skipped') throw invalid(event, `starts phase ${payload.phase}, which a run without the fix pass skips`);
  if (payload.attempt !== phase.attempt + 1) throw invalid(event, `starts phase ${payload.phase} at attempt ${String(payload.attempt)} after attempt ${String(phase.attempt)}`);
  for (const earlier of phases.slice(0, phases.indexOf(payload.phase))) {
    const status = review.phases[earlier].status;
    if (status !== 'completed' && status !== 'degraded' && status !== 'skipped') throw invalid(event, `starts phase ${payload.phase} while phase ${earlier} is ${status}`);
  }
  // A re-entry after a block gives the phase's units fresh attempts: the operator's action for worker-failed is to run again.
  let units = phase.status === 'blocked' ? withFreshAttempts(review, drafts, payload.phase) : review.units;
  // A re-entered survey opens its unit again, so its unit is answered only by a surveyor of the invocation that started the attempt, whose flags it was told (R6, R15, TD6, TD7 of the repository survey). Its last answer stays the run's survey, and the planner surveys again only when that answer does not settle this invocation's checks.
  if (payload.phase === 'survey' && payload.attempt > 1 && (review.fix?.checks.planned ?? null) === null) units = reopened({ ...review, units }, drafts, payload.phase, singleUnitKey(payload.phase));
  const phaseStates = { ...review.phases, [payload.phase]: { status: 'running' as const, attempt: payload.attempt } };
  return withReview(current, { ...review, phases: phaseStates, blocker: null, units }, event);
};

const phaseFinished: Reducer<PhaseFinished> = (state, payload, event) => {
  const { current, review } = requireReview(state, event);
  requireRunning(review, event, payload.phase, payload.attempt);
  if (payload.blocker?.code === 'check-unavailable' && payload.phase !== 'survey') throw invalid(event, `blocks phase ${payload.phase} on a check that cannot run, which only the survey finds`);
  const phaseStates = { ...review.phases, [payload.phase]: { status: payload.outcome, attempt: payload.attempt } };
  const blocker = payload.blocker === null ? null : { ...payload.blocker, phase: payload.phase };
  // The survey's last blocker outlives the next start, which clears the run's: a re-entered survey reads from it whether the flags may stand in for it.
  const survey = payload.phase === 'survey' && review.survey !== null && payload.blocker !== null ? { ...review.survey, lastBlock: payload.blocker } : review.survey;
  return withReview(current, { ...review, phases: phaseStates, blocker, survey }, event);
};

const worktreeChecked: Reducer<WorktreeCheckState> = (state, payload, event) => {
  const { current, review } = requireReview(state, event);
  requireRunning(review, event, payload.phase, payload.attempt);
  return withReview(current, { ...review, checks: [...review.checks, payload] }, event);
};

/** Version 1 of the check: at the attempt's start when it is the attempt's first, else before an answer, with no head and no strays recorded. */
const worktreeCheckedV1: Reducer<WorktreeCheckV1> = (state, payload, event, drafts) => {
  const first = !(state?.review?.checks.some((check) => check.phase === payload.phase && check.attempt === payload.attempt) ?? false);
  return worktreeChecked(state, { ...payload, moment: first ? 'start' : 'answer', head: null, strays: [] }, event, drafts);
};

/** The unit, which must be one its candidate phase has: the triage's or the sweep's one unit, or a finder angle. */
function requireCandidateUnit(payload: CandidatesRecorded, event: DecodedEvent): void {
  if (payload.phase === 'finders') {
    if (!(finderAngles as readonly string[]).includes(payload.key)) throw invalid(event, `records finder candidates under ${payload.key}, which is not a finder angle`);
    return;
  }
  const key = singleUnitKey(payload.phase);
  if (payload.key !== key) throw invalid(event, `records ${payload.phase} candidates under unit ${payload.key}, not ${key}`);
}

const candidatesRecorded: Reducer<CandidatesRecorded> = (state, payload, event, drafts) => {
  const { current, review } = requireReview(state, event);
  requireRunning(review, event, payload.phase);
  requireCandidateUnit(payload, event);
  const prefix = candidateIdPrefix(payload.phase, payload.key);
  const unit: UnitRef = { phase: payload.phase, key: payload.key };
  requireUnanswered(review, event, unit);
  if (payload.phase === 'finders' && Object.hasOwn(review.anglesNotRun, payload.key)) throw invalid(event, `records candidates for angle ${payload.key} after it failed`);
  const candidates = drafts.writable(review.candidates);
  if (current.scope === null) throw invalid(event, 'records candidates before its scope is captured');
  // A located candidate is in the change exactly when its file is a changed path of the scope.
  const scopePaths = new Set(current.scope.files.map((file) => file.path));
  for (const candidate of payload.candidates) {
    if (!candidate.id.startsWith(`${prefix}-`)) throw invalid(event, `records candidate ${candidate.id} under unit ${payload.key}, whose ids start with ${prefix}-`);
    if (payload.phase !== 'sweep' && candidate.angle !== payload.key) throw invalid(event, `records candidate ${candidate.id} with angle ${candidate.angle} under unit ${payload.key}`);
    if (Object.hasOwn(candidates, candidate.id)) throw invalid(event, `records candidate ${candidate.id} twice`);
    if (candidate.file !== null && candidate.inScope !== scopePaths.has(candidate.file)) {
      throw invalid(event, `records candidate ${candidate.id} on ${candidate.file} as ${candidate.inScope ? 'in' : 'outside'} the change, which the scope ${candidate.inScope ? 'does not hold' : 'holds'}`);
    }
    candidates[candidate.id] = { ...candidate, phase: payload.phase, workerId: payload.workerId, duplicateOf: null, verdict: null, unverified: false };
  }
  const leads = payload.leads ?? review.leads;
  return withReview(current, { ...review, candidates, leads, units: answered(review, drafts, unit, payload.workerId) }, event);
};

const attemptFailed: Reducer<AttemptFailed> = (state, payload, event, drafts) => {
  const { current, review } = requireReview(state, event);
  requireRunning(review, event, payload.phase);
  const unit: UnitRef = { phase: payload.phase, key: payload.key };
  requireUnanswered(review, event, unit);
  return withReview(current, withFailure(review, drafts, unit, { workerId: payload.workerId, reason: payload.reason, lost: false }), event);
};

const angleFailed: Reducer<AngleFailed> = (state, payload, event) => {
  const { current, review } = requireReview(state, event);
  requireRunning(review, event, 'finders');
  requireUnanswered(review, event, { phase: 'finders', key: payload.angle });
  if (Object.hasOwn(review.anglesNotRun, payload.angle)) throw invalid(event, `fails angle ${payload.angle} twice`);
  return withReview(current, { ...review, anglesNotRun: { ...review.anglesNotRun, [payload.angle]: payload.reason } }, event);
};

const deduplicationRecorded: Reducer<DeduplicationRecorded> = (state, payload, event, drafts) => {
  const { current, review } = requireReview(state, event);
  requireRunning(review, event, payload.phase);
  if (review.deduplications[payload.phase] !== null) throw invalid(event, `records ${payload.phase} twice`);
  const unit: UnitRef = { phase: payload.phase, key: singleUnitKey(payload.phase) };
  requireUnanswered(review, event, unit);
  const pool = new Set(poolCandidates(review, payload.phase).map((candidate) => candidate.id));
  const candidates = drafts.writable(review.candidates);
  const grouped = new Set<string>();
  for (const group of payload.groups) {
    for (const member of group.members) {
      if (!pool.has(member)) throw invalid(event, `groups candidate ${member}, which is not in the ${payload.phase} pool`);
      if (grouped.has(member)) throw invalid(event, `groups candidate ${member} twice`);
      grouped.add(member);
      if (member !== group.keep) candidates[member] = { ...candidates[member]!, duplicateOf: group.keep };
    }
  }
  const deduplications = { ...review.deduplications, [payload.phase]: payload.groups };
  return withReview(current, { ...review, candidates, deduplications, units: answered(review, drafts, unit, payload.workerId) }, event);
};

const verificationPlanned: Reducer<VerificationPlanned> = (state, payload, event) => {
  const { current, review } = requireReview(state, event);
  requireRunning(review, event, payload.phase);
  if (review.plans[payload.phase] !== null) throw invalid(event, `plans ${payload.phase} twice`);
  const pool = new Map(poolCandidates(review, payload.phase).map((candidate) => [candidate.id, candidate]));
  const planned = new Set<string>();
  const groupIds = new Set<string>();
  for (const group of payload.groups) {
    if (groupIds.has(group.id)) throw invalid(event, `plans group ${group.id} twice`);
    groupIds.add(group.id);
    for (const id of group.candidateIds) {
      const candidate = pool.get(id);
      if (candidate === undefined) throw invalid(event, `plans candidate ${id}, which is not in the ${payload.phase} pool`);
      if (candidate.duplicateOf !== null) throw invalid(event, `plans candidate ${id}, a duplicate of ${candidate.duplicateOf}`);
      if (planned.has(id)) throw invalid(event, `plans candidate ${id} in two groups`);
      planned.add(id);
    }
  }
  return withReview(current, { ...review, plans: { ...review.plans, [payload.phase]: payload.groups } }, event);
};

/** The planned group, which must exist and have no verdicts or unverified mark yet. */
function requireOpenGroup(review: ReviewState, event: DecodedEvent, phase: VerificationPhase, groupId: string): readonly string[] {
  const plan = review.plans[phase];
  if (plan === null) throw invalid(event, `has ${event.kind} for ${phase} before it is planned`);
  const group = plan.find((candidate) => candidate.id === groupId);
  if (group === undefined) throw invalid(event, `has ${event.kind} for group ${groupId}, which ${phase} did not plan`);
  requireUnanswered(review, event, { phase, key: groupId });
  if (isUnverified(review, phase, groupId)) throw invalid(event, `has ${event.kind} for group ${groupId} after it was marked unverified`);
  return group.candidateIds;
}

const verdictsRecorded: Reducer<VerdictsRecorded> = (state, payload, event, drafts) => {
  const { current, review } = requireReview(state, event);
  requireRunning(review, event, payload.phase);
  const expected = requireOpenGroup(review, event, payload.phase, payload.groupId);
  const given = payload.verdicts.map((verdict) => verdict.id);
  if (new Set(given).size !== given.length) throw invalid(event, `records two verdicts for one candidate in group ${payload.groupId}`);
  if (given.length !== expected.length || !expected.every((id) => given.includes(id))) {
    throw invalid(event, `records verdicts for [${given.join(', ')}] in group ${payload.groupId}, which holds [${expected.join(', ')}]`);
  }
  const candidates = drafts.writable(review.candidates);
  for (const { id, verdict, evidence } of payload.verdicts) candidates[id] = { ...candidates[id]!, verdict: { verdict, evidence } };
  return withReview(current, { ...review, candidates, units: answered(review, drafts, { phase: payload.phase, key: payload.groupId }, payload.workerId) }, event);
};

const groupUnverified: Reducer<GroupUnverified> = (state, payload, event, drafts) => {
  const { current, review } = requireReview(state, event);
  requireRunning(review, event, payload.phase);
  const ids = requireOpenGroup(review, event, payload.phase, payload.groupId);
  const candidates = drafts.writable(review.candidates);
  for (const id of ids) candidates[id] = { ...candidates[id]!, unverified: true };
  const unverifiedGroups = { ...review.unverifiedGroups, [payload.phase]: { ...review.unverifiedGroups[payload.phase], [payload.groupId]: payload.reason } };
  return withReview(current, { ...review, candidates, unverifiedGroups }, event);
};

const rankingRecorded: Reducer<RankingRecorded> = (state, payload, event, drafts) => {
  const { current, review } = requireReview(state, event);
  requireRunning(review, event, 'merge-rank');
  if (review.ranking !== null) throw invalid(event, 'records its ranking twice');
  const unit: UnitRef = { phase: 'merge-rank', key: singleUnitKey('merge-rank') };
  requireUnanswered(review, event, unit);
  const seen = new Set<string>();
  for (const finding of payload.findings) {
    for (const id of [finding.id, ...finding.members]) {
      if (!Object.hasOwn(review.candidates, id)) throw invalid(event, `ranks candidate ${id}, which was never recorded`);
      if (seen.has(id)) throw invalid(event, `ranks candidate ${id} twice`);
      seen.add(id);
    }
  }
  return withReview(current, { ...review, ranking: payload.findings, units: answered(review, drafts, unit, payload.workerId) }, event);
};

const reportWritten: Reducer<ReportWritten> = (state, payload, event) => {
  const { current, review } = requireReview(state, event);
  requireRunning(review, event, 'report');
  if (review.report !== null) throw invalid(event, 'writes its report twice');
  // One patch per revision, in ledger order (R13 of the fix pass); a run without the fix pass has neither.
  const revisions = review.fix?.revisions.length ?? 0;
  if (payload.patches.length !== revisions) throw invalid(event, `writes ${String(payload.patches.length)} patches for ${String(revisions)} revisions`);
  return withReview(current, { ...review, report: payload }, event);
};

/** Version 1 of the report, written before the fix pass existed: no patch. */
const reportWrittenV1: Reducer<ReportWrittenV1> = (state, payload, event, drafts) => reportWritten(state, { ...payload, patches: [] }, event, drafts);

/** The review reducers, registered by `fold.ts` beside the run's own. Versions of one kind whose payloads differ only in the wider phase list, or the wider list of blocker codes, share a reducer. */
export const reviewReducers = {
  'review.configured@1': configuredV1,
  'review.configured@2': configuredV2,
  'review.configured@3': configured,
  'limits.changed@1': limitsChanged,
  'phase.started@1': phaseStarted,
  'phase.started@2': phaseStarted,
  'phase.started@3': phaseStarted,
  'phase.finished@1': phaseFinished,
  'phase.finished@2': phaseFinished,
  'phase.finished@3': phaseFinished,
  'worktree.checked@1': worktreeCheckedV1,
  'worktree.checked@2': worktreeChecked,
  'worktree.checked@3': worktreeChecked,
  'candidates.recorded@1': candidatesRecorded,
  'attempt.failed@1': attemptFailed,
  'attempt.failed@2': attemptFailed,
  'attempt.failed@3': attemptFailed,
  'angle.failed@1': angleFailed,
  'deduplication.recorded@1': deduplicationRecorded,
  'verification.planned@1': verificationPlanned,
  'verdicts.recorded@1': verdictsRecorded,
  'group.unverified@1': groupUnverified,
  'ranking.recorded@1': rankingRecorded,
  'report.written@1': reportWrittenV1,
  'report.written@2': reportWritten,
  'report.written@3': reportWritten,
} as const;

/** Whether the unit `key` of `phase` has contributed: a worker's answer is recorded for it. */
export function isAnswered(review: ReviewState, phase: Phase, key: string): boolean {
  return (review.units[phase][key]?.answeredBy ?? null) !== null;
}

/** Whether the group `groupId` of a verification phase was marked unverified. */
export function isUnverified(review: ReviewState, phase: VerificationPhase, groupId: string): boolean {
  return Object.hasOwn(review.unverifiedGroups[phase], groupId);
}

/** A group whose verifier failed twice, with the candidates it held and the reason recorded. */
export interface UnverifiedGroup {
  readonly phase: VerificationPhase;
  readonly groupId: string;
  readonly candidateIds: readonly string[];
  readonly reason: string;
}

/** Every unverified group, first pool then sweep, each in plan order. */
export function unverifiedGroupsOf(review: ReviewState): UnverifiedGroup[] {
  return verificationPhases.flatMap((phase) =>
    (review.plans[phase] ?? []).flatMap((group) => {
      const reason = isUnverified(review, phase, group.id) ? review.unverifiedGroups[phase][group.id] : undefined;
      return reason === undefined ? [] : [{ phase, groupId: group.id, candidateIds: group.candidateIds, reason }];
    }),
  );
}
