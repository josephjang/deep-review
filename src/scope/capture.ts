import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Checkpoint } from '../checkpoint/checkpoint.ts';
import { RunClosedError } from '../checkpoint/errors.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { locateCheckpoint } from '../checkpoint/locate.ts';
import type { FrozenFile, ScopeFile, ScopeMode, ScopeRequest, ScopeState } from '../checkpoint/events.ts';
import { sha256Hex, type EvidenceStore } from '../evidence/store.ts';
import { readLinkText } from '../paths.ts';
import { CaptureRacedError, InvalidScopeRequestError, ScopeAlreadyCapturedError, UnsupportedRepositoryStateError } from './errors.ts';
import * as gitApi from './git.ts';

/** A file larger than this, before or after, is recorded by hash and size only (D2). */
export const freezeLimitBytes = 8 * 1024 * 1024;

/** More changed paths than this refuses the capture instead of trimming it (R6). */
export const maxScopeFiles = 2000;

/** What the worktree holds at one path: bytes of a file, the target of a symlink, or nothing. */
interface WorktreeEntry {
  readonly bytes: Buffer;
  readonly symlink: boolean;
}

/** One changed path of the change a request names: its status, and whether git tracks it, which an untracked file of `worktree`, `ref` or `range` mode is not. */
export interface ChangedPath {
  readonly path: string;
  readonly status: ScopeFile['status'];
  readonly untracked: boolean;
}

/** Everything the capture learned about one path before any evidence is stored. */
interface Observation {
  readonly path: string;
  readonly status: ScopeFile['status'];
  readonly before: { bytes: Buffer; symlink: boolean } | null;
  readonly after: WorktreeEntry | null;
}

/**
 * The change a request names in a repository as it is now: the request as
 * the capture records it, its mode, base and head, the commit a
 * `last-commit` scope diffs to or null, `HEAD` and the index as the
 * resolution found them, and every changed path in path order. Nothing is
 * read beyond the names, so it is the capture's first half and all a
 * comparison with a captured scope needs (TD4 of fix pass continuation).
 */
export interface ResolvedScope {
  readonly request: ScopeRequest;
  readonly mode: ScopeMode;
  readonly base: string;
  readonly target: string | null;
  readonly guard: { readonly head: string; readonly index: string };
  readonly changes: readonly ChangedPath[];
}

/**
 * Resolve a request as the capture does, writing nothing: validate it,
 * spell its paths as the capture records them, refuse a repository state
 * the capture cannot record, choose the mode against `HEAD` and the tree,
 * and list every changed path, each requested path matching one and no
 * more paths than the capture accepts. Throws what the capture throws for
 * a request the tree refutes.
 */
export function resolveScopeRequest(repo: string, input: ScopeRequest): ResolvedScope {
  validateRequest(input);
  // Backslashes become slashes once, here: a path typed Windows-style must
  // select the same file on every platform, and git pathspecs want slashes.
  const request = normalizeRequest(input);
  refuseUnsupportedState(repo);
  const guardBefore = guard(repo);
  const { mode, base, target } = chooseMode(repo, request, guardBefore.head);
  const changes = listChanges(repo, mode, base, target, request.paths);
  requirePathsMatched(request.paths, changes);
  if (changes.length > maxScopeFiles) {
    throw new UnsupportedRepositoryStateError(`The change touches ${String(changes.length)} paths, more than the ${String(maxScopeFiles)} the capture accepts`);
  }
  return { request, mode, base, target, guard: guardBefore, changes };
}

/**
 * Capture the change a run reviews: resolve the request to its mode and
 * every changed path (`resolveScopeRequest`), freeze each path's before
 * and after bytes, store the patch, and append one `scope.captured` event.
 * Nothing is written to the ledger unless every check passes and the
 * repository did not move meanwhile.
 */
export function captureScope(checkpoint: Checkpoint, runId: string, input: ScopeRequest): RunState {
  const state = checkpoint.fold(runId);
  if (state.status !== 'active') throw new RunClosedError(`Run ${runId} is ${state.status} and cannot capture a scope`);
  if (state.scope !== null) throw new ScopeAlreadyCapturedError(`Run ${runId} already captured its scope at sequence ${String(state.lastSequence)}`);
  const repo = state.worktree;
  if (locateCheckpoint(repo).root !== checkpoint.root) {
    throw new InvalidScopeRequestError(`Worktree ${repo} belongs to a different checkpoint than ${checkpoint.root}`);
  }
  const { request, mode, base, target, guard: guardBefore, changes } = resolveScopeRequest(repo, input);
  const observations = observe(repo, base, changes);

  const files = observations.map((observation) => freezeObservation(checkpoint.evidence, observation));
  const patch = checkpoint.evidence.put(buildPatch(repo, mode, base, target, request.paths, observations));

  const guardAfter = guard(repo);
  if (guardAfter.head !== guardBefore.head || guardAfter.index !== guardBefore.index) {
    throw new CaptureRacedError(`HEAD or the index changed while the scope was being captured in ${repo}`);
  }
  for (const observation of observations) {
    const now = readWorktree(repo, observation.path);
    if (!sameEntry(observation.after, now)) throw new CaptureRacedError(`${observation.path} changed while the scope was being captured`);
  }

  const payload: ScopeState = { mode, request, base, head: guardBefore.head, files, patch };
  return checkpoint.append(runId, state.lastSequence, [{ kind: 'scope.captured', version: 1, payload }]);
}

function validateRequest(request: ScopeRequest): void {
  if (request.ref !== undefined && request.range !== undefined) throw new InvalidScopeRequestError('Choose a ref or a range, not both');
  for (const path of request.paths) validateScopePath(path);
}

/** A path the request may name: relative, inside the repository, never the git directory. */
export function validateScopePath(path: string): void {
  const normalized = path.replaceAll('\\', '/');
  if (path.length === 0 || path.includes('\0')) throw new InvalidScopeRequestError(`Empty or NUL-containing scope path: ${JSON.stringify(path)}`);
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) throw new InvalidScopeRequestError(`Scope path must be relative to the repository: ${path}`);
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..')) throw new InvalidScopeRequestError(`Scope path must not leave the repository: ${path}`);
  if (parts.some((part) => part.toLowerCase() === '.git')) throw new InvalidScopeRequestError(`Scope path must not name the git directory: ${path}`);
}

function refuseUnsupportedState(repo: string): void {
  const unmerged = gitApi.unmergedPaths(repo);
  if (unmerged.length > 0) throw new UnsupportedRepositoryStateError(`Resolve unmerged paths before capturing a scope: ${unmerged.join(', ')}`);
  const gitlinks = gitApi.gitlinkPaths(repo);
  if (gitlinks.length > 0) throw new UnsupportedRepositoryStateError(`Submodules are unsupported: ${gitlinks.join(', ')}`);
}

function guard(repo: string): { head: string; index: string } {
  return { head: gitApi.head(repo), index: gitApi.indexDigest(repo) };
}

function chooseMode(repo: string, request: ScopeRequest, currentHead: string): { mode: ScopeMode; base: string; target: string | null } {
  if (request.range !== undefined) {
    const from = gitApi.resolveCommit(repo, request.range.from);
    const to = gitApi.resolveCommit(repo, request.range.to);
    if (to !== currentHead) {
      throw new InvalidScopeRequestError(`A range must end at HEAD: ${request.range.to} is ${to} but HEAD is ${currentHead}; check it out or add a worktree`);
    }
    return { mode: 'range', base: request.range.mergeBase ? gitApi.mergeBase(repo, from, to) : from, target: null };
  }
  if (request.ref !== undefined) return { mode: 'ref', base: gitApi.resolveCommit(repo, request.ref), target: null };
  if (gitApi.status(repo).length === 0) {
    return { mode: 'last-commit', base: gitApi.firstParent(repo, currentHead) ?? gitApi.emptyTree(repo), target: currentHead };
  }
  return { mode: 'worktree', base: currentHead, target: null };
}

/** List every changed path, tracked ones by git's diff and, outside `last-commit` mode, untracked ones, in path order; reads only names. */
function listChanges(repo: string, mode: ScopeMode, base: string, target: string | null, paths: readonly string[]): ChangedPath[] {
  const changes = new Map<string, ChangedPath>();
  for (const entry of gitApi.diffNameStatus(repo, base, target, paths)) changes.set(entry.path, { path: entry.path, status: statusOf(entry.code, entry.path), untracked: false });
  if (mode !== 'last-commit') {
    for (const path of gitApi.untrackedEntries(repo, paths)) {
      if (path.endsWith('/')) throw new UnsupportedRepositoryStateError(`Embedded repositories are unsupported: ${path}`);
      validateScopePath(path);
      changes.set(path, { path, status: 'added', untracked: true });
    }
  }
  return [...changes.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Read each changed path's before and after contents, in the order given, reading the repository but writing nothing; an untracked file has no before state. */
function observe(repo: string, base: string, changes: readonly ChangedPath[]): Observation[] {
  const atBase = gitApi.treeEntries(repo, base, changes.filter((change) => !change.untracked).map((change) => change.path));
  return changes.map(({ path, status, untracked }): Observation => {
    const after = readWorktree(repo, path);
    if (untracked) {
      if (after === null) throw new CaptureRacedError(`${path} is untracked but is not in the worktree`);
      return { path, status, before: null, after };
    }
    const baseEntry = atBase.get(path);
    const before = baseEntry === undefined ? null : readBase(repo, base, baseEntry);
    if (status !== 'deleted' && after === null) throw new CaptureRacedError(`${path} is reported ${status} but is not in the worktree`);
    return { path, status, before, after };
  });
}

function statusOf(code: string, path: string): ScopeFile['status'] {
  switch (code) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'M':
    case 'T':
      return 'modified';
    default:
      throw new UnsupportedRepositoryStateError(`Unexpected change status ${code} for ${path}`);
  }
}

function readBase(repo: string, base: string, entry: gitApi.TreeEntry): { bytes: Buffer; symlink: boolean } {
  if (entry.mode === '120000') return { bytes: gitApi.blobRaw(repo, entry.objectId), symlink: true };
  if (entry.mode === '160000') throw new UnsupportedRepositoryStateError(`Submodules are unsupported: ${entry.path}`);
  return { bytes: gitApi.blobThroughFilters(repo, base, entry.path), symlink: false };
}

/** What the worktree holds at a repository-relative path, or `null` when nothing does. */
export function readWorktree(repo: string, path: string): WorktreeEntry | null {
  const absolute = join(repo, ...path.split('/'));
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (stat === undefined) return null;
  if (stat.isSymbolicLink()) return { bytes: readLinkText(absolute), symlink: true };
  if (stat.isFile()) return { bytes: readFileSync(absolute), symlink: false };
  throw new UnsupportedRepositoryStateError(`${path} is neither a file nor a symlink`);
}

function sameEntry(a: WorktreeEntry | null, b: WorktreeEntry | null): boolean {
  if (a === null || b === null) return a === b;
  return a.symlink === b.symlink && a.bytes.equals(b.bytes);
}

/** Every requested path must select at least one changed path, as itself or as a directory prefix. */
function requirePathsMatched(paths: readonly string[], changes: readonly ChangedPath[]): void {
  for (const prefix of paths) {
    const matched = changes.some((change) => change.path === prefix || change.path.startsWith(`${prefix}/`));
    if (!matched) throw new InvalidScopeRequestError(`Scope path names nothing in the change: ${prefix}`);
  }
}

/** Store a file's bytes, or only its hash when it is over the limit. */
export function freezeBytes(evidence: Pick<EvidenceStore, 'put'>, bytes: Buffer): FrozenFile {
  if (bytes.length > freezeLimitBytes) return { oversized: { sha256: sha256Hex(bytes), size: bytes.length } };
  return { blob: evidence.put(bytes) };
}

function freezeObservation(evidence: EvidenceStore, observation: Observation): ScopeFile {
  return {
    path: observation.path,
    status: observation.status,
    symlink: observation.after?.symlink ?? observation.before?.symlink ?? false,
    before: observation.before === null ? null : freezeBytes(evidence, observation.before.bytes),
    after: observation.after === null ? null : freezeBytes(evidence, observation.after.bytes),
  };
}

function buildPatch(repo: string, mode: ScopeMode, base: string, target: string | null, paths: readonly string[], observations: readonly Observation[]): Buffer {
  const parts = [gitApi.diffPatch(repo, base, target, paths)];
  if (mode !== 'last-commit') {
    const tracked = new Set(gitApi.diffNameStatus(repo, base, target, paths).map((entry) => entry.path));
    for (const observation of observations) {
      if (!tracked.has(observation.path)) parts.push(gitApi.untrackedPatch(repo, observation.path));
    }
  }
  return Buffer.concat(parts);
}

function normalizeRequest(request: ScopeRequest): ScopeRequest {
  const normalized: { ref?: string; range?: { from: string; to: string; mergeBase: boolean }; paths: string[] } = {
    paths: request.paths.map((path) => path.replaceAll('\\', '/').replace(/\/+$/, '')),
  };
  if (request.ref !== undefined) normalized.ref = request.ref;
  if (request.range !== undefined) normalized.range = { from: request.range.from, to: request.range.to, mergeBase: request.range.mergeBase };
  return normalized;
}
