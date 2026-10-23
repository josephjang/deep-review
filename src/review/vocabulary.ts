/**
 * The words a review is described in, read-only and fix pass alike,
 * declared once so the ledger's event schemas, the planner, the prompts and
 * the report all spell them the same way. Nothing here reads a file or a
 * state.
 */
import { z } from 'zod';

/** The nine angles a finder worker runs, in the order they launch; `SCAN` is run by the triage worker. */
export const finderAngles = ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'] as const;
export const finderAngleSchema = z.enum(finderAngles);
export type FinderAngle = z.infer<typeof finderAngleSchema>;

/** The ten angles of a review, in the order the report lists them: `SCAN`, then the finder angles. */
export const angles = ['SCAN', ...finderAngles] as const;
export const angleSchema = z.enum(angles);
export type Angle = z.infer<typeof angleSchema>;

/**
 * The two classes of angle. A `correctness` angle's findings name a
 * failure: the rubric's "correctness & cost" angles and `CONVENTIONS`. A
 * `design` angle's findings name an improvement, with a `value_statement`
 * for their fourth field. Correctness outranks design at equal severity and
 * verdict (the rubric's cross-class tiebreak, TD9).
 */
export type AngleClass = 'correctness' | 'design';

/** The class of every angle, declared once; an angle added without a class does not compile. */
export const angleClasses: Readonly<Record<Angle, AngleClass>> = {
  SCAN: 'correctness',
  REMOVALS: 'correctness',
  RIPPLE: 'correctness',
  FOOTGUNS: 'correctness',
  WRAPPERS: 'correctness',
  EFFICIENCY: 'correctness',
  DESIGN: 'design',
  DUPLICATION: 'design',
  ALTITUDE: 'design',
  CONVENTIONS: 'correctness',
};

/** The role of the finder worker that runs a finder angle. */
export type FinderRole = `finder-${FinderAngle}`;

/** The role that runs each angle: the triage worker runs `SCAN`, a finder every other. */
export function roleOfAngle(angle: Angle): 'triage' | FinderRole {
  return angle === 'SCAN' ? 'triage' : `finder-${angle}`;
}

/**
 * The roles a review runs, in phase order: the survey's `surveyor`, every
 * angle's role, the later read-only phases', the decision step's
 * `decider`, the fix pass's `fixer`, which runs the fixes, the repair and
 * an answer pass, and the documentation step's `documentation` (PD8 of
 * the documentation step). The role policy must name exactly these.
 */
export const reviewRoles = ['surveyor', ...angles.map(roleOfAngle), 'deduplication', 'verifier', 'sweep', 'merge-rank', 'decider', 'fixer', 'documentation'] as const;
export type ReviewRole = (typeof reviewRoles)[number];

/** Whether a review role is one of the nine finders'. */
export const isFinderRole = (role: ReviewRole): role is FinderRole => role.startsWith('finder-');

/**
 * The phases of a review, in the order they run (R2 of the read-only
 * review, R1 of the fix pass, R1 of the repository survey, R1 of the
 * decision step, R9 of answers, R1 of the documentation step): the
 * survey, which a run configured before it existed records as skipped,
 * the read-only phases, the decision, which a run configured before it
 * existed records as skipped and every later run runs, `--fix` or not,
 * then the six of the fix pass, which a run without `--fix` records as
 * skipped, with the documentation step after the fixes, which a run
 * configured before it existed records as skipped too, then the two of the
 * answer pass, which every run records as skipped and only an
 * `answer.pass` opens, then `report`, a phase with no worker that is
 * started so the worktree check before the report has a phase to block,
 * and finished when the report is written.
 */
export const phases = [
  'survey',
  'triage', 'finders', 'deduplication', 'verification', 'sweep', 'sweep-deduplication', 'sweep-verification', 'merge-rank',
  'decision',
  'baseline-checks', 'fixes', 'documentation', 'checks', 'repair', 'repair-checks',
  'answer', 'answer-checks',
  'report',
] as const;
export const phaseSchema = z.enum(phases);
export type Phase = z.infer<typeof phaseSchema>;

/** The six phases of the fix pass, in the order they run; a run without `--fix` skips them, and a run configured before the documentation step its `documentation`. */
export const fixPhases = ['baseline-checks', 'fixes', 'documentation', 'checks', 'repair', 'repair-checks'] as const;
export type FixPhase = (typeof fixPhases)[number];

/**
 * The two phases of the answer pass, in the order they run (R5 of
 * answers): one fixer applies the answers that owe an edit, then the
 * checks run again. Every configuration skips them; an `answer.pass` on a
 * complete fix run opens them, so `configure` skips them and `fixPhases`
 * does not hold them.
 */
export const answerPhases = ['answer', 'answer-checks'] as const;
export type AnswerPhase = (typeof answerPhases)[number];

/** The phases that run the repository's checks and no worker: before any edit, after the fixes, after the repair, after an answer pass. */
export const checkPhases = ['baseline-checks', 'checks', 'repair-checks', 'answer-checks'] as const;
export const checkPhaseSchema = z.enum(checkPhases);
export type CheckPhase = z.infer<typeof checkPhaseSchema>;

/** The phases whose workers edit the tree: one fixer per batch of a cluster's findings, then the one documentation worker, then the one repair worker, then an answer pass's one fixer. */
export const editingPhases = ['fixes', 'documentation', 'repair', 'answer'] as const;
export const editingPhaseSchema = z.enum(editingPhases);
export type EditingPhase = z.infer<typeof editingPhaseSchema>;

export const isCheckPhase = (phase: Phase): phase is CheckPhase => (checkPhases as readonly string[]).includes(phase);
export const isEditingPhase = (phase: Phase): phase is EditingPhase => (editingPhases as readonly string[]).includes(phase);

/** The unit key of the one repair worker. */
export const repairUnitKey = 'repair';

/** The unit key of the one documentation worker (R1 of the documentation step), its phase's name as `singleUnitKey` gives it. */
export const documentationUnitKey = 'documentation';

/**
 * The editing phases whose units the run budget settles as not attempted
 * instead of blocking (R19 of the fix pass, R8 of the documentation
 * step): the fixes, the documentation step and the repair, so their edits
 * reach a report. The answer pass's one fixer blocks at the
 * budget instead, as a reading phase's worker does (TD8 of answers): on
 * its retry, the edits its failed attempt recorded stay unreported until
 * the run is resumed with `--budget-usd`, or abandoned.
 */
export const budgetDegradingPhases = ['fixes', 'documentation', 'repair'] as const satisfies readonly EditingPhase[];
export const isBudgetDegradingPhase = (phase: Phase): phase is (typeof budgetDegradingPhases)[number] => (budgetDegradingPhases as readonly string[]).includes(phase);

/**
 * The editing phases whose units share the tree through claims and rounds
 * (PD3, R5 of the fix pass): the fixes, whose clusters' fixers each hold
 * their own files and claim others. The repair and an answer pass's one
 * fixer are alone in the tree and claim nothing, and so is the
 * documentation step, which runs after every fixer of the fixes.
 */
export const claimingPhases = ['fixes'] as const satisfies readonly EditingPhase[];
export const isClaimingPhase = (phase: Phase): phase is (typeof claimingPhases)[number] => (claimingPhases as readonly string[]).includes(phase);

/** A fix cluster id as the plan assigns it: `c` and a number from 1, in the order of each cluster's best-ranked finding. */
export const clusterIdSchema = z.string().regex(/^c[1-9][0-9]*$/, 'a cluster id is c and a number from 1');

/** A fixer batch's key, the unit key of a fixes-phase worker (R18 of the fix pass): its cluster's id, a dash, and its number in the cluster from 1. */
export const batchKeySchema = z.string().regex(/^c[1-9][0-9]*-[1-9][0-9]*$/, 'a batch key is a cluster id, a dash and a number from 1');

/**
 * How one run of a check ended (R9 of the fix pass): its exit code, its
 * timeout, a spawn that failed, or not run because `build` did not pass;
 * or cut, ended by a kill from outside the engine with no result of its
 * own (R4 of resumable runs), which only `check.ran@3` records.
 */
export const checkOutcomes = ['passed', 'failed', 'timeout', 'not-started', 'skipped', 'cut'] as const;
export const checkOutcomeSchema = z.enum(checkOutcomes);
export type CheckOutcome = z.infer<typeof checkOutcomeSchema>;

/** The phases whose workers return candidates. */
export const candidatePhases = ['triage', 'finders', 'sweep'] as const;
export const candidatePhaseSchema = z.enum(candidatePhases);
export type CandidatePhase = z.infer<typeof candidatePhaseSchema>;

/** The two deduplication phases: over the triage and finder candidates, then over the sweep's. */
export const deduplicationPhases = ['deduplication', 'sweep-deduplication'] as const;
export const deduplicationPhaseSchema = z.enum(deduplicationPhases);
export type DeduplicationPhase = z.infer<typeof deduplicationPhaseSchema>;

/** The two verification phases, each one verifier per group. */
export const verificationPhases = ['verification', 'sweep-verification'] as const;
export const verificationPhaseSchema = z.enum(verificationPhases);
export type VerificationPhase = z.infer<typeof verificationPhaseSchema>;

/** How a phase ended: every unit answered, some unit degraded by its role's rule, or the run blocked. */
export const phaseOutcomes = ['completed', 'degraded', 'blocked'] as const;
export const phaseOutcomeSchema = z.enum(phaseOutcomes);
export type PhaseOutcome = z.infer<typeof phaseOutcomeSchema>;

/**
 * Why a run stopped short of a report, with the operator's action for
 * each (R5, R6, R7; R15 of the repository survey; R12 of commit series
 * integrity). The first five are recorded on `phase.finished`;
 * `lock-held` and `runtime-unqualified` are refused before any event
 * exists and are printed, never recorded.
 */
export const blockerCodes = ['worker-failed', 'budget', 'drift', 'check-unavailable', 'claims-lost', 'lock-held', 'runtime-unqualified'] as const;
export type BlockerCode = (typeof blockerCodes)[number];
export const recordedBlockerCodes = ['worker-failed', 'budget', 'drift', 'check-unavailable', 'claims-lost'] as const;
export const recordedBlockerCodeSchema = z.enum(recordedBlockerCodes);
export type RecordedBlockerCode = z.infer<typeof recordedBlockerCodeSchema>;

/**
 * Whose fault a failed attempt was (R12 of commit series integrity): the
 * unit's, or its environment's, a claims directory removed while it ran;
 * or, from `attempt.failed@7` on, a kill from outside the engine that left
 * a kill mark (`cut`, R4 of resumable runs) or the provider's usage limit
 * (`limit`, R14). Each uses an attempt, but only the unit's can degrade
 * the unit: one out of attempts with another among its failures blocks
 * its phase instead (`interrupted` in steps.ts).
 */
export const attemptFaults = ['unit', 'environment', 'cut', 'limit'] as const;
export type AttemptFault = (typeof attemptFaults)[number];

/** When a worktree check is made: at an attempt's start, before an answer is recorded, once an editing phase's last unit settled, or after a write back (R7 of resumable runs). */
export const worktreeMoments = ['start', 'answer', 'end', 'restored'] as const;

/**
 * Why the engine left a claim marker out of the ledger (R3 of commit
 * series integrity, review F9): a cluster of the round owns the path, an
 * unsettled other cluster holds it on the ledger, or the marker names a
 * unit the plan lacks.
 */
export const lostClaimReasons = ['owned', 'held', 'unplanned'] as const;
export type LostClaimReason = (typeof lostClaimReasons)[number];

/** Whom a lost claim's path went to, as the log and the report name it: its holder's cluster, or none for a unit the plan lacks. */
export const lostClaimWords = (holder: string | null): string => (holder === null ? 'which no batch of the round has' : `to ${holder}`);

/** The operator's action for each blocker code; a test holds every code to having one. */
export const blockerActions: Readonly<Record<BlockerCode, string>> = {
  'worker-failed': 'run the command again, which gives the failed worker two fresh attempts, or abandon the run',
  budget: 'run the command again with --budget-usd above the spend, or abandon the run',
  drift: 'restore the named files to the bytes the run expected, which the detail gives as evidence paths (a file expected absent is removed), reset a moved HEAD to the recorded head, and run the command again, or abandon the run and start a new one',
  // A run not continued from a read-only review blocks in its survey before any other worker, so a new run costs one survey; a resume would not read the clone's file (R8, PD7 of the skill surface corrections). A continued run records continuedCheckUnavailableAction.
  'check-unavailable': 'install the missing tool and run the command again, or run it again with --no-check <kind> to go without that check, or with --check <kind>=<command> to name one that runs, or set checks.<kind> in the clone\'s file, which deep-review config init --clone writes, then abandon this run and start a new one, which needs the flag on no resume; this run keeps the settings it recorded',
  'claims-lost': 'run the command again, which seeds the claims directory from the ledger and gives the units that ran without it fresh attempts, or abandon the run',
  'lock-held': 'wait for that engine to finish; the lock clears itself when its process ends',
  'runtime-unqualified': 'fix the runtime installation or pass --executable with a qualifying binary, then run the command again',
};

/**
 * The `check-unavailable` action of a run continued from a read-only
 * review into the fix pass (R8, PD7 of the skill surface corrections):
 * its survey blocks after the whole review, and an abandoned run cannot
 * be continued, so the clone's file, which only a new run reads, would
 * throw that review away; the action names the three ways a resume takes.
 */
export const continuedCheckUnavailableAction = 'install the missing tool and run the command again, or run it again with --no-check <kind> to go without that check, or with --check <kind>=<command> to name one that runs';

/**
 * The `worker-failed` action when the survey of a fix run blocks (R9 of
 * the repository survey): going on with no survey would run no check the
 * flags did not name, so the operator may name all four instead. The run
 * then surveys no more; an answer an earlier attempt recorded, before a
 * `check-unavailable` block, stays the run's survey and its convention
 * sources govern the review, and with none the run records the survey as
 * failed and goes on with no convention source.
 */
export const surveyWorkerFailedAction = 'run the command again, which surveys the repository afresh, or run it again with --check <kind>=<command> or --no-check <kind> for each of build, typecheck, lint and test, which goes on without surveying again, with the convention sources of an earlier survey of this run if one answered, and with none otherwise, or abandon the run';

/**
 * Every wording `surveyWorkerFailedAction` has had, the current one first:
 * a ledger keeps the action its block recorded, and a block under an
 * earlier wording made the same promise, so the survey reads each of them
 * as a survey that failed (R9 of the repository survey). A rewording adds the
 * old text here.
 */
export const surveyWorkerFailedActions: readonly string[] = [
  surveyWorkerFailedAction,
  'run the command again, which surveys the repository afresh, or run it again with --check <kind>=<command> or --no-check <kind> for each of build, typecheck, lint and test, which goes on without the survey and its convention sources, or abandon the run',
];

/** How a configured run is held to what it pinned: resumed, continued into the fix pass, or reopened by an answer pass, the last two of whose refusals name another way out (TD6 of fix pass continuation, R6 of answers). */
export type PinnedUse = 'resume' | 'continue' | 'answer';

/**
 * The way out a refusal of a pinned run names besides the flag that
 * matches: abandoning an active run; a new run for a finished one, which
 * is not abandoned; or applying the answer by hand for a complete run an
 * answer pass would reopen, which the refusal leaves complete.
 */
export function wayOut(runId: string, use: PinnedUse): string {
  switch (use) {
    case 'resume':
      return `abandon it with \`deep-review abandon --run ${runId} --reason <text>\``;
    case 'continue':
      return 'start a new run with --fresh';
    case 'answer':
      return `apply the answer by hand; the answer is recorded, and run ${runId} stays complete with its report`;
  }
}

/**
 * The `runtime-unqualified` action for a configured run, which keeps the
 * executable it pinned and ignores `--executable`, so the action for a new
 * run would name a flag that changes nothing: the way out is the pinned
 * path qualifying again, or a new run, after abandoning an active one; a
 * finished run continued into the fix pass, or reopened by an answer
 * pass, is not abandoned (`wayOut`).
 */
export function pinnedRuntimeAction(runId: string, executable: string, use: PinnedUse): string {
  const newRun = use === 'resume' ? `abandon the run with \`deep-review abandon --run ${runId} --reason <text>\` and start a new one` : wayOut(runId, use);
  return `make ${executable}, the executable run ${runId} is pinned to, qualify again (reinstall the runtime version the run started with) and run the command again, or ${newRun}; a configured run ignores --executable`;
}

/**
 * The kinds of check the fix pass runs, in the order they run (R8, R9 of
 * the fix pass): `build` first, since the other three read what it
 * produces, then `typecheck`, `lint` and `test`.
 */
export const checkKinds = ['build', 'typecheck', 'lint', 'test'] as const;
export const checkKindSchema = z.enum(checkKinds);
export type CheckKind = z.infer<typeof checkKindSchema>;

/**
 * Who decided a check's command (R6 of the repository survey): a
 * `--check` or `--no-check` flag, the survey, or nobody, when the survey
 * found the repository has none for the kind. The manifest rules that
 * once decided are the rules a hint names (`checks/discover.ts`).
 */
export const checkOrigins = ['flag', 'survey', 'none'] as const;
export const checkOriginSchema = z.enum(checkOrigins);
export type CheckOrigin = z.infer<typeof checkOriginSchema>;

/** What a surveyed command stood on (R11 of the repository survey): what the repository states, or the engine's mechanical hint. */
export const checkBases = ['stated', 'hint'] as const;
export const checkBaseSchema = z.enum(checkBases);
export type CheckBasis = z.infer<typeof checkBaseSchema>;

/** Where a convention source lives: in the repository, or among the reviewer's own user-level rules files. */
export const conventionLevels = ['repository', 'user'] as const;
export const conventionLevelSchema = z.enum(conventionLevels);
export type ConventionLevel = z.infer<typeof conventionLevelSchema>;

/**
 * Whether the reviewer's own rules files are convention sources (R3 of
 * the repository survey): never, always, or when the surveyor has
 * grounds that the repository is the reviewer's own or adopts them.
 */
export const userRulesSettings = ['ignore', 'apply', 'judge'] as const;
export const userRulesSettingSchema = z.enum(userRulesSettings);
export type UserRulesSetting = z.infer<typeof userRulesSettingSchema>;

/**
 * What a fixer did with one finding (R5 of the fix pass): applied it,
 * found it already applied, deferred it with a reason, or was blocked.
 */
export const fixStatuses = ['applied', 'already-applied', 'deferred', 'blocked'] as const;
export const fixStatusSchema = z.enum(fixStatuses);
export type FixStatus = z.infer<typeof fixStatusSchema>;

/** How a fixer validated a fix (fixer-validation.md): a red run on the old code, a mutation, a static check, existing tests, or a stated limit. */
export const validationMethods = ['old-code', 'mutation', 'static', 'existing', 'limited'] as const;
export const validationMethodSchema = z.enum(validationMethods);
export type ValidationMethod = z.infer<typeof validationMethodSchema>;

/** The result of the suite a fixer ran itself. */
export const suiteResults = ['pass', 'fail', 'not-run'] as const;
export const suiteResultSchema = z.enum(suiteResults);

/** The verifier's three routing labels (rubrics.md). */
export const verdicts = ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'] as const;
export const verdictSchema = z.enum(verdicts);
export type Verdict = z.infer<typeof verdictSchema>;

/**
 * What the decision step makes of a ranked finding (R3 of the decision
 * step): a fixer applies it the way the decider chose, it is left with a
 * stated reason, or the author is asked one question while the default
 * the decider named stands. A fix run's fixer applies that default when
 * it edits the code; one that keeps the code goes to no fixer.
 */
export const decisionKinds = ['fix', 'leave', 'ask'] as const;
export const decisionKindSchema = z.enum(decisionKinds);
export type DecisionKind = z.infer<typeof decisionKindSchema>;

/**
 * What a person's answer to a decided finding is (R1, R3 of answers, PD2):
 * one of an ask's options, or the acceptance or the rejection of a fix's
 * departure from a rule. Every reader of an answer switches on it.
 */
export const answerKinds = ['option', 'accept', 'reject'] as const;
export type AnswerKind = (typeof answerKinds)[number];

/** How many of the decisions are of each kind (R8 of the decision step). */
export function decisionCounts(decisions: readonly { readonly decision: DecisionKind }[]): Record<DecisionKind, number> {
  return Object.fromEntries(decisionKinds.map((kind) => [kind, decisions.filter((entry) => entry.decision === kind).length])) as Record<DecisionKind, number>;
}

/** The counts of `decisionCounts` as the log, `status` and the report word them. */
export const decisionCountWords = (counts: Readonly<Record<DecisionKind, number>>): string => `${String(counts.fix)} to fix, ${String(counts.leave)} to leave, ${String(counts.ask)} to ask the author`;

/**
 * Why a finding is left, and no other reason (R3 of the decision step):
 * acting on it would edit only code outside the change, which did not
 * cause or worsen it; another finding's fix removes it; or the repository
 * states the behavior on purpose and the rule's reason reaches the case.
 */
export const leaveReasons = ['outside-change-not-regression', 'superseded', 'intended'] as const;
export const leaveReasonSchema = z.enum(leaveReasons);
export type LeaveReason = z.infer<typeof leaveReasonSchema>;

/** The severities merge-rank assigns, most severe first. */
export const severities = ['critical', 'major', 'minor'] as const;
export const severitySchema = z.enum(severities);
export type Severity = z.infer<typeof severitySchema>;

/** A candidate id as the engine assigns it: the angle, or `SWEEP`, and a number from 1 (`RIPPLE-2`, `SWEEP-1`). */
export const candidateIdSchema = z.string().regex(/^[A-Z]+-[1-9][0-9]*$/, 'a candidate id is an upper-case prefix, a dash and a number from 1');

/** A verification group id as the plan assigns it: `g` and a number from 1, in file order. */
export const groupIdSchema = z.string().regex(/^g[1-9][0-9]*$/, 'a group id is g and a number from 1');

/** The prefix of a sweep candidate's id; a sweep candidate also names the angle whose territory it sits in. */
export const sweepIdPrefix = 'SWEEP';

/**
 * The prefix of the candidate ids a candidate phase's unit assigns: the
 * unit's angle for the triage (`SCAN`) and a finder, `SWEEP` for the sweep.
 */
export function candidateIdPrefix(phase: CandidatePhase, key: string): string {
  return phase === 'sweep' ? sweepIdPrefix : key;
}

/** The unit key of the one triage worker: the `SCAN` angle it runs. */
export const triageUnitKey = 'SCAN';

/** The unit key of a phase with one worker: the phase's own name, except the triage's, which is the `SCAN` angle. */
export function singleUnitKey(phase: Phase): string {
  return phase === 'triage' ? triageUnitKey : phase;
}

/** The key of a unit on the ledger, one per worker task of a phase: the angle, the group id, or the phase name for a phase with one worker. */
export const unitKeySchema = z.string().regex(/^[A-Za-z0-9-]{1,40}$/, 'a unit key is letters, digits and dashes');

/**
 * The longest reason or detail the ledger records for a failed attempt, an
 * angle not run, a group unverified or a blocker: `recordedTextLengthV1`,
 * the cap of the `attempt.failed`, `angle.failed`, `group.unverified`
 * and blocker schemas in events.ts, which a test holds equal to this. Text
 * the engine composes is cut to fit it.
 */
export const maxRecordedTextLength = 4000;

/** `phase:key`, the name of a unit in progress lines, blockers, the fold's refusals and the controller's set of workers in flight. The fold keeps units by phase and key, never by this name. */
export const unitName = (phase: Phase, key: string): string => `${phase}:${key}`;
