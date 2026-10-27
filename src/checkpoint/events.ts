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
const candidatesRecordedFields = {
  phase: candidatePhaseSchema,
  key: unitKeySchema,
  workerId: z.uuid(),
  candidates: z.array(recordedCandidateSchema).max(12),
  leads: z.array(leadSchema).length(vocabulary.finderAngles.length).nullable(),
};

/** The rules of version 1 that every later version keeps: the triage alone has leads, one per finder angle, and ids are unique. */
function checkCandidatesRecorded(recorded: z.infer<z.ZodObject<typeof candidatesRecordedFields>>, context: z.RefinementCtx): void {
  if ((recorded.phase === 'triage') !== (recorded.leads !== null)) context.addIssue({ code: 'custom', message: 'the triage alone returns leads', path: ['leads'] });
  if (recorded.leads !== null && new Set(recorded.leads.map((lead) => lead.angle)).size !== vocabulary.finderAngles.length) {
    context.addIssue({ code: 'custom', message: 'one lead per finder angle', path: ['leads'] });
  }
  if (new Set(recorded.candidates.map((candidate) => candidate.id)).size !== recorded.candidates.length) context.addIssue({ code: 'custom', message: 'candidate ids are unique', path: ['candidates'] });
}

export const candidatesRecordedV1 = z.strictObject(candidatesRecordedFields).superRefine(checkCandidatesRecorded);
export type CandidatesRecordedV1 = z.infer<typeof candidatesRecordedV1>;

/**
 * The longest text of the triage's account of the change that the ledger
 * records: the wide limit the triage's output schema holds each text to
 * (R3 of the brief of a run). The task asks for less, and the brief cuts
 * what it shows; the evidence shows the whole text.
 */
export const changeTextLengthV1 = 2000;
const changeTextSchema = z.string().min(1).max(changeTextLengthV1);
/** A commit or a repository path the account rests on, as the triage named it. */
const changeSourceSchema = z.string().min(1).max(1000);
/** The most sources of the account's `why` that the ledger records. */
export const changeWhyFromCountV1 = 20;
/** The most sources the account rests on that the ledger records. */
export const changeRestsOnCountV1 = 30;
/** The most files of a condition that the ledger records. */
export const changeConditionFilesCountV1 = 30;

/**
 * One condition of principle 8 that the triage judges (R4 of the brief of
 * a run): whether it holds, and when it does, one sentence that says what
 * and the files that show it. A condition that does not hold has neither,
 * which `normalizeTriageChange` makes so before the record.
 */
export const changeConditionSchema = z.strictObject({
  holds: z.boolean(),
  what: changeTextSchema.nullable(),
  files: z.array(changeSourceSchema).max(changeConditionFilesCountV1),
}).refine((condition) => condition.holds || (condition.what === null && condition.files.length === 0), {
  message: 'a condition that does not hold has no sentence and no files',
  path: ['holds'],
});
export type ChangeCondition = z.infer<typeof changeConditionSchema>;

/**
 * The triage's account of the change (R3, R4 of the brief of a run): a
 * title, what the change does, why in the change's own words with where
 * those words are, what the account rests on, and the two conditions of
 * principle 8 that only a judgment of the code finds. `why` is null when
 * the change states no reason, and then has no sources. No verifier
 * examines the account; the brief marks it so.
 */
export const changeReadingSchema = z.strictObject({
  title: changeTextSchema,
  what: changeTextSchema,
  why: changeTextSchema.nullable(),
  whyFrom: z.array(changeSourceSchema).max(changeWhyFromCountV1),
  restsOn: z.array(changeSourceSchema).max(changeRestsOnCountV1),
  publicInterface: changeConditionSchema,
  wideEffect: changeConditionSchema,
}).refine((reading) => reading.why !== null || reading.whyFrom.length === 0, {
  message: 'a reason the change does not state has no sources',
  path: ['whyFrom'],
});
export type ChangeReading = z.infer<typeof changeReadingSchema>;

/**
 * `candidates.recorded` with the triage's account of the change (R3, TD1
 * of the brief of a run): the account, or null when the triage gave none,
 * on the triage's record, and null on a finder's and the sweep's, which
 * give none.
 */
export const candidatesRecordedV2 = z.strictObject({
  ...candidatesRecordedFields,
  change: changeReadingSchema.nullable(),
}).superRefine((recorded, context) => {
  checkCandidatesRecorded(recorded, context);
  if (recorded.phase !== 'triage' && recorded.change !== null) context.addIssue({ code: 'custom', message: 'the triage alone gives an account of the change', path: ['change'] });
});
export type CandidatesRecorded = z.infer<typeof candidatesRecordedV2>;

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

/** The most strays one `worktree.checked` event lists; a check records the first of them in path order. */
export const maxStraysPerCheck = 2000;

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
  strays: z.array(z.string().min(1)).max(maxStraysPerCheck),
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
}).superRefine(refineCheckRan);
export type CheckRanV1 = z.infer<typeof checkRanV1>;

/** Hold a check's run to its outcome, as every version of `check.ran` does: a skipped check alone has no process, and each outcome has its termination. */
function refineCheckRan(check: Pick<CheckRanV1, 'termination' | 'stdout' | 'stderr' | 'error' | 'exitCode'> & { readonly outcome: string }, context: z.RefinementCtx): void {
  const skipped = check.outcome === 'skipped';
  if (skipped !== (check.termination === null) || skipped !== (check.stdout === null) || skipped !== (check.stderr === null)) {
    context.addIssue({ code: 'custom', message: 'a skipped check alone has no termination and no output', path: ['outcome'] });
  }
  if (skipped && check.error === null) context.addIssue({ code: 'custom', message: 'a skipped check records why', path: ['error'] });
  if (check.outcome === 'passed' && (check.termination !== 'exited' || check.exitCode !== 0)) context.addIssue({ code: 'custom', message: 'a passed check exited with code 0', path: ['outcome'] });
  if (check.outcome === 'timeout' && check.termination !== 'killed') context.addIssue({ code: 'custom', message: 'a check that timed out was killed', path: ['outcome'] });
  if (check.outcome === 'not-started' && check.termination !== 'not-started') context.addIssue({ code: 'custom', message: 'a check that did not start has the termination to say so', path: ['outcome'] });
  if (check.outcome === 'cut' && check.termination !== 'exited') context.addIssue({ code: 'custom', message: 'a cut check exited, ended by a kill from outside the engine', path: ['outcome'] });
}

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
}).superRefine(refineRevision);

/** Hold a revision to its source, as every version of `tree.revised` does: no path twice, and the findings each kind of source may name. */
function refineRevision(revision: Pick<z.infer<typeof treeRevisedV1>, 'files' | 'change' | 'source'>, context: z.RefinementCtx): void {
  if (new Set(revision.files.map((file) => file.path)).size !== revision.files.length) context.addIssue({ code: 'custom', message: 'each path is revised once', path: ['files'] });
  const named = revision.change.findings.length;
  const allowed = revision.source.kind === 'fix' ? named > 0 : revision.source.kind === 'check' ? named === 0 : named <= 1;
  if (!allowed) context.addIssue({ code: 'custom', message: 'a fix revision names a finding or more, a check\'s none, and an attempt\'s one or none', path: ['change'] });
}

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
/** What a recorded survey says of the conventions: its convention sources and user-level decisions, without its checks. */
export type SurveyedSources = Pick<SurveyRecorded, 'conventions' | 'userRules'>;

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
export type ReviewConfigurationV5 = z.infer<typeof reviewConfiguredV5>;
/**
 * The configuration as the fold holds it, with what a version 6 recorded
 * of the settings, or null for a run configured before them, and what a
 * `fix.pinned@2` recorded of the fix side, or null for a run not
 * continued at that version (R6, R17 of the configuration).
 */
export type ReviewConfiguration = ReviewConfigurationV5 & { readonly settings: SettingsRecorded | null; readonly fixSettings: FixSettingsRecorded | null };

/** `phase.started` over the sixteen phases. */
export const phaseStartedV4 = z.strictObject({
  phase: phaseSchemaV4,
  attempt: z.number().int().min(1),
});

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

/**
 * `attempt.failed` with its fault (R12 of commit series integrity): the
 * unit's, a worker that failed or answered what the engine refused, or
 * the environment's, a claims directory removed while the unit ran, which
 * uses an attempt but never degrades the unit, as a worker lost with its
 * engine does not. Every earlier version reads as the unit's fault.
 */
export const attemptFailedV5 = z.strictObject({
  ...attemptFailedV4.shape,
  fault: z.enum(vocabularyV5.attemptFaults),
});

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

/**
 * A complete read-only run continued into the fix pass (R6, TD1 to TD3 of
 * fix pass continuation): from this event on, the run fixes. It carries
 * what a fix run pins at configuration and a read-only run never did, the
 * per-check timeout and the fixer batch size, as the policy gives them at
 * the continuation, with the schemas of `review.configured@2`'s blocks;
 * and, when the operator's flags settled every kind, the checks planned
 * from them alone, one flag entry per kind in the order the kinds run,
 * else null, and the run's survey is asked for them.
 */
export const fixPinnedV1 = z.strictObject({
  checks: reviewConfiguredV2.shape.checks.unwrap(),
  fixes: reviewConfiguredV2.shape.fixes.unwrap(),
  plannedChecks: checksPlannedV2.shape.checks.nullable(),
}).refine((pinned) => pinned.plannedChecks === null || pinned.plannedChecks.every((check, index) => check.kind === vocabularyV3.checkKinds[index] && check.origin === 'flag'), {
  message: 'checks planned with the pin are the flags\', one per kind in the order the kinds run',
  path: ['plannedChecks'],
});
export type FixPinned = z.infer<typeof fixPinnedV1>;

/**
 * The vocabulary version 6 of the review events records, and version 1 of
 * the answers' events (R1, R5, R9 of answers): the eighteen phases, with
 * the answer pass's `answer` and `answer-checks` after the repair's
 * checks; the editing phases, with `answer`; the check phases, with
 * `answer-checks`; and the three kinds of an answer. Frozen here for the
 * reason `reviewVocabularyV1` is: a test holds it equal to today's
 * vocabulary.
 */
export const reviewVocabularyV6 = {
  phases: [
    'survey',
    'triage', 'finders', 'deduplication', 'verification', 'sweep', 'sweep-deduplication', 'sweep-verification', 'merge-rank',
    'decision',
    'baseline-checks', 'fixes', 'checks', 'repair', 'repair-checks',
    'answer', 'answer-checks',
    'report',
  ],
  editingPhases: ['fixes', 'repair', 'answer'],
  checkPhases: ['baseline-checks', 'checks', 'repair-checks', 'answer-checks'],
  answerKinds: ['option', 'accept', 'reject'],
} as const;

const vocabularyV6 = reviewVocabularyV6;
const phaseSchemaV6 = z.enum(vocabularyV6.phases);
const editingPhaseSchemaV6 = z.enum(vocabularyV6.editingPhases);
const checkPhaseSchemaV6 = z.enum(vocabularyV6.checkPhases);

/** `phase.started` over the eighteen phases. */
export const phaseStartedV5 = z.strictObject({
  phase: phaseSchemaV6,
  attempt: z.number().int().min(1),
});

/** `phase.finished` over the eighteen phases, with the blocker codes of version 5, which the answers do not widen. */
export const phaseFinishedV6 = z.strictObject({
  phase: phaseSchemaV6,
  attempt: z.number().int().min(1),
  outcome: z.enum(vocabularyV3.phaseOutcomes),
  blocker: blockerSchemaV5.nullable(),
}).refine((finish) => (finish.outcome === 'blocked') === (finish.blocker !== null), {
  message: 'a blocker is present exactly when the outcome is blocked',
  path: ['blocker'],
});

/** `worktree.checked` over the eighteen phases; from this version on, the head it expects is the run's head, the last commit `deep-review commit` made for the run once it made one (R6 of answers). */
export const worktreeCheckedV5 = z.strictObject({
  ...worktreeCheckedV2.shape,
  phase: phaseSchemaV6,
}).refine((check) => check.drifted === (check.files.length > 0 || check.head !== null), {
  message: 'drifted exactly when some file differs or HEAD moved',
  path: ['drifted'],
});
export type WorktreeCheckV5 = z.infer<typeof worktreeCheckedV5>;

/** `attempt.failed` over the eighteen phases, with its fault as version 5 records it. */
export const attemptFailedV6 = z.strictObject({
  ...attemptFailedV5.shape,
  phase: phaseSchemaV6,
});

/** `worker.lost` over the eighteen phases. */
export const workerLostV5 = z.strictObject({
  workerId: z.uuid(),
  phase: phaseSchemaV6.nullable(),
  key: unitKeySchema.nullable(),
  reason: z.string().min(1).max(1000),
}).refine((lost) => (lost.phase === null) === (lost.key === null), {
  message: 'a lost worker names both its phase and its unit key, or neither',
  path: ['key'],
});

/** `report.written` over the eighteen phases: the statistics gain the answer pass's rows. */
export const reportWrittenV5 = z.strictObject({
  report: artifactReferenceSchema,
  statistics: z.strictObject({
    phases: z.array(spendSchema.extend({ phase: phaseSchemaV6 })),
    total: spendSchema,
    budgetApplied: z.boolean(),
  }),
  patches: z.array(artifactReferenceSchema).max(2000),
});

/** `tree.revised` over the eighteen phases, so a revision of the answer pass and one of its checks can name their phase. */
export const treeRevisedV2 = z.strictObject({
  ...treeRevisedV1.shape,
  phase: phaseSchemaV6,
}).superRefine(refineRevision);

/** `fix.recorded` over the three editing phases, the answer pass's fixer among them. */
export const fixRecordedV2 = z.strictObject({
  ...fixRecordedV1.shape,
  phase: editingPhaseSchemaV6,
}).refine((recorded) => new Set(recorded.findings.map((finding) => finding.id)).size === recorded.findings.length, {
  message: 'each finding is answered once',
  path: ['findings'],
});

/** `check.ran` over the four check phases, the answer pass's checks among them. */
export const checkRanV2 = z.strictObject({
  ...checkRanV1.shape,
  phase: checkPhaseSchemaV6,
}).superRefine(refineCheckRan);
export type CheckRanV2 = z.infer<typeof checkRanV2>;

/**
 * What a person answered a decision with (R1, R3 of answers, TD9): the
 * index, from 0, of one of an ask's options, or the acceptance or the
 * rejection of a fix's departure from a rule. A further kind widens this
 * union and is `answer.recorded@2`: an older engine must refuse a kind it
 * does not know, as the strict union does.
 */
export const answerSchemaV1 = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('option'), option: z.number().int().min(0) }),
  z.strictObject({ kind: z.literal('accept') }),
  z.strictObject({ kind: z.literal('reject') }),
]);
export type Answer = z.infer<typeof answerSchemaV1>;

/** The longest note an answer records, beside the choice, of what the person said. */
export const answerNoteLengthV1 = 2000;

/**
 * A person's answer to one decided finding of a complete run (R1 of
 * answers): the finding, by its primary candidate id, the answer, and the
 * person's note, or null for none. It is the fact and the label, recorded
 * before anything is edited; it moves no phase.
 */
export const answerRecordedV1 = z.strictObject({
  id: candidateIdSchema,
  answer: answerSchemaV1,
  note: z.string().min(1).max(answerNoteLengthV1).nullable(),
});
export type AnswerRecorded = z.infer<typeof answerRecordedV1>;

/**
 * The answer pass of a complete fix run (R5 of answers): the answered
 * findings whose standing answers owe an edit, which one fixer applies,
 * each once. It opens the `answer` and `answer-checks` phases and the
 * report again.
 */
export const answerPassV1 = z.strictObject({
  ids: z.array(candidateIdSchema).min(1),
}).refine((pass) => new Set(pass.ids).size === pass.ids.length, {
  message: 'each finding is applied once',
  path: ['ids'],
});
export type AnswerPassed = z.infer<typeof answerPassV1>;

/**
 * The vocabulary of the configuration's events (R6, R12, R17, TD4 of the
 * configuration): the layers a value can come from, the layers a file
 * gives, the settings a run records, the values of `scope.default`, and
 * the states of the repository's file. Frozen here for the reason
 * `reviewVocabularyV1` is: a test holds it equal to the settings registry,
 * so a setting the engine records next is a new version of the events.
 */
export const recordedSettingsV1 = {
  layers: ['default', 'operator', 'repository', 'clone', 'invocation', 'flag'],
  fileLayers: ['repository', 'operator', 'clone', 'invocation'],
  names: [
    'review.base', 'scope.default', 'scope.exclude',
    'checks.build', 'checks.typecheck', 'checks.lint', 'checks.test', 'checks.timeout_minutes',
    'tools.path', 'conventions.user_rules', 'budget.usd', 'run.concurrency',
    'runtimes.claude.strong', 'runtimes.claude.fast', 'runtimes.claude.executable', 'runtimes.claude.args',
    'runtimes.codex.strong', 'runtimes.codex.fast', 'runtimes.codex.executable', 'runtimes.codex.args', 'runtimes.codex.windows_sandbox',
  ],
  checkNames: ['checks.build', 'checks.typecheck', 'checks.lint', 'checks.test'],
  scopeDefaults: ['worktree', 'last-commit', 'branch', 'auto'],
  repositoryStates: ['read', 'absent', 'skipped'],
} as const;

const settingLayerSchemaV1 = z.enum(recordedSettingsV1.layers);
const fileLayerSchemaV1 = z.enum(recordedSettingsV1.fileLayers);
const settingNameSchemaV1 = z.enum(recordedSettingsV1.names);

/** A recorded pattern, directory or revision: text a setting held, bounded as the registry bounds it. */
const settingTextSchemaV1 = z.string().min(1).max(4096);

/** A check's command as a setting gives it, `false` for none, or null when no setting gives one and the survey decides. */
const recordedCheckSettingV1 = z.union([z.string().min(1).max(32_000), z.literal(false)]).nullable();

/** The layer of each recorded setting, by its name; a name the version does not record is refused. */
const settingLayersSchemaV1 = z.partialRecord(settingNameSchemaV1, settingLayerSchemaV1);

/** Whether every runtime setting the layers name belongs to the run's runtime. */
const runtimeLayersMatch = (runtime: string, layers: Readonly<Partial<Record<string, unknown>>>): boolean =>
  Object.keys(layers).every((name) => !name.startsWith('runtimes.') || name.startsWith(`runtimes.${runtime}.`));

/**
 * Where a record of the settings came from, which `review.configured@6`
 * and the fix side of `fix.pinned@2` both hold: the files read, the state
 * of the repository's file, the repository values a higher layer
 * replaced, and the settings ignored.
 */
const settingsSourcesShapeV1 = {
  files: z.array(z.strictObject({ layer: fileLayerSchemaV1, path: settingTextSchemaV1, sha256: z.string().regex(/^[a-f0-9]{64}$/), commit: commitId.nullable() })).max(recordedSettingsV1.fileLayers.length),
  repository: z.strictObject({ state: z.enum(recordedSettingsV1.repositoryStates), commit: commitId.nullable(), edited: z.boolean() }),
  notFollowed: z.array(z.strictObject({ name: settingNameSchemaV1, repository: z.json(), value: z.json(), layer: settingLayerSchemaV1 })).max(recordedSettingsV1.names.length),
  ignored: z.array(z.strictObject({ layer: fileLayerSchemaV1, path: settingTextSchemaV1, name: z.string().min(1).max(1000), reason: z.string().min(1).max(1000) })).max(256),
};

/** What every record of the settings' sources holds to: a commit exactly for a repository's file not skipped, and among the files exactly when it was read. */
type SettingsSourcesV1 = { readonly files: readonly { readonly layer: string; readonly commit: string | null }[]; readonly repository: { readonly state: string; readonly commit: string | null } };
const sourcesProblem = (recorded: SettingsSourcesV1): string | null => {
  if ((recorded.repository.state === 'skipped') !== (recorded.repository.commit === null)) return 'the repository\'s file has a commit exactly when it was not skipped';
  if (!recorded.files.every((file) => (file.layer === 'repository') === (file.commit !== null))) return 'only the repository\'s file is read at a commit';
  if (recorded.repository.state !== 'read' && recorded.files.some((file) => file.layer === 'repository')) return 'the repository\'s file is among the files read exactly when it was read';
  return null;
};
const refineSources = (recorded: SettingsSourcesV1, context: z.RefinementCtx): void => {
  const problem = sourcesProblem(recorded);
  if (problem !== null) context.addIssue({ code: 'custom', message: problem, path: ['files'] });
};

/**
 * What a run recorded of its configuration beside version 5's fields (R6,
 * R7 of the configuration): the files it read, each with its layer, path,
 * content hash and, for the repository's, the commit; the state of the
 * repository's file and whether the change edits it; the value of each
 * recorded setting version 5 has no field for, the check commands only in
 * a run that fixes; the layer of every recorded setting; the repository
 * values a higher layer replaced; and the settings ignored.
 */
export const settingsRecordedV1 = z.strictObject({
  files: settingsSourcesShapeV1.files,
  repository: settingsSourcesShapeV1.repository,
  values: z.strictObject({
    'review.base': settingTextSchemaV1.nullable(),
    'scope.default': z.enum(recordedSettingsV1.scopeDefaults),
    'scope.exclude': z.array(settingTextSchemaV1).max(64),
    'tools.path': z.array(settingTextSchemaV1).max(64),
    'checks.build': recordedCheckSettingV1.optional(),
    'checks.typecheck': recordedCheckSettingV1.optional(),
    'checks.lint': recordedCheckSettingV1.optional(),
    'checks.test': recordedCheckSettingV1.optional(),
  }),
  layers: settingLayersSchemaV1,
  notFollowed: settingsSourcesShapeV1.notFollowed,
  ignored: settingsSourcesShapeV1.ignored,
}).superRefine(refineSources);
export type SettingsRecorded = z.infer<typeof settingsRecordedV1>;

/**
 * `review.configured` with the settings (R6, R17, TD4 of the
 * configuration): version 5's payload and `settings`, the record of where
 * each value came from. The fields of version 5 keep the values of the
 * settings they hold; the block gives their layers and the values of the
 * settings version 5 has no field for, so no value is recorded twice.
 * A setting recorded later is a new version, so an older engine passes
 * over a run it would resume without that setting's effect.
 */
export const reviewConfiguredV6 = z.strictObject({
  ...reviewConfiguredV4.shape,
  settings: settingsRecordedV1,
}).refine((configuration) => configuration.fix === (configuration.checks !== null), {
  message: 'the checks are pinned exactly when the run fixes',
  path: ['checks'],
}).refine((configuration) => configuration.fix === (configuration.fixes !== null), {
  message: 'the batch size is pinned exactly when the run fixes',
  path: ['fixes'],
}).refine((configuration) => configuration.runtime === 'codex' || configuration.codex === null, {
  message: 'only a Codex run pins a Codex Windows sandbox',
  path: ['codex'],
}).refine((configuration) => recordedSettingsV1.checkNames.every((name) => (configuration.settings.values[name] !== undefined) === configuration.fix), {
  message: 'the check settings are recorded exactly when the run fixes',
  path: ['settings', 'values'],
}).refine((configuration) => runtimeLayersMatch(configuration.runtime, configuration.settings.layers), {
  message: 'a runtime\'s settings are recorded only for the run\'s runtime',
  path: ['settings', 'layers'],
});
export type ReviewConfigurationV6 = z.infer<typeof reviewConfiguredV6>;

/** A scope request with the patterns `scope.exclude` left out of it (R10 of the configuration). */
export const scopeRequestSchemaV2 = z.strictObject({
  ...scopeRequestSchema.shape,
  exclude: z.array(z.string().min(1).max(1000)).max(64),
});
export type CapturedScopeRequest = z.infer<typeof scopeRequestSchemaV2>;

/**
 * `scope.captured` with the paths left out (R10 of the configuration): the
 * request with its `exclude` patterns, and the changed paths they left
 * out, at most 2000 of them, with their count. A version 1 capture reads
 * as one that left nothing out.
 */
export const scopeCapturedV2 = z.strictObject({
  ...scopeCapturedV1.shape,
  request: scopeRequestSchemaV2,
  excluded: z.strictObject({ paths: z.array(z.string().min(1)).max(2000), count: z.number().int().nonnegative() }),
}).refine((scope) => scope.excluded.count >= scope.excluded.paths.length && (scope.excluded.count === scope.excluded.paths.length || scope.excluded.paths.length === 2000), {
  message: 'the count of the paths left out is the paths named, or more only when 2000 are named',
  path: ['excluded', 'count'],
}).refine((scope) => scope.excluded.count === 0 || scope.request.exclude.length > 0, {
  message: 'only a request with patterns leaves a path out',
  path: ['excluded'],
});
/** The captured change as the fold holds it: a version 1 capture reads as one with no pattern and nothing left out. */
export type ScopeState = z.infer<typeof scopeCapturedV2>;
export type ScopeStateV1 = z.infer<typeof scopeCapturedV1>;

/**
 * One kind's check as a version 3 plan pins it (R11 of the
 * configuration): as version 2 does, but a check a setting settled has the
 * origin `setting` with the layer that gave it, a flag among them, where
 * version 2 had `flag`; the survey's and nobody's have no layer.
 */
export const plannedCheckSchemaV3 = z.union([
  z.strictObject({ kind: checkKindSchemaV3, command: z.string().min(1), origin: z.literal('setting'), layer: settingLayerSchemaV1.exclude(['default']), reason: z.null(), source: z.null() }),
  z.strictObject({ kind: checkKindSchemaV3, command: z.null(), origin: z.literal('setting'), layer: settingLayerSchemaV1.exclude(['default']), reason: z.string().min(1).max(1000), source: z.null() }),
  z.strictObject({
    kind: checkKindSchemaV3,
    command: z.string().min(1),
    origin: z.literal('survey'),
    layer: z.null(),
    reason: z.null(),
    source: z.strictObject({ path: surveyPathSchema, quote: z.string().min(1).max(2000), basis: checkBaseSchemaV3 }),
  }),
  z.strictObject({ kind: checkKindSchemaV3, command: z.null(), origin: z.literal('none'), layer: z.null(), reason: z.string().min(1).max(1000), source: z.null() }),
]);
export type PlannedCheckV3 = z.infer<typeof plannedCheckSchemaV3>;

/** The checks the run executes, one per kind in the order they run, a setting's with its layer (R11 of the configuration). */
export const checksPlannedV3 = z.strictObject({
  checks: z.array(plannedCheckSchemaV3).length(vocabularyV3.checkKinds.length),
}).refine((planned) => planned.checks.every((check, index) => check.kind === vocabularyV3.checkKinds[index]), {
  message: 'one check per kind, in the order the kinds run',
  path: ['checks'],
});
export type ChecksPlannedV3 = z.infer<typeof checksPlannedV3>;

/**
 * The fix side of the settings a continuation records (R6 of the
 * configuration): the check commands, `tools.path` and their layers, and
 * the layer of the check timeout, whose value the pin's `checks` holds;
 * and where the continuation took them from, as `review.configured@6`
 * records it for the run: the files, the repository's file, the values
 * not followed and the settings ignored.
 */
export const fixSettingsRecordedV1 = z.strictObject({
  values: z.strictObject({
    'checks.build': recordedCheckSettingV1,
    'checks.typecheck': recordedCheckSettingV1,
    'checks.lint': recordedCheckSettingV1,
    'checks.test': recordedCheckSettingV1,
    'tools.path': z.array(settingTextSchemaV1).max(64),
  }),
  layers: z.strictObject({
    'checks.build': settingLayerSchemaV1,
    'checks.typecheck': settingLayerSchemaV1,
    'checks.lint': settingLayerSchemaV1,
    'checks.test': settingLayerSchemaV1,
    'checks.timeout_minutes': settingLayerSchemaV1,
    'tools.path': settingLayerSchemaV1,
  }),
  ...settingsSourcesShapeV1,
}).superRefine(refineSources);
export type FixSettingsRecorded = z.infer<typeof fixSettingsRecordedV1>;

/**
 * `fix.pinned` with the settings (R6 of the configuration): version 1's
 * payload, its checks planned at version 3 when the settings settle
 * every kind, and the fix side of the settings with their layers, which
 * the continuation resolved from the repository's file at the run's base
 * and from the operator's files and flags as they are now.
 */
export const fixPinnedV2 = z.strictObject({
  checks: reviewConfiguredV2.shape.checks.unwrap(),
  fixes: reviewConfiguredV2.shape.fixes.unwrap(),
  plannedChecks: checksPlannedV3.shape.checks.nullable(),
  settings: fixSettingsRecordedV1,
}).refine((pinned) => pinned.plannedChecks === null || pinned.plannedChecks.every((check, index) => check.kind === vocabularyV3.checkKinds[index] && check.origin === 'setting'), {
  message: 'checks planned with the pin are the settings\', one per kind in the order the kinds run',
  path: ['plannedChecks'],
});
export type FixPinnedV2 = z.infer<typeof fixPinnedV2>;

/**
 * The vocabulary version 7 of the review events records (R4, R7, R14 of
 * resumable runs): how a check's run ended, with `cut` for a run a kill
 * mark or a guard with no result ended; why an attempt failed, with `cut`
 * for a worker a kill mark ended and `limit` for one the provider's usage
 * limit failed; and when a worktree check is made, with `restored` for the
 * check after a write back. Frozen here for the reason
 * `reviewVocabularyV1` is: a test holds it equal to today's vocabulary.
 */
export const reviewVocabularyV7 = {
  checkOutcomes: ['passed', 'failed', 'timeout', 'not-started', 'skipped', 'cut'],
  attemptFaults: ['unit', 'environment', 'cut', 'limit'],
  worktreeMoments: ['start', 'answer', 'end', 'restored'],
} as const;

const vocabularyV7 = reviewVocabularyV7;
const attemptNumber = z.number().int().min(1);

/**
 * The start of a check (R7 of resumable runs): its phase, attempt, kind
 * and command, appended before the check runs, so a check a stop cut has
 * a start and no end on the ledger. A skipped check, which never runs, has
 * none.
 */
export const checkStartedV1 = z.strictObject({
  phase: checkPhaseSchemaV6,
  attempt: attemptNumber,
  kind: checkKindSchemaV3,
  command: z.string().min(1),
});

/**
 * `check.ran` with the run it replaces and the outcome `cut` (R3, R4, R7,
 * TD2 of resumable runs). `replaces` is null for the first current run of
 * a kind in its phase, and otherwise names the last current run by its
 * attempt and outcome: one that did not pass in a cut attempt, one that was
 * cut, or the first timeout of the kind in the current attempt. A cut run
 * exited, with a kill mark or with no result from its guard, and has no
 * result of its own.
 */
export const checkRanV3 = z.strictObject({
  ...checkRanV1.shape,
  phase: checkPhaseSchemaV6,
  outcome: z.enum(vocabularyV7.checkOutcomes),
  replaces: z.strictObject({ attempt: attemptNumber, outcome: z.enum(vocabularyV7.checkOutcomes) }).nullable(),
}).superRefine(refineCheckRan);

/** A file a write back found differing: what the tree held, frozen, and what the run expects there; null where nothing was, or is expected. */
const restoredFileSchemaV1 = z.strictObject({
  path: z.string().min(1),
  before: frozenFileSchema.nullable(),
  beforeSymlink: z.boolean(),
  expected: frozenFileSchema.nullable(),
  expectedSymlink: z.boolean(),
});

/**
 * A write back after a check that a kill cut short (R7, TD7 of resumable
 * runs): the phase and the attempt it is made in, the check by its kind
 * and the attempt it ran in, and each file the run expects that differed,
 * with what the tree held, frozen as evidence, and the state the run
 * expects. Recorded before the expected bytes are written, so a stop
 * between the two writes them again at the next start; an empty list says
 * nothing differed.
 */
export const treeRestoredV1 = z.strictObject({
  phase: checkPhaseSchemaV6,
  attempt: attemptNumber,
  check: z.strictObject({ kind: checkKindSchemaV3, attempt: attemptNumber }),
  files: z.array(restoredFileSchemaV1).max(2000),
}).refine((restored) => new Set(restored.files.map((file) => file.path)).size === restored.files.length, {
  message: 'each path is written back once',
  path: ['files'],
});
export type TreeRestored = z.infer<typeof treeRestoredV1>;

/** `worktree.checked` with the moment `restored`, the check of the tree after a write back (R7 of resumable runs). */
export const worktreeCheckedV6 = z.strictObject({
  ...worktreeCheckedV5.shape,
  moment: z.enum(vocabularyV7.worktreeMoments),
}).refine((check) => check.drifted === (check.files.length > 0 || check.head !== null), {
  message: 'drifted exactly when some file differs or HEAD moved',
  path: ['drifted'],
});

/**
 * `attempt.failed` with the faults `cut`, a worker a kill mark ended (R4
 * of resumable runs), and `limit`, a worker the provider's usage limit
 * failed (R14). Each uses an attempt but never degrades the unit, as a
 * lost worker does not. The fault `environment` stays as version 5
 * records it, in the fixes phase.
 */
export const attemptFailedV7 = z.strictObject({
  ...attemptFailedV6.shape,
  fault: z.enum(vocabularyV7.attemptFaults),
});

/**
 * A complete fix run that the run budget stopped, reopened (R11, TD8 of
 * resumable runs): each unit the budget left not attempted, a batch of the
 * fixes or the repair, by its phase and key, once each.
 */
export const fixReopenedV1 = z.strictObject({
  units: z.array(z.strictObject({ phase: z.enum(['fixes', 'repair']), key: unitKeySchema })).min(1),
}).refine((reopened) => new Set(reopened.units.map((unit) => `${unit.phase}:${unit.key}`)).size === reopened.units.length, {
  message: 'each unit is reopened once',
  path: ['units'],
});

/**
 * A series of commits `deep-review commit` is about to make (R9, TD6 of
 * resumable runs): what `commits.created` records after it, appended before
 * the branch moves, so a stop between the two leaves a series the next
 * command completes or drops.
 */
export const commitsPreparedV1 = commitsCreatedV1;
export type CommitsPrepared = z.infer<typeof commitsPreparedV1>;

/** A prepared series that the next command dropped, by the head it starts from and the head it would have made, since the branch did not move (R9 of resumable runs). */
export const commitsDroppedV1 = z.strictObject({
  from: commitId,
  to: commitId,
});
export type CommitsDropped = z.infer<typeof commitsDroppedV1>;

/**
 * The vocabulary version 8 of the review events records (R1, TD1 of the
 * documentation step): the nineteen phases, with `documentation` after
 * the fixes and before their checks, and the editing phases, with
 * `documentation`. Frozen here for the reason `reviewVocabularyV1` is: a
 * test holds it equal to today's vocabulary. The engine writes a version
 * over this vocabulary only for an event that names the documentation
 * phase or its unit (TD5), so a run configured before the step holds
 * none of them.
 */
export const reviewVocabularyV8 = {
  phases: [
    'survey',
    'triage', 'finders', 'deduplication', 'verification', 'sweep', 'sweep-deduplication', 'sweep-verification', 'merge-rank',
    'decision',
    'baseline-checks', 'fixes', 'documentation', 'checks', 'repair', 'repair-checks',
    'answer', 'answer-checks',
    'report',
  ],
  editingPhases: ['fixes', 'documentation', 'repair', 'answer'],
} as const;

const vocabularyV8 = reviewVocabularyV8;
const phaseSchemaV8 = z.enum(vocabularyV8.phases);
const editingPhaseSchemaV8 = z.enum(vocabularyV8.editingPhases);

/**
 * `review.configured` with the documentation step (TD4 of the
 * documentation step): version 6 unchanged. The version alone says that
 * the run has the step, as version 5 said it has the decision step.
 */
export const reviewConfiguredV7 = reviewConfiguredV6;
export type ReviewConfigurationV7 = z.infer<typeof reviewConfiguredV7>;

/** `phase.started` over the nineteen phases. */
export const phaseStartedV6 = z.strictObject({
  phase: phaseSchemaV8,
  attempt: z.number().int().min(1),
});

/** `phase.finished` over the nineteen phases, with the blocker codes of version 5. */
export const phaseFinishedV7 = z.strictObject({
  phase: phaseSchemaV8,
  attempt: z.number().int().min(1),
  outcome: z.enum(vocabularyV3.phaseOutcomes),
  blocker: blockerSchemaV5.nullable(),
}).refine((finish) => (finish.outcome === 'blocked') === (finish.blocker !== null), {
  message: 'a blocker is present exactly when the outcome is blocked',
  path: ['blocker'],
});

/** `worktree.checked` over the nineteen phases, with the moments of version 6. */
export const worktreeCheckedV7 = z.strictObject({
  ...worktreeCheckedV6.shape,
  phase: phaseSchemaV8,
}).refine((check) => check.drifted === (check.files.length > 0 || check.head !== null), {
  message: 'drifted exactly when some file differs or HEAD moved',
  path: ['drifted'],
});

/** `attempt.failed` over the nineteen phases, with the faults of version 7. */
export const attemptFailedV8 = z.strictObject({
  ...attemptFailedV7.shape,
  phase: phaseSchemaV8,
});
export type AttemptFailed = z.infer<typeof attemptFailedV8>;

/** `worker.lost` over the nineteen phases. */
export const workerLostV6 = z.strictObject({
  workerId: z.uuid(),
  phase: phaseSchemaV8.nullable(),
  key: unitKeySchema.nullable(),
  reason: z.string().min(1).max(1000),
}).refine((lost) => (lost.phase === null) === (lost.key === null), {
  message: 'a lost worker names both its phase and its unit key, or neither',
  path: ['key'],
});
export type WorkerLost = z.infer<typeof workerLostV6>;

/** `report.written` over the nineteen phases: the statistics gain the documentation step's row. */
export const reportWrittenV6 = z.strictObject({
  report: artifactReferenceSchema,
  statistics: z.strictObject({
    phases: z.array(spendSchema.extend({ phase: phaseSchemaV8 })),
    total: spendSchema,
    budgetApplied: z.boolean(),
  }),
  patches: z.array(artifactReferenceSchema).max(2000),
});

/** `tree.revised` over the nineteen phases, so a revision of the documentation step can name its phase. */
export const treeRevisedV3 = z.strictObject({
  ...treeRevisedV2.shape,
  phase: phaseSchemaV8,
}).superRefine(refineRevision);
export type TreeRevised = z.infer<typeof treeRevisedV3>;

/** `fix.recorded` over the four editing phases, the documentation step among them, whose ids are its items. */
export const fixRecordedV3 = z.strictObject({
  ...fixRecordedV2.shape,
  phase: editingPhaseSchemaV8,
}).refine((recorded) => new Set(recorded.findings.map((finding) => finding.id)).size === recorded.findings.length, {
  message: 'each finding is answered once',
  path: ['findings'],
});
export type FixRecorded = z.infer<typeof fixRecordedV3>;

/** `unit.unattempted` over the four editing phases, so the documentation step's unit can be settled without an answer (R8 of the documentation step). */
export const unitUnattemptedV2 = z.strictObject({
  ...unitUnattemptedV1.shape,
  phase: editingPhaseSchemaV8,
});
export type UnitUnattempted = z.infer<typeof unitUnattemptedV2>;

/** `fix.reopened` that can list the documentation step's unit, which the run budget can leave not attempted (R8 of the documentation step). */
export const fixReopenedV2 = z.strictObject({
  units: z.array(z.strictObject({ phase: z.enum(['fixes', 'documentation', 'repair']), key: unitKeySchema })).min(1),
}).refine((reopened) => new Set(reopened.units.map((unit) => `${unit.phase}:${unit.key}`)).size === reopened.units.length, {
  message: 'each unit is reopened once',
  path: ['units'],
});
export type FixReopened = z.infer<typeof fixReopenedV2>;

/** The id of a documentation item: `doc-1` to `doc-n` for the documents, in the order of their first line, then `search`. */
export const documentationItemIdSchema = z.string().regex(/^(doc-[1-9][0-9]*|search)$/, 'a documentation item id is doc and a number from 1, or search');

/** The id of the item that answers for what the documentation step's own search finds. */
export const documentationSearchId = 'search';

/** One item of the documentation step's plan: a document the `drift` lines of the fixes name, with those lines, or the search. */
const documentationItemSchemaV1 = z.strictObject({
  /** `doc-1` to `doc-n` for the documents, then `search`. */
  id: documentationItemIdSchema,
  /** The path as the first `drift` line wrote it; null for `search`. */
  file: z.string().min(1).max(1000).nullable(),
  /** The repository path that `file` names, read as a reported path; null when the engine refuses it, and for `search`. */
  path: claimedPathSchema.nullable(),
  /** The lines the item holds, each with the batch that reported it; none for `search`. */
  drift: z.array(z.strictObject({ key: unitKeySchema, file: z.string().min(1), what: z.string().min(1) })),
});

/**
 * Hold a plan of the documentation step to its form (TD2, TD8 of the
 * documentation step): the document items first, numbered `doc-1`
 * upward, each with a file and a line or more, and the item `search`
 * last, with no file, no path and no line; no two items with one path.
 */
function refineDocumentationPlan(plan: { readonly items: readonly z.infer<typeof documentationItemSchemaV1>[] }, context: z.RefinementCtx): void {
  const last = plan.items.length - 1;
  plan.items.forEach((item, index) => {
    const expected = index === last ? documentationSearchId : `doc-${String(index + 1)}`;
    if (item.id !== expected) context.addIssue({ code: 'custom', message: `item ${String(index + 1)} is ${expected}: the documents from doc-1 in order, then search`, path: ['items', index, 'id'] });
    if (item.id === documentationSearchId && (item.file !== null || item.path !== null || item.drift.length > 0)) context.addIssue({ code: 'custom', message: 'the search names no file, no path and no line', path: ['items', index] });
    if (item.id !== documentationSearchId && (item.file === null || item.drift.length === 0)) context.addIssue({ code: 'custom', message: 'a document item has its file and a line or more', path: ['items', index] });
  });
  const paths = plan.items.flatMap((item) => (item.path === null ? [] : [item.path]));
  if (new Set(paths).size !== paths.length) context.addIssue({ code: 'custom', message: 'no two items have one path', path: ['items'] });
}

/**
 * The plan of the documentation step (R2, R5, TD2 of the documentation
 * step), recorded before its worker starts: each document the `drift`
 * lines of the fixes name, with its lines, then the search. The fold
 * holds it to the ledger: every `drift` line of the answers of the fixes,
 * once each, and no other.
 */
export const documentationPlannedV1 = z.strictObject({
  items: z.array(documentationItemSchemaV1).min(1),
}).superRefine(refineDocumentationPlan);
export type DocumentationPlanned = z.infer<typeof documentationPlannedV1>;
export type DocumentationItem = DocumentationPlanned['items'][number];

/**
 * Whether a documentation item is a document rather than the search: the
 * plan's form gives every document its file and the search none, so the
 * null file means the search and no other item.
 */
export function isDocumentItem(item: DocumentationItem): item is DocumentationItem & { readonly file: string } {
  return item.file !== null;
}

/**
 * The vocabulary version 9 of the review events records (R1, R2, TD1 of
 * the facts before a merge): the twenty phases, with `base-checks` after
 * the checks after the fixes and before the repair; the five check
 * phases, with `base-checks`; and the three readings of a comparison with
 * the base. Frozen here for the reason `reviewVocabularyV1` is: a test
 * holds it equal to today's vocabulary. The engine writes a version over
 * this vocabulary only for an event that names the phase or carries a
 * comparison (TD7), so a run configured before it holds none of them.
 */
export const reviewVocabularyV9 = {
  phases: [
    'survey',
    'triage', 'finders', 'deduplication', 'verification', 'sweep', 'sweep-deduplication', 'sweep-verification', 'merge-rank',
    'decision',
    'baseline-checks', 'fixes', 'documentation', 'checks', 'base-checks', 'repair', 'repair-checks',
    'answer', 'answer-checks',
    'report',
  ],
  checkPhases: ['baseline-checks', 'checks', 'base-checks', 'repair-checks', 'answer-checks'],
  baseReadings: ['same', 'adds', 'unknown'],
} as const;

const vocabularyV9 = reviewVocabularyV9;
const phaseSchemaV9 = z.enum(vocabularyV9.phases);
const checkPhaseSchemaV9 = z.enum(vocabularyV9.checkPhases);

/**
 * `review.configured` with the checks on the base (TD8 of the facts before
 * a merge): version 7 unchanged. The version alone says that the run has
 * the phase `base-checks`, as version 7 said it has the documentation
 * step.
 */
export const reviewConfiguredV8 = reviewConfiguredV7;
export type ReviewConfigurationV8 = z.infer<typeof reviewConfiguredV8>;

/** `phase.started` over the twenty phases. */
export const phaseStartedV7 = z.strictObject({
  phase: phaseSchemaV9,
  attempt: z.number().int().min(1),
});
export type PhaseStarted = z.infer<typeof phaseStartedV7>;

/** `phase.finished` over the twenty phases, with the blocker codes of version 5. */
export const phaseFinishedV8 = z.strictObject({
  phase: phaseSchemaV9,
  attempt: z.number().int().min(1),
  outcome: z.enum(vocabularyV3.phaseOutcomes),
  blocker: blockerSchemaV5.nullable(),
}).refine((finish) => (finish.outcome === 'blocked') === (finish.blocker !== null), {
  message: 'a blocker is present exactly when the outcome is blocked',
  path: ['blocker'],
});
export type PhaseFinished = z.infer<typeof phaseFinishedV8>;

/** `worktree.checked` over the twenty phases, with the moments of version 6. */
export const worktreeCheckedV8 = z.strictObject({
  ...worktreeCheckedV6.shape,
  phase: phaseSchemaV9,
}).refine((check) => check.drifted === (check.files.length > 0 || check.head !== null), {
  message: 'drifted exactly when some file differs or HEAD moved',
  path: ['drifted'],
});
/** A worktree check as the fold holds it, whichever version recorded it. */
export type WorktreeCheckV8 = z.infer<typeof worktreeCheckedV8>;

/** `check.started` over the five check phases, so a run on the base has its start (R11 of the facts before a merge). */
export const checkStartedV2 = z.strictObject({
  ...checkStartedV1.shape,
  phase: checkPhaseSchemaV9,
});
export type CheckStarted = z.infer<typeof checkStartedV2>;

/** `check.ran` over the five check phases, so a run on the base can name its phase. */
export const checkRanV4 = z.strictObject({
  ...checkRanV3.shape,
  phase: checkPhaseSchemaV9,
}).superRefine(refineCheckRan);
/** A check's run as the fold holds it: a version 1 or 2 run reads as one that replaces nothing. */
export type CheckRan = z.infer<typeof checkRanV4>;

/** The longest words of a comparison with the base: the cap the repair's schema gives them. */
export const comparisonWordsLengthV1 = 400;

/**
 * `fix.recorded` with the repair's comparison of each check that failed
 * or timed out on the base, once per kind (R2, TD6, TD13 of the facts
 * before a merge): its reading of the failures before the fixes, on the
 * change as submitted, against those on the base, with the worker's words
 * on why. Written only for the repair of a run with the phase
 * `base-checks`, its comparisons empty when it gave none; every other
 * answer keeps the version it is written at today (TD7).
 */
export const fixRecordedV4 = z.strictObject({
  ...fixRecordedV3.shape,
  comparisons: z.array(z.strictObject({
    kind: checkKindSchemaV3,
    reading: z.enum(vocabularyV9.baseReadings),
    words: z.string().min(1).max(comparisonWordsLengthV1),
  })),
}).refine((recorded) => new Set(recorded.findings.map((finding) => finding.id)).size === recorded.findings.length, {
  message: 'each finding is answered once',
  path: ['findings'],
});
/** An answer of an editing unit as the fold holds it: an answer recorded before version 4 reads as one with no comparison. */
export type FixRecordedV4 = z.infer<typeof fixRecordedV4>;
/** One comparison of the repair, of a check's failures before the fixes with those on the base. */
export type BaseComparison = FixRecordedV4['comparisons'][number];

/** `report.written` over the twenty phases: the statistics gain the row of the checks on the base. */
export const reportWrittenV7 = z.strictObject({
  report: artifactReferenceSchema,
  statistics: z.strictObject({
    phases: z.array(spendSchema.extend({ phase: phaseSchemaV9 })),
    total: spendSchema,
    budgetApplied: z.boolean(),
  }),
  patches: z.array(artifactReferenceSchema).max(2000),
});
/** The report as the fold holds it: version 1 reads as a report with no patch. */
export type ReportWritten = z.infer<typeof reportWrittenV7>;

/** Every event kind this engine can write or read. Later elements add theirs here. */
export const eventRegistry = defineRegistry({
  'run.created': { 1: { schema: runCreatedV1 } },
  'run.abandoned': { 1: { schema: runAbandonedV1 } },
  'scope.captured': { 1: { schema: scopeCapturedV1 }, 2: { schema: scopeCapturedV2 } },
  'worker.launched': { 1: { schema: workerLaunchedV1 } },
  'worker.finished': { 1: { schema: workerFinishedV1 } },
  'worker.lost': { 1: { schema: workerLostV1 }, 2: { schema: workerLostV2 }, 3: { schema: workerLostV3 }, 4: { schema: workerLostV4 }, 5: { schema: workerLostV5 }, 6: { schema: workerLostV6 } },
  'review.configured': { 1: { schema: reviewConfiguredV1 }, 2: { schema: reviewConfiguredV2 }, 3: { schema: reviewConfiguredV3 }, 4: { schema: reviewConfiguredV4 }, 5: { schema: reviewConfiguredV5 }, 6: { schema: reviewConfiguredV6 }, 7: { schema: reviewConfiguredV7 }, 8: { schema: reviewConfiguredV8 } },
  'limits.changed': { 1: { schema: limitsChangedV1 } },
  'phase.started': { 1: { schema: phaseStartedV1 }, 2: { schema: phaseStartedV2 }, 3: { schema: phaseStartedV3 }, 4: { schema: phaseStartedV4 }, 5: { schema: phaseStartedV5 }, 6: { schema: phaseStartedV6 }, 7: { schema: phaseStartedV7 } },
  'phase.finished': { 1: { schema: phaseFinishedV1 }, 2: { schema: phaseFinishedV2 }, 3: { schema: phaseFinishedV3 }, 4: { schema: phaseFinishedV4 }, 5: { schema: phaseFinishedV5 }, 6: { schema: phaseFinishedV6 }, 7: { schema: phaseFinishedV7 }, 8: { schema: phaseFinishedV8 } },
  'worktree.checked': { 1: { schema: worktreeCheckedV1 }, 2: { schema: worktreeCheckedV2 }, 3: { schema: worktreeCheckedV3 }, 4: { schema: worktreeCheckedV4 }, 5: { schema: worktreeCheckedV5 }, 6: { schema: worktreeCheckedV6 }, 7: { schema: worktreeCheckedV7 }, 8: { schema: worktreeCheckedV8 } },
  'candidates.recorded': { 1: { schema: candidatesRecordedV1 }, 2: { schema: candidatesRecordedV2 } },
  'attempt.failed': { 1: { schema: attemptFailedV1 }, 2: { schema: attemptFailedV2 }, 3: { schema: attemptFailedV3 }, 4: { schema: attemptFailedV4 }, 5: { schema: attemptFailedV5 }, 6: { schema: attemptFailedV6 }, 7: { schema: attemptFailedV7 }, 8: { schema: attemptFailedV8 } },
  'angle.failed': { 1: { schema: angleFailedV1 } },
  'deduplication.recorded': { 1: { schema: deduplicationRecordedV1 } },
  'verification.planned': { 1: { schema: verificationPlannedV1 } },
  'verdicts.recorded': { 1: { schema: verdictsRecordedV1 } },
  'group.unverified': { 1: { schema: groupUnverifiedV1 } },
  'ranking.recorded': { 1: { schema: rankingRecordedV1 } },
  'report.written': { 1: { schema: reportWrittenV1 }, 2: { schema: reportWrittenV2 }, 3: { schema: reportWrittenV3 }, 4: { schema: reportWrittenV4 }, 5: { schema: reportWrittenV5 }, 6: { schema: reportWrittenV6 }, 7: { schema: reportWrittenV7 } },
  'fixes.planned': { 1: { schema: fixesPlannedV1 } },
  'fixes.replanned': { 1: { schema: fixesReplannedV1 } },
  'checks.planned': { 1: { schema: checksPlannedV1 }, 2: { schema: checksPlannedV2 }, 3: { schema: checksPlannedV3 } },
  'check.started': { 1: { schema: checkStartedV1 }, 2: { schema: checkStartedV2 } },
  'check.ran': { 1: { schema: checkRanV1 }, 2: { schema: checkRanV2 }, 3: { schema: checkRanV3 }, 4: { schema: checkRanV4 } },
  'tree.restored': { 1: { schema: treeRestoredV1 } },
  'fix.recorded': { 1: { schema: fixRecordedV1 }, 2: { schema: fixRecordedV2 }, 3: { schema: fixRecordedV3 }, 4: { schema: fixRecordedV4 } },
  'tree.revised': { 1: { schema: treeRevisedV1 }, 2: { schema: treeRevisedV2 }, 3: { schema: treeRevisedV3 } },
  'unit.unattempted': { 1: { schema: unitUnattemptedV1 }, 2: { schema: unitUnattemptedV2 } },
  'commits.prepared': { 1: { schema: commitsPreparedV1 } },
  'commits.created': { 1: { schema: commitsCreatedV1 } },
  'commits.dropped': { 1: { schema: commitsDroppedV1 } },
  'survey.recorded': { 1: { schema: surveyRecordedV1 } },
  'survey.failed': { 1: { schema: surveyFailedV1 } },
  'decisions.recorded': { 1: { schema: decisionsRecordedV1 } },
  'files.claimed': { 1: { schema: filesClaimedV1 } },
  'claims.lost': { 1: { schema: claimsLostV1 } },
  'fix.pinned': { 1: { schema: fixPinnedV1 }, 2: { schema: fixPinnedV2 } },
  'fix.reopened': { 1: { schema: fixReopenedV1 }, 2: { schema: fixReopenedV2 } },
  'documentation.planned': { 1: { schema: documentationPlannedV1 } },
  'answer.recorded': { 1: { schema: answerRecordedV1 } },
  'answer.pass': { 1: { schema: answerPassV1 } },
});

export type EventRegistry = typeof eventRegistry;
