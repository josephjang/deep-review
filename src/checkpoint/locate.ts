import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gitFailureDetail, gitTimedOut, runGitSync } from '../runtime/git-sync.ts';
import { NotInRepositoryError } from './errors.ts';

/** The directory name under the git common directory. Distinct from the legacy skills' `deep-review` and `deep-review-node`. */
export const checkpointDirectoryName = 'deep-review-checkpoint';

export interface CheckpointLocation {
  /** Absolute directory that holds `ledger.sqlite` and `artifacts/`. It may not exist yet. */
  readonly root: string;
  /** Absolute root of the worktree the directory is in. */
  readonly worktree: string;
  /** Absolute git common directory shared by every worktree of the repository. */
  readonly commonDir: string;
}

/**
 * Where the checkpoint for the repository containing `directory` lives. One
 * checkpoint per repository, under the git common directory, so it survives
 * the removal of the worktree a run was started in. Nothing is created.
 */
export function locateCheckpoint(directory: string): CheckpointLocation {
  const cwd = resolve(directory);
  let output: string;
  try {
    output = runGitSync(['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw locateFailure(cwd, error);
  }
  const [commonDir, toplevel, ...rest] = output.split(/\r?\n/).filter((line) => line.length > 0);
  if (commonDir === undefined || toplevel === undefined || rest.length > 0) {
    throw new NotInRepositoryError(`Unexpected git output while locating the checkpoint for ${cwd}: ${JSON.stringify(output)}`);
  }
  // The native realpath is what makes the result canonical on Windows: it
  // expands an 8.3 alias such as RUNNER~1 to the long name, which the JavaScript
  // realpath leaves as given, so two spellings of one directory give one answer.
  const resolvedCommonDir = realpathSync.native(commonDir);
  return { root: join(resolvedCommonDir, checkpointDirectoryName), worktree: realpathSync.native(toplevel), commonDir: resolvedCommonDir };
}

/**
 * What a failed `git rev-parse` in `cwd` throws, from the error
 * `runGitSync` threw for it: a git ended at its timeout was slow, which
 * says nothing about whether `cwd` is in a repository, so it is reported as
 * a timeout; any other failure is a `NotInRepositoryError`.
 */
export function locateFailure(cwd: string, error: unknown): Error {
  const detail = gitFailureDetail(error);
  if (gitTimedOut(error)) return new Error(`Locating the checkpoint for ${cwd} failed: git rev-parse ${detail}`, { cause: error });
  return new NotInRepositoryError(`${cwd} is not inside a git worktree: ${detail}`);
}
