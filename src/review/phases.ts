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
import { isDocumentItem, recordedDecisionSchema, type CandidatesRecorded, type DecisionsRecorded, type DeduplicationRecorded, type Lead, type PinnedRole, type RankedFinding, type RankingRecorded, type RecordedCandidate, type RecordedDecision, type ReviewConfiguration, type SurveyRecorded, type TreeRevised, type VerdictsRecorded } from '../checkpoint/events.ts';
import { passOf, standingAnswer } from '../checkpoint/answer-state.ts';
import { allBatches, clusterClaims, exactPath, failedAtBaseline, failingBaselineRun, fixPassRevisedPaths, heldByOthers, kindsTakenToBase, lastAnswerOf, lastClaimOf, lastFreshRun, ownedFiles, repairTargets, roundOf, unitRevisions, type CheckRunState, type SpelledHolder } from '../checkpoint/fix-state.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { poolCandidates, type CandidateState, type ReviewState } from '../checkpoint/review-fold.ts';
import { lastSurvey } from '../checkpoint/survey-state.ts';
import type { ArtifactReference, EvidenceStore } from '../evidence/store.ts';
import type { AssembledRole } from '../roles/assemble.ts';
import type { InvocationInput } from '../runtime/contract.ts';
import type { WorkerReceipt } from '../runtime/launcher.ts';
import { settleClaims, type ClaimsAccess } from './claim-events.ts';
import { leftDocumentsOf } from './documents.ts';
import { StructuralCheckError } from './errors.ts';
import { writtenVersion } from './event-versions.ts';
import { attemptRevisionEvents, comparesWithBase, fixAnswerEvents, type AnswerContext, type RevisionContext } from './fix-events.ts';
import { unitLabel } from './labels.ts';
import { normalizeLocations, worktreeLookup } from './locations.ts';
import { pinnedRole, pinnedWindowsSandbox } from './policy.ts';
import { composeWorkerPrompt } from './prompts.ts';
import { snapshotsDirectoryName } from './snapshot.ts';
import {
  checkDecisions,
  checkDeduplication,
  checkMergeRank,
  checkTriageLeads,
  normalizeTriageChange,
  checkVerdicts,
  outputSchemaOf,
  repairOutputSchema,
  type CandidateOutput,
  type DeciderOutput,
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
import { mergeRankInput, rankedFindings, refutedIn, resolutionOf, survivors, type ReportFinding, type Resolved } from './state.ts';
import type { PlannedBatch } from './fixes.ts';
import { fixPlanOf, truncated, type Unit } from './steps.ts';
import { deciderTask, deduplicationTask, describeLocation, documentationTask, finderTask, fixerTask, mergeRankTask, repairTailBytes, repairTask, surveyTask, sweepTask, triageTask, verifierTask, type AnsweredFinding, type BaselineFailure, type ChangeMessages, type DeciderTaskFinding, type DocumentationTaskDecided, type DocumentationTaskFix, type FixerDecision, type FixerTaskEarlier, type FixerTaskFinding, type RepairTaskBase, type RepairTaskCheck, type TaskCandidate } from './tasks.ts';
import { candidateIdPrefix, documentationUnitKey, finderAngles, isEditingPhase, maxRecordedTextLength, repairUnitKey, type Angle, type AttemptFault, type CandidatePhase, type EditingPhase, type FinderAngle, type VerificationPhase } from './vocabulary.ts';

/**
 * Where a fixes-phase unit claims files (R1, R2 of commit series
 * integrity): its round's claims directory, which the engine has prepared
 * before the launch, the claim command into it, and its live markers.
 */
export interface ClaimsContext extends ClaimsAccess {
  /** The claims directory of a fixes-phase unit's round. */
  readonly directoryOf: (key: string) => string;
  /** The command a fixer runs to claim a file, for its unit and its round's directory, holding `claimPathPlaceholder` for the path. */
  readonly command: (key: string, directory: string) => string;
}

/** What building an invocation needs beyond the unit: the fold, the prompts, the pinned policy and the scope block, the survey's inputs, and for an editing unit its scratch, snapshot command and, in the fixes phase, its claims. */
export interface PhaseContext {
  readonly state: RunState;
  readonly worktree: string;
  readonly roles: ReadonlyMap<string, AssembledRole>;
  readonly configuration: ReviewConfiguration;
  /** The scope block a worker of the unit's phase receives: the surveyor's, without the convention sources, or the one every later worker shares, each rendered once. */
  readonly scopeBlock: (phase: Unit['phase']) => string;
  /** What this invocation knows for the survey, for the surveyor's task. */
  readonly survey: () => SurveyInputs;
  /** The commit messages of the change, for the triage's task, read when first asked for (R6 of the brief of a run). */
  readonly commitMessages: () => ChangeMessages;
  /** The evidence store, for the frozen logs a repair task quotes. */
  readonly evidence: Pick<EvidenceStore, 'read' | 'pathOf'>;
  /** A fresh scratch directory for an editing worker, outside the reviewed tree and the checkpoint, so its task can name its snapshot directory. */
  readonly newScratch: () => string;
  /** The command a fixer runs to snapshot into a directory, holding `snapshotIndexPlaceholder` for the index. */
  readonly snapshotCommand: (into: string) => string;
  /** Whether the run's editors work in Codex's unelevated Windows sandbox (`editorsUnderUnelevatedSandbox`). */
  readonly unelevatedEditors: boolean;
  /** Where a fixes-phase unit claims files. */
  readonly claims: ClaimsContext;
  /** What the documentation step's task names beyond the fold, the patches of the fixes put in the evidence store when first asked for, before the launch (R2 of the documentation step). */
  readonly documentation: () => DocumentationTaskOptions;
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

/** What an editing unit's task names beyond the fold: the command that takes a snapshot into its directory, the claim command, and what its sandbox will not run. */
export interface EditingTaskInput {
  readonly snapshotCommand: string;
  /** The command a fixer runs to claim a file, holding `claimPathPlaceholder` for the path; null for the repair and an answer pass, which claim nothing. */
  readonly claimCommand: string | null;
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

/**
 * What the first round said of a finding the second round takes: its
 * blocked note and the files it needed, each with the other first-round
 * cluster that had claimed it last, or null for a file another cluster
 * owned (R4 of commit series integrity).
 */
function firstRoundBlock(review: ReviewState, firstBatches: readonly PlannedBatch[], id: string, requiredFiles: readonly string[]): FixerTaskFinding['firstRound'] {
  const batch = firstBatches.find((candidate) => candidate.findingIds.includes(id));
  const fix = review.fix;
  const note = (batch === undefined ? undefined : fix?.answers.fixes[batch.key]?.findings.find((finding) => finding.id === id)?.note) ?? 'blocked';
  const owned = new Set((fix?.plan?.clusters ?? []).flatMap((cluster) => cluster.files));
  const claimedBy = (path: string): string | null => {
    if (fix === null || owned.has(path)) return null;
    return lastClaimOf(fix, 1, path, batch?.cluster)?.cluster ?? null;
  };
  return { note, requiredFiles: requiredFiles.map((path) => ({ path, claimedBy: claimedBy(path) })) };
}

/** What became of each finding of a fixes-phase batch, as a later batch of its cluster is told: the answer's status and note, or not attempted. */
function batchOutcomes(review: ReviewState, batch: Pick<PlannedBatch, 'key' | 'findingIds'>): FixerTaskEarlier[] {
  const answer = review.fix?.answers.fixes[batch.key];
  return batch.findingIds.map((id) => {
    const finding = answer?.findings.find((candidate) => candidate.id === id);
    return { batch: batch.key, id, outcome: finding?.status ?? 'not attempted', note: finding?.note ?? null };
  });
}

/** A candidate of a ranked finding as a task names it: its claim and location, and its own verdict and evidence. */
function taskCandidate(candidate: CandidateState): TaskCandidate {
  const resolution = resolutionOf(candidate);
  if (resolution === null) throw new Error(`Candidate ${candidate.id} is ranked with no verdict and no unverified mark`);
  return { id: candidate.id, angle: candidate.angle, location: describeLocation(candidate), summary: candidate.summary, detail: candidate.detail, verdict: resolution.verdict, unverified: resolution.unverified, evidence: resolution.evidence };
}

/** The ranked findings as the decider's task numbers them, in rank order, each with every candidate of it. */
export function deciderFindings(review: ReviewState): DeciderTaskFinding[] {
  return rankedFindings(review).map((entry): DeciderTaskFinding => ({
    id: entry.finding.id,
    severity: entry.finding.severity,
    verdict: entry.resolution.verdict,
    summary: entry.finding.summary,
    reason: entry.finding.reason,
    candidates: [entry.primary, ...entry.members].map(taskCandidate),
  }));
}

/**
 * What a fixer is told of the author's answer to a finding (R4, R5, R7 of
 * answers, TD9), from its standing answer, by its kind: for an option the
 * option chosen, its text, rule and whether it edits, for a rejection the
 * departure it rejects; its note; and what the run did with
 * the finding before, the last fixer answer and the files of that unit's
 * revisions for it, or none when no fixer saw it. An answer an answer
 * pass applied is given too, naming that pass: a batch the run budget
 * left, launched by a reopened fix pass after the pass, keeps what the
 * tree holds rather than apply the default again (R13 of resumable
 * runs). Null for a finding nobody answered, or whose answer the tree
 * held when it was recorded or a batch of the fixes applied, which owes
 * no edit and so is no fixer's to apply.
 */
function answeredFor(review: ReviewState, decision: FixerDecision | null, id: string): AnsweredFinding | null {
  const standing = standingAnswer(review, id);
  if (standing === null || decision === null) return null;
  const appliedBy = standing.appliedBy;
  if (appliedBy !== null && (appliedBy === 'tree' || appliedBy.phase !== 'answer')) return null;
  const fix = review.fix;
  const last = fix === null ? null : lastAnswerOf(fix, id);
  const files = last === null || fix === null ? [] : [...new Set(unitRevisions(fix, last.phase, last.key).filter((revision) => revision.change.findings.includes(id)).flatMap((revision) => revision.files.map((file) => file.path)))].sort();
  const shared = { note: standing.note, before: last === null ? null : { status: last.finding.status, note: last.finding.note, files }, appliedByPass: appliedBy === null ? null : appliedBy.key };
  const answer = standing.answer;
  // The ledger admits an answer only as its decision does (`admits`), so these hold for every answer recorded.
  switch (answer.kind) {
    case 'option': {
      const chosen = decision.decision === 'ask' ? decision.ask.options[answer.option] : undefined;
      if (chosen === undefined) throw new Error(`Finding ${id} is answered with an option its decision does not offer`);
      return { ...shared, kind: 'option', option: answer.option, chosen: { option: chosen.option, rule: chosen.rule, edits: chosen.edits } };
    }
    case 'reject': {
      const departure = decision.decision === 'fix' ? decision.departure : null;
      if (departure === null) throw new Error(`Finding ${id} rejects a departure its decision does not make`);
      return { ...shared, kind: 'reject', departure };
    }
    case 'accept':
      return { ...shared, kind: 'accept' };
  }
}

/** A fixer's task over its batch, from the plan, the ranked findings, their decisions and the answers the author gave before the fix pass, and the pinned checks. */
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
  // What the cluster and its siblings hold, by the plan or by a claim, in the fold as the launch read it with the round's live markers (R8 of commit series integrity).
  const fix = review.fix!;
  const round = roundOf(fix, batch.key);
  const othersHeld = new Map<string, Pick<SpelledHolder, 'path' | 'by'>[]>();
  for (const [path, holder] of heldByOthers(fix, batch.key, exactPath)) othersHeld.set(holder.cluster, [...(othersHeld.get(holder.cluster) ?? []), { path, by: holder.by }]);
  if (editing.claimCommand === null) throw new Error(`The fixer of ${batch.key} needs its claim command`);
  const ranked = new Map(rankedFindings(review).map((entry) => [entry.finding.id, entry]));
  const decided = new Map((review.decisions ?? []).map((decision) => [decision.id, decision]));
  const findings = batch.findingIds.map((id): FixerTaskFinding => {
    const entry = ranked.get(id);
    if (entry === undefined) throw new Error(`Batch ${batch.key} names finding ${id}, which the ranking does not hold`);
    const decision = decidedFor(review, decided, id);
    return {
      ...taskFinding(review, ranked, entry, decision),
      firstRound: inSecondRound ? firstRoundBlock(review, plan.batches, id, blockedOn.get(id) ?? []) : null,
    };
  });
  return fixerTask({
    kind: 'batch',
    cluster: cluster.id,
    batch: batch.key,
    secondRound: inSecondRound,
    findings,
    earlier: [...firstRoundInFiles, ...earlier].flatMap((sibling) => batchOutcomes(review, sibling)),
    owned: cluster.files,
    claimed: clusterClaims(fix, round, cluster.id),
    othersHeld: [...othersHeld].map(([held, files]) => ({ cluster: held, files })),
    checks: review.fix?.checks.planned?.checks ?? [],
    snapshotCommand: editing.snapshotCommand,
    claimCommand: editing.claimCommand,
    unelevatedSandbox: editing.unelevatedSandbox,
    mayHoldWork: mayHoldWork(review, 'fixes', unit.key, cluster.files, [...earlier, ...(inSecondRound ? plan.batches : [])].map((sibling) => sibling.key)),
    unfinished: unfinishedIds(review, 'fixes', unit.key),
    baselineFailures: baselineFailuresOf(review, evidence),
  });
}

/**
 * One finding as a fixer's task gives it, but for what the first round
 * said of it: its claim, its candidates, its decision, the findings left
 * because its fix removes them, and the author's answer when one is owed.
 */
function taskFinding(review: ReviewState, ranked: ReadonlyMap<string, ReportFinding>, entry: ReportFinding, decision: FixerDecision | null): Omit<FixerTaskFinding, 'firstRound'> {
  const id = entry.finding.id;
  return {
    id,
    severity: entry.finding.severity,
    verdict: entry.resolution.verdict,
    unverified: entry.resolution.unverified,
    summary: entry.finding.summary,
    reason: entry.finding.reason,
    primary: taskCandidate(entry.primary),
    members: entry.members.map(taskCandidate),
    decision,
    supersedes: (review.decisions ?? []).filter((left) => left.leave?.supersededBy === id).flatMap((left) => {
      const leftEntry = ranked.get(left.id);
      return leftEntry === undefined ? [] : [{ id: left.id, location: describeLocation(leftEntry.primary), summary: leftEntry.finding.summary }];
    }),
    answered: answeredFor(review, decision, id),
  };
}

/**
 * The answer pass's fixer's task (R5, R7 of answers, PD5): the pass's
 * findings in rank order, each with its decision, what the run did with
 * it and the author's answer; the files every revision of the run changed
 * and the files the findings are located in, which it owns, with any other
 * file free to edit, as the repair has; no claim; the checks, the
 * snapshot command, and whether an earlier attempt of this pass may have
 * left its work in the tree.
 */
function answerTaskOf(unit: Unit, review: ReviewState, editing: EditingTaskInput, evidence: Pick<EvidenceStore, 'pathOf'>): string {
  const pass = passOf(review, unit.key);
  if (pass === null) throw new Error(`The answer pass ${unit.key} is not recorded`);
  const ranked = new Map(rankedFindings(review).map((entry) => [entry.finding.id, entry]));
  const decided = new Map((review.decisions ?? []).map((decision) => [decision.id, decision]));
  const findings = [...ranked.values()].filter((entry) => pass.ids.includes(entry.finding.id)).map((entry): FixerTaskFinding => {
    const decision = decidedFor(review, decided, entry.finding.id, true);
    const finding = { ...taskFinding(review, ranked, entry, decision), firstRound: null };
    if (finding.answered === null) throw new Error(`Finding ${entry.finding.id} is in answer pass ${unit.key} with no answer owing an edit`);
    return finding;
  });
  // An earlier attempt of this pass, not an earlier pass, may have left its work: an earlier pass's edits are recorded revisions the task names as the files owned.
  const mayHold = review.phases.answer.attempt > pass.openedAt.answer + 1 || (review.units.answer[unit.key]?.failures.length ?? 0) > 0;
  return fixerTask({
    kind: 'answer-pass',
    batch: unit.key,
    findings,
    owned: ownedFiles(review, 'answer', unit.key),
    // What the run left out of date when the pass opens, so its fixer brings in line what an answer settles and its revision ends the count (PD10 of the documentation step).
    leftDocuments: leftDocumentsOf(review).map((document) => ({ file: document.file, facts: document.facts.map((fact) => fact.what) })),
    checks: review.fix?.checks.planned?.checks ?? [],
    snapshotCommand: editing.snapshotCommand,
    unelevatedSandbox: editing.unelevatedSandbox,
    mayHoldWork: mayHold,
    unfinished: unfinishedIds(review, 'answer', unit.key),
    baselineFailures: baselineFailuresOf(review, evidence),
  });
}

/**
 * The decision a fixer is told for a finding of its batch: the recorded
 * one, or none in a run configured before the decision step, whose plan
 * was made without decisions. A decided run that recorded none for a
 * finding it gives a fixer, or left it, is a plan the engine cannot have
 * made.
 */
function decidedFor(review: ReviewState, decided: ReadonlyMap<string, RecordedDecision>, id: string, answered = false): FixerDecision | null {
  const decision = decided.get(id) ?? null;
  if (decision === null && (answered || review.phases.decision.status !== 'skipped')) throw new Error(`Finding ${id} goes to a fixer with no decision recorded for it`);
  if (decision?.decision === 'leave') throw new Error(`Finding ${id} goes to a fixer though its decision leaves it`);
  return decision;
}

/** The checks that failed before any fixer edited the tree, with their frozen outputs' paths, as a fixer is told them (R24). */
function baselineFailuresOf(review: ReviewState, evidence: Pick<EvidenceStore, 'pathOf'>): BaselineFailure[] {
  const fix = review.fix;
  if (fix === null) return [];
  return (fix.checks.planned?.checks ?? []).flatMap((check): BaselineFailure[] => {
    const run = failedAtBaseline(fix, check.kind) ? lastFreshRun(fix, 'baseline-checks', check.kind) : null;
    return run === null ? [] : [{ kind: check.kind, stdout: run.stdout === null ? 'none' : evidence.pathOf(run.stdout), stderr: run.stderr === null ? 'none' : evidence.pathOf(run.stderr) }];
  });
}

/** The last bytes of a frozen stream, and its path. */
function tailOf(evidence: Pick<EvidenceStore, 'read' | 'pathOf'>, reference: ArtifactReference | null): { tail: Buffer; path: string } {
  if (reference === null) return { tail: Buffer.alloc(0), path: 'none' };
  const bytes = evidence.read(reference);
  return { tail: bytes.subarray(Math.max(0, bytes.length - repairTailBytes)), path: evidence.pathOf(reference) };
}

/**
 * A kind's run on the base as the repair task gives it (R2 of the facts
 * before a merge), or null when it has none: its outcome, with the tail of
 * its output when it failed or timed out there, or why it did not run.
 */
function baseRunOf(evidence: Pick<EvidenceStore, 'read' | 'pathOf'>, run: CheckRunState | null): RepairTaskBase | null {
  if (run === null) return null;
  switch (run.outcome) {
    case 'passed':
      return { outcome: 'passed' };
    case 'failed':
    case 'timeout':
      return { outcome: run.outcome, exitCode: run.exitCode, signal: run.signal, stdout: tailOf(evidence, run.stdout), stderr: tailOf(evidence, run.stderr) };
    case 'skipped':
    case 'not-started':
      return { outcome: run.outcome, reason: run.error ?? 'no reason recorded' };
    case 'cut':
      throw new Error(`The ${run.kind} check was cut short on the base and is due there again, so the repair cannot start before it runs`);
  }
}

/** The repair worker's task: the checks failing after the fixes and the documentation step with their output, their output before for one that failed then too (R24), and in a run with the checks on the base its run there (R2 of the facts before a merge), everything the fixes and the step changed (R9 of the documentation step), and what each fixer and the step did. */
function repairTaskOf(review: ReviewState, editing: EditingTaskInput, evidence: Pick<EvidenceStore, 'read' | 'pathOf'>): string {
  const fix = review.fix;
  if (fix === null) throw new Error('The repair runs only in a run with the fix pass');
  const onBase = kindsTakenToBase({ ...review, fix });
  const checks = repairTargets(fix).map((kind): RepairTaskCheck => {
    const run = lastFreshRun(fix, 'checks', kind)!;
    const before = failingBaselineRun(fix, kind);
    return {
      kind, command: run.command, outcome: run.outcome === 'timeout' ? 'timeout' : 'failed', exitCode: run.exitCode, signal: run.signal, stdout: tailOf(evidence, run.stdout), stderr: tailOf(evidence, run.stderr),
      baseline: before === null ? null : { stdout: tailOf(evidence, before.stdout), stderr: tailOf(evidence, before.stderr) },
      base: onBase.includes(kind) ? baseRunOf(evidence, lastFreshRun(fix, 'base-checks', kind)) : null,
    };
  });
  const owned = fixPassRevisedPaths(fix);
  const answers = Object.values(fix.answers.fixes).flatMap((answer) => answer.findings.map((finding) => ({ batch: answer.key, id: finding.id, status: finding.status, note: finding.note })));
  const documentation = (fix.answers.documentation[documentationUnitKey]?.findings ?? []).map((finding) => ({ id: finding.id, status: finding.status, note: finding.note }));
  return repairTask({ checks, baseChecks: review.baseChecksStep, owned, answers, documentation, allChecks: fix.checks.planned?.checks ?? [], snapshotCommand: editing.snapshotCommand, unelevatedSandbox: editing.unelevatedSandbox, mayHoldWork: mayHoldWork(review, 'repair', repairUnitKey, owned), unfinished: unfinishedIds(review, 'repair', repairUnitKey) });
}

/**
 * What was decided for a finding a fixer of the fixes answered, as the
 * documentation step is told it (R4 of the documentation step): the
 * recorded decision, the author's standing answer, and whether that answer
 * still owes an edit. Null for a finding with no decision, in a run
 * configured before the decision step.
 */
function documentationDecided(review: ReviewState, id: string): DocumentationTaskDecided | null {
  const decision = review.decisions?.find((candidate) => candidate.id === id) ?? null;
  if (decision === null) return null;
  const standing = standingAnswer(review, id);
  // An answer that still owes an edit, which a later answer pass applies: the tree does not hold it yet, and the step documents the tree (R4 of the documentation step).
  return { decision, answer: standing?.answer ?? null, owed: standing !== null && standing.appliedBy === null };
}

/**
 * The documentation step's task (R2 to R5, PD11 of the documentation
 * step): its documents from the recorded plan, then the search; what each
 * fixer of the fixes did, batch by batch in the order of the plan, with
 * what was decided; the path of each patch of the fixes, with the subject
 * of its commit; the files it owns; the patterns `scope.exclude` names;
 * and the checks and its snapshot command.
 */
function documentationTaskOf(review: ReviewState, editing: EditingTaskInput, evidence: Pick<EvidenceStore, 'pathOf'>, options: DocumentationTaskOptions): string {
  const fix = review.fix;
  const plan = fix?.documentation ?? null;
  if (fix === null || plan === null) throw new Error('The documentation step runs only once it is planned');
  const fixes = allBatches(fix).flatMap((batch) => (fix.answers.fixes[batch.key]?.findings ?? []).map((finding): DocumentationTaskFix => ({
    batch: batch.key, id: finding.id, status: finding.status, note: finding.note, files: finding.files, subject: finding.message?.subject ?? null, decided: documentationDecided(review, finding.id),
  })));
  const owned = ownedFiles(review, 'documentation', documentationUnitKey);
  return documentationTask({
    documents: plan.items.filter(isDocumentItem).map((item) => ({ id: item.id, file: item.file, path: item.path, drift: item.drift.map((line) => ({ batch: line.key, file: line.file, what: line.what })) })),
    fixes,
    patches: options.patches.map((patch) => ({ path: evidence.pathOf(patch.reference), subject: patch.subject })),
    owned,
    exclude: options.exclude,
    checks: fix.checks.planned?.checks ?? [],
    snapshotCommand: editing.snapshotCommand,
    mayHoldWork: mayHoldWork(review, 'documentation', documentationUnitKey, owned),
    unfinished: unfinishedIds(review, 'documentation', documentationUnitKey),
    unelevatedSandbox: editing.unelevatedSandbox,
  });
}

/**
 * What the documentation step's task needs beyond the fold (R2, PD11 of
 * the documentation step): the patch of each revision of the fixes, in
 * ledger order, with the subject of its commit, which the controller put
 * in the evidence store before the launch, and the patterns
 * `scope.exclude` kept out of the review, which the run's scope records.
 */
export interface DocumentationTaskOptions {
  readonly patches: readonly DocumentationPatch[];
  readonly exclude: readonly string[];
}

/** A patch of the fix pass in the evidence store, with the subject of the message its commit would carry. */
export interface DocumentationPatch {
  readonly reference: ArtifactReference;
  readonly subject: string;
}

/** What a unit's task may need beyond the fold: an editing unit's snapshot command, the evidence store a fixer or repair task names frozen output from, the survey's inputs, the commit messages of the change the triage's task lists, and the documentation step's patches and patterns. */
export interface TaskOptions {
  readonly editing?: EditingTaskInput | null;
  readonly evidence?: Pick<EvidenceStore, 'read' | 'pathOf'> | null;
  readonly survey?: SurveyInputs | null;
  readonly commitMessages?: ChangeMessages | null;
  readonly documentation?: DocumentationTaskOptions | null;
}

/**
 * What the survey of a read-only run continued into the fix pass stands
 * on while its checks are unplanned (R4, PD5 of fix pass continuation):
 * the last answer it recorded, whose convention sources and user-level
 * decisions every worker of the review was held to, so its surveyor is
 * asked for the checks alone. Null for a run never continued, and once
 * the checks are planned.
 */
export function standingSurvey(review: ReviewState): SurveyRecorded | null {
  if (review.continuedFrom === null || (review.fix?.checks.planned ?? null) !== null) return null;
  const answer = review.survey === null ? null : lastSurvey(review.survey);
  // A run that went on without its survey is continued only with its checks planned (`fix.pinned`), so a continued run asking its survey again has an answer.
  if (answer === null) throw new Error('A continued run asks its survey for the checks with no answer of it recorded');
  return answer;
}

/**
 * The surveyor's task: what the invocation knows, read against the pinned
 * policy and whether the run fixes, and for a continued run what its
 * survey recorded, which stands. The reviewer's authorship (two git
 * commands) is passed as a getter, so it is read only by a task that
 * prints it, the one that offers a user-level file.
 */
function surveyTaskOf(review: ReviewState, inputs: SurveyInputs): string {
  const setting = review.configuration.survey.userRules;
  const fix = review.fix !== null;
  const unsettled = fix ? unsettledKinds(inputs.checkSettings) : [];
  return surveyTask({
    platform: inputs.platform,
    fix,
    settled: fix ? settledKinds(inputs.checkSettings) : [],
    unsettled,
    hints: inputs.hints.filter((hint) => unsettled.includes(hint.kind)),
    offered: offeredUserFiles(setting, inputs),
    policySettlesUserRules: setting !== 'judge' && inputs.userFiles.length > 0,
    elevatedSandbox: pinnedWindowsSandbox(review.configuration, inputs.platform) === 'elevated',
    standing: standingSurvey(review),
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
      if (options.commitMessages === undefined || options.commitMessages === null) throw new Error('The triage\'s task lists the commit messages of the change and needs them');
      return triageTask(options.commitMessages);
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
    case 'decision':
      return deciderTask(deciderFindings(review));
    case 'fixes':
      if (evidence === null) throw new Error('The fixer task names the baseline checks\' frozen outputs and needs the evidence store');
      return fixerTaskOf(unit, review, requireEditing(), evidence);
    case 'documentation':
      if (evidence === null || options.documentation === undefined || options.documentation === null) throw new Error('The documentation step\'s task names the patches of the fixes in the evidence store and the patterns scope.exclude left out, and needs them');
      return documentationTaskOf(review, requireEditing(), evidence, options.documentation);
    case 'repair':
      if (evidence === null) throw new Error('The repair task quotes frozen logs and needs the evidence store');
      return repairTaskOf(review, requireEditing(), evidence);
    case 'answer':
      if (evidence === null) throw new Error('The answer pass\'s task names the baseline checks\' frozen outputs and needs the evidence store');
      return answerTaskOf(unit, review, requireEditing(), evidence);
    case 'baseline-checks':
    case 'checks':
    case 'base-checks':
    case 'repair-checks':
    case 'answer-checks':
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
 * every other unit is read-only. A fixes-phase unit also shares its
 * round's claims directory with its siblings, which its task's claim
 * command writes, and its task names what each cluster holds as the fold
 * and the directory's live markers say at the launch (R2, R8 of commit
 * series integrity). Each unit answers in its role's schema, but the
 * repair of a run with the checks on the base answers in its own, which
 * carries its comparisons (TD6 of the facts before a merge).
 */
export function invocationFor(unit: Unit, context: PhaseContext): InvocationInput {
  const role = context.roles.get(unit.role);
  if (role === undefined) throw new Error(`No assembled prompt for role ${unit.role}`);
  const policy: PinnedRole = pinnedRole(context.configuration.roles, unit.role);
  const scratch = isEditingPhase(unit.phase) ? context.newScratch() : null;
  const shared = unit.phase === 'fixes' ? context.claims.directoryOf(unit.key) : null;
  const live = unit.phase === 'fixes' ? context.claims.live(unit.key) : null;
  const review = requireReview(live === null ? context.state : settleClaims(context.state, unit.key, live, context.worktree).state);
  const editing = scratch === null ? null : { snapshotCommand: context.snapshotCommand(join(scratch, snapshotsDirectoryName)), claimCommand: shared === null ? null : context.claims.command(unit.key, shared), unelevatedSandbox: context.unelevatedEditors };
  const survey = unit.phase === 'survey' ? context.survey() : null;
  const commitMessages = unit.phase === 'triage' ? context.commitMessages() : null;
  const documentation = unit.phase === 'documentation' ? context.documentation() : null;
  const prompt = composeWorkerPrompt(role.prompt, { role: unit.role, phase: unit.phase, unitKey: unit.key, task: taskFor(unit, review, { editing, evidence: context.evidence, survey, commitMessages, documentation }) }, context.scopeBlock(unit.phase));
  return {
    runtime: context.configuration.runtime,
    executable: context.configuration.executable,
    executableArgs: [...context.configuration.executableArgs],
    model: policy.model,
    effort: policy.effort,
    access: scratch === null ? 'read-only' : 'edit',
    shell: true,
    prompt,
    outputSchema: comparesWithBase(review, unit.phase) ? repairOutputSchema : outputSchemaOf(unit.role),
    timeoutMs: policy.timeoutMs,
    ...(policy.budgetUsd === null ? {} : { budgetUsd: policy.budgetUsd }),
    ...(scratch === null ? {} : { scratch }),
    ...(shared === null ? {} : { shared }),
    label: unitLabel(unit.role, unit.phase, unit.key),
  };
}

/** The failed attempt a unit records for a receipt or a refused answer, the unit's own fault, or for a unit that ran while its claims directory was removed, the environment's (R12 of commit series integrity). */
function failed(unit: Unit, receipt: WorkerReceipt, reason: string, fault: AttemptFault): NewEvent {
  return { kind: 'attempt.failed', version: writtenVersion('attempt.failed', [unit.phase], { fault }), payload: { phase: unit.phase, key: unit.key, workerId: receipt.workerId, reason: truncated(reason, maxRecordedTextLength), fault } };
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

/**
 * The decisions of a decider's answer, its indexes resolved to the ids of
 * the findings its task numbered: the finding each decides, and the finding
 * that supersedes one left as superseded. Each is parsed into its kind's
 * variant, whose parts `checkDecisions` has already held. They keep the
 * answer's order; the fold holds them in the ranking's.
 */
function recordedDecisions(output: DeciderOutput, findings: readonly ReportFinding[]): RecordedDecision[] {
  const idAt = (position: number): string => findings[position]!.finding.id;
  return output.decisions.map(({ index, leave, ...decided }) => recordedDecisionSchema.parse({
    id: idAt(index),
    ...decided,
    leave: leave === null ? null : { reason: leave.reason, supersededBy: leave.supersededBy === null ? null : idAt(leave.supersededBy) },
  }));
}

/** What recording a contribution needs: the answer context, for the survey what the invocation knew when it launched the surveyor, and whether a fixes-phase unit's claims directory was removed while it ran. */
export interface ContributionContext extends AnswerContext {
  readonly survey: () => SurveyInputs;
  readonly claimsLost: boolean;
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
  // A fixer that ran without its claims directory is not answered, whatever it returned: its edits are kept, and the failure is its environment's (R12 of commit series integrity).
  if (unit.phase === 'fixes' && context.claimsLost) return failedWithEdits(unit, receipt, 'the claims directory was removed while the unit ran', context, 'environment');
  // A worker a kill from outside ended with a kill mark is an interruption of its unit, as a lost one is (R4 of resumable runs), and one the provider's usage limit stopped is no fault of its unit's either (R14); every other failure is the unit's. A fixer's edits are kept in each case.
  if (receipt.outcome !== 'completed') return failedWithEdits(unit, receipt, `${receipt.outcome}: ${receipt.error ?? 'no reason recorded'}`, context, receipt.cause ?? 'unit');
  const review = requireReview(context.state);
  try {
    return isEditingPhase(unit.phase) ? fixAnswerEvents(unit, receipt, context) : [contributionEvent(unit, receipt, review, context)];
  } catch (error) {
    if (error instanceof StructuralCheckError) return failedWithEdits(unit, receipt, `structural check: ${error.message}`, context);
    throw error;
  }
}

/**
 * A failed attempt, for an editing unit preceded by the claims its settle
 * records (R3 of commit series integrity) and followed by the revisions of
 * what the attempt left (R20 of the fix pass), which the fold takes after
 * the failure.
 */
function failedWithEdits(unit: Unit, receipt: WorkerReceipt, reason: string, context: RevisionContext, fault: AttemptFault = 'unit'): NewEvent[] {
  const failure = failed(unit, receipt, reason, fault);
  if (!isEditingPhase(unit.phase)) return [failure];
  const attempt = attemptRevisionEvents(context, unit.phase, unit.key, receipt.workerId, reason, 'failed');
  return [...attempt.claims, failure, ...attempt.revisions];
}

/** The events a unit's contribution is recorded as, each kind with its own payload. */
type ContributionEvent =
  | { readonly kind: 'survey.recorded'; readonly version: 1; readonly payload: SurveyRecorded }
  | { readonly kind: 'candidates.recorded'; readonly version: 2; readonly payload: CandidatesRecorded }
  | { readonly kind: 'deduplication.recorded'; readonly version: 1; readonly payload: DeduplicationRecorded }
  | { readonly kind: 'verdicts.recorded'; readonly version: 1; readonly payload: VerdictsRecorded }
  | { readonly kind: 'ranking.recorded'; readonly version: 1; readonly payload: RankingRecorded }
  | { readonly kind: 'decisions.recorded'; readonly version: 1; readonly payload: DecisionsRecorded };

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
      const checked = checkSurveyAnswer(output, { worktree, lookup: worktreeLookup(worktree), setting: review.configuration.survey.userRules, fix: review.fix !== null, inputs: context.survey(), standing: standingSurvey(review) });
      return { kind: 'survey.recorded', version: 1, payload: { workerId: receipt.workerId, ...checked } };
    }
    case 'triage': {
      const output = receipt.output as TriageOutput;
      checkTriageLeads(output);
      const candidates = recordCandidates('triage', unit.key, output.candidates.map((candidate) => ({ ...candidate, angle: 'SCAN' as const })), state, worktree);
      return { kind: 'candidates.recorded', version: 2, payload: { phase: 'triage', key: unit.key, workerId: receipt.workerId, candidates, leads: orderedLeads(output.leads), change: normalizeTriageChange(output.change) } };
    }
    case 'finders': {
      const output = receipt.output as FinderOutput;
      const angle = unit.key as FinderAngle;
      const candidates = recordCandidates('finders', unit.key, output.candidates.map((candidate) => ({ ...candidate, angle })), state, worktree);
      return { kind: 'candidates.recorded', version: 2, payload: { phase: 'finders', key: unit.key, workerId: receipt.workerId, candidates, leads: null, change: null } };
    }
    case 'sweep': {
      const output = receipt.output as SweepOutput;
      const candidates = recordCandidates('sweep', unit.key, output.candidates, state, worktree);
      return { kind: 'candidates.recorded', version: 2, payload: { phase: 'sweep', key: unit.key, workerId: receipt.workerId, candidates, leads: null, change: null } };
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
    case 'decision': {
      const output = receipt.output as DeciderOutput;
      const findings = rankedFindings(review);
      checkDecisions(output, findings.length);
      return { kind: 'decisions.recorded', version: 1, payload: { workerId: receipt.workerId, decisions: recordedDecisions(output, findings) } };
    }
    case 'fixes':
    case 'documentation':
    case 'repair':
    case 'answer':
      throw new Error(`An answer of ${unit.phase} is recorded with the revisions it made, by fixAnswerEvents`);
    case 'baseline-checks':
    case 'checks':
    case 'base-checks':
    case 'repair-checks':
    case 'answer-checks':
    case 'report':
      throw new Error(`The ${unit.phase} phase has no worker`);
  }
}
