/**
 * `deep-review commit` (R17, PD13, TD13 of the fix pass): turn a completed
 * fix run's revisions into commits, one per revision, after the run and
 * only when a person asks. The commits are built from the run's frozen
 * bytes with git's plumbing (blobs with hash-object, trees through a
 * temporary index, commits with commit-tree), so no file of the worktree
 * is written and no hook runs; the branch, or a detached HEAD, moves once
 * at the end with a compare-and-swap against the head the command started
 * from, and the index is reset to it so the tree shows clean.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Checkpoint } from '../checkpoint/checkpoint.ts';
import type { CommitsCreated, FrozenFile, TreeRevised } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { sameDirectory } from '../paths.ts';
import { ReviewRefusedError } from './errors.ts';
import { acquireRunLock, acquireStartLock } from './lock.ts';
import { rankedFindings } from './state.ts';
import { compareExpected, expectedTree, worktreeReader, type ExpectedFile } from './tree.ts';

export interface CommitOptions {
  readonly checkpoint: Checkpoint;
  /** The worktree the command runs in, which must be the run's. */
  readonly worktree: string;
  /** The run to commit; the newest completed fix run with revisions and no commits when absent. */
  readonly runId?: string;
  /** The message of the captured change's own commit, required in worktree mode and refused in every other. */
  readonly changeMessage?: string;
  /** Called after every object is built and before the ref moves; a test makes a commit there to see the move refused. */
  readonly beforeMove?: () => void;
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

/** Run git in the worktree with the given environment additions and stdin, returning stdout as text. */
function git(worktree: string, args: readonly string[], options: { readonly env?: NodeJS.ProcessEnv; readonly input?: Buffer | string } = {}): string {
  try {
    return execFileSync('git', ['--no-optional-locks', ...args], {
      cwd: worktree,
      env: { ...process.env, ...options.env },
      input: options.input ?? '',
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const failure = error as { stderr?: string; message: string };
    throw new Error(`git ${args.join(' ')} failed: ${failure.stderr?.trim() || failure.message}`, { cause: error });
  }
}

/** Why a run cannot be committed, or null when it can: a fix run with its report, at least one revision, and no commits yet. */
function whyNotCommittable(run: RunState): string | null {
  const fix = run.review?.fix ?? null;
  if (run.status !== 'active') return `run ${run.id} is ${run.status}; only a completed fix run is committed`;
  if (run.review === null || fix === null) return `run ${run.id} ran without --fix, so it has no fixes to commit`;
  if (run.review.report === null) return `run ${run.id} has no report yet; run the review to its report first`;
  if (fix.commits !== null) return `run ${run.id}'s commits were already created: ${fix.commits.commits.map((commit) => commit.sha.slice(0, 12)).join(', ')}`;
  if (fix.revisions.length === 0) return `run ${run.id} changed no file, so there is nothing to commit`;
  return null;
}

/** Refuse a run that cannot be committed, naming why. */
function requireCommittable(run: RunState): RunState {
  const reason = whyNotCommittable(run);
  if (reason !== null) throw new ReviewRefusedError(reason);
  return run;
}

/** The run to commit: the one named, which must be committable, or the newest committable run of the repository. */
function chooseRun(checkpoint: Checkpoint, runId: string | undefined): RunState {
  if (runId !== undefined) return requireCommittable(checkpoint.fold(runId));
  const found = checkpoint.listRuns().filter((run) => whyNotCommittable(run) === null).at(-1);
  if (found === undefined) throw new ReviewRefusedError('no completed fix run has changes left to commit; name one with --run <id>');
  return found;
}

/** The bytes a frozen file holds, refused for one frozen by hash and size only, which the run never kept. */
function bytesOf(checkpoint: Checkpoint, path: string, frozen: FrozenFile): Buffer {
  if ('oversized' in frozen) throw new ReviewRefusedError(`${path} is larger than the run freezes (${String(frozen.oversized.size)} bytes), so its bytes were never kept and no commit can be built for it; commit it by hand`);
  return checkpoint.evidence.read(frozen.blob);
}

/** The trailer a revision's commit carries, naming the run and what the revision holds. */
function trailer(run: RunState, revision: TreeRevised): string {
  switch (revision.source.kind) {
    case 'fix': {
      if (revision.phase === 'repair') return `Deep-review: run ${run.id}, repair of the ${revision.change.findings.join(', ')} check`;
      const findings = new Map(rankedFindings(run.review!).map((entry) => [entry.finding.id, entry]));
      const named = revision.change.findings.map((id) => {
        const entry = findings.get(id);
        return entry === undefined ? id : `${id} (${entry.primary.angle}, ${entry.resolution.verdict})`;
      });
      return `Deep-review: run ${run.id}, ${named.join(', ')}`;
    }
    case 'check':
      return `Deep-review: run ${run.id}, ${revision.source.check} check`;
    case 'unanswered':
      return `Deep-review: run ${run.id}, partial edits of ${revision.source.key === 'repair' ? 'the repair' : `batch ${revision.source.key}`}`;
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

/** The branch HEAD names, as a full ref, or the empty string for a detached HEAD, for which `symbolic-ref -q` exits 1 and prints nothing. */
function currentBranch(worktree: string): string {
  try {
    return execFileSync('git', ['--no-optional-locks', 'symbolic-ref', '-q', 'HEAD'], { cwd: worktree, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if ((error as { status?: number }).status === 1) return '';
    throw error;
  }
}

/**
 * Refuse, naming the reason, before any object is written: a HEAD that is
 * not the scope's head; a revised path, or in worktree mode any path the
 * run expects, whose bytes differ from what the run recorded last; a
 * change message missing in worktree mode or given in any other.
 */
function refuse(run: RunState, worktree: string, changeMessage: string | undefined): void {
  const scope = run.scope!;
  const fix = run.review!.fix!;
  const head = git(worktree, ['rev-parse', 'HEAD']).trim();
  if (head !== scope.head) throw new ReviewRefusedError(`HEAD is ${head}, not ${scope.head}, the head run ${run.id} reviewed; check that commit out, or commit the patch series by hand`);
  if (scope.mode === 'worktree' && (changeMessage === undefined || changeMessage.trim() === '')) {
    throw new ReviewRefusedError(`run ${run.id} reviewed uncommitted changes, which are committed first as the change under review; give that commit's message with --change-message <text>`);
  }
  if (scope.mode !== 'worktree' && changeMessage !== undefined) throw new ReviewRefusedError(`run ${run.id} reviewed a committed change (${scope.mode}), so there is no change to commit first; leave out --change-message`);
  const expected = expectedTree(scope, fix.revisions);
  // The revised paths always; in worktree mode the change's own paths too, since its commit is built from their frozen bytes.
  const committed = new Set([...fix.revisions.flatMap((revision) => revision.files.map((file) => file.path)), ...(scope.mode === 'worktree' ? scope.files.map((file) => file.path) : [])]);
  const differs = compareExpected(new Map([...expected].filter(([path]) => committed.has(path))), worktreeReader(worktree));
  if (differs.length > 0) {
    throw new ReviewRefusedError(`the worktree no longer holds what run ${run.id} recorded at ${differs.map((file) => `${file.path} (${file.outcome})`).join(', ')}; undo those edits, or commit the patch series by hand`);
  }
}

/**
 * Commit a completed fix run's revisions (R17): under the checkpoint's
 * start lock and the run's lock, refuse what cannot be committed, build
 * every commit, move the ref once with a compare-and-swap, reset the index
 * to the new head, and record the commits on the run's ledger.
 */
export function commitRun(options: CommitOptions): CommitOutcome {
  const { checkpoint, worktree } = options;
  const releaseStart = acquireStartLock(checkpoint.root);
  try {
    const chosen = chooseRun(checkpoint, options.runId);
    const release = acquireRunLock(checkpoint.root, chosen.id);
    try {
      // Read again under the run's lock, as every writer does: another command may have committed it since it was chosen.
      const run = requireCommittable(checkpoint.fold(chosen.id));
      if (!sameDirectory(run.worktree, worktree)) throw new ReviewRefusedError(`run ${run.id} was reviewed in worktree ${run.worktree}, not ${worktree}; run the command there`);
      refuse(run, worktree, options.changeMessage);
      return build(run, options);
    } finally {
      release();
    }
  } finally {
    releaseStart();
  }
}

/** Build the commits, move the ref, reset the index and record them; every refusal has been made. */
function build(run: RunState, options: CommitOptions): CommitOutcome {
  const { checkpoint, worktree } = options;
  const scope = run.scope!;
  const fix = run.review!.fix!;
  // Every byte is read and checked before any object is written, so an unfreezable file refuses with nothing built.
  for (const [path, file] of expectedTree(scope, fix.revisions)) if (file !== null) bytesOf(checkpoint, path, file.frozen);

  const temporary = mkdtempSync(join(tmpdir(), 'deep-review-commit-'));
  try {
    const trees = new TreeBuilder(worktree, checkpoint, join(temporary, 'index'), scope.head);
    const made: (CommitsCreated['commits'][number])[] = [];
    let parent = scope.head;
    const commit = (message: string, revision: number | 'change'): void => {
      const tree = trees.write();
      const sha = git(worktree, ['commit-tree', tree, '-p', parent, '-F', '-'], { input: message }).trim();
      made.push({ sha, revision, subject: subjectOf(message) });
      parent = sha;
    };
    if (scope.mode === 'worktree') {
      for (const file of scope.files) trees.set(file.path, file.after === null ? null : { frozen: file.after, symlink: file.symlink });
      commit(messageOf(options.changeMessage!, '', null), 'change');
    }
    fix.revisions.forEach((revision, index) => {
      for (const file of revision.files) trees.set(file.path, file.after === null ? null : { frozen: file.after, symlink: file.symlink });
      commit(messageOf(revision.change.message.subject, revision.change.message.body, trailer(run, revision)), index);
    });

    // What the user had staged that no commit holds is unstaged by the reset below, and named; nothing is lost from the tree.
    const committed = new Set([...(scope.mode === 'worktree' ? scope.files.map((file) => file.path) : []), ...fix.revisions.flatMap((revision) => revision.files.map((file) => file.path))]);
    const staged = git(worktree, ['diff', '--cached', '--name-only', '-z', 'HEAD']).split('\0').filter((path) => path.length > 0 && !committed.has(path));

    options.beforeMove?.();
    const last = parent;
    const branch = currentBranch(worktree);
    try {
      // The compare-and-swap: the ref moves only from the head the command started from.
      if (branch === '') git(worktree, ['update-ref', '--no-deref', '-m', `deep-review commit: run ${run.id}`, 'HEAD', last, scope.head]);
      else git(worktree, ['update-ref', '-m', `deep-review commit: run ${run.id}`, branch, last, scope.head]);
    } catch (error) {
      throw new ReviewRefusedError(`${branch === '' ? 'HEAD' : branch} moved while the commits were built, so it was left where it is and the commits are unreferenced: ${(error as Error).message}`);
    }
    git(worktree, ['reset', '-q']);
    const payload: CommitsCreated = { commits: made, from: scope.head, to: last };
    const state = checkpoint.fold(run.id);
    checkpoint.append(run.id, state.lastSequence, [{ kind: 'commits.created', version: 1, payload }]);
    return { runId: run.id, commits: made.map((entry) => ({ sha: entry.sha, subject: entry.subject })), unstaged: staged };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
