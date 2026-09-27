/**
 * Where a worker may write temporary files (R7, TD7): outside the reviewed
 * tree and the checkpoint, judged on canonical paths.
 */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Checkpoint } from '../checkpoint/checkpoint.ts';
import type { RunState, WorkerState } from '../checkpoint/fold.ts';
import { sha256Hex } from '../evidence/store.ts';
import type { RuntimeAdapter } from './adapter.ts';
import type { Invocation } from './contract.ts';
import { InvalidInvocationError } from './errors.ts';

/**
 * Where scratch directories live by default: the system's temporary
 * directory, never the checkpoint. The checkpoint sits in the git directory,
 * which is inside a main worktree, and a sandboxed runtime keeps that
 * directory read-only: Codex refuses every command of a worker given a
 * writable root beneath it.
 */
export function defaultScratchRoot(): string {
  return join(tmpdir(), 'deep-review-scratch');
}

/** The directory under a scratch root that holds one checkpoint's scratch directories, so two repositories never share one. */
export function checkpointScratchKey(checkpoint: Checkpoint): string {
  return sha256Hex(Buffer.from(checkpoint.root, 'utf8')).slice(0, 16);
}

/**
 * The path with every symlink, junction and short name of its longest
 * existing ancestor resolved and the rest appended as written, so two
 * spellings of one directory compare equal even before it exists.
 */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const rest: string[] = [];
  for (let current = absolute; ; current = dirname(current)) {
    try {
      return join(realpathSync.native(current), ...rest);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    if (dirname(current) === current) return absolute;
    rest.unshift(basename(current));
  }
}

/**
 * Whether `child` is `parent` or beneath it. Both are canonical first, so an
 * alias through a link is caught, and the relative path is judged by whole
 * segments, so a child named `..tmp` is inside while `..` is not.
 */
function isInside(parent: string, child: string): boolean {
  const path = relative(canonicalPath(parent), canonicalPath(child));
  return path === '' || !(path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path));
}

/**
 * Where the worker may write temporary files (R7, TD7): the one it
 * continues, the caller's, or `fallback`, a fresh one under the scratch
 * root. None when a read-only worker's runtime cannot allow writes to it.
 * One inside the reviewed tree or the checkpoint is refused: the first would
 * be a stray file in the review, the second sits in a git directory a
 * sandboxed runtime keeps read-only.
 */
export function chooseScratch(checkpoint: Checkpoint, state: RunState, adapter: RuntimeAdapter, invocation: Invocation, continued: WorkerState | null, fallback: string): string | null {
  if (continued !== null) return continued.launch.scratch;
  if (invocation.access === 'read-only' && !adapter.capabilities.readOnlyScratch) return null;
  const scratch = resolve(invocation.scratch ?? fallback);
  if (isInside(state.worktree, scratch)) throw new InvalidInvocationError(`The scratch directory ${scratch} is inside the reviewed tree ${state.worktree}`);
  if (isInside(checkpoint.root, scratch)) throw new InvalidInvocationError(`The scratch directory ${scratch} is inside the checkpoint ${checkpoint.root}`);
  return scratch;
}
