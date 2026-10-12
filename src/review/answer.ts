/**
 * `deep-review answer` (R1 to R6 of answers): record a person's answer to
 * a question the decision step asked, or their acceptance or rejection of
 * a fix's departure from a rule, on a complete run's ledger, before
 * anything is edited; then, on a run that fixed, open the answer pass that
 * applies every answer owing an edit, once the run's spend and the tree
 * allow it and the resume that runs it would not refuse it. Running the
 * pass is the caller's: it resumes the run as `review` does. Shaped as
 * `commitRun` is: the run is chosen under the checkpoint's start lock,
 * folded again under its own lock, and appended to there.
 */
import type { Checkpoint } from '../checkpoint/checkpoint.ts';
import { answerWords, owedAnswers, sameAnswer, standingAnswer, type RecordedAnswer } from '../checkpoint/answer-state.ts';
import { admits, departs, takesAnswer } from '../checkpoint/answer-fold.ts';
import type { Answer, RecordedDecision } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { sameDirectory } from '../paths.ts';
import type { RuntimeAdapter } from '../runtime/adapter.ts';
import { budgetReached, driftList, isResumable, requirePinned, type PinnedOptions } from './controller.ts';
import { drifted, findDrift } from './drift.ts';
import { ReviewRefusedError } from './errors.ts';
import { acquireRunLock, acquireStartLock } from './lock.ts';
import type { PolicyFlags } from './policy.ts';
import { readableRuns } from './runs.ts';
import { budgetBlocker } from './steps.ts';
import { rankedFindings, reviewStatus } from './state.ts';
import type { ExpectedMatch } from './tree.ts';

/** What `answer` needs; the roles, platform, environment and preflight limits are the ones the pass's resume holds the run with, checked before the pass opens. */
export interface AnswerOptions extends Pick<PinnedOptions, 'rolesRoot' | 'platform' | 'environment' | 'preflightOptions'> {
  readonly checkpoint: Checkpoint;
  /** The worktree the command runs in, which must be the run's. */
  readonly worktree: string;
  /** The run to answer on; when absent, the newest complete decided run of this worktree, by its last event in the ledger (`chooseAnswerRun`). */
  readonly runId?: string;
  /** The finding answered, by its id as the report prints it. */
  readonly finding: string;
  readonly answer: Answer;
  readonly note: string | null;
  /** Whether to record the answer only and open no pass (PD11). */
  readonly recordOnly: boolean;
  /** The flags of this invocation that apply to the pass: the run budget, checked before the pass opens as the run will check it. */
  readonly flags: Pick<PolicyFlags, 'budgetUsd'>;
  /** The adapter of the run's runtime, which prices its spend and preflights the executable it pinned. */
  readonly adapter: (runtime: string) => RuntimeAdapter;
  /** How a file is compared with what the run expects, as git would store it (R22 of the fix pass). */
  readonly match: ExpectedMatch;
  /** Where a line for each run passed over is written. */
  readonly log: (line: string) => void;
}

/** What the command did: the answer it recorded, or found already recorded and still owed, and whether it opened a pass the caller now runs. */
export interface AnswerOutcome {
  readonly runId: string;
  /** False when the answer equals the standing one, still owed, and only the pass was opened to apply it. */
  readonly recorded: boolean;
  /** The answer as it stands on the ledger now. */
  readonly standing: RecordedAnswer;
  /** What happens next: a pass to run; the run only reviewed; recorded only; or nothing owed. */
  readonly next: 'pass' | 'read-only' | 'record-only' | 'nothing-owed';
  /** The run as it is after the append. */
  readonly state: RunState;
}

/** Why a run cannot take an answer, or null when it can: complete, of this worktree, decided, with findings. */
export function whyNotAnswerable(run: RunState, worktree: string): string | null {
  const status = reviewStatus(run);
  if (status === 'active' || status === 'blocked') return `run ${run.id} is ${status}, and an answer is given to a run that wrote its report; resume or abandon it first`;
  if (status === 'abandoned') return `run ${run.id} is abandoned`;
  if (!sameDirectory(run.worktree, worktree)) return `run ${run.id} was reviewed in worktree ${run.worktree}, not ${worktree}; run the command there`;
  if (run.review === null || run.review.phases.decision.status === 'skipped') return `run ${run.id} was configured before the decision step, so it asked no question and departed from no rule`;
  if ((run.review.decisions ?? []).length === 0) return `run ${run.id} ranked no finding, so it has nothing to answer`;
  return null;
}

/** The findings a run's decisions let a person answer: the questions, and the fixes that depart from a rule, in rank order. */
function answerable(run: RunState): RecordedDecision[] {
  const decided = new Map((run.review!.decisions ?? []).map((decision) => [decision.id, decision]));
  return rankedFindings(run.review!).flatMap((entry) => {
    const decision = decided.get(entry.finding.id);
    return decision !== undefined && takesAnswer(decision) ? [decision] : [];
  });
}

/** What a decision admits, as a refusal names it. */
function admitted(decision: RecordedDecision): string {
  switch (decision.decision) {
    case 'ask':
      return `an --option from 1 to ${String(decision.ask.options.length)}`;
    case 'fix':
      return decision.departure === null ? 'no answer, since the fix departs from no rule' : '--accept or --reject';
    case 'leave':
      return 'no answer, since it was left';
  }
}

/** The answer as the command's flags spell it. */
const flagOf = (answer: Answer): string => (answer.kind === 'option' ? `--option ${String(answer.option + 1)}` : `--${answer.kind}`);

/** Refuse an answer the finding's decision does not admit, naming the decision and what it admits; refuse a finding the run did not decide, naming the ones it can answer. */
function requireAdmitted(run: RunState, finding: string, answer: Answer): RecordedDecision {
  const decision = run.review!.decisions!.find((candidate) => candidate.id === finding);
  if (decision === undefined) {
    const ids = answerable(run).map((entry) => entry.id);
    throw new ReviewRefusedError(`run ${run.id} has no finding ${finding}; ${ids.length === 0 ? 'it asked no question and no fix of it departs from a rule' : `the findings it can answer are ${ids.join(', ')}`}`);
  }
  if (!admits(decision, answer)) throw new ReviewRefusedError(`${finding} was decided ${decision.decision}${departs(decision) ? ', departing from a rule' : ''}, which admits ${admitted(decision)}, not ${flagOf(answer)}`);
  return decision;
}

/**
 * The run to answer on (R2 of answers): the one named, which `fold` refuses
 * when this engine cannot read it, or the newest complete decided run of
 * this worktree, by its last event in the ledger, among those this engine
 * can read, the others passed over with a line on `log`.
 */
export function chooseAnswerRun(checkpoint: Checkpoint, runId: string | undefined, worktree: string, log: (line: string) => void): RunState {
  // An id the checkpoint does not hold throws UnknownRunError, which the command reports as a usage mistake, as `commit` and `status` do.
  if (runId !== undefined) return checkpoint.fold(runId);
  const found = readableRuns(checkpoint, log)
    .filter((run) => whyNotAnswerable(run, worktree) === null)
    .reduce<RunState | undefined>((last, run) => (last === undefined || run.lastSequence > last.lastSequence ? run : last), undefined);
  if (found === undefined) throw new ReviewRefusedError('no complete run of this worktree has decisions to answer; name one with --run <id>');
  return found;
}

/** What an owed answer says, as a refusal of the pass names it for the person to apply by hand: the option's text, or the departure's rule and its source. */
function saying(run: RunState, answer: RecordedAnswer): string {
  const decision = run.review!.decisions!.find((candidate) => candidate.id === answer.id)!;
  switch (answer.answer.kind) {
    case 'option':
      return `${answer.id} option ${String(answer.answer.option + 1)}, "${decision.ask!.options[answer.answer.option]!.option}"`;
    case 'reject':
      return `${answer.id} rejected: follow the rule "${decision.departure!.rule}" as ${decision.departure!.source} states it`;
    case 'accept':
      return `${answer.id} accepted: keep the departure from "${decision.departure!.rule}" (${decision.departure!.source})`;
  }
}

/**
 * Hold a fix run to what an answer pass needs before it opens (R6 of
 * answers, TD6, TD8): a spend below the run budget in force, with
 * `--budget-usd` as the way out; and the tree where the run left it,
 * `HEAD` at the run's head and every expected file as the run recorded
 * it, else the refusal names what moved and what each owed answer says,
 * so the person can apply it by hand; no other run of the checkpoint
 * resumable, as `findActiveRun` counts them, since the pass makes this one
 * resumable too and the resume that runs it would refuse the two; and,
 * last, since it spawns the executable, the run held to its roles digest
 * and its executable as that resume holds it (`requirePinned`). Each
 * refusal leaves every answer recorded and the run complete with its
 * report, so it stays committable.
 */
async function requirePassable(run: RunState, options: AnswerOptions, owed: readonly RecordedAnswer[]): Promise<void> {
  // Unreadable runs are passed over silently here: the resume that runs the pass names each with its line.
  const active = readableRuns(options.checkpoint, () => {}).filter((other) => other.id !== run.id && isResumable(other)).map((other) => other.id);
  if (active.length > 0) {
    const them = active.length === 1 ? 'it' : 'them';
    throw new ReviewRefusedError(`${active.length === 1 ? `run ${active[0]!} is` : `runs ${active.join(', ')} are`} active, and the answer pass would resume run ${run.id} beside ${them}; the answer is recorded; finish ${them} with deep-review review, or abandon ${them} with \`deep-review abandon --run <id> --reason <text>\`, then run deep-review answer again with the same answer to apply it`);
  }
  const adapter = options.adapter(run.review!.configuration.runtime);
  const reached = budgetReached(run, options.flags, adapter);
  if (reached !== null) {
    throw new ReviewRefusedError(`run ${run.id} ${budgetBlocker(reached.spend, reached.runBudgetUsd).detail}, so no fixer could launch; the answer is recorded; run deep-review answer again with the same answer and --budget-usd above ${reached.spend.usd.toFixed(2)} to apply it`);
  }
  const found = findDrift(run, options.worktree, options.match);
  if (drifted(found)) {
    throw new ReviewRefusedError(`the tree is not where run ${run.id} left it: ${driftList(found)}; the answer is recorded; restore the tree and run deep-review answer again with the same answer to apply it, or apply it by hand: ${owed.map((answer) => saying(run, answer)).join('; ')}; a review of the changed tree is a new run and does not carry this answer`);
  }
  await requirePinned(run, { ...options, adapter });
}

/**
 * Record a person's answer, and on a run that fixed open the answer pass
 * that applies every answer owing an edit (R1 to R6 of answers): under
 * the checkpoint's start lock the run is chosen, and under its lock it is
 * folded again, refused as `whyNotAnswerable` says, and the answer held to
 * the finding's decision. An answer equal to the standing one is refused
 * as already given, unless it still owes an edit on a run that fixes and
 * a pass is asked for, when it is not recorded again and the pass is
 * opened to apply it: the way to apply an answer whose pass was refused
 * for the tree or the budget. Such a retry keeps the note the answer was
 * recorded with, so one giving another note is refused. The answer is
 * appended first; then, unless `recordOnly`, the run only reviewed, or
 * nothing is owed, the spend, the tree, the checkpoint's other runs and
 * what the run pinned are checked (`requirePassable`) and `answer.pass` is
 * appended.
 */
export async function answerRun(options: AnswerOptions): Promise<AnswerOutcome> {
  const { checkpoint, worktree } = options;
  const releaseStart = acquireStartLock(checkpoint.root);
  try {
    const chosen = chooseAnswerRun(checkpoint, options.runId, worktree, options.log);
    const release = acquireRunLock(checkpoint.root, chosen.id);
    try {
      // Read again under the run's lock, as every writer does: another command may have answered or resumed it since it was chosen.
      let run = checkpoint.fold(chosen.id);
      const reason = whyNotAnswerable(run, worktree);
      if (reason !== null) throw new ReviewRefusedError(reason);
      requireAdmitted(run, options.finding, options.answer);
      const fixes = run.review!.fix !== null;
      const standing = standingAnswer(run.review!, options.finding);
      const again = standing !== null && sameAnswer(standing.answer, options.answer);
      const retry = again && standing.appliedBy === null && fixes && !options.recordOnly;
      if (again && !retry) throw new ReviewRefusedError(`${options.finding} is already answered ${answerWords(options.answer)} on run ${run.id}, on ${standing.at}${standing.appliedBy === null ? '' : ', and the tree holds it'}`);
      // A retry is not recorded again (R3), so a note it carries would never reach the pass's fixer, which reads the standing one.
      if (retry && options.note !== null && options.note !== standing.note) {
        throw new ReviewRefusedError(`${options.finding} is already answered ${answerWords(options.answer)} on run ${run.id}, ${standing.note === null ? 'with no note' : `with the note "${standing.note}"`}, and applying it again keeps the note it was recorded with; run deep-review answer again without --note to apply it`);
      }
      if (!retry) run = checkpoint.append(run.id, run.lastSequence, [{ kind: 'answer.recorded', version: 1, payload: { id: options.finding, answer: options.answer, note: options.note } }]);
      const recorded = standingAnswer(run.review!, options.finding)!;
      const outcome = (next: AnswerOutcome['next'], state: RunState): AnswerOutcome => ({ runId: run.id, recorded: !retry, standing: recorded, next, state });
      if (!fixes) return outcome('read-only', run);
      if (options.recordOnly) return outcome('record-only', run);
      // In rank order, as the pass's fixer works them.
      const owed = owedAnswers(run.review!);
      const order = rankedFindings(run.review!).map((entry) => entry.finding.id);
      const ids = owed.map((answer) => answer.id).sort((a, b) => order.indexOf(a) - order.indexOf(b));
      if (ids.length === 0) return outcome('nothing-owed', run);
      await requirePassable(run, options, owed);
      return outcome('pass', checkpoint.append(run.id, run.lastSequence, [{ kind: 'answer.pass', version: 1, payload: { ids } }]));
    } finally {
      release();
    }
  } finally {
    releaseStart();
  }
}
