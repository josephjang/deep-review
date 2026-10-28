/**
 * Where a check runs on the base of the change, and with what (R1, R11,
 * TD2, TD3, TD11 of the facts before a merge): a detached linked worktree
 * of the base, made with the hooks of the repository off, which git
 * records locked with a reason that names the run, so any later command of
 * the run finds it whatever its temporary directory; and the environment of
 * a check there, which loses git's repository variables, a `VIRTUAL_ENV`
 * inside the reviewed worktree and the entries inside it of the directory
 * lists (`directoryLists`), so the check finds neither the repository nor
 * the programs and modules of the change through them. Every other
 * variable, such as `PWD`, `HOME` or `CLAUDE_PROJECT_DIR`, is inherited as
 * it is, and may still name the reviewed worktree.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalPath, isInside } from '../../paths.ts';
import { comparable, pinVariables } from '../../runtime/environment.ts';
import { gitFailureDetail, isRepositoryVariable, runGitSync, withoutRepositoryVariables } from '../../runtime/git-sync.ts';
import { requireOutsideRun } from '../../runtime/scratch.ts';
import { isEmptyTree } from '../../scope/git.ts';
import { baseSkipReasons, type BaseSkip } from '../vocabulary.ts';
import { checkEnvironment } from './run.ts';

/** The reason git records with the lock of each worktree of the base a run makes, by which a later command of the run finds it. */
export const baseLockReason = (runId: string): string => `deep-review ${runId}`;

/** The start of the name of each directory a run makes under the scratch directory for a worktree of its base; never the run's own directory there, which holds its claims. */
const directoryPrefix = (runId: string): string => `${runId}-base-`;

/**
 * How long `git worktree add` may run: ten minutes. The checkout writes
 * every file of the base, which takes minutes for the largest repositories
 * on a cold disk, and in a partial clone it fetches their blobs over the
 * network; the 60 seconds `runGitSync` gives a detached git on Windows
 * would refuse such a base. The bound still ends a git that waits on a lock
 * or a remote, and the removal of such a tree gets it too.
 */
export const baseCheckoutTimeoutMs = 600_000;

/** Where the checks on the base of an attempt run, or why no worktree is there, as a `skipped` run records it. */
export type BaseTree = { readonly kind: 'made'; readonly path: string } | { readonly kind: 'none'; readonly skip: BaseSkip };

/** What making and removing the worktrees of the base of a run read. */
export interface BaseTreeContext {
  readonly runId: string;
  /** The reviewed worktree, where git runs: every worktree of the repository lists them all. */
  readonly worktree: string;
  /** The scratch directory of the checkpoint, under which each worktree of the base gets a private directory. */
  readonly scratch: string;
  /** The checkpoint's root, which a worktree of the base is held outside of. */
  readonly checkpointRoot: string;
  /** The environment of the engine, which git runs with less its repository variables (TD11). */
  readonly environment: NodeJS.ProcessEnv;
  readonly log: (line: string) => void;
}

/** git's environment for a worktree of the base: the engine's without its repository variables (TD11), with no download of a large file of Git LFS at the checkout and no prompt for credentials. */
const gitEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => pinVariables(withoutRepositoryVariables(environment), { GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' }, process.platform);

/** Run git in the reviewed worktree for a worktree of the base. */
const baseGit = (context: BaseTreeContext, args: readonly string[], timeout?: number): string =>
  runGitSync(args, { cwd: context.worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnvironment(context.environment), ...(timeout === undefined ? {} : { timeout }) });

/**
 * Make the worktree of the base for an attempt (R1, TD2): none for the
 * empty tree, the base of a root commit, which no worktree can check out;
 * else `git worktree add --detach --lock` of `base` in a new private
 * directory under the scratch directory, held outside the reviewed tree
 * and the checkpoint, with a hooks path that does not exist, so no hook of
 * the repository runs at the checkout. Whatever fails gives no worktree,
 * with its reason, the fixed words and the first line of the error: the run on the
 * base never blocks the run (R11). What a failed call left is removed with
 * the rest of the run's (`removeBaseTrees`).
 */
export function makeBaseTree(context: BaseTreeContext, base: string): BaseTree {
  if (isEmptyTree(base)) return { kind: 'none', skip: { reason: 'empty-tree', error: baseSkipReasons['empty-tree'] } };
  try {
    requireOutsideRun('worktree of the base', context.scratch, { worktree: context.worktree }, { root: context.checkpointRoot });
    mkdirSync(context.scratch, { recursive: true });
    const path = mkdtempSync(join(context.scratch, directoryPrefix(context.runId)));
    baseGit(context, ['-c', `core.hooksPath=${path}.no-hooks`, 'worktree', 'add', '--detach', '--lock', '--reason', baseLockReason(context.runId), path, base], baseCheckoutTimeoutMs);
    context.log(`the worktree of the base ${base.slice(0, 8)} is at ${path}`);
    return { kind: 'made', path };
  } catch (error) {
    const detail = gitFailureDetail(error, baseCheckoutTimeoutMs);
    context.log(`no worktree of the base ${base.slice(0, 8)} could be made: ${detail}`);
    return { kind: 'none', skip: { reason: 'no-worktree', error: `${baseSkipReasons['no-worktree']}: ${detail.split(/\r?\n/)[0] ?? ''}` } };
  }
}

/**
 * The paths of the worktrees `git worktree list --porcelain` gives whose
 * lock reason is `reason`, its fields ended by `separator`: NUL with `-z`,
 * which quotes no path or reason, else a newline, as a git before 2.36
 * gives them, which has no `-z` and quotes neither.
 */
function lockedWith(listing: string, reason: string, separator: '\0' | '\n'): string[] {
  const paths: string[] = [];
  let path: string | null = null;
  for (const field of listing.split(separator)) {
    if (field.startsWith('worktree ')) path = field.slice('worktree '.length);
    else if (field === `locked ${reason}` && path !== null) paths.push(path);
  }
  return paths;
}

/**
 * Remove every worktree of the base the run left (R1, R11, TD3): each
 * entry of `git worktree list` locked with the run's reason, by
 * `git worktree remove -f -f`, which removes a locked entry, and the entry
 * alone when its directory is gone; then each directory of the run's
 * worktrees of the base under this scratch directory, which a stop before
 * git recorded the entry leaves. The entries are listed with `-z` where
 * git has it, and by line on a git before 2.36, which refuses `-z`, so its
 * locked entries are removed too. It never runs `git worktree prune`, which
 * would remove the entry of each other worktree whose directory is
 * missing. A removal that fails is logged and left to the next command, so
 * this converges however often it runs and wherever a crash stopped it.
 */
export function removeBaseTrees(context: BaseTreeContext): void {
  let paths: string[] = [];
  try {
    paths = lockedWith(baseGit(context, ['worktree', 'list', '--porcelain', '-z']), baseLockReason(context.runId), '\0');
  } catch (error) {
    context.log(`could not list the worktrees of the base with -z, listing them by line: ${gitFailureDetail(error)}`);
    try {
      paths = lockedWith(baseGit(context, ['worktree', 'list', '--porcelain']), baseLockReason(context.runId), '\n');
    } catch (lineError) {
      context.log(`could not list the worktrees of the base: ${gitFailureDetail(lineError)}`);
    }
  }
  for (const path of paths) {
    try {
      baseGit(context, ['worktree', 'remove', '-f', '-f', path], baseCheckoutTimeoutMs);
      context.log(`removed the worktree of the base at ${path}`);
    } catch (error) {
      context.log(`could not remove the worktree of the base at ${path}: ${gitFailureDetail(error, baseCheckoutTimeoutMs)}`);
    }
  }
  let names: string[] = [];
  try {
    names = readdirSync(context.scratch).filter((name) => name.startsWith(directoryPrefix(context.runId)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') context.log(`could not read the scratch directory ${context.scratch}: ${(error as Error).message}`);
  }
  for (const name of names) {
    try {
      rmSync(join(context.scratch, name), { recursive: true, force: true });
    } catch (error) {
      context.log(`could not remove ${join(context.scratch, name)}: ${(error as Error).message}`);
    }
  }
}

/** The variables that list directories or archives a check finds programs or modules in, of the shell, Python, Node, Perl, Ruby and Java, whose entries inside the reviewed worktree a check on the base leaves out (TD11). */
const directoryLists: readonly string[] = ['PATH', 'PYTHONPATH', 'NODE_PATH', 'PERL5LIB', 'PERLLIB', 'RUBYLIB', 'GEM_PATH', 'CLASSPATH'];

/** The environment of a check on the base, and each variable it changed, in the words of the log. */
export interface BaseEnvironment {
  readonly environment: NodeJS.ProcessEnv;
  readonly changed: readonly string[];
}

/**
 * Whether the absolute `directory` is the reviewed worktree or beneath it:
 * on canonical paths, or, when `directory` cannot be canonical, such as one
 * under a directory the user cannot search, as written against the
 * canonical worktree, so one entry the check could not read anyway never
 * ends the run (R11).
 */
function insideReviewed(reviewed: string, directory: string): boolean {
  try {
    return isInside(reviewed, directory);
  } catch {
    const path = relative(canonicalPath(reviewed), resolve(directory));
    return path === '' || !(path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path));
  }
}

/**
 * The environment of a check on the base (TD11): `checkEnvironment` with
 * the directories of `tools.path` first on PATH, as every check has it,
 * then without the repository variables of git, without each entry of
 * PATH, PYTHONPATH, NODE_PATH, PERL5LIB, PERLLIB, RUBYLIB, GEM_PATH and
 * CLASSPATH inside the reviewed worktree, without such a variable when no
 * entry is left, and without VIRTUAL_ENV when it is inside it. A relative
 * entry stays: it names a directory of the
 * check's working directory, the worktree of the base. A variable that
 * names one path or holds options, such as HOME, TMPDIR or NODE_OPTIONS,
 * stays as it is.
 */
export function baseEnvironment(environment: NodeJS.ProcessEnv, reviewed: string, toolsPath: readonly string[], platform: NodeJS.Platform = process.platform): BaseEnvironment {
  const inside = (directory: string): boolean => isAbsolute(directory) && insideReviewed(reviewed, directory);
  const delimiter = platform === 'win32' ? ';' : ':';
  const lists = new Set(directoryLists.map((name) => comparable(name, platform)));
  const changed: string[] = [];
  const kept: [string, string | undefined][] = [];
  for (const [name, value] of Object.entries(checkEnvironment(environment, platform, toolsPath))) {
    if (isRepositoryVariable(name, platform)) {
      changed.push(name);
      continue;
    }
    if (comparable(name, platform) === comparable('VIRTUAL_ENV', platform) && value !== undefined && inside(value)) {
      changed.push(`${name}, inside the reviewed worktree`);
      continue;
    }
    if (lists.has(comparable(name, platform)) && value !== undefined) {
      const entries = value.split(delimiter);
      const removed = entries.filter(inside);
      if (removed.length > 0) {
        const rest = entries.filter((entry) => !inside(entry)).join(delimiter);
        // An empty PATH searches the working directory alone, so a list left with no entry goes.
        if (rest === '') {
          changed.push(`${name}, every entry inside the reviewed worktree: ${removed.join(', ')}`);
          continue;
        }
        changed.push(`the entries of ${name} inside the reviewed worktree: ${removed.join(', ')}`);
        kept.push([name, rest]);
        continue;
      }
    }
    kept.push([name, value]);
  }
  return { environment: Object.fromEntries(kept), changed };
}
