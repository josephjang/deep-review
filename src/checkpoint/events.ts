import { z } from 'zod';
import { artifactReferenceSchema } from '../evidence/store.ts';
import { defineRegistry } from './registry.ts';

/**
 * The review vocabulary as version 1 of the review events records it (R10
 * of the read-only review): the angles, phases, outcomes, blocker codes,
 * verdicts and severities, and the spelling of candidate ids, group ids and
 * unit keys.
 *
 * Written out here rather than taken from `review/vocabulary.ts`, as
 * `worker.launched@1` writes out its enums: the vocabulary may change, and
 * a version's shape must not change with it, or a newer engine would
 * refuse an older ledger (a tenth finder angle, say, would make every
 * `candidates.recorded@1` with nine leads fail to decode). A test holds
 * these equal to today's vocabulary, so a change there fails until the
 * events that carry the changed words get a new version.
 */
export const reviewVocabularyV1 = {
  angles: ['SCAN', 'REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'],
  finderAngles: ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'],
  phases: ['triage', 'finders', 'deduplication', 'verification', 'sweep', 'sweep-deduplication', 'sweep-verification', 'merge-rank', 'report'],
  candidatePhases: ['triage', 'finders', 'sweep'],
  deduplicationPhases: ['deduplication', 'sweep-deduplication'],
  verificationPhases: ['verification', 'sweep-verification'],
  phaseOutcomes: ['completed', 'degraded', 'blocked'],
  recordedBlockerCodes: ['worker-failed', 'budget', 'drift'],
  verdicts: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'],
  severities: ['critical', 'major', 'minor'],
} as const;

const vocabulary = reviewVocabularyV1;
const angleSchema = z.enum(vocabulary.angles);
const finderAngleSchema = z.enum(vocabulary.finderAngles);
const phaseSchema = z.enum(vocabulary.phases);
const candidatePhaseSchema = z.enum(vocabulary.candidatePhases);
const deduplicationPhaseSchema = z.enum(vocabulary.deduplicationPhases);
const verificationPhaseSchema = z.enum(vocabulary.verificationPhases);
const phaseOutcomeSchema = z.enum(vocabulary.phaseOutcomes);
const recordedBlockerCodeSchema = z.enum(vocabulary.recordedBlockerCodes);
const verdictSchema = z.enum(vocabulary.verdicts);
const severitySchema = z.enum(vocabulary.severities);

/** The identifier spellings version 1 of the review events records, frozen for the same reason as the enums above. */
export const reviewIdentifiersV1 = {
  candidateId: z.string().regex(/^[A-Z]+-[1-9][0-9]*$/, 'a candidate id is an upper-case prefix, a dash and a number from 1'),
  groupId: z.string().regex(/^g[1-9][0-9]*$/, 'a group id is g and a number from 1'),
  unitKey: z.string().regex(/^[A-Za-z0-9-]{1,40}$/, 'a unit key is letters, digits and dashes'),
} as const;
const candidateIdSchema = reviewIdentifiersV1.candidateId;
const groupIdSchema = reviewIdentifiersV1.groupId;
const unitKeySchema = reviewIdentifiersV1.unitKey;

/**
 * The longest reason or detail version 1 of the review events records: a
 * failed attempt's reason, an angle not run, a group unverified and a
 * blocker's detail. Frozen here for the same reason as the vocabulary
 * above; the engine cuts the text it composes to `maxRecordedTextLength`,
 * which a test holds equal to it.
 */
export const recordedTextLengthV1 = 4000;
const recordedTextSchema = z.string().min(1).max(recordedTextLengthV1);

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
 * `limits.changed` records every later change to them.
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
export type ReviewConfigurationV1 = z.infer<typeof reviewConfiguredV1>;

/**
 * The concurrency and the run budget in force from here on (R6), written
 * when an invocation of a resumed run puts different ones in force than
 * the run had: its `--concurrency` or `--budget-usd`, or, without them, the
 * pinned values again. Both are recorded whole, so the fold replaces the
 * limits in force and the planner, `status` and the report read them from
 * one place. The run budget is null when there is none.
 */
export const limitsChangedV1 = z.strictObject({
  concurrency: z.number().int().min(1).max(16),
  runBudgetUsd: z.number().positive().nullable(),
});
export type ReviewLimits = z.infer<typeof limitsChangedV1>;

/** A phase begins, or a resumed engine re-enters a phase that was running or blocked; the attempt counts both. */
export const phaseStartedV1 = z.strictObject({
  phase: phaseSchema,
  attempt: z.number().int().min(1),
});
export type PhaseStarted = z.infer<typeof phaseStartedV1>;

/** Why a run is blocked and what the operator does about it (R5). */
export const blockerSchema = z.strictObject({
  code: recordedBlockerCodeSchema,
  detail: recordedTextSchema,
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
export type WorktreeCheckV1 = z.infer<typeof worktreeCheckedV1>;

/**
 * One candidate as the engine recorded it (R8): its engine-assigned id, the
 * angle it belongs to, the canonical repository path and checked line when
 * the finder's location names a file of the repository with such a line,
 * whether that file is a changed path of the scope, and always the finder's
 * own file and line.
 */
export const recordedCandidateSchema = z.strictObject({
  id: candidateIdSchema,
  angle: angleSchema,
  /**
   * The canonical repository path the candidate was matched to: a changed
   * path of the scope, or the worktree's own spelling of an unchanged file;
   * null when unlocated.
   */
  file: z.string().min(1).nullable(),
  /** The line, within a changed file's after state or an unchanged file's worktree bytes, or null when unlocated. */
  line: z.number().int().min(1).nullable(),
  located: z.boolean(),
  /** Whether `file` is a changed path of the scope; false for a candidate on an unchanged file, and for an unlocated one. */
  inScope: z.boolean(),
  rawFile: z.string().min(1).max(1000),
  rawLine: z.number().int().min(1),
  summary: z.string().min(1).max(400),
  /** The fourth field of the finder output contract: a `failure_scenario` or a `value_statement`, as the angle decides. */
  detail: z.string().min(1).max(2000),
}).superRefine((candidate, context) => {
  if (candidate.located !== (candidate.file !== null && candidate.line !== null)) {
    context.addIssue({ code: 'custom', message: 'a located candidate has a file and a line; an unlocated one has neither', path: ['located'] });
  }
  if (candidate.inScope && !candidate.located) context.addIssue({ code: 'custom', message: 'a candidate in the change is located', path: ['inScope'] });
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
  leads: z.array(leadSchema).length(vocabulary.finderAngles.length).nullable(),
}).superRefine((recorded, context) => {
  if ((recorded.phase === 'triage') !== (recorded.leads !== null)) context.addIssue({ code: 'custom', message: 'the triage alone returns leads', path: ['leads'] });
  if (recorded.leads !== null && new Set(recorded.leads.map((lead) => lead.angle)).size !== vocabulary.finderAngles.length) {
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
  reason: recordedTextSchema,
});
export type AttemptFailed = z.infer<typeof attemptFailedV1>;

/** A finder angle failed twice and is not run in this review; the report says so and the sweep is told (R5). */
export const angleFailedV1 = z.strictObject({
  angle: finderAngleSchema,
  reason: recordedTextSchema,
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
  reason: recordedTextSchema,
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

/**
 * What one phase, or the whole run, spent: the workers finished; the wall
 * seconds they ran, the length of the union of their process intervals, so
 * concurrent workers count once; and each usage figure summed over the
 * workers that reported it, or null when none did.
 */
export const spendSchema = z.strictObject({
  workers: z.number().int().nonnegative(),
  seconds: z.number().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  /**
   * How many workers spent money `costUsd` leaves out: finished without
   * reporting a cost (timed out, or failed after its process started but
   * before the runtime printed its usage) or lost. A worker whose process
   * never started spent nothing and is not counted. Null on a runtime that
   * reports no cost in USD at all.
   */
  costUnreported: z.number().int().nonnegative().nullable(),
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
export type ReportWrittenV1 = z.infer<typeof reportWrittenV1>;

/**
 * The vocabulary version 2 of the review events records, and version 1 of
 * the fix pass's events (R1, R5, R9 of the fix pass): the fourteen phases,
 * with the five of the fix pass before the report, and the words the fix
 * pass's events carry. Frozen here for the reason `reviewVocabularyV1`
 * is: a test holds it equal to today's vocabulary, so a later change to
 * these words needs new versions of the events that carry them.
 */
export const reviewVocabularyV2 = {
  phases: [
    'triage', 'finders', 'deduplication', 'verification', 'sweep', 'sweep-deduplication', 'sweep-verification', 'merge-rank',
    'baseline-checks', 'fixes', 'checks', 'repair', 'repair-checks',
    'report',
  ],
  checkPhases: ['baseline-checks', 'checks', 'repair-checks'],
  editingPhases: ['fixes', 'repair'],
  phaseOutcomes: ['completed', 'degraded', 'blocked'],
  recordedBlockerCodes: ['worker-failed', 'budget', 'drift'],
  checkKinds: ['build', 'typecheck', 'lint', 'test'],
  checkOrigins: ['flag', 'taskfile', 'makefile', 'justfile', 'package', 'language', 'none'],
  checkOutcomes: ['passed', 'failed', 'timeout', 'not-started', 'skipped'],
  fixStatuses: ['applied', 'already-applied', 'deferred', 'blocked'],
  validationMethods: ['old-code', 'mutation', 'static', 'existing', 'limited'],
  suiteResults: ['pass', 'fail', 'not-run'],
} as const;

/** The identifier spellings the fix pass's events record, frozen for the same reason. */
export const reviewIdentifiersV2 = {
  clusterId: z.string().regex(/^c[1-9][0-9]*$/, 'a cluster id is c and a number from 1'),
  repairKey: z.literal('repair'),
} as const;

const vocabularyV2 = reviewVocabularyV2;
const phaseSchemaV2 = z.enum(vocabularyV2.phases);
const checkPhaseSchemaV2 = z.enum(vocabularyV2.checkPhases);
const editingPhaseSchemaV2 = z.enum(vocabularyV2.editingPhases);
const checkKindSchemaV2 = z.enum(vocabularyV2.checkKinds);
const clusterIdSchemaV2 = reviewIdentifiersV2.clusterId;

/** The blocker of version 2 of `phase.finished`: the recorded codes, which the wider phase list did not change. */
const blockerSchemaV2 = z.strictObject({
  code: z.enum(vocabularyV2.recordedBlockerCodes),
  detail: recordedTextSchema,
  action: z.string().min(1).max(1000),
});

/**
 * `review.configured` with the fix pass: whether the run fixes, and the
 * per-check timeout and fixer batch size it pinned, each present exactly
 * when it fixes (R1, R12, R18 of the fix pass).
 */
export const reviewConfiguredV2 = z.strictObject({
  ...reviewConfiguredV1.shape,
  fix: z.boolean(),
  checks: z.strictObject({ timeoutMs: z.number().int().positive() }).nullable(),
  fixes: z.strictObject({ batchSize: z.number().int().min(1).max(20) }).nullable(),
}).refine((configuration) => configuration.fix === (configuration.checks !== null), {
  message: 'the checks are pinned exactly when the run fixes',
  path: ['checks'],
}).refine((configuration) => configuration.fix === (configuration.fixes !== null), {
  message: 'the batch size is pinned exactly when the run fixes',
  path: ['fixes'],
});
export type ReviewConfigurationV2 = z.infer<typeof reviewConfiguredV2>;
/** The configuration as the fold holds it, whichever version recorded it: version 1 reads as a run without the fix pass. */
export type ReviewConfiguration = ReviewConfigurationV2;

/** `phase.started` over the fourteen phases. */
export const phaseStartedV2 = z.strictObject({
  phase: phaseSchemaV2,
  attempt: z.number().int().min(1),
});

/** `phase.finished` over the fourteen phases. */
export const phaseFinishedV2 = z.strictObject({
  phase: phaseSchemaV2,
  attempt: z.number().int().min(1),
  outcome: z.enum(vocabularyV2.phaseOutcomes),
  blocker: blockerSchemaV2.nullable(),
}).refine((finish) => (finish.outcome === 'blocked') === (finish.blocker !== null), {
  message: 'a blocker is present exactly when the outcome is blocked',
  path: ['blocker'],
});

/**
 * The worktree compared with what the run expects (R7 of the fix pass):
 * when in the attempt, each expected file that differs with the state the
 * run expected there (null where it expected nothing), `HEAD` when it
 * moved from the scope's head, and the untracked files the run does not
 * expect, listed and never counted as drift.
 */
export const worktreeCheckedV2 = z.strictObject({
  phase: phaseSchemaV2,
  attempt: z.number().int().min(1),
  /** At the attempt's start, before an answer is recorded, or once an editing phase's last unit settled. */
  moment: z.enum(['start', 'answer', 'end']),
  drifted: z.boolean(),
  head: z.strictObject({ expected: commitId, actual: commitId }).nullable(),
  files: z.array(z.strictObject({ path: z.string().min(1), outcome: z.enum(['modified', 'deleted', 'restored']), expected: frozenFileSchema.nullable() })).max(2000),
  strays: z.array(z.string().min(1)).max(2000),
}).refine((check) => check.drifted === (check.files.length > 0 || check.head !== null), {
  message: 'drifted exactly when some file differs or HEAD moved',
  path: ['drifted'],
});
export type WorktreeCheckV2 = z.infer<typeof worktreeCheckedV2>;

/** `attempt.failed` over the fourteen phases. */
export const attemptFailedV2 = z.strictObject({
  phase: phaseSchemaV2,
  key: unitKeySchema,
  workerId: z.uuid(),
  reason: recordedTextSchema,
});

/** `worker.lost` over the fourteen phases. */
export const workerLostV2 = z.strictObject({
  workerId: z.uuid(),
  phase: phaseSchemaV2.nullable(),
  key: unitKeySchema.nullable(),
  reason: z.string().min(1).max(1000),
}).refine((lost) => (lost.phase === null) === (lost.key === null), {
  message: 'a lost worker names both its phase and its unit key, or neither',
  path: ['key'],
});

/** `report.written` over the fourteen phases, with the patch series: one patch per revision in ledger order, empty for a run that changed nothing (R13 of the fix pass). */
export const reportWrittenV2 = z.strictObject({
  report: artifactReferenceSchema,
  statistics: z.strictObject({
    phases: z.array(spendSchema.extend({ phase: phaseSchemaV2 })),
    total: spendSchema,
    budgetApplied: z.boolean(),
  }),
  patches: z.array(artifactReferenceSchema).max(2000),
});
export type ReportWrittenV2 = z.infer<typeof reportWrittenV2>;
/** The report as the fold holds it: version 1 reads as a report with no patch. */
export type ReportWritten = ReportWrittenV2;

/** The routes of every ranked finding and the clusters of the fixer-routed ones, planned once at the fixes phase's first attempt (R2, R3 of the fix pass). */
export const fixesPlannedV1 = z.strictObject({
  routes: z.array(z.strictObject({ id: candidateIdSchema, route: z.enum(['fixer', 'held']) })),
  clusters: z.array(z.strictObject({
    id: clusterIdSchemaV2,
    findingIds: z.array(candidateIdSchema).min(1),
    files: z.array(z.string().min(1)),
  })),
});
export type FixesPlanned = z.infer<typeof fixesPlannedV1>;

/** One kind's check as the run pinned it: its command, or null with the reason none runs. */
export const plannedCheckSchema = z.strictObject({
  kind: checkKindSchemaV2,
  command: z.string().min(1).nullable(),
  origin: z.enum(vocabularyV2.checkOrigins),
  reason: z.string().min(1).max(1000).nullable(),
}).refine((check) => (check.command === null) === (check.reason !== null), {
  message: 'a reason is given exactly when the kind has no command',
  path: ['reason'],
});

/** The checks the run pinned, one per kind in the order they run, with the package manager a script runs through (R8 of the fix pass). */
export const checksPlannedV1 = z.strictObject({
  checks: z.array(plannedCheckSchema).length(vocabularyV2.checkKinds.length),
  manager: z.string().min(1).nullable(),
}).refine((planned) => planned.checks.every((check, index) => check.kind === vocabularyV2.checkKinds[index]), {
  message: 'one check per kind, in the order the kinds run',
  path: ['checks'],
});
export type ChecksPlanned = z.infer<typeof checksPlannedV1>;

/**
 * One check as it ran, or as it was skipped because `build` did not pass
 * (R9, R10 of the fix pass). A skipped check never had a process: it
 * records no termination, exit or output, and its reason as `error`.
 */
export const checkRanV1 = z.strictObject({
  phase: checkPhaseSchemaV2,
  attempt: z.number().int().min(1),
  kind: checkKindSchemaV2,
  command: z.string().min(1),
  outcome: z.enum(vocabularyV2.checkOutcomes),
  exitCode: z.number().int().nullable(),
  signal: z.string().min(1).nullable(),
  termination: z.enum(['exited', 'killed', 'not-started']).nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  stdout: artifactReferenceSchema.nullable(),
  stderr: artifactReferenceSchema.nullable(),
  error: z.string().min(1).max(recordedTextLengthV1).nullable(),
}).superRefine((check, context) => {
  const skipped = check.outcome === 'skipped';
  if (skipped !== (check.termination === null) || skipped !== (check.stdout === null) || skipped !== (check.stderr === null)) {
    context.addIssue({ code: 'custom', message: 'a skipped check alone has no termination and no output', path: ['outcome'] });
  }
  if (skipped && check.error === null) context.addIssue({ code: 'custom', message: 'a skipped check records why', path: ['error'] });
  if (check.outcome === 'passed' && (check.termination !== 'exited' || check.exitCode !== 0)) context.addIssue({ code: 'custom', message: 'a passed check exited with code 0', path: ['outcome'] });
  if (check.outcome === 'timeout' && check.termination !== 'killed') context.addIssue({ code: 'custom', message: 'a check that timed out was killed', path: ['outcome'] });
  if (check.outcome === 'not-started' && check.termination !== 'not-started') context.addIssue({ code: 'custom', message: 'a check that did not start has the termination to say so', path: ['outcome'] });
});
export type CheckRan = z.infer<typeof checkRanV1>;

const commitMessageSchema = z.strictObject({ subject: z.string().min(1).max(200), body: z.string().max(4000) });

/** One finding (or, for the repair, one failing check) as a fixer answered it, its paths resolved to the worktree's spelling. */
export const fixedFindingSchema = z.strictObject({
  /** The finding's candidate id, or the check kind a repair answered. */
  id: z.string().min(1).max(40),
  status: z.enum(vocabularyV2.fixStatuses),
  file: z.string().min(1).max(1000),
  line: z.number().int().min(1).nullable(),
  note: z.string().min(1).max(400),
  message: commitMessageSchema.nullable(),
  files: z.array(z.string().min(1)).max(200),
  corrections: z.array(z.strictObject({ file: z.string().min(1), anchor: z.string().min(1), claim: z.string().min(1), fact: z.string().min(1), evidence: z.string().min(1) })).max(20),
  validation: z.array(z.strictObject({ method: z.enum(vocabularyV2.validationMethods), source: z.string().min(1), evidence: z.string().min(1) })).max(20),
  requiredFiles: z.array(z.string().min(1)).max(50),
});
export type FixedFinding = z.infer<typeof fixedFindingSchema>;

/** A fixer's or the repair worker's answer, as the engine recorded it, with the files another cluster owns that it reported (R5, PD4 of the fix pass). */
export const fixRecordedV1 = z.strictObject({
  phase: editingPhaseSchemaV2,
  key: unitKeySchema,
  workerId: z.uuid(),
  findings: z.array(fixedFindingSchema),
  drift: z.array(z.strictObject({ file: z.string().min(1), what: z.string().min(1) })).max(50),
  tests: z.array(z.strictObject({ file: z.string().min(1), covers: z.string().min(1) })).max(50),
  suite: z.strictObject({ result: z.enum(vocabularyV2.suiteResults), command: z.string(), failures: z.string() }),
  violations: z.array(z.string().min(1)),
}).refine((recorded) => new Set(recorded.findings.map((finding) => finding.id)).size === recorded.findings.length, {
  message: 'each finding is answered once',
  path: ['findings'],
});
export type FixRecorded = z.infer<typeof fixRecordedV1>;

/**
 * One path a revision changed: what it held before (null when nothing
 * was there) and whether that was a symlink, and what it became (null
 * when deleted) and whether that is one. For a path the run expected
 * nothing of before, the state before is what the scope's head commit
 * held there, so a revision of a file outside the change is a
 * modification of it, not a creation.
 */
export const revisedFileSchema = z.strictObject({
  path: z.string().min(1),
  status: z.enum(['created', 'modified', 'deleted']),
  before: frozenFileSchema.nullable(),
  beforeSymlink: z.boolean(),
  symlink: z.boolean(),
  after: frozenFileSchema.nullable(),
}).superRefine((file, context) => {
  if ((file.status === 'created') !== (file.before === null)) context.addIssue({ code: 'custom', message: 'a created file alone has no state before', path: ['before'] });
  if ((file.status === 'deleted') !== (file.after === null)) context.addIssue({ code: 'custom', message: 'a deleted file alone has no after state', path: ['after'] });
});

/**
 * One revision of the tree (R6, TD1, TD6 of the fix pass): the bytes one
 * finding's fix, one check's writes, or a failed cluster's partial edits
 * left in the paths it changed, with the message a commit of it carries.
 */
export const treeRevisedV1 = z.strictObject({
  phase: phaseSchemaV2,
  source: z.discriminatedUnion('kind', [
    /** A recorded answer's edits, for the findings `change` names. */
    z.strictObject({ kind: z.literal('fix'), key: unitKeySchema, workerId: z.uuid() }),
    /** A check's writes to files the run expected. */
    z.strictObject({ kind: z.literal('check'), check: checkKindSchemaV2 }),
    /** The edits the failed workers of a unit that degraded left in its owned files. */
    z.strictObject({ kind: z.literal('unanswered'), key: unitKeySchema }),
  ]),
  change: z.strictObject({ findings: z.array(z.string().min(1)), message: commitMessageSchema }),
  files: z.array(revisedFileSchema).min(1).max(2000),
}).superRefine((revision, context) => {
  if (new Set(revision.files.map((file) => file.path)).size !== revision.files.length) context.addIssue({ code: 'custom', message: 'each path is revised once', path: ['files'] });
  if ((revision.source.kind === 'fix') !== (revision.change.findings.length > 0)) context.addIssue({ code: 'custom', message: 'a fix revision alone names findings', path: ['change'] });
});
export type TreeRevised = z.infer<typeof treeRevisedV1>;

/** A unit of an editing phase failed twice: its findings are not attempted, and the phase degraded (R12 of the fix pass). */
export const clusterFailedV1 = z.strictObject({
  phase: editingPhaseSchemaV2,
  key: unitKeySchema,
  reason: recordedTextSchema,
});
export type ClusterFailed = z.infer<typeof clusterFailedV1>;

/** The commits `deep-review commit` built from a completed fix run, in order, and the head they were built on and moved to (R17 of the fix pass). */
export const commitsCreatedV1 = z.strictObject({
  commits: z.array(z.strictObject({
    sha: commitId,
    /** The index of the revision it commits in the run's revisions, or `change` for the captured change in worktree mode. */
    revision: z.union([z.number().int().nonnegative(), z.literal('change')]),
    subject: z.string().min(1).max(200),
  })).min(1),
  from: commitId,
  to: commitId,
});
export type CommitsCreated = z.infer<typeof commitsCreatedV1>;

/** Every event kind this engine can write or read. Later elements add theirs here. */
export const eventRegistry = defineRegistry({
  'run.created': { 1: { schema: runCreatedV1 } },
  'run.abandoned': { 1: { schema: runAbandonedV1 } },
  'scope.captured': { 1: { schema: scopeCapturedV1 } },
  'worker.launched': { 1: { schema: workerLaunchedV1 } },
  'worker.finished': { 1: { schema: workerFinishedV1 } },
  'worker.lost': { 1: { schema: workerLostV1 }, 2: { schema: workerLostV2 } },
  'review.configured': { 1: { schema: reviewConfiguredV1 }, 2: { schema: reviewConfiguredV2 } },
  'limits.changed': { 1: { schema: limitsChangedV1 } },
  'phase.started': { 1: { schema: phaseStartedV1 }, 2: { schema: phaseStartedV2 } },
  'phase.finished': { 1: { schema: phaseFinishedV1 }, 2: { schema: phaseFinishedV2 } },
  'worktree.checked': { 1: { schema: worktreeCheckedV1 }, 2: { schema: worktreeCheckedV2 } },
  'candidates.recorded': { 1: { schema: candidatesRecordedV1 } },
  'attempt.failed': { 1: { schema: attemptFailedV1 }, 2: { schema: attemptFailedV2 } },
  'angle.failed': { 1: { schema: angleFailedV1 } },
  'deduplication.recorded': { 1: { schema: deduplicationRecordedV1 } },
  'verification.planned': { 1: { schema: verificationPlannedV1 } },
  'verdicts.recorded': { 1: { schema: verdictsRecordedV1 } },
  'group.unverified': { 1: { schema: groupUnverifiedV1 } },
  'ranking.recorded': { 1: { schema: rankingRecordedV1 } },
  'report.written': { 1: { schema: reportWrittenV1 }, 2: { schema: reportWrittenV2 } },
  'fixes.planned': { 1: { schema: fixesPlannedV1 } },
  'checks.planned': { 1: { schema: checksPlannedV1 } },
  'check.ran': { 1: { schema: checkRanV1 } },
  'fix.recorded': { 1: { schema: fixRecordedV1 } },
  'tree.revised': { 1: { schema: treeRevisedV1 } },
  'cluster.failed': { 1: { schema: clusterFailedV1 } },
  'commits.created': { 1: { schema: commitsCreatedV1 } },
});

export type EventRegistry = typeof eventRegistry;
