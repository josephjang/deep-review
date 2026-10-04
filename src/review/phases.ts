/**
 * What each phase asks of a worker and how it records the answer (R2, R4,
 * R5, R8 of the read-only review; R4, R5, R11 of the fix pass).
 * `invocationFor` turns a planned unit into the launcher's invocation;
 * `contributionOf` turns the receipt into the events the ledger records
 * for it: a contribution when the worker completed and its answer passes
 * the structural checks, with the revisions of the tree an editing unit
 * made, else a failed attempt with the reason.
 */
import { join } from 'node:path';
import type { NewEvent } from '../checkpoint/checkpoint.ts';
import type { CandidatesRecorded, DeduplicationRecorded, Lead, PinnedRole, RankedFinding, RankingRecorded, RecordedCandidate, ReviewConfiguration, SurveyRecorded, TreeRevised, VerdictsRecorded } from '../checkpoint/events.ts';
import { failedAtBaseline, fixesRevisedPaths, lastRun, repairTargets } from '../checkpoint/fix-state.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { poolCandidates, type CandidateState, type ReviewState } from '../checkpoint/review-fold.ts';
import type { ArtifactReference, EvidenceStore } from '../evidence/store.ts';
import type { AssembledRole } from '../roles/assemble.ts';
import type { InvocationInput } from '../runtime/contract.ts';
import type { WorkerReceipt } from '../runtime/launcher.ts';
import { StructuralCheckError } from './errors.ts';
import { attemptRevisionEvents, fixAnswerEvents, type RevisionContext } from './fix-events.ts';
import { unitLabel } from './labels.ts';
import { normalizeLocations, worktreeLookup } from './locations.ts';
import { pinnedRole } from './policy.ts';
import { composeWorkerPrompt } from './prompts.ts';
import { snapshotsDirectoryName } from './snapshot.ts';
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
  type SurveyorOutput,
  type SweepOutput,
  type TriageOutput,
  type VerifierOutput,
} from './schemas.ts';
import { settledKinds, unsettledKinds } from './checks/discover.ts';
import { checkSurveyAnswer, offeredUserFiles, type SurveyInputs } from './survey.ts';
import { mergeRankInput, rankedFindings, refutedIn, survivors, type Resolved } from './state.ts';
import type { PlannedBatch } from './fixes.ts';
import { fixPlanOf, truncated, type Unit } from './steps.ts';
import { deduplicationTask, describeLocation, finderTask, fixerTask, mergeRankTask, repairTailBytes, repairTask, surveyTask, sweepTask, triageTask, verifierTask, type BaselineFailure, type FixerTaskEarlier, type FixerTaskFinding, type RepairTaskCheck } from './tasks.ts';
import { candidateIdPrefix, finderAngles, isEditingPhase, maxRecordedTextLength, repairUnitKey, type Angle, type CandidatePhase, type EditingPhase, type FinderAngle, type VerificationPhase } from './vocabulary.ts';

/** What building an invocation needs beyond the unit: the fold, the prompts, the pinned policy and the scope block, the survey's inputs, and for an editing unit its scratch and snapshot command. */
export interface PhaseContext {
  readonly state: RunState;
  readonly worktree: string;
  readonly roles: ReadonlyMap<string, AssembledRole>;
  readonly configuration: ReviewConfiguration;
  /** The scope block a worker of the unit's phase receives: the surveyor's, without the convention sources, or the one every later worker shares, each rendered once. */
  readonly scopeBlock: (phase: Unit['phase']) => string;
  /** What this invocation knows for the survey, for the surveyor's task. */
  readonly survey: () => SurveyInputs;
  /** The evidence store, for the frozen logs a repair task quotes. */
  readonly evidence: Pick<EvidenceStore, 'read' | 'pathOf'>;
  /** A fresh scratch directory for an editing worker, outside the reviewed tree and the checkpoint, so its task can name its snapshot directory. */
  readonly newScratch: () => string;
  /** The command a fixer runs to snapshot into a directory, holding `snapshotIndexPlaceholder` for the index. */
  readonly snapshotCommand: (into: string) => string;
  /** Whether the run's editors work in Codex's unelevated Windows sandbox (`editorsUnderUnelevatedSandbox`). */
  readonly unelevatedEditors: boolean;
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

/** What an editing unit's task names beyond the fold: the command that takes a snapshot into its directory, and what its sandbox will not run. */
export interface EditingTaskInput {
  readonly snapshotCommand: string;
  /** Whether the worker runs in Codex's unelevated Windows sandbox, whose limit its task states (R6 of the Codex sandbox). */
  readonly unelevatedSandbox: boolean;
}

/**
 * Whether an earlier worker on an editing unit may have left part of its
 * work in the tree: a re-entered phase, an earlier failure or loss, or a
 * revision that reached its files (an earlier answer's violation). The
 * revisions of the earlier batches of its own cluster do not count: their
 * work is in the tree by design, and the task names it (R18).
 */
function mayHoldWork(review: ReviewState, phase: EditingPhase, key: string, owned: readonly string[], ownCluster: readonly string[] = []): boolean {
  if (review.phases[phase].attempt > 1 || (review.units[phase][key]?.failures.length ?? 0) > 0) return true;
  const sourceKey = (revision: TreeRevised): string | null => (revision.source.kind === 'check' ? null : revision.source.key);
  return (review.fix?.revisions ?? []).some((revision) => revision.phase === phase && !ownCluster.includes(sourceKey(revision) ?? '') && revision.files.some((file) => owned.includes(file.path)));
}

/** The ids an earlier attempt of an editing unit left recorded edits for, in the order of their first revision (R20 of the fix pass). */
function unfinishedIds(review: ReviewState, phase: EditingPhase, key: string): string[] {
  const ids = (review.fix?.revisions ?? []).filter((revision) => revision.phase === phase && revision.source.kind === 'attempt' && revision.source.key === key).flatMap((revision) => revision.change.findings);
  return [...new Set(ids)];
}

/** What the first round said of a finding the second round takes: its blocked note and the files it needed. */
function firstRoundBlock(review: ReviewState, firstBatches: readonly PlannedBatch[], id: string, requiredFiles: readonly string[]): FixerTaskFinding['firstRound'] {
  const batch = firstBatches.find((candidate) => candidate.findingIds.includes(id));
  const note = (batch === undefined ? undefined : review.fix?.answers.fixes[batch.key]?.findings.find((finding) => finding.id === id)?.note) ?? 'blocked';
  return { note, requiredFiles };
}

/** What became of each finding of a fixes-phase batch, as a later batch of its cluster is told: the answer's status and note, or not attempted. */
function batchOutcomes(review: ReviewState, batch: Pick<PlannedBatch, 'key' | 'findingIds'>): FixerTaskEarlier[] {
  const answer = review.fix?.answers.fixes[batch.key];
  return batch.findingIds.map((id) => {
    const finding = answer?.findings.find((candidate) => candidate.id === id);
    return { batch: batch.key, id, outcome: finding?.status ?? 'not attempted', note: finding?.note ?? null };
  });
}

/** A fixer's task over its batch, from the plan, the ranked findings and the pinned checks. */
function fixerTaskOf(unit: Unit, review: ReviewState, editing: EditingTaskInput, evidence: Pick<EvidenceStore, 'pathOf'>): string {
  const plan = fixPlanOf(review);
  const second = review.fix?.secondRound ?? null;
  const all = [...plan.batches, ...(second?.batches ?? [])];
  const batch = all.find((candidate) => candidate.key === unit.key);
  if (batch === undefined) throw new Error(`The fix plan has no batch ${unit.key}`);
  const inSecondRound = second?.batches.some((candidate) => candidate.key === batch.key) ?? false;
  // Within a round no file has two owners; the first round's ownership ends with it (R21 of the fix pass).
  const clusters = inSecondRound ? second!.clusters : plan.clusters;
  const cluster = clusters.find((candidate) => candidate.id === batch.cluster);
  if (cluster === undefined) throw new Error(`Batch ${batch.key} names cluster ${batch.cluster}, which the fix plan does not have`);
  const siblings = all.filter((candidate) => candidate.cluster === cluster.id);
  const earlier = siblings.slice(0, siblings.indexOf(batch));
  // A second-round batch is also told what the first round did in the files it now owns.
  const firstRoundInFiles = inSecondRound ? plan.batches.filter((candidate) => plan.clusters.find((owner) => owner.id === candidate.cluster)?.files.some((path) => cluster.files.includes(path)) ?? false) : [];
  const blockedOn = new Map((second?.blocked ?? []).map((entry) => [entry.id, entry.requiredFiles]));
  const ranked = new Map(rankedFindings(review).map((entry) => [entry.finding.id, entry]));
  const findings = batch.findingIds.map((id): FixerTaskFinding => {
    const entry = ranked.get(id);
    if (entry === undefined) throw new Error(`Batch ${batch.key} names finding ${id}, which the ranking does not hold`);
    return {
      id,
      severity: entry.finding.severity,
      verdict: entry.resolution.verdict,
      unverified: entry.resolution.unverified,
      angle: entry.primary.angle,
      location: describeLocation(entry.primary),
      summary: entry.finding.summary,
      detail: entry.primary.detail,
      evidence: entry.resolution.evidence,
      reason: entry.finding.reason,
      also: entry.members.map((member) => `${member.id} at ${describeLocation(member)}`),
      firstRound: inSecondRound ? firstRoundBlock(review, plan.batches, id, blockedOn.get(id) ?? []) : null,
    };
  });
  return fixerTask({
    cluster: cluster.id,
    batch: batch.key,
    secondRound: inSecondRound,
    findings,
    earlier: [...firstRoundInFiles, ...earlier].flatMap((sibling) => batchOutcomes(review, sibling)),
    owned: cluster.files,
    othersOwned: clusters.filter((other) => other.id !== cluster.id).map((other) => ({ cluster: other.id, files: other.files })),
    checks: review.fix?.checks.planned?.checks ?? [],
    snapshotCommand: editing.snapshotCommand,
    unelevatedSandbox: editing.unelevatedSandbox,
    mayHoldWork: mayHoldWork(review, 'fixes', unit.key, cluster.files, [...earlier, ...(inSecondRound ? plan.batches : [])].map((sibling) => sibling.key)),
    unfinished: unfinishedIds(review, 'fixes', unit.key),
    baselineFailures: baselineFailuresOf(review, evidence),
  });
}

/** The checks that failed before any fixer edited the tree, with their frozen outputs' paths, as a fixer is told them (R24). */
function baselineFailuresOf(review: ReviewState, evidence: Pick<EvidenceStore, 'pathOf'>): BaselineFailure[] {
  const fix = review.fix;
  if (fix === null) return [];
  return (fix.checks.planned?.checks ?? []).flatMap((check): BaselineFailure[] => {
    const run = failedAtBaseline(fix, check.kind) ? lastRun(fix, 'baseline-checks', check.kind) : null;
    return run === null ? [] : [{ kind: check.kind, stdout: run.stdout === null ? 'none' : evidence.pathOf(run.stdout), stderr: run.stderr === null ? 'none' : evidence.pathOf(run.stderr) }];
  });
}

/** The last bytes of a frozen stream, and its path. */
function tailOf(evidence: Pick<EvidenceStore, 'read' | 'pathOf'>, reference: ArtifactReference | null): { tail: Buffer; path: string } {
  if (reference === null) return { tail: Buffer.alloc(0), path: 'none' };
  const bytes = evidence.read(reference);
  return { tail: bytes.subarray(Math.max(0, bytes.length - repairTailBytes)), path: evidence.pathOf(reference) };
}

/** The repair worker's task: the checks failing after the fixes with their output, and their output before for one that failed then too (R24), everything the fixes changed, and what each fixer did. */
function repairTaskOf(review: ReviewState, editing: EditingTaskInput, evidence: Pick<EvidenceStore, 'read' | 'pathOf'>): string {
  const fix = review.fix;
  if (fix === null) throw new Error('The repair runs only in a run with the fix pass');
  const checks = repairTargets(fix).map((kind): RepairTaskCheck => {
    const run = lastRun(fix, 'checks', kind)!;
    const before = failedAtBaseline(fix, kind) ? lastRun(fix, 'baseline-checks', kind)! : null;
    return {
      kind, command: run.command, outcome: run.outcome === 'timeout' ? 'timeout' : 'failed', exitCode: run.exitCode, stdout: tailOf(evidence, run.stdout), stderr: tailOf(evidence, run.stderr),
      baseline: before === null ? null : { stdout: tailOf(evidence, before.stdout), stderr: tailOf(evidence, before.stderr) },
    };
  });
  const owned = fixesRevisedPaths(fix);
  const answers = Object.values(fix.answers.fixes).flatMap((answer) => answer.findings.map((finding) => ({ batch: answer.key, id: finding.id, status: finding.status, note: finding.note })));
  return repairTask({ checks, owned, answers, allChecks: fix.checks.planned?.checks ?? [], snapshotCommand: editing.snapshotCommand, unelevatedSandbox: editing.unelevatedSandbox, mayHoldWork: mayHoldWork(review, 'repair', repairUnitKey, owned), unfinished: unfinishedIds(review, 'repair', repairUnitKey) });
}

/** What a unit's task may need beyond the fold: an editing unit's snapshot command, the evidence store a fixer or repair task names frozen output from, and the survey's inputs. */
export interface TaskOptions {
  readonly editing?: EditingTaskInput | null;
  readonly evidence?: Pick<EvidenceStore, 'read' | 'pathOf'> | null;
  readonly survey?: SurveyInputs | null;
}

/**
 * The surveyor's task: what the invocation knows, read against the pinned
 * policy and whether the run fixes. The reviewer's authorship (two git
 * commands) is passed as a getter, so it is read only by a task that
 * prints it, the one that offers a user-level file.
 */
function surveyTaskOf(review: ReviewState, inputs: SurveyInputs): string {
  const setting = review.configuration.survey.userRules;
  const fix = review.fix !== null;
  const unsettled = fix ? unsettledKinds(inputs.flags) : [];
  return surveyTask({
    platform: inputs.platform,
    fix,
    settled: fix ? settledKinds(inputs.flags) : [],
    unsettled,
    hints: inputs.hints.filter((hint) => unsettled.includes(hint.kind)),
    offered: offeredUserFiles(setting, inputs),
    policySettlesUserRules: setting !== 'judge' && inputs.userFiles.length > 0,
    elevatedSandbox: inputs.platform === 'win32' && review.configuration.codex?.windowsSandbox === 'elevated',
    get authorship() {
      return inputs.authorship;
    },
  });
}

/** The task text of a unit, from the fold at launch time; an editing unit's names its snapshot command too. */
export function taskFor(unit: Unit, review: ReviewState, options: TaskOptions = {}): string {
  const editing = options.editing ?? null;
  const evidence = options.evidence ?? null;
  const requireEditing = (): EditingTaskInput => {
    if (editing === null) throw new Error(`The ${unit.phase} unit ${unit.key} needs its snapshot command`);
    return editing;
  };
  switch (unit.phase) {
    case 'survey':
      if (options.survey === undefined || options.survey === null) throw new Error('The surveyor\'s task names what the invocation knows for the survey and needs it');
      return surveyTaskOf(review, options.survey);
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
    case 'fixes':
      if (evidence === null) throw new Error('The fixer task names the baseline checks\' frozen outputs and needs the evidence store');
      return fixerTaskOf(unit, review, requireEditing(), evidence);
    case 'repair':
      if (evidence === null) throw new Error('The repair task quotes frozen logs and needs the evidence store');
      return repairTaskOf(review, requireEditing(), evidence);
    case 'baseline-checks':
    case 'checks':
    case 'repair-checks':
      throw new Error(`The ${unit.phase} phase runs checks, not workers`);
    case 'report':
      throw new Error('The report phase has no worker');
  }
}

/**
 * The launcher's invocation for a unit: the pinned model, effort, budget
 * and timeout of its role, with a shell, labelled with its unit. A unit
 * of an editing phase has edit access and its own scratch directory,
 * which its task names as where its snapshots go (TD7 of the fix pass);
 * every other unit is read-only.
 */
export function invocationFor(unit: Unit, context: PhaseContext): InvocationInput {
  const review = requireReview(context.state);
  const role = context.roles.get(unit.role);
  if (role === undefined) throw new Error(`No assembled prompt for role ${unit.role}`);
  const policy: PinnedRole = pinnedRole(context.configuration.roles, unit.role);
  const scratch = isEditingPhase(unit.phase) ? context.newScratch() : null;
  const editing = scratch === null ? null : { snapshotCommand: context.snapshotCommand(join(scratch, snapshotsDirectoryName)), unelevatedSandbox: context.unelevatedEditors };
  const survey = unit.phase === 'survey' ? context.survey() : null;
  const prompt = composeWorkerPrompt(role.prompt, { role: unit.role, phase: unit.phase, unitKey: unit.key, task: taskFor(unit, review, { editing, evidence: context.evidence, survey }) }, context.scopeBlock(unit.phase));
  return {
    runtime: context.configuration.runtime,
    executable: context.configuration.executable,
    executableArgs: [...context.configuration.executableArgs],
    model: policy.model,
    effort: policy.effort,
    access: scratch === null ? 'read-only' : 'edit',
    shell: true,
    prompt,
    outputSchema: outputSchemaOf(unit.role),
    timeoutMs: policy.timeoutMs,
    ...(policy.budgetUsd === null ? {} : { budgetUsd: policy.budgetUsd }),
    ...(scratch === null ? {} : { scratch }),
    label: unitLabel(unit.role, unit.phase, unit.key),
  };
}

/** The failed attempt a unit records for a receipt or a refused answer. */
function failed(unit: Unit, receipt: WorkerReceipt, reason: string): NewEvent {
  return { kind: 'attempt.failed', version: 3, payload: { phase: unit.phase, key: unit.key, workerId: receipt.workerId, reason: truncated(reason, maxRecordedTextLength) } };
}

/** Candidates as a candidate phase's unit returned them, located against the scope and the worktree and given ids from 1 in the worker's order, under the unit's id prefix. */
function recordCandidates(phase: CandidatePhase, key: string, candidates: readonly (CandidateOutput & { angle: Angle })[], state: RunState, worktree: string): RecordedCandidate[] {
  if (state.scope === null) throw new Error(`Run ${state.id} has no scope`);
  const prefix = candidateIdPrefix(phase, key);
  const locations = normalizeLocations(state.scope, worktree, candidates);
  return candidates.map((candidate, index) => {
    const location = locations[index]!;
    return {
      id: `${prefix}-${String(index + 1)}`,
      angle: candidate.angle,
      file: location.file,
      line: location.line,
      located: location.located,
      inScope: location.inScope,
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

/** The findings of a merge-rank answer, its indexes resolved to the ids of the working list it numbered, in the engine's order (`rankedFindings`). */
function orderedRanking(review: ReviewState, output: MergeRankOutput, input: readonly Resolved[]): RankedFinding[] {
  const findings = output.findings.map((finding): RankedFinding => ({
    id: input[finding.primary]!.candidate.id,
    members: finding.members.map((member) => input[member]!.candidate.id),
    severity: finding.severity,
    summary: finding.summary,
    reason: finding.reason,
  }));
  return rankedFindings(review, findings).map((entry) => entry.finding);
}

/** What recording a contribution needs: the revision context, and for the survey what the invocation knew when it launched the surveyor. */
export interface ContributionContext extends RevisionContext {
  readonly survey: () => SurveyInputs;
}

/**
 * The events a unit's receipt becomes. A receipt that did not complete, or
 * whose answer fails a structural check, is a failed attempt with the
 * reason; otherwise the phase's contribution, with ids assigned and indexes
 * resolved against the same fold the task was numbered from: one event,
 * or for an editing unit its recorded answer and the revisions of the
 * tree it made.
 */
export function contributionOf(unit: Unit, receipt: WorkerReceipt, context: ContributionContext): NewEvent[] {
  if (receipt.outcome !== 'completed') return failedWithEdits(unit, receipt, `${receipt.outcome}: ${receipt.error ?? 'no reason recorded'}`, context);
  const review = requireReview(context.state);
  try {
    return isEditingPhase(unit.phase) ? fixAnswerEvents(unit, receipt, context) : [contributionEvent(unit, receipt, review, context)];
  } catch (error) {
    if (error instanceof StructuralCheckError) return failedWithEdits(unit, receipt, `structural check: ${error.message}`, context);
    throw error;
  }
}

/** A failed attempt, followed for an editing unit by the revisions of what the attempt left (R20 of the fix pass), which the fold takes after the failure. */
function failedWithEdits(unit: Unit, receipt: WorkerReceipt, reason: string, context: RevisionContext): NewEvent[] {
  const failure = failed(unit, receipt, reason);
  return isEditingPhase(unit.phase) ? [failure, ...attemptRevisionEvents(context, unit.phase, unit.key, receipt.workerId, reason)] : [failure];
}

/** The events a unit's contribution is recorded as, each kind with its own payload. */
type ContributionEvent =
  | { readonly kind: 'survey.recorded'; readonly version: 1; readonly payload: SurveyRecorded }
  | { readonly kind: 'candidates.recorded'; readonly version: 1; readonly payload: CandidatesRecorded }
  | { readonly kind: 'deduplication.recorded'; readonly version: 1; readonly payload: DeduplicationRecorded }
  | { readonly kind: 'verdicts.recorded'; readonly version: 1; readonly payload: VerdictsRecorded }
  | { readonly kind: 'ranking.recorded'; readonly version: 1; readonly payload: RankingRecorded };

/**
 * The contribution event of a completed unit whose answer passes its
 * structural checks. Each phase's case builds the kind and its payload
 * together, typed as a pair, so the two cannot disagree; a phase added to
 * the review does not compile until it is given a case. Throws
 * `StructuralCheckError` for an answer a check refuses.
 */
function contributionEvent(unit: Unit, receipt: WorkerReceipt, review: ReviewState, context: ContributionContext): ContributionEvent {
  const { state, worktree } = context;
  switch (unit.phase) {
    case 'survey': {
      const output = receipt.output as SurveyorOutput;
      const checked = checkSurveyAnswer(output, { worktree, lookup: worktreeLookup(worktree), setting: review.configuration.survey.userRules, fix: review.fix !== null, inputs: context.survey() });
      return { kind: 'survey.recorded', version: 1, payload: { workerId: receipt.workerId, ...checked } };
    }
    case 'triage': {
      const output = receipt.output as TriageOutput;
      checkTriageLeads(output);
      const candidates = recordCandidates('triage', unit.key, output.candidates.map((candidate) => ({ ...candidate, angle: 'SCAN' as const })), state, worktree);
      return { kind: 'candidates.recorded', version: 1, payload: { phase: 'triage', key: unit.key, workerId: receipt.workerId, candidates, leads: orderedLeads(output.leads) } };
    }
    case 'finders': {
      const output = receipt.output as FinderOutput;
      const angle = unit.key as FinderAngle;
      const candidates = recordCandidates('finders', unit.key, output.candidates.map((candidate) => ({ ...candidate, angle })), state, worktree);
      return { kind: 'candidates.recorded', version: 1, payload: { phase: 'finders', key: unit.key, workerId: receipt.workerId, candidates, leads: null } };
    }
    case 'sweep': {
      const output = receipt.output as SweepOutput;
      const candidates = recordCandidates('sweep', unit.key, output.candidates, state, worktree);
      return { kind: 'candidates.recorded', version: 1, payload: { phase: 'sweep', key: unit.key, workerId: receipt.workerId, candidates, leads: null } };
    }
    case 'deduplication':
    case 'sweep-deduplication': {
      const output = receipt.output as DeduplicationOutput;
      const pool = poolCandidates(review, unit.phase);
      checkDeduplication(output, pool.length);
      const groups = output.groups.map((group) => ({ members: group.members.map((member) => pool[member]!.id), keep: pool[group.keep]!.id, reason: group.reason }));
      return { kind: 'deduplication.recorded', version: 1, payload: { phase: unit.phase, workerId: receipt.workerId, groups } };
    }
    case 'verification':
    case 'sweep-verification': {
      const output = receipt.output as VerifierOutput;
      const group = groupCandidates(review, unit.phase, unit.key);
      checkVerdicts(output, group.length);
      const verdicts = output.verdicts.map((verdict) => ({ id: group[verdict.index]!.id, verdict: verdict.verdict, evidence: verdict.evidence }));
      return { kind: 'verdicts.recorded', version: 1, payload: { phase: unit.phase, groupId: unit.key, workerId: receipt.workerId, verdicts } };
    }
    case 'merge-rank': {
      const output = receipt.output as MergeRankOutput;
      const input = mergeRankInput(review);
      checkMergeRank(output, input.length);
      return { kind: 'ranking.recorded', version: 1, payload: { workerId: receipt.workerId, findings: orderedRanking(review, output, input) } };
    }
    case 'fixes':
    case 'repair':
      throw new Error(`An answer of ${unit.phase} is recorded with the revisions it made, by fixAnswerEvents`);
    case 'baseline-checks':
    case 'checks':
    case 'repair-checks':
    case 'report':
      throw new Error(`The ${unit.phase} phase has no worker`);
  }
}
