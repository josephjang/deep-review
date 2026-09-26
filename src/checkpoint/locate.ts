import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
    output = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
    throw new NotInRepositoryError(`${cwd} is not inside a git worktree: ${detail}`);
  }
  const [commonDir, toplevel, ...rest] = output.split(/\r?\n/).filter((line) => line.length > 0);
  if (commonDir === undefined || toplevel === undefined || rest.length > 0) {
    throw new NotInRepositoryError(`Unexpected git output while locating the checkpoint for ${cwd}: ${JSON.stringify(output)}`);
  }
  const resolvedCommonDir = realpathSync(commonDir);
  return { root: join(resolvedCommonDir, checkpointDirectoryName), worktree: realpathSync(toplevel), commonDir: resolvedCommonDir };
}
