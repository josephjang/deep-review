/**
 * What the read-only review's events say about a run, and the reducers that
 * fold them (R10 of the read-only review). The state holds facts as the
 * events recorded them: the pinned configuration, each phase's status and
 * attempt, every candidate with its resolution, each unit's contribution
 * and failures, the plans, the ranking and the report. What the run does
 * next is read from these by the planner, never stored.
 */
import {
  candidatePhases,
  deduplicationPhases,
  finderAngles,
  phases,
  sweepIdPrefix,
  triageUnitKey,
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
  GroupUnverified,
  Lead,
  PhaseFinished,
  PhaseStarted,
  RankedFinding,
  RankingRecorded,
  RecordedCandidate,
  ReportWritten,
  ReviewConfiguration,
  VerdictsRecorded,
  VerificationPlanned,
  WorktreeCheck,
} from './events.ts';
import type { DecodedEvent, FoldDrafts, Reducer, RunState } from './fold.ts';

export type PhaseStatus = 'pending' | 'running' | 'completed' | 'degraded' | 'blocked';

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
  readonly failures: readonly { readonly workerId: string; readonly reason: string }[];
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

export interface ReviewState {
  readonly configuration: ReviewConfiguration;
  readonly phases: Readonly<Record<Phase, PhaseState>>;
  /** Why the run is blocked and in which phase, or null; cleared by the next `phase.started`. */
  readonly blocker: (Blocker & { readonly phase: Phase }) | null;
  readonly checks: readonly WorktreeCheck[];
  /** The triage's one lead per finder angle, or null until the triage answers. */
  readonly leads: readonly Lead[] | null;
  /** Every candidate by id, in the order recorded. */
  readonly candidates: Readonly<Record<string, CandidateState>>;
  /** Every unit that contributed or failed, by `phase:key`. */
  readonly units: Readonly<Record<string, UnitState>>;
  /** The finder angles that failed twice, with the reason. */
  readonly anglesNotRun: Readonly<Record<string, string>>;
  readonly deduplications: Readonly<Record<DeduplicationPhase, DeduplicationRecorded['groups'] | null>>;
  readonly plans: Readonly<Record<VerificationPhase, VerificationPlanned['groups'] | null>>;
  /** The groups whose verifier failed twice, by `phase:groupId`, with the reason. */
  readonly unverifiedGroups: Readonly<Record<string, string>>;
  readonly ranking: readonly RankedFinding[] | null;
  readonly report: ReportWritten | null;
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

/** The unit key of a phase with one worker: the phase's own name, except the triage's, which is the `SCAN` angle. */
export function singleUnitKey(phase: Phase): string {
  return phase === 'triage' ? triageUnitKey : phase;
}

/** The unit name under which a lost worker's attempt is counted, or null when the launch label named no unit. */
export function unitOfLostWorker(phase: Phase | null, key: string | null): string | null {
  return phase === null || key === null ? null : unitName(phase, key);
}

const invalid = (event: DecodedEvent, what: string): InvalidHistoryError =>
  new InvalidHistoryError(`Run ${event.runId} ${what}, at sequence ${String(event.sequence)} (${event.kind}@${String(event.version)})`);

/** The run, which must exist and be configured for review. */
function requireReview(state: RunState | undefined, event: DecodedEvent): { current: RunState; review: ReviewState } {
  if (state === undefined) throw new InvalidHistoryError(`Run ${event.runId} has ${event.kind} at sequence ${String(event.sequence)} before its creation`);
  if (state.review === null) throw invalid(event, `has ${event.kind} before review.configured`);
  return { current: state, review: state.review };
}

/** The phase, which must be running under the given attempt. */
function requireRunning(review: ReviewState, event: DecodedEvent, phase: Phase, attempt?: number): void {
  const state = review.phases[phase];
  if (state.status !== 'running') throw invalid(event, `has ${event.kind} for phase ${phase} while it is ${state.status}`);
  if (attempt !== undefined && attempt !== state.attempt) throw invalid(event, `has ${event.kind} for phase ${phase} attempt ${String(attempt)} while it is at attempt ${String(state.attempt)}`);
}

/** The unit, which must not have contributed yet. */
function requireUnanswered(review: ReviewState, event: DecodedEvent, unit: string): UnitState {
  const state = review.units[unit] ?? { answeredBy: null, failures: [] };
  if (state.answeredBy !== null) throw invalid(event, `has ${event.kind} for unit ${unit}, which worker ${state.answeredBy} already answered`);
  return state;
}

function withReview(current: RunState, review: ReviewState, event: DecodedEvent): RunState {
  return { ...current, review, lastSequence: event.sequence };
}

/** The unit record with `unit` answered by `workerId`. */
function answered(review: ReviewState, drafts: FoldDrafts, unit: string, workerId: string): ReviewState['units'] {
  const units = drafts.writable(review.units);
  units[unit] = { answeredBy: workerId, failures: units[unit]?.failures ?? [] };
  return units;
}

/** Record one failed attempt of `unit`; shared by `attempt.failed` and a lost worker with a unit. */
export function withFailure(review: ReviewState, drafts: FoldDrafts, unit: string, workerId: string, reason: string): ReviewState {
  const units = drafts.writable(review.units);
  const state = units[unit] ?? { answeredBy: null, failures: [] };
  units[unit] = { answeredBy: state.answeredBy, failures: [...state.failures, { workerId, reason }] };
  return { ...review, units };
}

const configured: Reducer<ReviewConfiguration> = (state, payload, event) => {
  if (state === undefined) throw new InvalidHistoryError(`Run ${event.runId} has ${event.kind} at sequence ${String(event.sequence)} before its creation`);
  if (state.scope === null) throw invalid(event, 'is configured for review before its scope is captured');
  if (state.review !== null) throw invalid(event, 'is configured for review twice');
  const review: ReviewState = {
    configuration: payload,
    phases: Object.fromEntries(phases.map((phase) => [phase, { status: 'pending', attempt: 0 }])) as Record<Phase, PhaseState>,
    blocker: null,
    checks: [],
    leads: null,
    candidates: {},
    units: {},
    anglesNotRun: {},
    deduplications: Object.fromEntries(deduplicationPhases.map((phase) => [phase, null])) as Record<DeduplicationPhase, null>,
    plans: Object.fromEntries(verificationPhases.map((phase) => [phase, null])) as Record<VerificationPhase, null>,
    unverifiedGroups: {},
    ranking: null,
    report: null,
  };
  return withReview(state, review, event);
};

/** The unit record with every failure of `phase`'s units forgotten; what they answered stays. */
function withFreshAttempts(review: ReviewState, drafts: FoldDrafts, phase: Phase): ReviewState['units'] {
  const units = drafts.writable(review.units);
  for (const [unit, state] of Object.entries(units)) {
    if (unit.startsWith(`${phase}:`) && state.failures.length > 0) units[unit] = { answeredBy: state.answeredBy, failures: [] };
  }
  return units;
}

const phaseStarted: Reducer<PhaseStarted> = (state, payload, event, drafts) => {
  const { current, review } = requireReview(state, event);
  const phase = review.phases[payload.phase];
  if (phase.status === 'completed' || phase.status === 'degraded') throw invalid(event, `starts phase ${payload.phase} again after it ${phase.status}`);
  if (payload.attempt !== phase.attempt + 1) throw invalid(event, `starts phase ${payload.phase} at attempt ${String(payload.attempt)} after attempt ${String(phase.attempt)}`);
  for (const earlier of phases.slice(0, phases.indexOf(payload.phase))) {
    const status = review.phases[earlier].status;
    if (status !== 'completed' && status !== 'degraded') throw invalid(event, `starts phase ${payload.phase} while phase ${earlier} is ${status}`);
  }
  // A re-entry after a block gives the phase's units fresh attempts: the operator's action for worker-failed is to run again.
  const units = phase.status === 'blocked' ? withFreshAttempts(review, drafts, payload.phase) : review.units;
  const phaseStates = { ...review.phases, [payload.phase]: { status: 'running' as const, attempt: payload.attempt } };
  return withReview(current, { ...review, phases: phaseStates, blocker: null, units }, event);
};

const phaseFinished: Reducer<PhaseFinished> = (state, payload, event) => {
  const { current, review } = requireReview(state, event);
  requireRunning(review, event, payload.phase, payload.attempt);
  const phaseStates = { ...review.phases, [payload.phase]: { status: payload.outcome, attempt: payload.attempt } };
  const blocker = payload.blocker === null ? null : { ...payload.blocker, phase: payload.phase };
  return withReview(current, { ...review, phases: phaseStates, blocker }, event);
};

const worktreeChecked: Reducer<WorktreeCheck> = (state, payload, event) => {
  const { current, review } = requireReview(state, event);
  requireRunning(review, event, payload.phase, payload.attempt);
  return withReview(current, { ...review, checks: [...review.checks, payload] }, event);
};

/** The id prefix every candidate of a unit carries, and the key the unit must have. */
function candidateRules(payload: CandidatesRecorded, event: DecodedEvent): { prefix: string } {
  switch (payload.phase) {
    case 'triage':
      if (payload.key !== triageUnitKey) throw invalid(event, `records triage candidates under unit ${payload.key}, not ${triageUnitKey}`);
      return { prefix: 'SCAN' };
    case 'finders':
      if (!(finderAngles as readonly string[]).includes(payload.key)) throw invalid(event, `records finder candidates under ${payload.key}, which is not a finder angle`);
      return { prefix: payload.key };
    case 'sweep':
      if (payload.key !== 'sweep') throw invalid(event, `records sweep candidates under unit ${payload.key}, not sweep`);
      return { prefix: sweepIdPrefix };
  }
}

const candidatesRecorded: Reducer<CandidatesRecorded> = (state, payload, event, drafts) => {
  const { current, review } = requireReview(state, event);
  requireRunning(review, event, payload.phase);
  const { prefix } = candidateRules(payload, event);
  const unit = unitName(payload.phase, payload.key);
  requireUnanswered(review, event, unit);
  if (payload.phase === 'finders' && Object.hasOwn(review.anglesNotRun, payload.key)) throw invalid(event, `records candidates for angle ${payload.key} after it failed`);
  const candidates = drafts.writable(review.candidates);
  for (const candidate of payload.candidates) {
    if (!candidate.id.startsWith(`${prefix}-`)) throw invalid(event, `records candidate ${candidate.id} under unit ${payload.key}, whose ids start with ${prefix}-`);
    if (payload.phase !== 'sweep' && candidate.angle !== payload.key) throw invalid(event, `records candidate ${candidate.id} with angle ${candidate.angle} under unit ${payload.key}`);
    if (Object.hasOwn(candidates, candidate.id)) throw invalid(event, `records candidate ${candidate.id} twice`);
    candidates[candidate.id] = { ...candidate, phase: payload.phase, workerId: payload.workerId, duplicateOf: null, verdict: null, unverified: false };
  }
  const leads = payload.leads ?? review.leads;
  return withReview(current, { ...review, candidates, leads, units: answered(review, drafts, unit, payload.workerId) }, event);
};

const attemptFailed: Reducer<AttemptFailed> = (state, payload, event, drafts) => {
  const { current, review } = requireReview(state, event);
  requireRunning(review, event, payload.phase);
  const unit = unitName(payload.phase, payload.key);
  requireUnanswered(review, event, unit);
  return withReview(current, withFailure(review, drafts, unit, payload.workerId, payload.reason), event);
};

const angleFailed: Reducer<AngleFailed> = (state, payload, event) => {
  const { current, review } = requireReview(state, event);
  requireRunning(review, event, 'finders');
  requireUnanswered(review, event, unitName('finders', payload.angle));
  if (Object.hasOwn(review.anglesNotRun, payload.angle)) throw invalid(event, `fails angle ${payload.angle} twice`);
  return withReview(current, { ...review, anglesNotRun: { ...review.anglesNotRun, [payload.angle]: payload.reason } }, event);
};

const deduplicationRecorded: Reducer<DeduplicationRecorded> = (state, payload, event, drafts) => {
  const { current, review } = requireReview(state, event);
  requireRunning(review, event, payload.phase);
  if (review.deduplications[payload.phase] !== null) throw invalid(event, `records ${payload.phase} twice`);
  const unit = unitName(payload.phase, payload.phase);
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
  requireUnanswered(review, event, unitName(phase, groupId));
  if (Object.hasOwn(review.unverifiedGroups, unitName(phase, groupId))) throw invalid(event, `has ${event.kind} for group ${groupId} after it was marked unverified`);
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
  return withReview(current, { ...review, candidates, units: answered(review, drafts, unitName(payload.phase, payload.groupId), payload.workerId) }, event);
};

const groupUnverified: Reducer<GroupUnverified> = (state, payload, event, drafts) => {
  const { current, review } = requireReview(state, event);
  requireRunning(review, event, payload.phase);
  const ids = requireOpenGroup(review, event, payload.phase, payload.groupId);
  const candidates = drafts.writable(review.candidates);
  for (const id of ids) candidates[id] = { ...candidates[id]!, unverified: true };
  const unverifiedGroups = { ...review.unverifiedGroups, [unitName(payload.phase, payload.groupId)]: payload.reason };
  return withReview(current, { ...review, candidates, unverifiedGroups }, event);
};

const rankingRecorded: Reducer<RankingRecorded> = (state, payload, event, drafts) => {
  const { current, review } = requireReview(state, event);
  requireRunning(review, event, 'merge-rank');
  if (review.ranking !== null) throw invalid(event, 'records its ranking twice');
  const unit = unitName('merge-rank', 'merge-rank');
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
  return withReview(current, { ...review, report: payload }, event);
};

/** The review reducers, registered by `fold.ts` beside the run's own. */
export const reviewReducers = {
  'review.configured@1': configured,
  'phase.started@1': phaseStarted,
  'phase.finished@1': phaseFinished,
  'worktree.checked@1': worktreeChecked,
  'candidates.recorded@1': candidatesRecorded,
  'attempt.failed@1': attemptFailed,
  'angle.failed@1': angleFailed,
  'deduplication.recorded@1': deduplicationRecorded,
  'verification.planned@1': verificationPlanned,
  'verdicts.recorded@1': verdictsRecorded,
  'group.unverified@1': groupUnverified,
  'ranking.recorded@1': rankingRecorded,
  'report.written@1': reportWritten,
} as const;

/** Every phase's units that have a record, for the phase's planner. */
export function unitsOfPhase(review: ReviewState, phase: Phase): Record<string, UnitState> {
  const prefix = `${phase}:`;
  return Object.fromEntries(Object.entries(review.units).filter(([unit]) => unit.startsWith(prefix)).map(([unit, state]) => [unit.slice(prefix.length), state]));
}

/** The candidate phases, for callers that iterate them in review order. */
export const orderedCandidatePhases: readonly CandidatePhase[] = candidatePhases;
