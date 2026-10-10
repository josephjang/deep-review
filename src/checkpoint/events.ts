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

/** Why a run is blocked and what the operator does about it (R5), as version 1 of `phase.finished` records it. */
export const blockerSchema = z.strictObject({
  code: recordedBlockerCodeSchema,
  detail: recordedTextSchema,
  action: z.string().min(1).max(1000),
});

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
  batchKey: z.string().regex(/^c[1-9][0-9]*-[1-9][0-9]*$/, 'a batch key is a cluster id, a dash and a number from 1'),
  repairKey: z.literal('repair'),
} as const;

const vocabularyV2 = reviewVocabularyV2;
const phaseSchemaV2 = z.enum(vocabularyV2.phases);
const checkPhaseSchemaV2 = z.enum(vocabularyV2.checkPhases);
const editingPhaseSchemaV2 = z.enum(vocabularyV2.editingPhases);
const checkKindSchemaV2 = z.enum(vocabularyV2.checkKinds);
const clusterIdSchemaV2 = reviewIdentifiersV2.clusterId;
const batchKeySchemaV2 = reviewIdentifiersV2.batchKey;

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

/**
 * The routes of every ranked finding, the clusters of the fixer-routed
 * ones, and the batches each cluster's findings are fixed in, one fixer
 * unit per batch, planned once at the fixes phase's first attempt (R2,
 * R3, R18 of the fix pass).
 */
export const fixesPlannedV1 = z.strictObject({
  routes: z.array(z.strictObject({ id: candidateIdSchema, route: z.enum(['fixer', 'held']) })),
  clusters: z.array(z.strictObject({
    id: clusterIdSchemaV2,
    findingIds: z.array(candidateIdSchema).min(1),
    files: z.array(z.string().min(1)),
  })),
  /** In launch order: by the rank of each batch's first finding. */
  batches: z.array(z.strictObject({
    key: batchKeySchemaV2,
    cluster: clusterIdSchemaV2,
    findingIds: z.array(candidateIdSchema).min(1),
  })),
});
export type FixesPlanned = z.infer<typeof fixesPlannedV1>;

/**
 * The second round of the fixes phase (R21 of the fix pass), planned once
 * when every unit of the first round has settled, also when it is empty:
 * the findings a fixer reported blocked only on files other first-round
 * clusters owned, each with those files, clustered over their cluster's
 * files and the files they needed, numbered on from the first round's
 * clusters, and batched as the first round is.
 */
export const fixesReplannedV1 = z.strictObject({
  blocked: z.array(z.strictObject({ id: candidateIdSchema, requiredFiles: z.array(z.string().min(1)).min(1) })),
  clusters: z.array(z.strictObject({
    id: clusterIdSchemaV2,
    findingIds: z.array(candidateIdSchema).min(1),
    files: z.array(z.string().min(1)),
  })),
  batches: z.array(z.strictObject({
    key: batchKeySchemaV2,
    cluster: clusterIdSchemaV2,
    findingIds: z.array(candidateIdSchema).min(1),
  })),
});
export type FixesReplanned = z.infer<typeof fixesReplannedV1>;

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
export type ChecksPlannedV1 = z.infer<typeof checksPlannedV1>;

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
 * One revision of the tree (R6, R20, TD1, TD6 of the fix pass): the bytes
 * one finding's fix, one check's writes, or an unfinished attempt's edits
 * left in the paths it changed, with the message a commit of it carries
 * (for an attempt's finding, unless a later answer of the unit gives one).
 */
export const treeRevisedV1 = z.strictObject({
  phase: phaseSchemaV2,
  source: z.discriminatedUnion('kind', [
    /** A recorded answer's edits, for the findings `change` names. */
    z.strictObject({ kind: z.literal('fix'), key: unitKeySchema, workerId: z.uuid() }),
    /** A check's writes to files the run expected. */
    z.strictObject({ kind: z.literal('check'), check: checkKindSchemaV2 }),
    /**
     * What an attempt of an editing unit that ended without an answer left
     * (R20 of the fix pass): one revision per finding it snapshotted, naming
     * that finding, and one naming none for what it left after its last
     * snapshot, all recorded with its failure.
     */
    z.strictObject({ kind: z.literal('attempt'), key: unitKeySchema, workerId: z.uuid() }),
  ]),
  change: z.strictObject({ findings: z.array(z.string().min(1)), message: commitMessageSchema }),
  files: z.array(revisedFileSchema).min(1).max(2000),
}).superRefine((revision, context) => {
  if (new Set(revision.files.map((file) => file.path)).size !== revision.files.length) context.addIssue({ code: 'custom', message: 'each path is revised once', path: ['files'] });
  const named = revision.change.findings.length;
  const allowed = revision.source.kind === 'fix' ? named > 0 : revision.source.kind === 'check' ? named === 0 : named <= 1;
  if (!allowed) context.addIssue({ code: 'custom', message: 'a fix revision names a finding or more, a check\'s none, and an attempt\'s one or none', path: ['change'] });
});
export type TreeRevised = z.infer<typeof treeRevisedV1>;

/**
 * A unit of an editing phase is settled without an answer: it failed
 * twice, or the run budget was reached before it could be launched again
 * (R12, R19 of the fix pass). Its findings are not attempted, and the
 * phase degraded.
 */
export const unitUnattemptedV1 = z.strictObject({
  phase: editingPhaseSchemaV2,
  key: unitKeySchema,
  cause: z.enum(['failures', 'budget']),
  reason: recordedTextSchema,
});
export type UnitUnattempted = z.infer<typeof unitUnattemptedV1>;

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

/**
 * The vocabulary version 3 of the review events records, and version 1 of
 * the survey's events (R1, R3, R4, R15 of the repository survey): the
 * fifteen phases, with `survey` first; the recorded blocker codes, with
 * `check-unavailable`; who decided a check (`flag`, `survey` or `none`)
 * and what a surveyed command stood on; where a convention source lives;
 * and the values of the policy setting for the reviewer's own rules.
 * Frozen here for the reason `reviewVocabularyV1` is: a test holds it
 * equal to today's vocabulary.
 */
export const reviewVocabularyV3 = {
  phases: [
    'survey',
    'triage', 'finders', 'deduplication', 'verification', 'sweep', 'sweep-deduplication', 'sweep-verification', 'merge-rank',
    'baseline-checks', 'fixes', 'checks', 'repair', 'repair-checks',
    'report',
  ],
  phaseOutcomes: ['completed', 'degraded', 'blocked'],
  recordedBlockerCodes: ['worker-failed', 'budget', 'drift', 'check-unavailable'],
  checkKinds: ['build', 'typecheck', 'lint', 'test'],
  checkOrigins: ['flag', 'survey', 'none'],
  checkBases: ['stated', 'hint'],
  conventionLevels: ['repository', 'user'],
  userRulesSettings: ['ignore', 'apply', 'judge'],
} as const;

const vocabularyV3 = reviewVocabularyV3;
const phaseSchemaV3 = z.enum(vocabularyV3.phases);
const checkKindSchemaV3 = z.enum(vocabularyV3.checkKinds);
const checkBaseSchemaV3 = z.enum(vocabularyV3.checkBases);

/** The blocker of version 3 of `phase.finished`, with the survey's `check-unavailable`. */
export const blockerSchemaV3 = z.strictObject({
  code: z.enum(vocabularyV3.recordedBlockerCodes),
  detail: recordedTextSchema,
  action: z.string().min(1).max(1000),
});

/**
 * `review.configured` with the survey (R3, TD13 of the repository
 * survey): version 2 and the pinned value of the policy setting that
 * decides whether the reviewer's own rules files apply.
 */
export const reviewConfiguredV3 = z.strictObject({
  ...reviewConfiguredV2.shape,
  survey: z.strictObject({ userRules: z.enum(vocabularyV3.userRulesSettings) }),
}).refine((configuration) => configuration.fix === (configuration.checks !== null), {
  message: 'the checks are pinned exactly when the run fixes',
  path: ['checks'],
}).refine((configuration) => configuration.fix === (configuration.fixes !== null), {
  message: 'the batch size is pinned exactly when the run fixes',
  path: ['fixes'],
});
export type ReviewConfigurationV3 = z.infer<typeof reviewConfiguredV3>;

/**
 * How a Codex run's workers are confined on Windows, as version 4 of
 * `review.configured` records it (R3 of the Codex sandbox). Frozen here,
 * as the review vocabulary is, so a later change to the Codex adapter's
 * values is a new version of the event; a test holds it equal to them.
 */
export const codexWindowsSandboxesV4 = ['unelevated', 'elevated', 'none'] as const;

/**
 * `review.configured` with the Codex Windows sandbox (R1, R3 of the Codex
 * sandbox): version 3 and the value the run's Codex workers are confined
 * by, from `--codex-windows-sandbox` or the policy. It is null for a run
 * on another runtime, and for a Codex run on another platform than
 * Windows, where the adapter applies no Windows sandbox.
 */
export const reviewConfiguredV4 = z.strictObject({
  ...reviewConfiguredV3.shape,
  codex: z.strictObject({ windowsSandbox: z.enum(codexWindowsSandboxesV4) }).nullable(),
}).refine((configuration) => configuration.fix === (configuration.checks !== null), {
  message: 'the checks are pinned exactly when the run fixes',
  path: ['checks'],
}).refine((configuration) => configuration.fix === (configuration.fixes !== null), {
  message: 'the batch size is pinned exactly when the run fixes',
  path: ['fixes'],
}).refine((configuration) => configuration.runtime === 'codex' || configuration.codex === null, {
  message: 'only a Codex run pins a Codex Windows sandbox',
  path: ['codex'],
});
/** `phase.started` over the fifteen phases. */
export const phaseStartedV3 = z.strictObject({
  phase: phaseSchemaV3,
  attempt: z.number().int().min(1),
});

/** `phase.finished` over the fifteen phases, with the blocker codes of version 3. */
export const phaseFinishedV3 = z.strictObject({
  phase: phaseSchemaV3,
  attempt: z.number().int().min(1),
  outcome: z.enum(vocabularyV3.phaseOutcomes),
  blocker: blockerSchemaV3.nullable(),
}).refine((finish) => (finish.outcome === 'blocked') === (finish.blocker !== null), {
  message: 'a blocker is present exactly when the outcome is blocked',
  path: ['blocker'],
});

/** `worktree.checked` over the fifteen phases. */
export const worktreeCheckedV3 = z.strictObject({
  ...worktreeCheckedV2.shape,
  phase: phaseSchemaV3,
}).refine((check) => check.drifted === (check.files.length > 0 || check.head !== null), {
  message: 'drifted exactly when some file differs or HEAD moved',
  path: ['drifted'],
});

/** `attempt.failed` over the fifteen phases. */
export const attemptFailedV3 = z.strictObject({
  phase: phaseSchemaV3,
  key: unitKeySchema,
  workerId: z.uuid(),
  reason: recordedTextSchema,
});

/** `worker.lost` over the fifteen phases. */
export const workerLostV3 = z.strictObject({
  workerId: z.uuid(),
  phase: phaseSchemaV3.nullable(),
  key: unitKeySchema.nullable(),
  reason: z.string().min(1).max(1000),
}).refine((lost) => (lost.phase === null) === (lost.key === null), {
  message: 'a lost worker names both its phase and its unit key, or neither',
  path: ['key'],
});

/** `report.written` over the fifteen phases: the statistics gain the survey's row. */
export const reportWrittenV3 = z.strictObject({
  report: artifactReferenceSchema,
  statistics: z.strictObject({
    phases: z.array(spendSchema.extend({ phase: phaseSchemaV3 })),
    total: spendSchema,
    budgetApplied: z.boolean(),
  }),
  patches: z.array(artifactReferenceSchema).max(2000),
});

/** A repository-relative path with forward slashes, or an absolute path for a user-level file, as the survey's events record them. */
const surveyPathSchema = z.string().min(1).max(1000);

/**
 * One file that states rules a change must follow (R2, R3 of the
 * repository survey): its path, repository-relative for one in the
 * repository and absolute for a user-level file; what it governs; the
 * globs it applies to when that is narrower than the repository; and,
 * for a user-level file alone, the grounds on which it applies.
 */
export const conventionSourceSchema = z.strictObject({
  path: surveyPathSchema,
  level: z.enum(vocabularyV3.conventionLevels),
  governs: z.string().min(1).max(1000),
  appliesTo: z.array(z.string().min(1).max(400)).min(1).max(50).nullable(),
  grounds: z.string().min(1).max(1000).nullable(),
}).refine((source) => (source.level === 'user') === (source.grounds !== null), {
  message: 'a user-level source alone states its grounds',
  path: ['grounds'],
});
export type ConventionSource = z.infer<typeof conventionSourceSchema>;

/** Whether one user-level rules file that existed applies to the run, and why: the policy's value, or the surveyor's judgment (R3). */
export const userRuleDecisionSchema = z.strictObject({
  path: surveyPathSchema,
  applied: z.boolean(),
  reason: z.string().min(1).max(1000),
});
export type UserRuleDecision = z.infer<typeof userRuleDecisionSchema>;

/**
 * One kind's check as the surveyor chose it (R4, R11, R15): its command
 * with the file and text it took it from and whether that was stated or a
 * hint, and the tool it found missing; or no command, with the reason.
 * Each is its own variant, so a command always carries its basis and
 * source, and no command carries a reason and nothing else.
 */
export const surveyedCheckSchema = z.union([
  z.strictObject({
    kind: checkKindSchemaV3,
    command: z.string().min(1).max(2000),
    basis: checkBaseSchemaV3,
    source: z.strictObject({ path: surveyPathSchema, quote: z.string().min(1).max(2000) }),
    missingTool: z.string().min(1).max(400).nullable(),
    reason: z.string().min(1).max(1000).nullable(),
  }),
  z.strictObject({
    kind: checkKindSchemaV3,
    command: z.null(),
    basis: z.null(),
    source: z.null(),
    missingTool: z.null(),
    reason: z.string().min(1).max(1000),
  }),
]);
export type SurveyedCheck = z.infer<typeof surveyedCheckSchema>;

/**
 * Hold the convention sources and the user-level decisions to each
 * other: no path twice in either, and the user-level sources exactly the
 * user-level files decided as applied.
 */
function refineConventions(recorded: { readonly conventions: readonly ConventionSource[]; readonly userRules: readonly UserRuleDecision[] }, context: z.RefinementCtx): void {
  if (new Set(recorded.conventions.map((source) => source.path)).size !== recorded.conventions.length) context.addIssue({ code: 'custom', message: 'each convention source is named once', path: ['conventions'] });
  if (new Set(recorded.userRules.map((rule) => rule.path)).size !== recorded.userRules.length) context.addIssue({ code: 'custom', message: 'each user-level file is decided once', path: ['userRules'] });
  const userSources = recorded.conventions.filter((source) => source.level === 'user').map((source) => source.path).sort();
  const applied = recorded.userRules.filter((rule) => rule.applied).map((rule) => rule.path).sort();
  if (userSources.join('\n') !== applied.join('\n')) context.addIssue({ code: 'custom', message: 'the user-level sources are exactly the user-level files applied', path: ['userRules'] });
}

/**
 * The survey's answer as the engine checked it (R2, R4, R6, R8 of the
 * repository survey): the convention sources, repository paths
 * normalized to forward slashes and user-level ones joined by the pinned
 * policy; every user-level rules file that existed, with whether it
 * applies and why; in a fix run, one check per kind no flag settled when
 * the surveyor was launched, and null in a run without the fix pass; and
 * the surveyor's note.
 */
export const surveyRecordedV1 = z.strictObject({
  workerId: z.uuid(),
  conventions: z.array(conventionSourceSchema).max(100),
  userRules: z.array(userRuleDecisionSchema).max(10),
  checks: z.array(surveyedCheckSchema).max(vocabularyV3.checkKinds.length).nullable(),
  note: z.string().max(4000),
}).superRefine((recorded, context) => {
  refineConventions(recorded, context);
  if (recorded.checks !== null && new Set(recorded.checks.map((check) => check.kind)).size !== recorded.checks.length) context.addIssue({ code: 'custom', message: 'each kind is answered once', path: ['checks'] });
});
export type SurveyRecorded = z.infer<typeof surveyRecordedV1>;

/**
 * The run goes on without the survey (R9, PD6): a read-only review whose
 * surveyor failed twice, or a fix run whose flags settled every check
 * after its survey blocked on failures. It records the reason and the
 * part of the convention sources the pinned policy decides alone, the
 * user-level files it applies, with every user-level file's decision.
 */
export const surveyFailedV1 = z.strictObject({
  reason: recordedTextSchema,
  conventions: z.array(conventionSourceSchema).max(10),
  userRules: z.array(userRuleDecisionSchema).max(10),
}).superRefine((failed, context) => {
  refineConventions(failed, context);
  if (failed.conventions.some((source) => source.level !== 'user')) context.addIssue({ code: 'custom', message: 'a failed survey names no repository source', path: ['conventions'] });
});
export type SurveyFailed = z.infer<typeof surveyFailedV1>;

/**
 * One kind's check as a version 2 plan pins it (R6, R15 of the
 * repository survey): its command or none with the reason, who decided
 * (a flag, the survey, or nobody, when the survey found none), and for
 * the survey's command the file and text it came from and what it stood
 * on. The four shapes are the variants: a flag's command, a flag's drop
 * with its reason, the survey's command with its source, and no command
 * that nobody decided, with the survey's reason.
 */
export const plannedCheckSchemaV2 = z.union([
  z.strictObject({ kind: checkKindSchemaV3, command: z.string().min(1), origin: z.literal('flag'), reason: z.null(), source: z.null() }),
  z.strictObject({ kind: checkKindSchemaV3, command: z.null(), origin: z.literal('flag'), reason: z.string().min(1).max(1000), source: z.null() }),
  z.strictObject({
    kind: checkKindSchemaV3,
    command: z.string().min(1),
    origin: z.literal('survey'),
    reason: z.null(),
    source: z.strictObject({ path: surveyPathSchema, quote: z.string().min(1).max(2000), basis: checkBaseSchemaV3 }),
  }),
  z.strictObject({ kind: checkKindSchemaV3, command: z.null(), origin: z.literal('none'), reason: z.string().min(1).max(1000), source: z.null() }),
]);
export type PlannedCheckV2 = z.infer<typeof plannedCheckSchemaV2>;

/** The checks the run executes, one per kind in the order they run, planned when the survey phase completes (R6 of the repository survey). */
export const checksPlannedV2 = z.strictObject({
  checks: z.array(plannedCheckSchemaV2).length(vocabularyV3.checkKinds.length),
}).refine((planned) => planned.checks.every((check, index) => check.kind === vocabularyV3.checkKinds[index]), {
  message: 'one check per kind, in the order the kinds run',
  path: ['checks'],
});
export type ChecksPlannedV2 = z.infer<typeof checksPlannedV2>;

/**
 * The vocabulary version 4 of the review events records, and version 1 of
 * the decision step's events (R1, R3, R10 of the decision step): the
 * sixteen phases, with `decision` after merge and rank; what a decision
 * makes of a finding; and why a finding is left. Frozen here for the
 * reason `reviewVocabularyV1` is: a test holds it equal to today's
 * vocabulary.
 */
export const reviewVocabularyV4 = {
  phases: [
    'survey',
    'triage', 'finders', 'deduplication', 'verification', 'sweep', 'sweep-deduplication', 'sweep-verification', 'merge-rank',
    'decision',
    'baseline-checks', 'fixes', 'checks', 'repair', 'repair-checks',
    'report',
  ],
  decisionKinds: ['fix', 'leave', 'ask'],
  leaveReasons: ['outside-change-not-regression', 'superseded', 'intended'],
} as const;

const vocabularyV4 = reviewVocabularyV4;
const phaseSchemaV4 = z.enum(vocabularyV4.phases);

/**
 * `review.configured` of a run with the decision step (R10 of the
 * decision step): version 4's payload, unchanged. The version alone says
 * the run decides its findings, as version 3 said the run was surveyed; a
 * run configured at version 4 or earlier records its decision phase as
 * skipped.
 */
export const reviewConfiguredV5 = reviewConfiguredV4;
/**
 * The configuration as the fold holds it, whichever version recorded it:
 * version 1 reads as a run without the fix pass; versions 1 and 2 as runs
 * that applied the reviewer's own rules, which the engine did when they
 * were recorded; and versions 1 to 3 of a Codex run on Windows as one
 * under the unelevated Windows sandbox, the adapter's default and the one
 * `deep-review review` ran then, while one off Windows, whose recorded
 * worktree is rooted at `/`, pins none. A library caller could have built
 * the adapter with the elevated one; the ledger did not record which, so
 * such a run reads as unelevated too.
 */
export type ReviewConfiguration = z.infer<typeof reviewConfiguredV5>;

/** `phase.started` over the sixteen phases. */
export const phaseStartedV4 = z.strictObject({
  phase: phaseSchemaV4,
  attempt: z.number().int().min(1),
});
export type PhaseStarted = z.infer<typeof phaseStartedV4>;

/** `phase.finished` over the sixteen phases, with the blocker codes of version 3, which the decision step does not widen. */
export const phaseFinishedV4 = z.strictObject({
  phase: phaseSchemaV4,
  attempt: z.number().int().min(1),
  outcome: z.enum(vocabularyV3.phaseOutcomes),
  blocker: blockerSchemaV3.nullable(),
}).refine((finish) => (finish.outcome === 'blocked') === (finish.blocker !== null), {
  message: 'a blocker is present exactly when the outcome is blocked',
  path: ['blocker'],
});

/** `worktree.checked` over the sixteen phases. */
export const worktreeCheckedV4 = z.strictObject({
  ...worktreeCheckedV2.shape,
  phase: phaseSchemaV4,
}).refine((check) => check.drifted === (check.files.length > 0 || check.head !== null), {
  message: 'drifted exactly when some file differs or HEAD moved',
  path: ['drifted'],
});
export type WorktreeCheckV4 = z.infer<typeof worktreeCheckedV4>;

/** `attempt.failed` over the sixteen phases. */
export const attemptFailedV4 = z.strictObject({
  phase: phaseSchemaV4,
  key: unitKeySchema,
  workerId: z.uuid(),
  reason: recordedTextSchema,
});

/** `worker.lost` over the sixteen phases. */
export const workerLostV4 = z.strictObject({
  workerId: z.uuid(),
  phase: phaseSchemaV4.nullable(),
  key: unitKeySchema.nullable(),
  reason: z.string().min(1).max(1000),
}).refine((lost) => (lost.phase === null) === (lost.key === null), {
  message: 'a lost worker names both its phase and its unit key, or neither',
  path: ['key'],
});
export type WorkerLost = z.infer<typeof workerLostV4>;

/** `report.written` over the sixteen phases: the statistics gain the decision's row. */
export const reportWrittenV4 = z.strictObject({
  report: artifactReferenceSchema,
  statistics: z.strictObject({
    phases: z.array(spendSchema.extend({ phase: phaseSchemaV4 })),
    total: spendSchema,
    budgetApplied: z.boolean(),
  }),
  patches: z.array(artifactReferenceSchema).max(2000),
});
/** The report as the fold holds it: version 1 reads as a report with no patch. */
export type ReportWritten = z.infer<typeof reportWrittenV4>;

const decisionText = (max: number) => z.string().min(1).max(max);

/**
 * One finding as the decider decided it (R3 of the decision step), by
 * the finding's primary candidate id: what it makes of the finding, one
 * sentence of grounds, and the one part its decision names, the other two
 * null. A `fix` is the approach a fixer applies and the options rejected;
 * a `leave` is its reason, and for `superseded` the finding whose fix
 * removes this one; an `ask` is one question, its options each with its
 * cost, the rule a convention source would state for it and whether it
 * edits the code, and the indexes of the option recommended and the
 * default applied, with where the decider looked. A `fix` alone may
 * depart from a rule, naming it, its source and why. Each kind is its own
 * variant, so the type holds each part non-null exactly on its own kind.
 */
const decidedFix = z.strictObject({
  approach: decisionText(2000),
  rejected: z.array(z.strictObject({ option: decisionText(400), reason: decisionText(400) })).max(4),
});
const decidedLeave = z.strictObject({ reason: z.enum(vocabularyV4.leaveReasons), supersededBy: candidateIdSchema.nullable() }).refine((leave) => (leave.reason === 'superseded') === (leave.supersededBy !== null), {
  message: 'a superseded finding names the finding that supersedes it, and no other left finding names one',
  path: ['supersededBy'],
});
const decidedAsk = z.strictObject({
  question: decisionText(400),
  options: z.array(z.strictObject({ option: decisionText(400), cost: decisionText(400), rule: decisionText(400), edits: z.boolean() })).min(2).max(4),
  recommended: z.number().int().min(0),
  applied: z.number().int().min(0),
  searched: z.array(decisionText(400)).min(1).max(10),
}).refine((ask) => ask.recommended < ask.options.length && ask.applied < ask.options.length, { message: 'the recommended and the applied option are among the options' });
const decidedDeparture = z.strictObject({ rule: decisionText(400), source: decisionText(400), reason: decisionText(1000) });
export const recordedDecisionSchema = z.discriminatedUnion('decision', [
  z.strictObject({ id: candidateIdSchema, decision: z.literal('fix'), grounds: decisionText(1000), fix: decidedFix, leave: z.null(), ask: z.null(), departure: decidedDeparture.nullable() }),
  z.strictObject({ id: candidateIdSchema, decision: z.literal('leave'), grounds: decisionText(1000), fix: z.null(), leave: decidedLeave, ask: z.null(), departure: z.null() }),
  z.strictObject({ id: candidateIdSchema, decision: z.literal('ask'), grounds: decisionText(1000), fix: z.null(), leave: z.null(), ask: decidedAsk, departure: z.null() }),
]);
export type RecordedDecision = z.infer<typeof recordedDecisionSchema>;

/**
 * The decider's decisions, one per ranked finding, in the order its answer
 * gave them, or, as the first engine to write this event recorded them,
 * sorted by the task's index; the fold holds them in the ranking's order
 * either way (R2, R3 of the decision step).
 */
export const decisionsRecordedV1 = z.strictObject({
  workerId: z.uuid(),
  decisions: z.array(recordedDecisionSchema).min(1),
}).refine((recorded) => new Set(recorded.decisions.map((decided) => decided.id)).size === recorded.decisions.length, {
  message: 'each finding is decided once',
  path: ['decisions'],
});
export type DecisionsRecorded = z.infer<typeof decisionsRecordedV1>;

/**
 * The vocabulary version 5 of the review events records, and version 1 of
 * the claims' events (R3, R12 of commit series integrity): the recorded
 * blocker codes, with `claims-lost`; why an attempt failed, the unit's
 * fault or its environment's; and why a claim marker was left out of the
 * ledger. Frozen here for the reason `reviewVocabularyV1` is: a test holds
 * it equal to today's vocabulary.
 */
export const reviewVocabularyV5 = {
  recordedBlockerCodes: ['worker-failed', 'budget', 'drift', 'check-unavailable', 'claims-lost'],
  attemptFaults: ['unit', 'environment'],
  lostClaimReasons: ['owned', 'held', 'unplanned'],
} as const;

const vocabularyV5 = reviewVocabularyV5;

/** The blocker of version 5 of `phase.finished`, with the claims' `claims-lost`. */
export const blockerSchemaV5 = z.strictObject({
  code: z.enum(vocabularyV5.recordedBlockerCodes),
  detail: recordedTextSchema,
  action: z.string().min(1).max(1000),
});
/** A blocker as the fold holds it, whichever version recorded it. */
export type Blocker = z.infer<typeof blockerSchemaV5>;

/** `phase.finished` over the sixteen phases, with the blocker codes of version 5. */
export const phaseFinishedV5 = z.strictObject({
  phase: phaseSchemaV4,
  attempt: z.number().int().min(1),
  outcome: z.enum(vocabularyV3.phaseOutcomes),
  blocker: blockerSchemaV5.nullable(),
}).refine((finish) => (finish.outcome === 'blocked') === (finish.blocker !== null), {
  message: 'a blocker is present exactly when the outcome is blocked',
  path: ['blocker'],
});
export type PhaseFinished = z.infer<typeof phaseFinishedV5>;

/**
 * `attempt.failed` with its fault (R12 of commit series integrity): the
 * unit's, a worker that failed or answered what the engine refused, or
 * the environment's, a claims directory removed while the unit ran, which
 * counts against no attempt, as a worker lost with its engine does not.
 * Every earlier version reads as the unit's fault.
 */
export const attemptFailedV5 = z.strictObject({
  ...attemptFailedV4.shape,
  fault: z.enum(vocabularyV5.attemptFaults),
});
export type AttemptFailed = z.infer<typeof attemptFailedV5>;

/**
 * Whether a claim can record a path: repository-relative, at most 1000
 * characters, inside the tree, outside `.git`, with no empty, `.` or `..`
 * segment and no drive-like prefix, so not `a:b.txt` though a POSIX file
 * system holds it.
 */
export function isClaimablePath(path: string): boolean {
  const parts = path.split('/');
  return path.length >= 1 && path.length <= 1000 && !path.includes('\\') && !path.includes('\0') && !/^[a-zA-Z]:/.test(path) && parts.every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

/** A repository-relative path as a claim records it, as `isClaimablePath` allows. */
const claimedPathSchema = z.string().min(1).max(1000).refine(isClaimablePath, { message: 'a claimed path is relative to the repository, inside it and outside .git' });

/** The most files one `files.claimed` or `claims.lost` event holds; more are split across consecutive events. */
export const maxClaimFilesPerEvent = 2000;

/** No path twice in a claims event's files. */
const pathsOnce = <T extends { readonly path: string }>(files: readonly T[]): boolean => new Set(files.map((file) => file.path)).size === files.length;

/**
 * Claims one unit made on files no cluster owns (R1, R3, R6 of commit
 * series integrity), appended before whichever unit's outcome is recorded
 * next: the batch and its cluster, and each file with when it was claimed,
 * or null for a late claim, a file an answer named that nobody held and
 * the cluster never claimed. The fold makes the cluster each file's holder
 * until the cluster settles.
 */
export const filesClaimedV1 = z.strictObject({
  phase: z.literal('fixes'),
  key: batchKeySchemaV2,
  cluster: clusterIdSchemaV2,
  files: z.array(z.strictObject({ path: claimedPathSchema, claimedAt: z.iso.datetime().nullable() })).min(1).max(maxClaimFilesPerEvent),
}).refine((claimed) => pathsOnce(claimed.files), { message: 'each file is claimed once', path: ['files'] });
export type FilesClaimed = z.infer<typeof filesClaimedV1>;

/**
 * Claim markers the engine left out of the ledger because the fold would
 * refuse them (R3 of commit series integrity, review F9): one event per
 * unit that wrote markers, its key and cluster as the markers spell them,
 * since a unit the plan lacks is one of the reasons; each file with its
 * time, why it was left out, and the cluster that owns or holds it, null
 * exactly for a unit the plan lacks.
 */
export const claimsLostV1 = z.strictObject({
  phase: z.literal('fixes'),
  unit: z.string().min(1).max(200),
  cluster: z.string().min(1).max(200),
  files: z.array(z.strictObject({
    path: z.string().min(1).max(1000),
    claimedAt: z.iso.datetime().nullable(),
    reason: z.enum(vocabularyV5.lostClaimReasons),
    holder: clusterIdSchemaV2.nullable(),
  }).refine((file) => (file.reason === 'unplanned') === (file.holder === null), { message: 'a holder is named exactly when the unit is the plan\'s', path: ['holder'] })).min(1).max(maxClaimFilesPerEvent),
});
export type ClaimsLost = z.infer<typeof claimsLostV1>;

/** Every event kind this engine can write or read. Later elements add theirs here. */
export const eventRegistry = defineRegistry({
  'run.created': { 1: { schema: runCreatedV1 } },
  'run.abandoned': { 1: { schema: runAbandonedV1 } },
  'scope.captured': { 1: { schema: scopeCapturedV1 } },
  'worker.launched': { 1: { schema: workerLaunchedV1 } },
  'worker.finished': { 1: { schema: workerFinishedV1 } },
  'worker.lost': { 1: { schema: workerLostV1 }, 2: { schema: workerLostV2 }, 3: { schema: workerLostV3 }, 4: { schema: workerLostV4 } },
  'review.configured': { 1: { schema: reviewConfiguredV1 }, 2: { schema: reviewConfiguredV2 }, 3: { schema: reviewConfiguredV3 }, 4: { schema: reviewConfiguredV4 }, 5: { schema: reviewConfiguredV5 } },
  'limits.changed': { 1: { schema: limitsChangedV1 } },
  'phase.started': { 1: { schema: phaseStartedV1 }, 2: { schema: phaseStartedV2 }, 3: { schema: phaseStartedV3 }, 4: { schema: phaseStartedV4 } },
  'phase.finished': { 1: { schema: phaseFinishedV1 }, 2: { schema: phaseFinishedV2 }, 3: { schema: phaseFinishedV3 }, 4: { schema: phaseFinishedV4 }, 5: { schema: phaseFinishedV5 } },
  'worktree.checked': { 1: { schema: worktreeCheckedV1 }, 2: { schema: worktreeCheckedV2 }, 3: { schema: worktreeCheckedV3 }, 4: { schema: worktreeCheckedV4 } },
  'candidates.recorded': { 1: { schema: candidatesRecordedV1 } },
  'attempt.failed': { 1: { schema: attemptFailedV1 }, 2: { schema: attemptFailedV2 }, 3: { schema: attemptFailedV3 }, 4: { schema: attemptFailedV4 }, 5: { schema: attemptFailedV5 } },
  'angle.failed': { 1: { schema: angleFailedV1 } },
  'deduplication.recorded': { 1: { schema: deduplicationRecordedV1 } },
  'verification.planned': { 1: { schema: verificationPlannedV1 } },
  'verdicts.recorded': { 1: { schema: verdictsRecordedV1 } },
  'group.unverified': { 1: { schema: groupUnverifiedV1 } },
  'ranking.recorded': { 1: { schema: rankingRecordedV1 } },
  'report.written': { 1: { schema: reportWrittenV1 }, 2: { schema: reportWrittenV2 }, 3: { schema: reportWrittenV3 }, 4: { schema: reportWrittenV4 } },
  'fixes.planned': { 1: { schema: fixesPlannedV1 } },
  'fixes.replanned': { 1: { schema: fixesReplannedV1 } },
  'checks.planned': { 1: { schema: checksPlannedV1 }, 2: { schema: checksPlannedV2 } },
  'check.ran': { 1: { schema: checkRanV1 } },
  'fix.recorded': { 1: { schema: fixRecordedV1 } },
  'tree.revised': { 1: { schema: treeRevisedV1 } },
  'unit.unattempted': { 1: { schema: unitUnattemptedV1 } },
  'commits.created': { 1: { schema: commitsCreatedV1 } },
  'survey.recorded': { 1: { schema: surveyRecordedV1 } },
  'survey.failed': { 1: { schema: surveyFailedV1 } },
  'decisions.recorded': { 1: { schema: decisionsRecordedV1 } },
  'files.claimed': { 1: { schema: filesClaimedV1 } },
  'claims.lost': { 1: { schema: claimsLostV1 } },
});

export type EventRegistry = typeof eventRegistry;
