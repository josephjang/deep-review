import { z } from 'zod';
import { artifactReferenceSchema } from '../evidence/store.ts';
import {
  angleSchema,
  candidateIdSchema,
  candidatePhaseSchema,
  deduplicationPhaseSchema,
  finderAngleSchema,
  finderAngles,
  groupIdSchema,
  phaseOutcomeSchema,
  phaseSchema,
  recordedBlockerCodeSchema,
  severitySchema,
  unitKeySchema,
  verdictSchema,
  verificationPhaseSchema,
} from '../review/vocabulary.ts';
import { defineRegistry } from './registry.ts';

/** A run exists. Its first and only creation event; the run id is the ledger's, not the payload's. */
export const runCreatedV1 = z.strictObject({
  /** Absolute worktree the run was started from. Informational: the checkpoint is shared by every worktree. */
  worktree: z.string().min(1),
});

/** The run was closed by an operator and accepts no further events. */
export const runAbandonedV1 = z.strictObject({
  reason: z.string().min(1),
});

const commitId = z.string().regex(/^[0-9a-f]{40,64}$/);

/**
 * One state of one file. A blob is stored evidence; an oversized file is
 * recorded by hash and size only, and its key is `size`, not `bytes`, so it
 * is never mistaken for an artifact reference.
 */
export const frozenFileSchema = z.union([
  z.strictObject({ blob: artifactReferenceSchema }),
  z.strictObject({ oversized: z.strictObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative() }) }),
]);
export type FrozenFile = z.infer<typeof frozenFileSchema>;

export const scopeFileSchema = z.strictObject({
  /** Repository-relative, forward slashes, as git reports it. */
  path: z.string().min(1),
  status: z.enum(['added', 'modified', 'deleted']),
  symlink: z.boolean(),
  /** The file at base, or null when it did not exist there. */
  before: frozenFileSchema.nullable(),
  /** The file in the worktree at capture, or null when it does not exist. */
  after: frozenFileSchema.nullable(),
});
export type ScopeFile = z.infer<typeof scopeFileSchema>;

export const scopeRequestSchema = z.strictObject({
  ref: z.string().min(1).optional(),
  range: z.strictObject({ from: z.string().min(1), to: z.string().min(1), mergeBase: z.boolean() }).optional(),
  paths: z.array(z.string().min(1)),
});
export type ScopeRequest = z.infer<typeof scopeRequestSchema>;

export const scopeModeSchema = z.enum(['last-commit', 'worktree', 'ref', 'range']);
export type ScopeMode = z.infer<typeof scopeModeSchema>;

/** The change a run reviews: how it was named, what it spans, and every file's frozen before and after. */
export const scopeCapturedV1 = z.strictObject({
  mode: scopeModeSchema,
  request: scopeRequestSchema,
  /** Commit or empty tree the change is measured from. */
  base: commitId,
  /** HEAD at capture; the after bytes are the worktree's at that moment. */
  head: commitId,
  files: z.array(scopeFileSchema).max(2000),
  /** The unified patch, base to worktree, plus one diff per untracked file. */
  patch: artifactReferenceSchema,
});
export type ScopeState = z.infer<typeof scopeCapturedV1>;

/**
 * How hard a worker's model thinks. Every level a runtime can take; an
 * adapter declares which of them it has. This is the runtime contract's
 * enum and may grow; `worker.launched@1` records its own frozen copy.
 */
export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof effortSchema>;

/**
 * What a worker may do to the reviewed tree: read it, or also edit it. The
 * runtime contract's enum, like `effortSchema`; `worker.launched@1` records
 * its own frozen copy.
 */
export const accessSchema = z.enum(['read-only', 'edit']);
export type Access = z.infer<typeof accessSchema>;

/** One tool call the runtime refused: the tool, and its command or path when the runtime reports one. */
export const deniedToolSchema = z.strictObject({
  tool: z.string().min(1),
  detail: z.string().nullable(),
});
export type DeniedTool = z.infer<typeof deniedToolSchema>;

/**
 * A session id as the runtimes print them: a UUID for Claude Code and Codex.
 * Kept to a conservative alphabet rather than a UUID so a third runtime's ids
 * fit, and it never starts with a dash, so it cannot be read as an option.
 */
export const sessionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/, 'must be a session id');

/**
 * A worker is about to be spawned (TD12). Written before the process exists,
 * so a worker that never answers is still on the ledger with the session its
 * transcript is under, whenever the runtime lets the engine choose it.
 *
 * The effort and access enums are written out here rather than taken from
 * `effortSchema` and `accessSchema`: those belong to the runtime contract and
 * may change, and this version's shape must not change with them. A contract
 * value this version cannot hold fails to typecheck where the launcher builds
 * the launch, which is the signal to add `worker.launched@2`.
 */
export const workerLaunchedV1 = z.strictObject({
  workerId: z.uuid(),
  /** Free text from the caller; the role element gives it meaning. */
  label: z.string().min(1).nullable(),
  runtime: z.string().min(1),
  executable: z.string().min(1),
  executableArgs: z.array(z.string()),
  /** The version the preflight observed at this launch. */
  version: z.string().min(1),
  model: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  access: z.enum(['read-only', 'edit']),
  shell: z.boolean(),
  /** The session the worker runs under when known before launch: pinned, or the one it continues. */
  sessionId: sessionIdSchema.nullable(),
  /** The session this worker continues, or null for a fresh worker (R9). When set, `sessionId` is the same session. */
  resumes: sessionIdSchema.nullable(),
  /** The directory the worker may write temporary files to, or null when the runtime cannot allow it. */
  scratch: z.string().min(1).nullable(),
  budgetUsd: z.number().positive().nullable(),
  timeoutMs: z.number().int().positive(),
  /** The bytes sent on stdin, including the scratch note. */
  prompt: artifactReferenceSchema,
  /** The compiled draft-07 output schema, exactly as the runtime received it. */
  schema: artifactReferenceSchema,
}).refine((launch) => launch.resumes === null || launch.sessionId === launch.resumes, {
  message: 'a continuation runs under the session it resumes, so sessionId must equal resumes',
  path: ['sessionId'],
});
export type WorkerLaunch = z.infer<typeof workerLaunchedV1>;

export const workerOutcomeSchema = z.enum(['completed', 'budget', 'timeout', 'failed']);
export type WorkerOutcome = z.infer<typeof workerOutcomeSchema>;

/**
 * A launched worker is over, whatever became of it (TD5). The process, the
 * runtime's own report, the refused tool calls and the validated answer
 * are separate fields, and every byte exchanged is evidence (R6).
 */
export const workerFinishedV1 = z.strictObject({
  workerId: z.uuid(),
  outcome: workerOutcomeSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().min(1).nullable(),
  /** `exited` on its own, `killed` by the launcher at the timeout, or `not-started` when the spawn failed. */
  termination: z.enum(['exited', 'killed', 'not-started']),
  /** Wall-clock start and end of the process, so a suspended machine's gap is visible later. */
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  sessionIds: z.array(sessionIdSchema),
  /**
   * Usage as the runtime reported it, as JSON text. Text rather than a JSON
   * value, so nothing the runtime prints can be mistaken for an artifact
   * reference and verified as one.
   */
  usage: z.string().nullable(),
  /** Refused tool calls, or null when the runtime gives no evidence either way. */
  denials: z.array(deniedToolSchema).nullable(),
  error: z.string().min(1).nullable(),
  stdout: artifactReferenceSchema,
  stderr: artifactReferenceSchema,
  /** The runtime's separate final answer file, for a runtime that writes one and did. */
  finalMessage: artifactReferenceSchema.nullable(),
  /** The validated answer as JSON, present exactly when the outcome is `completed`. */
  output: artifactReferenceSchema.nullable(),
}).refine((finish) => (finish.outcome === 'completed') === (finish.output !== null), {
  message: 'output is present exactly when the outcome is completed',
  path: ['output'],
});
export type WorkerFinish = z.infer<typeof workerFinishedV1>;

/**
 * A worker that was running when the engine that launched it stopped
 * (TD5 of the read-only review). The resuming engine cannot know what its
 * process did, so nothing is finished; the worker is lost, and its unit
 * counts one more failed attempt. The unit is read from the launch label
 * the review controller writes; a worker whose label names no unit is lost
 * without one.
 */
export const workerLostV1 = z.strictObject({
  workerId: z.uuid(),
  phase: phaseSchema.nullable(),
  key: unitKeySchema.nullable(),
  reason: z.string().min(1).max(1000),
}).refine((lost) => (lost.phase === null) === (lost.key === null), {
  message: 'a lost worker names both its phase and its unit key, or neither',
  path: ['key'],
});
export type WorkerLost = z.infer<typeof workerLostV1>;

/** One role as the run pinned it: the model and effort it runs with, its per-worker budget (null on a runtime without a budget cap) and timeout. */
export const pinnedRoleSchema = z.strictObject({
  role: z.string().regex(/^[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)*$/),
  model: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  budgetUsd: z.number().positive().nullable(),
  timeoutMs: z.number().int().positive(),
});
export type PinnedRole = z.infer<typeof pinnedRoleSchema>;

/**
 * The policy as resolved for the run (R3), written once before the first
 * worker. A resumed run reads it from here and ignores the policy file and
 * the model flags; only the concurrency and the run budget are per
 * invocation, and the values here are the ones in force at the start.
 */
export const reviewConfiguredV1 = z.strictObject({
  runtime: z.string().min(1),
  executable: z.string().min(1),
  executableArgs: z.array(z.string()),
  /** The runtime version the preflight observed before the run was created. */
  version: z.string().min(1),
  models: z.strictObject({ strong: z.string().min(1), fast: z.string().min(1) }),
  roles: z.array(pinnedRoleSchema).min(1),
  /** SHA-256 over the sorted `roleKey:sha256` lines of the assembled roles, so the run says which prompts it ran. */
  rolesDigest: z.string().regex(/^[a-f0-9]{64}$/),
  concurrency: z.number().int().min(1).max(16),
  /** The run budget in US dollars, or null when there is none or the runtime reports no cost. */
  runBudgetUsd: z.number().positive().nullable(),
});
export type ReviewConfiguration = z.infer<typeof reviewConfiguredV1>;

/** A phase begins, or a resumed engine re-enters a phase that was running or blocked; the attempt counts both. */
export const phaseStartedV1 = z.strictObject({
  phase: phaseSchema,
  attempt: z.number().int().min(1),
});
export type PhaseStarted = z.infer<typeof phaseStartedV1>;

/** Why a run is blocked and what the operator does about it (R5). */
export const blockerSchema = z.strictObject({
  code: recordedBlockerCodeSchema,
  detail: z.string().min(1).max(4000),
  action: z.string().min(1).max(1000),
});
export type Blocker = z.infer<typeof blockerSchema>;

/** A phase ends: every unit answered, some unit degraded by its role's rule, or the run blocked, with the blocker. */
export const phaseFinishedV1 = z.strictObject({
  phase: phaseSchema,
  attempt: z.number().int().min(1),
  outcome: phaseOutcomeSchema,
  blocker: blockerSchema.nullable(),
}).refine((finish) => (finish.outcome === 'blocked') === (finish.blocker !== null), {
  message: 'a blocker is present exactly when the outcome is blocked',
  path: ['blocker'],
});
export type PhaseFinished = z.infer<typeof phaseFinishedV1>;

/** The worktree was compared with the captured scope before a phase's work (R7); only the files that differ are listed. */
export const worktreeCheckedV1 = z.strictObject({
  phase: phaseSchema,
  attempt: z.number().int().min(1),
  drifted: z.boolean(),
  files: z.array(z.strictObject({ path: z.string().min(1), outcome: z.enum(['modified', 'deleted', 'restored']) })).max(2000),
}).refine((check) => check.drifted === (check.files.length > 0), {
  message: 'drifted exactly when some file differs',
  path: ['drifted'],
});
export type WorktreeCheck = z.infer<typeof worktreeCheckedV1>;

/**
 * One candidate as the engine recorded it (R8): its engine-assigned id, the
 * angle it belongs to, the scope path and line when the finder's location
 * matched the scope, and always the finder's own file and line.
 */
export const recordedCandidateSchema = z.strictObject({
  id: candidateIdSchema,
  angle: angleSchema,
  /** The scope path the candidate was matched to, or null when unlocated. */
  file: z.string().min(1).nullable(),
  /** The line, within the file's after state, or null when unlocated. */
  line: z.number().int().min(1).nullable(),
  located: z.boolean(),
  rawFile: z.string().min(1).max(1000),
  rawLine: z.number().int().min(1),
  summary: z.string().min(1).max(400),
  /** The fourth field of the finder output contract: a `failure_scenario` or a `value_statement`, as the angle decides. */
  detail: z.string().min(1).max(2000),
}).refine((candidate) => candidate.located === (candidate.file !== null && candidate.line !== null), {
  message: 'a located candidate has a scope file and a line; an unlocated one has neither',
  path: ['located'],
});
export type RecordedCandidate = z.infer<typeof recordedCandidateSchema>;

/** One lead the triage returned for a finder angle: a file, symbol or mechanism to inspect first, or null when the diff supports none. */
export const leadSchema = z.strictObject({
  angle: finderAngleSchema,
  lead: z.string().min(1).max(1000).nullable(),
});
export type Lead = z.infer<typeof leadSchema>;

/**
 * A triage, finder or sweep worker's answer, with ids assigned. The unit
 * key is `SCAN` for the triage, the angle for a finder and `sweep` for the
 * sweep; the triage alone carries one lead per finder angle.
 */
export const candidatesRecordedV1 = z.strictObject({
  phase: candidatePhaseSchema,
  key: unitKeySchema,
  workerId: z.uuid(),
  candidates: z.array(recordedCandidateSchema).max(12),
  leads: z.array(leadSchema).length(finderAngles.length).nullable(),
}).superRefine((recorded, context) => {
  if ((recorded.phase === 'triage') !== (recorded.leads !== null)) context.addIssue({ code: 'custom', message: 'the triage alone returns leads', path: ['leads'] });
  if (recorded.leads !== null && new Set(recorded.leads.map((lead) => lead.angle)).size !== finderAngles.length) {
    context.addIssue({ code: 'custom', message: 'one lead per finder angle', path: ['leads'] });
  }
  if (new Set(recorded.candidates.map((candidate) => candidate.id)).size !== recorded.candidates.length) context.addIssue({ code: 'custom', message: 'candidate ids are unique', path: ['candidates'] });
});
export type CandidatesRecorded = z.infer<typeof candidatesRecordedV1>;

/** A unit's worker did not contribute: it failed, timed out, hit its budget, or answered something the structural checks refused (R5). */
export const attemptFailedV1 = z.strictObject({
  phase: phaseSchema,
  key: unitKeySchema,
  workerId: z.uuid(),
  reason: z.string().min(1).max(4000),
});
export type AttemptFailed = z.infer<typeof attemptFailedV1>;

/** A finder angle failed twice and is not run in this review; the report says so and the sweep is told (R5). */
export const angleFailedV1 = z.strictObject({
  angle: finderAngleSchema,
  reason: z.string().min(1).max(4000),
});
export type AngleFailed = z.infer<typeof angleFailedV1>;

/** The deduplication worker's groups, by candidate id: the members of each describe one defect, and `keep` is the one that stays on the working list. */
export const deduplicationRecordedV1 = z.strictObject({
  phase: deduplicationPhaseSchema,
  workerId: z.uuid(),
  groups: z.array(z.strictObject({
    members: z.array(candidateIdSchema).min(2),
    keep: candidateIdSchema,
    reason: z.string().min(1).max(1000),
  }).refine((group) => group.members.includes(group.keep), { message: 'the kept candidate is a member', path: ['keep'] })),
});
export type DeduplicationRecorded = z.infer<typeof deduplicationRecordedV1>;

/** The groups a verification phase verifies, planned once so a later engine resumes the plan this run made (TD7). */
export const verificationPlannedV1 = z.strictObject({
  phase: verificationPhaseSchema,
  groups: z.array(z.strictObject({ id: groupIdSchema, candidateIds: z.array(candidateIdSchema).min(1) })),
});
export type VerificationPlanned = z.infer<typeof verificationPlannedV1>;

/** One verifier's verdicts, one per candidate of its group, each with the evidence line. */
export const verdictsRecordedV1 = z.strictObject({
  phase: verificationPhaseSchema,
  groupId: groupIdSchema,
  workerId: z.uuid(),
  verdicts: z.array(z.strictObject({ id: candidateIdSchema, verdict: verdictSchema, evidence: z.string().min(1).max(1000) })).min(1),
});
export type VerdictsRecorded = z.infer<typeof verdictsRecordedV1>;

/** A group's verifier failed twice; its candidates carry `PLAUSIBLE` with the `unverified` mark (R5). */
export const groupUnverifiedV1 = z.strictObject({
  phase: verificationPhaseSchema,
  groupId: groupIdSchema,
  reason: z.string().min(1).max(4000),
});
export type GroupUnverified = z.infer<typeof groupUnverifiedV1>;

/** One finding after merge and rank: the primary candidate, the candidates merged into it, and the severity the worker judged. */
export const rankedFindingSchema = z.strictObject({
  id: candidateIdSchema,
  members: z.array(candidateIdSchema),
  severity: severitySchema,
  summary: z.string().min(1).max(400),
  reason: z.string().min(1).max(2000),
});
export type RankedFinding = z.infer<typeof rankedFindingSchema>;

/** The merge and rank worker's findings, in the engine's order (TD9). */
export const rankingRecordedV1 = z.strictObject({
  workerId: z.uuid(),
  findings: z.array(rankedFindingSchema).min(1),
});
export type RankingRecorded = z.infer<typeof rankingRecordedV1>;

/** What one phase, or the whole run, spent: workers finished, wall seconds, and the usage summed where every worker reported it. */
export const spendSchema = z.strictObject({
  workers: z.number().int().nonnegative(),
  seconds: z.number().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
});
export type Spend = z.infer<typeof spendSchema>;

/** The report is written (R9): the Markdown in the evidence store, and the statistics its Statistics section prints. */
export const reportWrittenV1 = z.strictObject({
  report: artifactReferenceSchema,
  statistics: z.strictObject({
    phases: z.array(spendSchema.extend({ phase: phaseSchema })),
    total: spendSchema,
    /** Whether the run budget applied: false on a runtime that reports no cost. */
    budgetApplied: z.boolean(),
  }),
});
export type ReportWritten = z.infer<typeof reportWrittenV1>;

/** Every event kind this engine can write or read. Later elements add theirs here. */
export const eventRegistry = defineRegistry({
  'run.created': { 1: { schema: runCreatedV1 } },
  'run.abandoned': { 1: { schema: runAbandonedV1 } },
  'scope.captured': { 1: { schema: scopeCapturedV1 } },
  'worker.launched': { 1: { schema: workerLaunchedV1 } },
  'worker.finished': { 1: { schema: workerFinishedV1 } },
  'worker.lost': { 1: { schema: workerLostV1 } },
  'review.configured': { 1: { schema: reviewConfiguredV1 } },
  'phase.started': { 1: { schema: phaseStartedV1 } },
  'phase.finished': { 1: { schema: phaseFinishedV1 } },
  'worktree.checked': { 1: { schema: worktreeCheckedV1 } },
  'candidates.recorded': { 1: { schema: candidatesRecordedV1 } },
  'attempt.failed': { 1: { schema: attemptFailedV1 } },
  'angle.failed': { 1: { schema: angleFailedV1 } },
  'deduplication.recorded': { 1: { schema: deduplicationRecordedV1 } },
  'verification.planned': { 1: { schema: verificationPlannedV1 } },
  'verdicts.recorded': { 1: { schema: verdictsRecordedV1 } },
  'group.unverified': { 1: { schema: groupUnverifiedV1 } },
  'ranking.recorded': { 1: { schema: rankingRecordedV1 } },
  'report.written': { 1: { schema: reportWrittenV1 } },
});

export type EventRegistry = typeof eventRegistry;
