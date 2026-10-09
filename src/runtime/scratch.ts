/**
 * Where a worker may write temporary files (R7, TD7): outside the reviewed
 * tree and the checkpoint, judged on canonical paths.
 */
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Checkpoint } from '../checkpoint/checkpoint.ts';
import type { RunState, WorkerState } from '../checkpoint/fold.ts';
import { sha256Hex } from '../evidence/store.ts';
import { isInside } from '../paths.ts';
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
 * Where the worker may write temporary files (R7, TD7): the one it
 * continues, the caller's, or `fallback`, a fresh one under the scratch
 * root. None when a read-only worker's runtime cannot allow writes to it.
 * One inside the reviewed tree or the checkpoint is refused
 * (`requireOutsideRun`).
 */
export function chooseScratch(checkpoint: Checkpoint, state: RunState, adapter: RuntimeAdapter, invocation: Invocation, continued: WorkerState | null, fallback: string): string | null {
  if (continued !== null) return continued.launch.scratch;
  if (invocation.access === 'read-only' && !adapter.capabilities.readOnlyScratch) return null;
  return requireOutsideRun('scratch directory', resolve(invocation.scratch ?? fallback), state, checkpoint);
}

/**
 * The directory an editor shares with the run's other editors (R2 of
 * commit series integrity), resolved, or null when the invocation names
 * none. A read-only worker writes nowhere, so one is refused for it, and
 * one inside the reviewed tree or the checkpoint is refused as a scratch
 * directory there is.
 */
export function chooseShared(checkpoint: Checkpoint, state: RunState, invocation: Invocation): string | null {
  if (invocation.shared === undefined) return null;
  if (invocation.access === 'read-only') throw new InvalidInvocationError(`A read-only worker writes nowhere, so it is given no shared directory, not ${invocation.shared}`);
  return requireOutsideRun('shared directory', resolve(invocation.shared), state, checkpoint);
}

/**
 * A directory a worker may write, held outside the run: one inside the
 * reviewed tree would be a stray file in the review, and one inside the
 * checkpoint sits in a git directory a sandboxed runtime keeps read-only.
 */
function requireOutsideRun(what: string, directory: string, state: RunState, checkpoint: Checkpoint): string {
  if (isInside(state.worktree, directory)) throw new InvalidInvocationError(`The ${what} ${directory} is inside the reviewed tree ${state.worktree}`);
  if (isInside(checkpoint.root, directory)) throw new InvalidInvocationError(`The ${what} ${directory} is inside the checkpoint ${checkpoint.root}`);
  return directory;
}
