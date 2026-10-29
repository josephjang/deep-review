/**
 * The facts of a fix run's checks that the brief gives before a merge (R3
 * to R5 of the facts before a merge; R4, R5 of the report for the person),
 * each computed from the fold alone, so nothing records them and a run an
 * engine before that change configured gets them too (TD9): each check's
 * outcome before the fixes and at its last run with when it ran, what its
 * base says, the fault of the table of the design that it has, and its
 * meaning from the ordered table `checkMeanings`; and the kinds of the
 * validations a fixer reports, in the order of their strength.
 */
import type { ScopeState } from '../checkpoint/events.ts';
import { kindsTakenToBase, lastCurrentRun, lastRecordedRun, type CheckRunState, type FixState } from '../checkpoint/fix-state.ts';
import type { ReviewState } from '../checkpoint/review-fold.ts';
import { isEmptyTree } from '../scope/git.ts';
import { baseNameOf, commitWords } from '../scope/scope-line.ts';
import { baseSkipReasons, failedOrTimedOut, repairUnitKey, treeCheckPhases, type BaseReading, type CheckKind, type CheckOutcome, type TreeCheckPhase, type ValidationMethod } from './vocabulary.ts';

/** When a run of a check ran, by its phase (R3 of the facts before a merge): before the fixes, after them, after the repair, or after an answer pass. */
export const checkMoments = ['before', 'fixes', 'repair', 'answers'] as const;
export type CheckMoment = (typeof checkMoments)[number];

/** When the last run of a check ran: after the fixes, after the repair or after the answers (R3). */
export const lastMoments = ['fixes', 'repair', 'answers'] as const satisfies readonly CheckMoment[];
export type LastMoment = (typeof lastMoments)[number];

/** The phases after the fixes, the latest first, whose run can be a check's last; a run on the base never is, so no later phase hides when a check failed (R3; #78). */
const afterPhases = ['answer-checks', 'repair-checks', 'checks'] as const satisfies readonly TreeCheckPhase[];
type AfterPhase = (typeof afterPhases)[number];

const lastMomentOf: Readonly<Record<AfterPhase, LastMoment>> = { checks: 'fixes', 'repair-checks': 'repair', 'answer-checks': 'answers' };
const momentOf: Readonly<Record<TreeCheckPhase, CheckMoment>> = { 'baseline-checks': 'before', ...lastMomentOf };

/**
 * Why the run could not compare a check it took to the base (R5 of the
 * facts before a merge): the base is the empty tree, no worktree of it
 * could be made, the build did not pass there, the check did not start or did
 * not run there, the repair gave no comparison, or the repair could not
 * compare the outputs.
 */
export const notComparedReasons = ['empty-tree', 'no-worktree', 'build-failed', 'not-started', 'not-run', 'no-comparison', 'unknown'] as const;
export type NotComparedReason = (typeof notComparedReasons)[number];

/** Each reason in the fixed words the brief gives; the error of a worktree of the base and the words of the repair stay in the report, since they can name local paths (R5). */
export const notComparedWords: Readonly<Record<NotComparedReason, string>> = {
  ...baseSkipReasons,
  'not-started': 'the check did not start on the base',
  'not-run': 'the check did not run on the base',
  'no-comparison': 'the repair gave no comparison',
  unknown: 'the repair could not compare the outputs',
};

/**
 * What the base says of a check that the run took there (R1, R2, R5 of
 * the facts before a merge): the base, how the kind's run there ended,
 * the repair's reading of the failures, and why the run could not compare
 * them when it could not.
 */
export interface BriefBase {
  /** The commit of the base as the scope records it; the text forms give its first 8 characters. */
  readonly commit: string;
  /** The base as a person reads it, such as `the merge base with origin/main` (`baseNameOf`). */
  readonly name: string;
  /** How the kind's run on the base ended, or null when it has none there. */
  readonly outcome: CheckOutcome | null;
  /** The repair's reading of the failures before the fixes against those on the base, or null when the base passed or the repair gave none. */
  readonly reading: BaseReading | null;
  /** Why the run could not compare the kind with the base, or null when it compared it: the base passed, or the repair read `same` or `adds`. */
  readonly reason: NotComparedReason | null;
}

/**
 * The faults of a check (R4, R5; the table of `fault` of the design):
 * the edits of the run made it fail, the change breaks it, the change
 * adds failures to those of the base, the run could not compare it with
 * the base, or the base has the same failures.
 */
export const checkFaults = ['edits', 'change-breaks', 'change-adds', 'not-compared', 'base-has'] as const;
export type CheckFault = (typeof checkFaults)[number];

/** One check with a command, as the brief gives it (R3 to R5). */
export interface BriefCheck {
  readonly kind: CheckKind;
  /** How its last run before the fixes ended, or null when it has none. */
  readonly before: CheckOutcome | null;
  /** How its last run ended, and when it ran: the current run of the latest phase after the fixes that has one, else the run that checked the newest tree; null where no check ran after the fixes. */
  readonly last: { readonly outcome: CheckOutcome; readonly when: LastMoment } | null;
  /** When it last passed, and last failed or timed out, before its last run, in the order of the ledger; null where no earlier run did. */
  readonly earlier: { readonly passed: CheckMoment | null; readonly failed: CheckMoment | null };
  /** What the base says of it, for a kind the run took to the base; null for any other, and for each kind of a run configured before the checks on the base (R10). */
  readonly base: BriefBase | null;
  /** Its fault, or null for none. */
  readonly fault: CheckFault | null;
}

type FaultFacts = Omit<BriefCheck, 'fault'>;

// A timeout counts as a failure, as the repair counts it (R4).
const failsNow = ({ last }: FaultFacts): boolean => last !== null && failedOrTimedOut(last.outcome);

/** A fault read from the base: it holds for a kind the run took there, and only while its last run fails, since the merge question is about the tree now (R5). */
const fromBase = (holds: (base: BriefBase) => boolean) => (check: FaultFacts): boolean => failsNow(check) && check.base !== null && holds(check.base);

/**
 * Whether each fault holds of a check (R4, R5; the table of the design).
 * A check takes the first fault of `checkFaults` that holds. `base-has`
 * and `not-compared` never both hold, so this order, the order the line
 * `Checks:` names them in, gives each check the fault of the design's
 * table, which lists `base-has` first.
 */
const faultHolds: Readonly<Record<CheckFault, (check: FaultFacts) => boolean>> = {
  edits: (check) => failsNow(check) && check.earlier.passed !== null,
  'change-breaks': fromBase((base) => base.outcome === 'passed'),
  'change-adds': fromBase((base) => base.reading === 'adds'),
  'not-compared': fromBase((base) => base.reason !== null),
  'base-has': fromBase((base) => base.reading === 'same'),
};

/** A run of a check after the fixes, with its phase. */
interface LastRun {
  readonly phase: AfterPhase;
  readonly run: CheckRunState;
}

/** The run that stands for the tree a check last checked: the current run of the latest phase after the fixes that has one, so no run a later revision made old stands for it; or when none is current, the run that checked the newest tree. */
function lastRunOf(review: Pick<ReviewState, 'answerPasses'> & { readonly fix: FixState }, kind: CheckKind): LastRun | null {
  const runs = (read: (phase: AfterPhase) => CheckRunState | null): LastRun[] => afterPhases.flatMap((phase) => {
    const run = read(phase);
    return run === null ? [] : [{ phase, run }];
  });
  const [current] = runs((phase) => lastCurrentRun(review, phase, kind));
  if (current !== undefined) return current;
  return runs((phase) => lastRecordedRun(review.fix, phase, kind)).reduce<LastRun | null>((found, entry) => (found === null || entry.run.revisionsBefore > found.run.revisionsBefore ? entry : found), null);
}

/**
 * When a check last passed, and last failed or timed out, before its last
 * run, in the order of the ledger: the runs of the phases that check the
 * reviewed tree, by the revisions before each, then by the order of the
 * phases, which run in that order between two revisions, then by the
 * order of the runs of a phase.
 */
function earlierOf(fix: FixState, kind: CheckKind, last: LastRun | null): BriefCheck['earlier'] {
  if (last === null) return { passed: null, failed: null };
  const runs = treeCheckPhases
    .flatMap((phase, rank) => fix.checks.runs[phase].flatMap((run, index) => (run.kind === kind ? [{ phase, run, order: [run.revisionsBefore, rank, index] as const }] : [])))
    .sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2]);
  const before = runs.slice(0, runs.findIndex((entry) => entry.run === last.run));
  const latest = (holds: (outcome: CheckOutcome) => boolean): CheckMoment | null => {
    const found = before.findLast((entry) => holds(entry.run.outcome));
    return found === undefined ? null : momentOf[found.phase];
  };
  return { passed: latest((outcome) => outcome === 'passed'), failed: latest(failedOrTimedOut) };
}

/** Why a run on the base was skipped, as it records it; a skipped run that records no reason, which `check.ran@4` refuses on the base, did not run there. */
export const skippedReason = (run: Pick<CheckRunState, 'skipReason'>): NotComparedReason => run.skipReason ?? 'not-run';

/** Why a kind's run on the base left it not compared, by how the run ended, or null when the run compared it (R5). */
const reasonOf: Readonly<Record<CheckOutcome, (run: CheckRunState, reading: BaseReading | null) => NotComparedReason | null>> = {
  passed: () => null,
  failed: (_run, reading) => (reading === null ? 'no-comparison' : reading === 'unknown' ? 'unknown' : null),
  timeout: (run, reading) => reasonOf.failed(run, reading),
  skipped: skippedReason,
  'not-started': () => 'not-started',
  cut: () => 'not-run',
};

/** What the base says of a kind the run took there: its last run there, which never grows old (TD5), and the repair's reading of it, which the fold holds to a kind that failed or timed out there. */
function baseOf(fix: FixState, kind: CheckKind, base: Pick<BriefBase, 'commit' | 'name'>): BriefBase {
  const run = lastRecordedRun(fix, 'base-checks', kind);
  const outcome = run?.outcome ?? null;
  const reading = failedOrTimedOut(outcome) ? (fix.answers.repair[repairUnitKey]?.comparisons.find((comparison) => comparison.kind === kind)?.reading ?? null) : null;
  return { ...base, outcome, reading, reason: run === null ? 'not-run' : reasonOf[run.outcome](run, reading) };
}

/**
 * Each check of a fix run with a command, as the brief gives it (R3 to
 * R5, TD9 of the facts before a merge): its outcome before the fixes, its
 * last run with when it ran, when it passed and failed before that, what
 * its base says when the run took it there, and its fault. The run took a
 * kind to the base when it is configured with the checks on the base and
 * the kind failed before the fixes and after them, as the runs after the
 * fixes recorded it, so an answer pass that makes those runs old does not
 * take the comparison away (R2, TD13).
 */
export function briefChecksOf(review: Pick<ReviewState, 'answerPasses' | 'baseChecksStep'> & { readonly fix: FixState }, scope: Pick<ScopeState, 'base' | 'mode' | 'request'>): BriefCheck[] {
  const { fix } = review;
  const taken = kindsTakenToBase(review, 'recorded');
  const base = { commit: scope.base, name: baseNameOf(scope.mode, scope.request) };
  return (fix.checks.planned?.checks ?? []).filter((check) => check.command !== null).map((check) => {
    const last = lastRunOf(review, check.kind);
    const facts = {
      kind: check.kind,
      before: lastRecordedRun(fix, 'baseline-checks', check.kind)?.outcome ?? null,
      last: last === null ? null : { outcome: last.run.outcome, when: lastMomentOf[last.phase] },
      earlier: earlierOf(fix, check.kind, last),
      base: taken.includes(check.kind) ? baseOf(fix, check.kind, base) : null,
    };
    return { ...facts, fault: checkFaults.find((fault) => faultHolds[fault](facts)) ?? null };
  });
}

/** The base as the brief names it (R5): its name and its first 8 characters, as the line `Scope:` does, or the empty tree, which has no other name. */
export const baseWords = (base: Pick<BriefBase, 'commit' | 'name'>): string => (isEmptyTree(base.commit) ? 'the empty tree' : `${base.name} (${commitWords(base.commit)})`);

/**
 * How strongly a fixer validated a fix, the strongest first (TD12 of the
 * facts before a merge), as version 4 of the JSON form names them: a test
 * that fails on the code before the fix or on a mutation of it, the tests
 * that already exist, a check of the source, a limit the fixer named, or
 * no validation at all. The brief names the kinds (`validationKinds`).
 */
export const validationStrengths = ['test', 'existing', 'static', 'limited', 'none'] as const;
export type ValidationStrength = (typeof validationStrengths)[number];

/** Who compared the failures of a check with those of the base, when the meaning of the check rests on a comparison (R4 of the report for the person): the engine, from the outcome on the base, or a model, the worker that compared the failures. */
export type ComparedBy = 'engine' | 'model';

/** What a run's configuration tells the meanings of its checks: whether an engine before the checks on the base configured it (R10 of the facts before a merge). */
export interface MeaningRun {
  readonly baseChecksStep: boolean;
}

/** One row of the meanings of a check (R4, TD3 of the report for the person): when it holds, what it means, its rank in "What needs you", and who compared. */
export interface CheckMeaningRow {
  readonly holds: (check: BriefCheck, run: MeaningRun) => boolean;
  readonly meaning: (check: BriefCheck) => string;
  readonly rank: 1 | 2 | 3 | null;
  readonly comparedBy: ComparedBy | null;
}

/** Whether an outcome counts as a failure, as `faultHolds` counts it: a timeout does. */
const fails = (outcome: CheckOutcome | null | undefined): boolean => outcome !== null && outcome !== undefined && failedOrTimedOut(outcome);

/** The reasons a check was not compared, in the plain words of the brief, which names the worker that compared the failures rather than the step it ran in (R10 of the report for the person). */
export const notComparedPlainWords: Readonly<Record<NotComparedReason, string>> = {
  ...notComparedWords,
  'no-comparison': 'the worker that compared the failures gave no comparison',
  unknown: 'the worker that compared the failures could not compare the outputs',
};

/**
 * The meanings of a check, in order (R4, TD3 of the report for the
 * person): the first row that holds gives the meaning. The rows of a fault
 * read the fault that `faultHolds` gave, so a meaning and a fault cannot
 * disagree; the rows after them read the outcomes, and the last holds for
 * any check, so every check has a meaning.
 */
export const checkMeanings: readonly CheckMeaningRow[] = [
  { holds: (check) => check.fault === 'edits', meaning: () => 'the edits of this run made it fail', rank: 1, comparedBy: null },
  { holds: (check) => check.fault === 'change-breaks', meaning: () => 'fails because of the change', rank: 2, comparedBy: 'engine' },
  { holds: (check) => check.fault === 'change-adds', meaning: () => 'fails on the base too, and the change adds failures, by a model\'s comparison', rank: 2, comparedBy: 'model' },
  { holds: (check) => check.fault === 'not-compared', meaning: (check) => `fails, not compared with the base, since ${notComparedPlainWords[check.base?.reason ?? 'not-run']}`, rank: 3, comparedBy: null },
  { holds: (check) => check.fault === 'base-has', meaning: () => 'fails the same way on the base, by a model\'s comparison', rank: null, comparedBy: 'model' },
  { holds: (check, run) => !run.baseChecksStep && (fails(check.last?.outcome) || (check.last === null && fails(check.before))), meaning: () => 'fails', rank: null, comparedBy: null },
  { holds: (check) => check.last === null && fails(check.before), meaning: () => 'fails as submitted, not compared with the base', rank: 3, comparedBy: null },
  { holds: (check) => check.before === 'passed' && check.last?.outcome === 'passed', meaning: () => 'passes', rank: null, comparedBy: null },
  { holds: (check) => fails(check.before) && check.last?.outcome === 'passed', meaning: () => 'passes; it failed as submitted', rank: null, comparedBy: null },
  { holds: (check) => check.before === 'passed' && check.last === null, meaning: () => 'passes as submitted; no check ran after the fixes', rank: null, comparedBy: null },
  { holds: (check) => ['skipped', 'not-started', 'cut'].includes((check.last?.outcome ?? check.before) ?? ''), meaning: () => 'did not finish its last run', rank: null, comparedBy: null },
  { holds: () => true, meaning: (check) => (check.before === null && check.last === null ? 'did not run' : 'fails'), rank: null, comparedBy: null },
];

/** The row of `checkMeanings` that gives a check its meaning: the first that holds. */
export function meaningRowOf(check: BriefCheck, run: MeaningRun): CheckMeaningRow {
  return checkMeanings.find((row) => row.holds(check, run))!;
}

/**
 * The kinds of validation a fixer reports, the strongest first, with
 * their words in the table of the fixes (R5 of the report for the
 * person). It refines `validationStrengths`, which puts a test that fails
 * on the code before the fix and one that fails when the fix is undone
 * together.
 */
export const validationKinds: readonly { readonly method: ValidationMethod; readonly words: string }[] = [
  { method: 'old-code', words: 'a new test fails on the code before the fix' },
  { method: 'mutation', words: 'a test fails when the fix is undone' },
  { method: 'existing', words: 'existing tests and checks rerun' },
  { method: 'static', words: 'read against the source' },
  { method: 'limited', words: 'a limited check' },
];

/** The words when a fixer reported no validation. */
export const noValidationWords = 'none reported';

/** The kinds of a fix's validations, each once, the strongest first, or none. */
export const validationKindsOf = (methods: readonly ValidationMethod[]): ValidationMethod[] => validationKinds.filter((kind) => methods.includes(kind.method)).map((kind) => kind.method);

/** A fix's validations as the cell of the table of the fixes names them. */
export function validationWords(methods: readonly ValidationMethod[]): string {
  const kinds = validationKindsOf(methods);
  return kinds.length === 0 ? noValidationWords : kinds.map((method) => validationKinds.find((kind) => kind.method === method)!.words).join('; ');
}
