/**
 * The facts of a fix run's checks and fixes that the brief gives before a
 * merge (R3 to R7 of the facts before a merge), each computed from the
 * fold alone, so nothing records them and a run an engine before that
 * change configured gets them too (TD9): each check's outcome before the
 * fixes and at its last run with when it ran, what its base says, and
 * the fault of the table of the design that it has; their words in the
 * brief; and the sentence on how the fixers validated the fixes they
 * applied.
 */
import type { ScopeState } from '../checkpoint/events.ts';
import { baseKinds, lastCurrentRun, lastRecordedRun, type CheckRunState, type FixState } from '../checkpoint/fix-state.ts';
import type { ReviewState } from '../checkpoint/review-fold.ts';
import { isEmptyTree } from '../scope/git.ts';
import { baseNameOf, commitWords } from '../scope/scope-line.ts';
import { listed } from './markdown.ts';
import { baseSkipReasons, checkKinds, repairUnitKey, treeCheckPhases, type BaseReading, type BaseSkipReason, type CheckKind, type CheckOutcome, type TreeCheckPhase, type ValidationMethod } from './vocabulary.ts';

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
 * could be made, the build failed there, the check did not start or did
 * not run there, the repair gave no comparison, or the repair could not
 * compare the outputs.
 */
export const notComparedReasons = ['empty-tree', 'no-worktree', 'build-failed', 'not-started', 'not-run', 'no-comparison', 'unknown'] as const;
export type NotComparedReason = (typeof notComparedReasons)[number];

/** Each reason in the fixed words the brief gives; the error of git and the words of the repair stay in the report, since they can name local paths (R5). */
export const notComparedWords: Readonly<Record<NotComparedReason, string>> = {
  'empty-tree': baseSkipReasons.emptyTree,
  'no-worktree': baseSkipReasons.noWorktree,
  'build-failed': baseSkipReasons.buildFailed,
  'not-started': 'the check did not start on the base',
  'not-run': 'the check did not run on the base',
  'no-comparison': 'the repair gave no comparison',
  unknown: 'the repair could not compare the outputs',
};

/** The reason of each fixed phrase that the error of a `skipped` run on the base starts with. */
const skippedReasons: Readonly<Record<BaseSkipReason, NotComparedReason>> = { emptyTree: 'empty-tree', noWorktree: 'no-worktree', buildFailed: 'build-failed' };

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

const failedOrTimedOut = (outcome: CheckOutcome | null): outcome is 'failed' | 'timeout' => outcome === 'failed' || outcome === 'timeout';

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

/**
 * Why a run on the base was skipped, from its error, which starts with
 * one of the fixed phrases the run records (`baseSkipReasons`); the error
 * of git after one stays in the facts of the run.
 */
export function skippedReason(error: string | null): NotComparedReason {
  const reason = (Object.keys(skippedReasons) as BaseSkipReason[]).find((key) => error?.startsWith(baseSkipReasons[key]) === true);
  return reason === undefined ? 'not-run' : skippedReasons[reason];
}

/** Why a kind's run on the base left it not compared, by how the run ended, or null when the run compared it (R5). */
const reasonOf: Readonly<Record<CheckOutcome, (run: CheckRunState, reading: BaseReading | null) => NotComparedReason | null>> = {
  passed: () => null,
  failed: (_run, reading) => (reading === null ? 'no-comparison' : reading === 'unknown' ? 'unknown' : null),
  timeout: (run, reading) => reasonOf.failed(run, reading),
  skipped: (run) => skippedReason(run.error),
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
  const taken = review.baseChecksStep ? baseKinds(fix, 'recorded') : [];
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

/** How a run ended, as the verb the brief says it with. */
const outcomeVerbs: Readonly<Record<CheckOutcome, string>> = { passed: 'passed', failed: 'failed', timeout: 'timed out', 'not-started': 'did not start', skipped: 'was skipped', cut: 'was cut short' };

/** When a check's last run ran, as the words after its verb (R3): an answer pass is the person's. */
const lastWords: Readonly<Record<LastMoment, string>> = { fixes: 'after the fixes', repair: 'after the repair', answers: 'after your answers' };

/** A check's outcome before the fixes and at its last run, with when that ran (R3), as the words after its kind. */
function ranWords({ before, last }: BriefCheck): string {
  if (last !== null && before === last.outcome && last.when === 'fixes') return `${outcomeVerbs[last.outcome]} before and after the fixes`;
  const first = before === null ? 'did not run before the fixes' : `${outcomeVerbs[before]} before the fixes`;
  if (last === null) return `${first} and did not run after them`;
  const when = last.when === 'fixes' ? 'after them' : lastWords[last.when];
  return `${first} and ${before === last.outcome ? when : `${outcomeVerbs[last.outcome]} ${when}`}`;
}

/** What the base says of a check, as the words after its outcomes, in fixed words; a fact that rests on the repair's reading says so (R5, principle 1). */
function baseFactWords(base: BriefBase): string {
  const where = baseWords(base);
  if (base.reason !== null) return `, and the run could not compare it with the base, ${where}, since ${notComparedWords[base.reason]}`;
  if (base.outcome === 'passed') return `, and it passes on the base, ${where}`;
  return base.reading === 'adds'
    ? `, and the change has failures that the base, ${where}, does not have, by the repair's reading`
    : `, and the base, ${where}, has the same failures, by the repair's reading`;
}

/**
 * How the checks of a fix run ended, as one sentence of "What deep-review
 * changed" (R3): each check's outcome before the fixes and at its last
 * run, with when that ran, so no failure after the answers reads as one
 * after the fixes (#78), and what its base says.
 */
export function checksSentence(checks: readonly BriefCheck[]): string {
  if (checks.length === 0) return 'No check ran.';
  if (checks.every((check) => check.before === 'passed' && check.last?.outcome === 'passed' && check.earlier.failed === null)) return 'The checks passed before and after the fixes.';
  return `The checks: ${checks.map((check) => `${check.kind} ${ranWords(check)}${check.base === null ? '' : baseFactWords(check.base)}`).join('; ')}.`;
}

/**
 * The rows of the line `Checks:` (R6, PD5 of the facts before a merge;
 * the table of the short form of the design), in the order the line
 * names them: each fault, a check that still fails with none, the other
 * ways a check did not pass at some point of the run, a kind with no
 * command, and last the kinds that passed at each run. A kind takes the
 * first row that holds, so the kinds that need the person come first and
 * a cut of the line drops the kinds that passed first.
 */
export const lineRows = [...checkFaults, 'failing', 'passes-now', 'repaired', 'not-rerun', 'unfinished', 'no-command', 'passed'] as const;
export type LineRow = (typeof lineRows)[number];
type ClauseRow = Exclude<LineRow, 'no-command' | 'passed'>;

/** When an earlier run of a check ran, before its last, as the words after its verb: an answer pass before the last run is an earlier one. */
const earlierWords: Readonly<Record<CheckMoment, string>> = { before: 'before the fixes', fixes: 'after the fixes', repair: 'after the repair', answers: 'after earlier answers' };

/** How a check that did not finish ended last: it timed out, was skipped, did not start, or was cut short, or it never ran. */
const unfinished = (outcome: CheckOutcome | null): boolean => outcome === null || ['timeout', 'skipped', 'not-started', 'cut'].includes(outcome);

/** The clause of each row for a check, in a few words, when the row holds for it, else null; a clause that rests on the repair's reading says so (principle 1). */
const clauses: Readonly<Record<ClauseRow, (check: BriefCheck) => string | null>> = {
  edits: ({ kind, fault, last, earlier }) => (fault === 'edits' && last !== null && earlier.passed !== null ? `${kind} ${outcomeVerbs[last.outcome]} ${lastWords[last.when]}, and passed ${earlierWords[earlier.passed]}` : null),
  'change-breaks': ({ kind, fault, base }) => (fault === 'change-breaks' && base !== null ? `${kind} fails on the change and passes on the base (${commitWords(base.commit)})` : null),
  'change-adds': ({ kind, fault, base }) => (fault === 'change-adds' && base !== null ? `${kind} fails on the change with failures that the base (${commitWords(base.commit)}) does not have, by the repair's reading` : null),
  'not-compared': ({ kind, fault }) => (fault === 'not-compared' ? `${kind} failed before and after the fixes, not compared with the base` : null),
  'base-has': ({ kind, fault, base }) => (fault === 'base-has' && base !== null ? `${kind} failed, as it does on the base (${commitWords(base.commit)}), by the repair's reading` : null),
  // A check whose last run failed with no fault: one that never passed, in a run configured before the checks on the base or of a kind the run did not take there.
  failing: (check) => (check.last?.outcome === 'failed' ? `${check.kind} ${ranWords(check)}` : null),
  'passes-now': ({ kind, before, last }) => (failedOrTimedOut(before) && last?.outcome === 'passed' ? `${kind} ${outcomeVerbs[before]} before the fixes and passes now` : null),
  repaired: ({ kind, earlier, last }) => (earlier.failed !== null && last?.outcome === 'passed' ? `${kind} failed ${earlierWords[earlier.failed]} and passed ${lastWords[last.when]}` : null),
  'not-rerun': ({ kind, before, last }) => (failedOrTimedOut(before) && last === null ? `${kind} ${outcomeVerbs[before]} before the fixes and did not run again` : null),
  unfinished: ({ kind, before, last }) => (unfinished(last?.outcome ?? before) ? `${kind} did not finish` : null),
};

const clauseRows = lineRows.filter((row): row is ClauseRow => row !== 'no-command' && row !== 'passed');

/** A kind as the line names it: its row, and its clause, or for one that passed at each run its kind alone, which the line names with the others that did. */
function lineEntry(check: BriefCheck): { readonly kind: CheckKind; readonly row: LineRow; readonly clause: string } {
  for (const row of clauseRows) {
    const clause = clauses[row](check);
    if (clause !== null) return { kind: check.kind, row, clause };
  }
  return { kind: check.kind, row: 'passed', clause: check.kind };
}

/**
 * The line `Checks:` of the short form of a fix run (R6, PD5 of the facts
 * before a merge), uncut: each kind by the first row of `lineRows` that
 * holds for it, the rows in order and the kinds of one row in the order
 * of the kinds, the kinds that passed at each run named together; or one
 * line that each passed, before and after the fixes or before them alone
 * when no fix changed a file, or that the run has no check command.
 */
export function checksLine(checks: readonly BriefCheck[], noCommand: readonly CheckKind[]): string {
  if (checks.length === 0) return 'Checks: none, since the run has no check command';
  const entries = [...checks.map(lineEntry), ...noCommand.map((kind) => ({ kind, row: 'no-command' as const, clause: `no ${kind} check` }))]
    .sort((a, b) => lineRows.indexOf(a.row) - lineRows.indexOf(b.row) || checkKinds.indexOf(a.kind) - checkKinds.indexOf(b.kind));
  // No check runs after the fixes when no fix changed a file.
  const ranAfter = checks.some((check) => check.last !== null);
  const passed = entries.filter((entry) => entry.row === 'passed').map((entry) => entry.kind);
  if (passed.length === entries.length) return ranAfter ? 'Checks: each passed before and after the fixes' : 'Checks: each passed before the fixes; no check ran after them, since no fix changed a file';
  const parts = [
    ...entries.filter((entry) => entry.row !== 'passed').map((entry) => entry.clause),
    ...(passed.length === 0 ? [] : [`${listed(passed)} passed`]),
    ...(ranAfter ? [] : ['no check ran after the fixes, since no fix changed a file']),
  ];
  return `Checks: ${parts.join('; ')}`;
}

/**
 * The gap of "What the review did not cover" that a check's fault gives
 * (R5): a check the change breaks, or that the run took to the base and
 * could not compare, with the reason; none for any other fault, since the
 * headline counts a check the edits of the run made fail and the run
 * covered a check whose base has the same failures.
 */
export function checkGap({ kind, base, fault }: BriefCheck): string | null {
  if (base === null) return null;
  const where = baseWords(base);
  switch (fault) {
    case 'change-breaks':
      return `The ${kind} check fails on the change and passes on its base, ${where}. No step of the run fixes a failure that the change brings.`;
    case 'change-adds':
      return `The ${kind} check fails on the change with failures that its base, ${where}, does not have, by the repair's reading. No step of the run fixes a failure that the change brings.`;
    case 'not-compared':
      return base.reason === null ? null : `The ${kind} check failed before and after the fixes, and the run could not compare it with the base, ${where}: ${notComparedWords[base.reason]}.`;
    default:
      return null;
  }
}

/**
 * How strongly a fixer validated a fix, the strongest first (TD12 of the
 * facts before a merge): a test that fails on the code before the fix or
 * on a mutation of it, the tests that already exist, a check of the
 * source, a limit the fixer named, or no validation at all.
 */
export const validationStrengths = ['test', 'existing', 'static', 'limited', 'none'] as const;
export type ValidationStrength = (typeof validationStrengths)[number];

/** The strength of each method a fixer reports (fixer-validation.md). */
const strengthOfMethod: Readonly<Record<ValidationMethod, Exclude<ValidationStrength, 'none'>>> = {
  'old-code': 'test',
  mutation: 'test',
  existing: 'existing',
  static: 'static',
  limited: 'limited',
};

/** The applied fixes under the strongest validation of each, in the order they are given (R7). */
export type BriefValidation = Readonly<Record<ValidationStrength, readonly string[]>>;

/** Each applied fix under the strongest method of the validation that applied it, or `none` when that answer gave no entry (TD12). */
export function validationOf(applied: readonly { readonly id: string; readonly methods: readonly ValidationMethod[] }[]): BriefValidation {
  const strongest = (methods: readonly ValidationMethod[]): ValidationStrength => validationStrengths.find((strength) => methods.some((method) => strengthOfMethod[method] === strength)) ?? 'none';
  const byFix = applied.map((fix) => ({ id: fix.id, strength: strongest(fix.methods) }));
  return Object.fromEntries(validationStrengths.map((strength) => [strength, byFix.filter((fix) => fix.strength === strength).map((fix) => fix.id)])) as Record<ValidationStrength, string[]>;
}

/** What a fix validated less strongly than by a test rests on, after its ids, for one id and for several (R7); a check of the source can run a source assertion as well as read the source. */
const restsOn: Readonly<Record<Exclude<ValidationStrength, 'test'>, readonly [one: string, many: string]>> = {
  existing: ['rests on the tests that already exist', 'rest on the tests that already exist'],
  static: ['rests on a check of the source', 'rest on a check of the source'],
  limited: ['rests on a limit that its fixer named', 'rest on limits that their fixers named'],
  none: ['has no validation that its fixer reported', 'have no validation that their fixers reported'],
};

/**
 * The sentence of "What deep-review changed" on the validation of the
 * applied fixes (R7, PD6 of the facts before a merge), marked as what the
 * fixers report: how many of them a test validated, then the others by
 * the strongest validation of each, their ids as `list` gives them, which
 * the brief shows at most 8 of and counts the rest. None for a run that
 * applied no fix.
 */
export function validationSentence(validation: BriefValidation, list: (ids: readonly string[]) => string): string | null {
  const total = validationStrengths.reduce((sum, strength) => sum + validation[strength].length, 0);
  if (total === 0) return null;
  const tested = validation.test.length;
  const fixes = total === 1 ? 'the fix' : `${tested === total ? 'each' : tested === 0 ? 'none' : String(tested)} of the ${String(total)} fixes`;
  const lead = tested === 0 && total === 1
    ? 'The fixers report that no test validated the fix.'
    : `The fixers report that a test validated ${fixes}${tested === 0 ? '.' : ': it fails on the code before the fix, or on a mutation of the fix.'}`;
  const rest = (['existing', 'static', 'limited', 'none'] as const).flatMap((strength) => {
    const ids = validation[strength];
    return ids.length === 0 ? [] : [`${list(ids)} ${restsOn[strength][ids.length === 1 ? 0 : 1]}.`];
  });
  return [lead, ...rest].join(' ');
}
