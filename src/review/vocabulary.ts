/**
 * The words the read-only review is described in, declared once so the
 * ledger's event schemas, the planner, the prompts and the report all spell
 * them the same way. Nothing here reads a file or a state.
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

/** The roles the read-only review runs, in phase order: every angle's role, then the later phases'. The role policy must name exactly these. */
export const reviewRoles = [...angles.map(roleOfAngle), 'deduplication', 'verifier', 'sweep', 'merge-rank'] as const;
export type ReviewRole = (typeof reviewRoles)[number];

/** Whether a review role is one of the nine finders'. */
export const isFinderRole = (role: ReviewRole): role is FinderRole => role.startsWith('finder-');

/**
 * The phases of a review, in the order they run (R2). `report` is a phase
 * with no worker: it is started so the worktree check before the report
 * has a phase to block, and finished when the report is written.
 */
export const phases = ['triage', 'finders', 'deduplication', 'verification', 'sweep', 'sweep-deduplication', 'sweep-verification', 'merge-rank', 'report'] as const;
export const phaseSchema = z.enum(phases);
export type Phase = z.infer<typeof phaseSchema>;

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
 * each (R5, R6, R7). The first three are recorded on `phase.finished`;
 * `lock-held` and `runtime-unqualified` are refused before any event
 * exists and are printed, never recorded.
 */
export const blockerCodes = ['worker-failed', 'budget', 'drift', 'lock-held', 'runtime-unqualified'] as const;
export type BlockerCode = (typeof blockerCodes)[number];
export const recordedBlockerCodes = ['worker-failed', 'budget', 'drift'] as const;
export const recordedBlockerCodeSchema = z.enum(recordedBlockerCodes);
export type RecordedBlockerCode = z.infer<typeof recordedBlockerCodeSchema>;

/** The operator's action for each blocker code; a test holds every code to having one. */
export const blockerActions: Readonly<Record<BlockerCode, string>> = {
  'worker-failed': 'run the command again, which gives the failed worker two fresh attempts, or abandon the run',
  budget: 'run the command again with --budget-usd above the spend, or abandon the run',
  drift: 'restore the named files to the reviewed change and run the command again, or abandon the run and start a new one',
  'lock-held': 'wait for that engine to finish; the lock clears itself when its process ends',
  'runtime-unqualified': 'fix the runtime installation or pass --executable with a qualifying binary, then run the command again',
};

/** The verifier's three routing labels (rubrics.md). */
export const verdicts = ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'] as const;
export const verdictSchema = z.enum(verdicts);
export type Verdict = z.infer<typeof verdictSchema>;

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
