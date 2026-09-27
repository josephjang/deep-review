/**
 * What each phase asks of a worker and how it records the answer (R2, R4,
 * R5, R8 of the read-only review). `invocationFor` turns a planned unit
 * into the launcher's invocation; `contributionOf` turns the receipt into
 * the one event the ledger records for it: a contribution when the worker
 * completed and its answer passes the structural checks, else a failed
 * attempt with the reason.
 */
import type { NewEvent } from '../checkpoint/checkpoint.ts';
import type { Lead, PinnedRole, RankedFinding, RecordedCandidate, ReviewConfiguration } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { poolCandidates, type CandidateState, type ReviewState } from '../checkpoint/review-fold.ts';
import type { AssembledRole } from '../roles/assemble.ts';
import type { InvocationInput } from '../runtime/contract.ts';
import type { WorkerReceipt } from '../runtime/launcher.ts';
import { StructuralCheckError } from './errors.ts';
import { unitLabel } from './labels.ts';
import { normalizeLocations } from './locations.ts';
import { pinnedRole } from './policy.ts';
import { composeWorkerPrompt } from './prompts.ts';
import {
  checkDeduplication,
  checkMergeRank,
  checkTriageLeads,
  checkVerdicts,
  outputSchemaOf,
  type CandidateOutput,
  type DeduplicationOutput,
  type FinderOutput,
  type MergeRankOutput,
  type SweepOutput,
  type TriageOutput,
  type VerifierOutput,
} from './schemas.ts';
import { compareFindings, mergeRankInput, mergedResolution, refutedIn, survivors, type Resolved } from './state.ts';
import { truncated, type Unit } from './steps.ts';
import { deduplicationTask, finderTask, mergeRankTask, sweepTask, triageTask, verifierTask } from './tasks.ts';
import { finderAngles, maxRecordedTextLength, sweepIdPrefix, type Angle, type CandidatePhase, type DeduplicationPhase, type FinderAngle, type VerificationPhase } from './vocabulary.ts';

/** What building an invocation needs beyond the unit: the fold, the prompts, the pinned policy and the scope block. */
export interface PhaseContext {
  readonly state: RunState;
  readonly worktree: string;
  readonly roles: ReadonlyMap<string, AssembledRole>;
  readonly configuration: ReviewConfiguration;
  /** The scope block every worker of the run shares, rendered once. */
  readonly scopeBlock: string;
}

function requireReview(state: RunState): ReviewState {
  if (state.review === null) throw new Error(`Run ${state.id} is not configured for review`);
  return state.review;
}

/** The candidates of a planned verification group, in the plan's order. */
export function groupCandidates(review: ReviewState, phase: VerificationPhase, groupId: string): CandidateState[] {
  const group = review.plans[phase]?.find((candidate) => candidate.id === groupId);
  if (group === undefined) throw new Error(`Phase ${phase} has no planned group ${groupId}`);
  return group.candidateIds.map((id) => {
    const candidate = review.candidates[id];
    if (candidate === undefined) throw new Error(`Group ${groupId} names candidate ${id}, which the run never recorded`);
    return candidate;
  });
}

/** The task text of a unit, from the fold at launch time. */
export function taskFor(unit: Unit, review: ReviewState): string {
  switch (unit.phase) {
    case 'triage':
      return triageTask();
    case 'finders': {
      const angle = unit.key as FinderAngle;
      return finderTask(angle, review.leads?.find((lead) => lead.angle === angle) ?? null);
    }
    case 'deduplication':
    case 'sweep-deduplication':
      return deduplicationTask(poolCandidates(review, unit.phase));
    case 'verification':
    case 'sweep-verification':
      return verifierTask(unit.key, groupCandidates(review, unit.phase, unit.key));
    case 'sweep':
      return sweepTask({
        verified: survivors(review, 'verification').map(({ candidate, resolution }) => ({ candidate, verdict: resolution.verdict, unverified: resolution.unverified })),
        refuted: refutedIn(review, 'verification'),
        anglesNotRun: review.anglesNotRun,
      });
    case 'merge-rank':
      return mergeRankTask(mergeRankInput(review).map(({ candidate, resolution }) => ({ candidate, verdict: resolution.verdict, unverified: resolution.unverified, evidence: resolution.evidence })));
    case 'report':
      throw new Error('The report phase has no worker');
  }
}

/** The launcher's invocation for a unit: the pinned model, effort, budget and timeout of its role, read-only with a shell, labelled with its unit. */
export function invocationFor(unit: Unit, context: PhaseContext): InvocationInput {
  const review = requireReview(context.state);
  const role = context.roles.get(unit.role);
  if (role === undefined) throw new Error(`No assembled prompt for role ${unit.role}`);
  const policy: PinnedRole = pinnedRole(context.configuration.roles, unit.role);
  const prompt = composeWorkerPrompt(role.prompt, { role: unit.role, phase: unit.phase, unitKey: unit.key, task: taskFor(unit, review) }, context.scopeBlock);
  return {
    runtime: context.configuration.runtime,
    executable: context.configuration.executable,
    executableArgs: [...context.configuration.executableArgs],
    model: policy.model,
    effort: policy.effort,
    access: 'read-only',
    shell: true,
    prompt,
    outputSchema: outputSchemaOf(unit.role),
    timeoutMs: policy.timeoutMs,
    ...(policy.budgetUsd === null ? {} : { budgetUsd: policy.budgetUsd }),
    label: unitLabel(unit.role, unit.phase, unit.key),
  };
}

/** The failed attempt a unit records for a receipt or a refused answer. */
function failed(unit: Unit, receipt: WorkerReceipt, reason: string): NewEvent {
  return { kind: 'attempt.failed', version: 1, payload: { phase: unit.phase, key: unit.key, workerId: receipt.workerId, reason: truncated(reason, maxRecordedTextLength) } };
}

/** Candidates as a finder returned them, located against the scope and given ids from 1 in the worker's order. */
function recordCandidates(phase: CandidatePhase, key: string, prefix: string, candidates: readonly (CandidateOutput & { angle: Angle })[], state: RunState, worktree: string): RecordedCandidate[] {
  if (state.scope === null) throw new Error(`Run ${state.id} has no scope`);
  const locations = normalizeLocations(state.scope, worktree, candidates);
  return candidates.map((candidate, index) => {
    const location = locations[index]!;
    return {
      id: `${prefix}-${String(index + 1)}`,
      angle: candidate.angle,
      file: location.file,
      line: location.line,
      located: location.located,
      rawFile: candidate.file,
      rawLine: candidate.line,
      summary: candidate.summary,
      detail: candidate.detail,
    };
  });
}

/** The leads in the finder angles' order, whatever order the triage gave them. */
function orderedLeads(leads: readonly Lead[]): Lead[] {
  return finderAngles.map((angle) => leads.find((lead) => lead.angle === angle)!);
}

/** The candidates of the working list a merge-rank worker numbered, with the engine's order applied to its findings. */
function orderedRanking(review: ReviewState, output: MergeRankOutput, input: readonly Resolved[]): RankedFinding[] {
  const findings = output.findings.map((finding): RankedFinding => ({
    id: input[finding.primary]!.candidate.id,
    members: finding.members.map((member) => input[member]!.candidate.id),
    severity: finding.severity,
    summary: finding.summary,
    reason: finding.reason,
  }));
  const entries = findings.map((finding) => {
    const primary = review.candidates[finding.id]!;
    const members = finding.members.map((id) => review.candidates[id]!);
    return { finding, primary, members, resolution: mergedResolution([primary, ...members]) };
  });
  return entries.sort(compareFindings).map((entry) => entry.finding);
}

/**
 * The event a unit's receipt becomes. A receipt that did not complete, or
 * whose answer fails a structural check, is a failed attempt with the
 * reason; otherwise the phase's contribution, with ids assigned and indexes
 * resolved against the same fold the task was numbered from.
 */
export function contributionOf(unit: Unit, receipt: WorkerReceipt, state: RunState, worktree: string): NewEvent {
  if (receipt.outcome !== 'completed') return failed(unit, receipt, `${receipt.outcome}: ${receipt.error ?? 'no reason recorded'}`);
  const review = requireReview(state);
  try {
    return { kind: contributionKind(unit), version: 1, payload: contributionPayload(unit, receipt, review, state, worktree) };
  } catch (error) {
    if (error instanceof StructuralCheckError) return failed(unit, receipt, `structural check: ${error.message}`);
    throw error;
  }
}

function contributionKind(unit: Unit): string {
  switch (unit.phase) {
    case 'triage':
    case 'finders':
    case 'sweep':
      return 'candidates.recorded';
    case 'deduplication':
    case 'sweep-deduplication':
      return 'deduplication.recorded';
    case 'verification':
    case 'sweep-verification':
      return 'verdicts.recorded';
    case 'merge-rank':
      return 'ranking.recorded';
    case 'report':
      throw new Error('The report phase has no worker');
  }
}

function contributionPayload(unit: Unit, receipt: WorkerReceipt, review: ReviewState, state: RunState, worktree: string): unknown {
  switch (unit.phase) {
    case 'triage': {
      const output = receipt.output as TriageOutput;
      checkTriageLeads(output);
      const candidates = recordCandidates('triage', unit.key, 'SCAN', output.candidates.map((candidate) => ({ ...candidate, angle: 'SCAN' as const })), state, worktree);
      return { phase: 'triage', key: unit.key, workerId: receipt.workerId, candidates, leads: orderedLeads(output.leads) };
    }
    case 'finders': {
      const output = receipt.output as FinderOutput;
      const angle = unit.key as FinderAngle;
      const candidates = recordCandidates('finders', unit.key, angle, output.candidates.map((candidate) => ({ ...candidate, angle })), state, worktree);
      return { phase: 'finders', key: unit.key, workerId: receipt.workerId, candidates, leads: null };
    }
    case 'sweep': {
      const output = receipt.output as SweepOutput;
      const candidates = recordCandidates('sweep', unit.key, sweepIdPrefix, output.candidates, state, worktree);
      return { phase: 'sweep', key: unit.key, workerId: receipt.workerId, candidates, leads: null };
    }
    case 'deduplication':
    case 'sweep-deduplication': {
      const output = receipt.output as DeduplicationOutput;
      const pool = poolCandidates(review, unit.phase as DeduplicationPhase);
      checkDeduplication(output, pool.length);
      const groups = output.groups.map((group) => ({ members: group.members.map((member) => pool[member]!.id), keep: pool[group.keep]!.id, reason: group.reason }));
      return { phase: unit.phase, workerId: receipt.workerId, groups };
    }
    case 'verification':
    case 'sweep-verification': {
      const output = receipt.output as VerifierOutput;
      const group = groupCandidates(review, unit.phase as VerificationPhase, unit.key);
      checkVerdicts(output, group.length);
      const verdicts = output.verdicts.map((verdict) => ({ id: group[verdict.index]!.id, verdict: verdict.verdict, evidence: verdict.evidence }));
      return { phase: unit.phase, groupId: unit.key, workerId: receipt.workerId, verdicts };
    }
    case 'merge-rank': {
      const output = receipt.output as MergeRankOutput;
      const input = mergeRankInput(review);
      checkMergeRank(output, input.length);
      return { workerId: receipt.workerId, findings: orderedRanking(review, output, input) };
    }
    case 'report':
      throw new Error('The report phase has no worker');
  }
}
