/**
 * `deep-review commit` (R17, PD13, TD13 of the fix pass): turn a completed
 * fix run's revisions into commits, one per revision, after the run and
 * only when a person asks. The commits are built from the run's frozen
 * bytes with git's plumbing (blobs with hash-object, trees through a
 * temporary index, commits with commit-tree), so no file of the worktree
 * is written and no hook runs; the branch, or a detached HEAD, moves once
 * at the end with a compare-and-swap against the head the command started
 * from, and the index is reset to it so the tree shows clean. The ledger
 * records the series before the branch moves and again after, so the next
 * command completes or drops a series a stop cut short between the two
 * (R9 of resumable runs). A run whose
 * revisions were committed and that then gained revisions in an answer
 * pass is committed again, as a later series from the last commit the
 * first made (R8 of answers).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Checkpoint, NewEvent } from '../checkpoint/checkpoint.ts';
import type { CommitsCreated, CommitsPrepared, FrozenFile, TreeRevised } from '../checkpoint/events.ts';
import { committedRevisions, nextSeries, revisionMessageOf, runHead, type NextSeries } from '../checkpoint/fix-state.ts';
import { attemptOwner } from './fix-events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { sameDirectory } from '../paths.ts';
import { gitFailureDetail, gitTimedOut, runGitSync } from '../runtime/git-sync.ts';
import { ReviewRefusedError } from './errors.ts';
import { acquireRunLock, acquireStartLock } from './lock.ts';
import { readableRuns } from './runs.ts';
import { rankedFindings } from './state.ts';
import { gitContent } from './content.ts';
import { compareExpected, expectedTree, worktreeReader, type ExpectedFile, type ExpectedMatch } from './tree.ts';
import type { EditingPhase } from './vocabulary.ts';

export interface CommitOptions {
  readonly checkpoint: Checkpoint;
  /** The worktree the command runs in, which must be the run's. */
  readonly worktree: string;
  /** The run to commit; when absent, the completed fix run with revisions and no commits that finished last. */
  readonly runId?: string;
  /** The message of the captured change's own commit, required in worktree mode and refused in every other. */
  readonly changeMessage?: string;
  /** Called after every object is built and before the ref moves; a test makes a commit there to see the move refused. */
  readonly beforeMove?: () => void;
  /** Where a line for each run passed over is written; stderr when absent. */
  readonly log?: (line: string) => void;
}

/** One commit the command made, as it prints it. */
export interface MadeCommit {
  readonly sha: string;
  readonly subject: string;
}

export interface CommitOutcome {
  readonly runId: string;
  readonly commits: readonly MadeCommit[];
  /** Paths the user had staged that no commit holds, unstaged by the index reset and left as they are in the tree. */
  readonly unstaged: readonly string[];
}

interface GitOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: Buffer | string;
  /** How long git may run, in milliseconds, 0 for no bound; `runGitSync`'s default when absent. */
  readonly timeout?: number;
}

/** Run git in the worktree with the given environment additions and stdin, returning stdout as text. */
function git(worktree: string, args: readonly string[], options: GitOptions = {}): string {
  try {
    return runGitSync(['--no-optional-locks', ...args], {
      cwd: worktree,
      env: { ...process.env, ...options.env },
      input: options.input ?? '',
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    });
  } catch (error) {
    throw gitFailure(args, error, options.timeout);
  }
}

/** What a failed git call throws: the command, then `gitFailureDetail` of the runner's error, which names a timeout of `timeout` ms. */
function gitFailure(args: readonly string[], error: unknown, timeout?: number): Error {
  return new Error(`git ${args.join(' ')} failed: ${gitFailureDetail(error, timeout)}`, { cause: error });
}

/**
 * Why a run cannot be committed, or null when it can: a fix run with its
 * report and a revision no series of commits holds yet, which is every
 * revision of a run never committed and the revisions an answer pass or
 * a reopened fix pass added after its commits (R8 of answers, R11 of
 * resumable runs).
 */
function whyNotCommittable(run: RunState): string | null {
  const fix = run.review?.fix ?? null;
  if (run.status !== 'active') return `run ${run.id} is ${run.status}; only a completed fix run is committed`;
  if (run.review === null || fix === null) return `run ${run.id} ran without --fix, so it has no fixes to commit`;
  if (run.review.report === null) return `run ${run.id} has no report yet; run the review to its report first`;
  if (fix.revisions.length === 0) return `run ${run.id} changed no file, so there is nothing to commit`;
  if (committedRevisions(fix) >= fix.revisions.length) return `run ${run.id}'s commits were already created, and it has no revision since: ${fix.commits.flatMap((series) => series.commits).map((commit) => commit.sha.slice(0, 12)).join(', ')}`;
  return null;
}

/** Refuse a run that cannot be committed, naming why. */
function requireCommittable(run: RunState): RunState {
  const reason = whyNotCommittable(run);
  if (reason !== null) throw new ReviewRefusedError(reason);
  return run;
}

/**
 * The run to commit: the one named, which must be committable and which
 * `fold` refuses when this engine cannot read it, or the committable run of
 * the repository that finished last, its last event the highest in the
 * ledger, among those this engine can read, the others passed over with a
 * line on `log`. Not the newest created: a read-only run continued into the
 * fix pass finishes after runs created later (R6 of fix pass continuation).
 */
function chooseRun(checkpoint: Checkpoint, runId: string | undefined, log: (line: string) => void): RunState {
  if (runId !== undefined) return requireCommittable(checkpoint.fold(runId));
  const found = readableRuns(checkpoint, log)
    .filter((run) => whyNotCommittable(run) === null)
    .reduce<RunState | undefined>((last, run) => (last === undefined || run.lastSequence > last.lastSequence ? run : last), undefined);
  if (found === undefined) throw new ReviewRefusedError('no completed fix run has changes left to commit; name one with --run <id>');
  return found;
}

/** The bytes a frozen file holds, refused for one frozen by hash and size only, which the run never kept. */
function bytesOf(checkpoint: Checkpoint, path: string, frozen: FrozenFile): Buffer {
  if ('oversized' in frozen) throw new ReviewRefusedError(`${path} is larger than the run freezes (${String(frozen.oversized.size)} bytes), so its bytes were never kept and no commit can be built for it; commit it by hand`);
  return checkpoint.evidence.read(frozen.blob);
}

/** What a revision of an editing phase's answer or attempt holds, as its trailer names it: the findings with their angle and verdict, an answer pass's as the answers to them (R7 of answers), or the checks the repair worked. */
function namedFindings(run: RunState, revision: TreeRevised): string {
  if (revision.phase === 'repair') return `repair of the ${revision.change.findings.join(', ')} check`;
  const findings = new Map(rankedFindings(run.review!).map((entry) => [entry.finding.id, entry]));
  const answer = revision.phase === 'answer' ? 'answer to ' : '';
  return revision.change.findings.map((id) => {
    const entry = findings.get(id);
    return `${answer}${entry === undefined ? id : `${id} (${entry.primary.angle}, ${entry.resolution.verdict})`}`;
  }).join(', ');
}

/** The trailer a revision's commit carries, naming the run and what the revision holds. */
function trailer(run: RunState, revision: TreeRevised): string {
  switch (revision.source.kind) {
    case 'fix':
      return `Deep-review: run ${run.id}, ${namedFindings(run, revision)}`;
    case 'check':
      return `Deep-review: run ${run.id}, ${revision.source.check} check`;
    case 'attempt': {
      const who = attemptOwner(revision.phase as EditingPhase, revision.source.key);
      return revision.change.findings.length === 0
        ? `Deep-review: run ${run.id}, partial edits of an unfinished attempt of ${who}`
        : `Deep-review: run ${run.id}, ${namedFindings(run, revision)}, from an unfinished attempt of ${who}`;
    }
  }
}

/** A commit message from a subject and a body, with a trailer after a blank line. */
const messageOf = (subject: string, body: string, end: string | null): string => [subject.trim(), body.trim(), end].filter((part): part is string => part !== null && part !== '').join('\n\n') + '\n';

/** The first line of a message, as a commit's subject. */
const subjectOf = (message: string): string => message.split(/\r?\n/)[0]!.trim();

/**
 * Builds trees in a temporary index, outside the worktree and the real
 * index: each tree is the previous one with some paths set or removed, so
 * a nested path needs no hand-made subtree.
 */
class TreeBuilder {
  readonly #worktree: string;
  readonly #checkpoint: Checkpoint;
  readonly #env: NodeJS.ProcessEnv;

  constructor(worktree: string, checkpoint: Checkpoint, indexFile: string, base: string) {
    this.#worktree = worktree;
    this.#checkpoint = checkpoint;
    this.#env = { GIT_INDEX_FILE: indexFile };
    git(worktree, ['read-tree', `${base}^{tree}`], { env: this.#env });
  }

  /** The mode the temporary index gives a path, or null when it holds none. */
  #mode(path: string): string | null {
    const listed = git(this.#worktree, ['ls-files', '--stage', '-z', '--', `:(literal)${path}`], { env: this.#env }).split('\0').find((record) => record.length > 0);
    return listed === undefined ? null : listed.split(' ')[0]!;
  }

  /** Set a path to a frozen state, as `git add` would store it, or remove it. */
  set(path: string, file: ExpectedFile | null): void {
    if (file === null) {
      git(this.#worktree, ['update-index', '--force-remove', '--', path], { env: this.#env });
      return;
    }
    const bytes = bytesOf(this.#checkpoint, path, file.frozen);
    // A file's blob goes through the clean filters for its path, as `git add` would store the worktree's bytes, so the tree shows clean once the index is reset; a symlink's target text is stored as it is.
    const blob = git(this.#worktree, ['hash-object', '-w', '--stdin', ...(file.symlink ? ['--no-filters'] : ['--path', path])], { input: bytes }).trim();
    const existing = this.#mode(path);
    const mode = file.symlink ? '120000' : existing === '100755' ? '100755' : '100644';
    git(this.#worktree, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`], { env: this.#env });
  }

  /** The tree the temporary index holds now. */
  write(): string {
    return git(this.#worktree, ['write-tree'], { env: this.#env }).trim();
  }
}

/** The branch HEAD names, as a full ref, or the empty string for a detached HEAD, for which `symbolic-ref -q` exits 1 and prints nothing; any other failure throws as `git`'s do. */
export function currentBranch(worktree: string): string {
  const args = ['symbolic-ref', '-q', 'HEAD'];
  try {
    return runGitSync(['--no-optional-locks', ...args], { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if ((error as { status?: number }).status === 1) return '';
    throw gitFailure(args, error);
  }
}

/**
 * The series of commits `commit` builds for a run now (R17 of the fix
 * pass, R8 of answers): from the run's head, the scope's head for the
 * first series and the last commit the series before made for a later
 * one; then what `nextSeries` says it holds.
 */
interface Series extends NextSeries {
  readonly head: string;
  /** Every path a commit of the series sets: the change's when it commits the change, and each revision's. */
  readonly paths: ReadonlySet<string>;
}

function seriesOf(run: RunState): Series {
  const { change, revisions } = nextSeries(run.review!.fix!, run.scope!.mode);
  return { head: runHead(run), change, revisions, paths: pathsSet(run, change, revisions.map(({ revision }) => revision)) };
}

/** Every path a series' commits set: the change's when it commits the change, and each revision's. */
function pathsSet(run: RunState, change: boolean, revisions: readonly TreeRevised[]): ReadonlySet<string> {
  return new Set([...(change ? run.scope!.files.map((file) => file.path) : []), ...revisions.flatMap((revision) => revision.files.map((file) => file.path))]);
}

/** Every path a recorded series' commits set, from the revision each commits. */
function recordedPaths(run: RunState, series: CommitsCreated): ReadonlySet<string> {
  const { revisions } = run.review!.fix!;
  return pathsSet(run, series.commits.some((commit) => commit.revision === 'change'), series.commits.flatMap((commit) => (commit.revision === 'change' ? [] : [revisions[commit.revision]!])));
}

/** The paths the user staged that differ from `HEAD` and that no commit of a series sets, which an index reset unstages and leaves as they are in the tree. */
function stagedOutside(worktree: string, paths: ReadonlySet<string>): string[] {
  return git(worktree, ['diff', '--cached', '--name-only', '-z', 'HEAD']).split('\0').filter((path) => path.length > 0 && !paths.has(path));
}

/**
 * Refuse, naming the reason, before any object is written: a HEAD that is
 * not the run's head, the scope's head or, once the run has commits, the
 * last of them (R8 of answers); a path the series commits, each revision's
 * and in worktree mode for the first series every path of the change,
 * whose content differs from what the run recorded last, as git would
 * store each (R22 of the fix pass); a change message missing where the
 * series commits the change first, or given where it does not.
 */
function refuse(run: RunState, worktree: string, changeMessage: string | undefined, match: ExpectedMatch): void {
  const scope = run.scope!;
  const fix = run.review!.fix!;
  const series = seriesOf(run);
  const head = git(worktree, ['rev-parse', 'HEAD']).trim();
  if (head !== series.head) {
    const which = fix.commits.length === 0 ? `the head run ${run.id} reviewed` : `the last commit made for run ${run.id}`;
    throw new ReviewRefusedError(`HEAD is ${head}, not ${series.head}, ${which}; check that commit out, or commit the patch series by hand`);
  }
  if (series.change && (changeMessage === undefined || changeMessage.trim() === '')) {
    throw new ReviewRefusedError(`run ${run.id} reviewed uncommitted changes, which are committed first as the change under review; give that commit's message with --change-message <text>`);
  }
  if (scope.mode !== 'worktree' && changeMessage !== undefined) throw new ReviewRefusedError(`run ${run.id} reviewed a committed change (${scope.mode}), so there is no change to commit first; leave out --change-message`);
  if (scope.mode === 'worktree' && !series.change && changeMessage !== undefined) throw new ReviewRefusedError(`run ${run.id}'s change was committed with its first series, so there is no change to commit first; leave out --change-message`);
  const expected = expectedTree(scope, fix.revisions);
  const committed = series.paths;
  const differs = compareExpected(new Map([...expected].filter(([path]) => committed.has(path))), worktreeReader(worktree), new Set(), match);
  if (differs.length > 0) {
    throw new ReviewRefusedError(`the worktree no longer holds what run ${run.id} recorded at ${differs.map((file) => `${file.path} (${file.outcome})`).join(', ')}; undo those edits, or commit the patch series by hand`);
  }
}

/** What settling a run's open series of commits did: the run as it stands after, and the series it completed, if it completed one. */
export interface SettledSeries {
  readonly run: RunState;
  readonly completed: CommitsCreated | null;
}

/**
 * What settling a run's open series of commits does with `HEAD` where it
 * is (R9, TD6 of resumable runs): a series `commit` prepared on the
 * ledger and never recorded as created. With `HEAD` at the head the
 * series makes, the branch moved, and the series is completed; with
 * `HEAD` at the head it starts from, the branch did not move, and the
 * series is dropped and can be built again; with `HEAD` at any other
 * commit, neither record would be true. Each settle that records names
 * its event and the line that says it.
 */
export type SeriesSettle =
  | { readonly kind: 'complete' | 'drop'; readonly series: CommitsPrepared; readonly event: NewEvent; readonly line: string }
  | { readonly kind: 'elsewhere'; readonly series: CommitsPrepared; readonly head: string };

/** How the run's open series settles with `HEAD` at `head`, or null when no series is open. */
export function seriesSettleOf(run: RunState, head: string): SeriesSettle | null {
  const open = run.review?.fix?.openSeries ?? null;
  if (open === null) return null;
  if (head === open.to) {
    const line = `run ${run.id}: a commit a stop cut short had moved HEAD to ${open.to.slice(0, 12)}; the ${commitCount(open.commits.length)} it made ${open.commits.length === 1 ? 'is' : 'are'} recorded now`;
    return { kind: 'complete', series: open, event: { kind: 'commits.created', version: 1, payload: open }, line };
  }
  if (head === open.from) {
    const line = `run ${run.id}: a commit a stop cut short had left HEAD at ${open.from.slice(0, 12)}; its series is dropped`;
    return { kind: 'drop', series: open, event: { kind: 'commits.dropped', version: 1, payload: { from: open.from, to: open.to } }, line };
  }
  return { kind: 'elsewhere', series: open, head };
}

/** The commit `HEAD` names in `worktree`. */
export const headOf = (worktree: string): string => git(worktree, ['rev-parse', 'HEAD']).trim();

/** Reset the index to `HEAD` once a series moved the branch; not cut short, since the ledger must then record what the branch holds, and it waits on neither a lock nor a remote. */
export function resetIndex(worktree: string): void {
  git(worktree, ['reset', '-q'], { timeout: 0 });
}

/**
 * Reset the index to the head a completed series moved the branch to
 * (`resetIndex`), giving the paths the user staged that none of its
 * commits sets, which the reset unstaged and left as they are in the
 * tree, as `commit` names them for a series it completes itself.
 */
export function resetSettledIndex(run: RunState, series: CommitsPrepared, worktree: string): readonly string[] {
  const staged = stagedOutside(worktree, recordedPaths(run, series));
  resetIndex(worktree);
  return staged;
}

/** The line that names the staged paths a settle's index reset unstaged. */
export const unstagedLine = (runId: string, paths: readonly string[]): string => `run ${runId}: staged paths no commit holds were unstaged and are unchanged in the tree: ${paths.join(', ')}`;

/** What `settle` did: the settled series, and the paths a completed series' index reset unstaged. */
interface Settled extends SettledSeries {
  readonly unstaged: readonly string[];
}

/** `settleOpenSeries`, giving the paths the index reset unstaged rather than naming them. */
function settle(checkpoint: Checkpoint, run: RunState, worktree: string, log: (line: string) => void): Settled {
  const settled = seriesSettleOf(run, headOf(worktree));
  if (settled === null) return { run, completed: null, unstaged: [] };
  if (settled.kind === 'elsewhere') {
    const { series, head } = settled;
    throw new ReviewRefusedError(`a commit of run ${run.id} that a stop cut short was moving HEAD from ${series.from} to ${series.to}, and HEAD is ${head}, at neither; move HEAD to ${series.to} to keep those commits, or to ${series.from} to drop them, and run the command again`);
  }
  const unstaged = settled.kind === 'complete' ? resetSettledIndex(run, settled.series, worktree) : [];
  const state = checkpoint.append(run.id, run.lastSequence, [settled.event]);
  log(settled.line);
  return { run: state, completed: settled.kind === 'complete' ? settled.series : null, unstaged };
}

/**
 * Settle the series of commits a stop left open (`seriesSettleOf`) before
 * a command reads the run's head: a completed series resets the index to
 * the head the branch moved to, naming the staged paths its commits do
 * not hold, which the reset unstaged, and is recorded as created; a
 * dropped one is recorded as dropped; with `HEAD` at neither of its heads
 * the command refuses, naming both. The caller holds the run's lock and
 * has checked that `worktree` is the run's.
 */
export function settleOpenSeries(checkpoint: Checkpoint, run: RunState, worktree: string, log: (line: string) => void): SettledSeries {
  const { unstaged, ...settled } = settle(checkpoint, run, worktree, log);
  if (unstaged.length > 0) log(unstagedLine(run.id, unstaged));
  return settled;
}

/** A count of commits, as a log line names it. */
const commitCount = (count: number): string => `${String(count)} commit${count === 1 ? '' : 's'}`;

/**
 * Commit a completed fix run's revisions (R17): under the checkpoint's
 * start lock and the run's lock, settle a series a stop left open (R9 of
 * resumable runs), refuse what cannot be committed, build every commit,
 * record the series as prepared, move the ref once with a
 * compare-and-swap, reset the index to the new head, and record the
 * commits as created on the run's ledger. A run whose open series the
 * settle completed and that has nothing left to commit gives that series
 * as what the command made. The staged paths the settle's index reset
 * unstaged are given with the outcome's, or logged when the command then
 * refuses.
 */
export function commitRun(options: CommitOptions): CommitOutcome {
  const { checkpoint, worktree } = options;
  const log = options.log ?? ((line: string): void => {
    process.stderr.write(`${line}\n`);
  });
  const releaseStart = acquireStartLock(checkpoint.root);
  try {
    const chosen = chooseRun(checkpoint, options.runId, log);
    const release = acquireRunLock(checkpoint.root, chosen.id);
    try {
      // Read again under the run's lock, as every writer does: another command may have committed it since it was chosen.
      const folded = requireCommittable(checkpoint.fold(chosen.id));
      if (!sameDirectory(folded.worktree, worktree)) throw new ReviewRefusedError(`run ${folded.id} was reviewed in worktree ${folded.worktree}, not ${worktree}; run the command there`);
      const { run, completed, unstaged } = settle(checkpoint, folded, worktree, log);
      if (completed !== null && whyNotCommittable(run) !== null) return { runId: run.id, commits: completed.commits.map((entry) => ({ sha: entry.sha, subject: entry.subject })), unstaged };
      try {
        requireCommittable(run);
        refuse(run, worktree, options.changeMessage, gitContent(worktree, (reference) => checkpoint.evidence.read(reference)).match);
        const built = build(run, options);
        return { ...built, unstaged: [...unstaged, ...built.unstaged] };
      } catch (error) {
        // The settle's reset has unstaged them whatever follows, so a refusal still names them.
        if (unstaged.length > 0) log(unstagedLine(run.id, unstaged));
        throw error;
      }
    } finally {
      release();
    }
  } finally {
    releaseStart();
  }
}

/**
 * What a failed compare-and-swap of `ref` to `last` throws, from the error
 * `git` threw for it. git refuses a ref that moved, which leaves it where it
 * is; a git ended at its timeout is another case, since it may have moved the
 * ref already, and on Windows it is killed with `TerminateProcess`, which
 * runs none of git's cleanup, so its `<ref>.lock` may remain.
 */
export function moveFailure(ref: string, last: string, error: Error): Error {
  if (gitTimedOut(error.cause)) {
    return new Error(`git update-ref timed out and was ended, so ${ref} may or may not point at ${last} now, the commits are not recorded on the run, and git may have left ${ref}.lock behind in the git directory, which refuses every later update of ${ref} until it is removed by hand: ${error.message}`, { cause: error });
  }
  return new ReviewRefusedError(`${ref} moved while the commits were built, so it was left where it is and the commits are unreferenced: ${error.message}`);
}

/**
 * Build the commits, record the series as prepared, move the ref, reset
 * the index and record the series as created; every refusal has been
 * made. A stop between the two records leaves the series open, which the
 * next command settles by where `HEAD` is (`settleOpenSeries`, R9 of
 * resumable runs); a move git refused leaves the ref where it was, so the
 * series is dropped at once.
 */
function build(run: RunState, options: CommitOptions): CommitOutcome {
  const { checkpoint, worktree } = options;
  const scope = run.scope!;
  const fix = run.review!.fix!;
  const series = seriesOf(run);
  // Every byte the series commits is read and checked before any object is written, so an unfreezable file refuses with nothing built.
  for (const [path, file] of expectedTree(scope, fix.revisions)) if (file !== null && series.paths.has(path)) bytesOf(checkpoint, path, file.frozen);

  const temporary = mkdtempSync(join(tmpdir(), 'deep-review-commit-'));
  try {
    // A later series starts from the tree of the last commit made for the run, which holds every revision before it (PD7 of answers).
    const trees = new TreeBuilder(worktree, checkpoint, join(temporary, 'index'), series.head);
    const made: (CommitsCreated['commits'][number])[] = [];
    let parent = series.head;
    const commit = (message: string, revision: number | 'change'): void => {
      const tree = trees.write();
      // commit-tree signs when commit.gpgSign asks; like every detached git call, a signing step is bounded by gitTimeoutMs.
      const sha = git(worktree, ['commit-tree', tree, '-p', parent, '-F', '-'], { input: message }).trim();
      made.push({ sha, revision, subject: subjectOf(message) });
      parent = sha;
    };
    if (series.change) {
      for (const file of scope.files) trees.set(file.path, file.after === null ? null : { frozen: file.after, symlink: file.symlink });
      commit(messageOf(options.changeMessage!, '', null), 'change');
    }
    // One commit per revision, an unfinished attempt's too, so a partial edit that does not build fails each commit until its unit's next one: https://github.com/josephjang/deep-review/issues/63
    for (const { index, revision } of series.revisions) {
      for (const file of revision.files) trees.set(file.path, file.after === null ? null : { frozen: file.after, symlink: file.symlink });
      const message = revisionMessageOf(fix, revision);
      commit(messageOf(message.subject, message.body, trailer(run, revision)), index);
    }

    // What the user had staged that no commit holds is unstaged by the reset below, and named; nothing is lost from the tree.
    const staged = stagedOutside(worktree, series.paths);

    const last = parent;
    const payload: CommitsCreated = { commits: made, from: series.head, to: last };
    // The series is on the ledger before the ref moves, so a stop past the move leaves a record to complete, not commits the ledger does not hold (R9 of resumable runs).
    const prepared = checkpoint.append(run.id, checkpoint.fold(run.id).lastSequence, [{ kind: 'commits.prepared', version: 1, payload }]);
    options.beforeMove?.();
    const branch = currentBranch(worktree);
    try {
      // The compare-and-swap: the ref moves only from the head the command started from.
      if (branch === '') git(worktree, ['update-ref', '--no-deref', '-m', `deep-review commit: run ${run.id}`, 'HEAD', last, series.head]);
      else git(worktree, ['update-ref', '-m', `deep-review commit: run ${run.id}`, branch, last, series.head]);
    } catch (error) {
      const failure = moveFailure(branch === '' ? 'HEAD' : branch, last, error as Error);
      // git refused the move and left the ref where it was, so the series did not happen; a git ended at its timeout may have moved it, and its series stays open for the next command to settle by HEAD.
      if (failure instanceof ReviewRefusedError) checkpoint.append(run.id, prepared.lastSequence, [{ kind: 'commits.dropped', version: 1, payload: { from: payload.from, to: payload.to } }]);
      throw failure;
    }
    resetIndex(worktree);
    checkpoint.append(run.id, prepared.lastSequence, [{ kind: 'commits.created', version: 1, payload }]);
    return { runId: run.id, commits: made.map((entry) => ({ sha: entry.sha, subject: entry.subject })), unstaged: staged };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
