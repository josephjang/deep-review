import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Checkpoint } from '../checkpoint/checkpoint.ts';
import { RunClosedError } from '../checkpoint/errors.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { locateCheckpoint } from '../checkpoint/locate.ts';
import type { CapturedScopeRequest, FrozenFile, ScopeFile, ScopeMode, ScopeRequest, ScopeState } from '../checkpoint/events.ts';
import { sha256Hex, type EvidenceStore } from '../evidence/store.ts';
import { readLinkText } from '../paths.ts';
import { CaptureRacedError, EmptyChangeError, InvalidScopeRequestError, ScopeAlreadyCapturedError, UnsupportedRepositoryStateError } from './errors.ts';
import * as gitApi from './git.ts';

/** A file larger than this, before or after, is recorded by hash and size only (D2). */
export const freezeLimitBytes = 8 * 1024 * 1024;

/** More changed paths than this refuses the capture instead of trimming it (R6). */
export const maxScopeFiles = 2000;

/** The most paths left out that a capture names; it counts the rest (R10 of the configuration). */
export const maxExcludedNamed = 2000;

/** The most patterns a request leaves out, which the settings registry holds `scope.exclude` to as well. */
export const maxExcludePatterns = 64;

// The rules a `scope.exclude` pattern breaks, each a predicate that holds
// for a pattern it refuses: the capture and the settings registry both
// test a pattern with these, each in its own words.

/** A pattern that starts with `:`, which git reads as pathspec magic. */
export function isMagicPattern(pattern: string): boolean {
  return pattern.startsWith(':');
}

/** A pattern with a `..` segment, with either slash. */
export function hasParentSegment(pattern: string): boolean {
  return pattern.replaceAll('\\', '/').split('/').includes('..');
}

/** A pattern that starts at the root of the file system or of a drive rather than at the repository root. */
export function isAbsolutePattern(pattern: string): boolean {
  const slashed = pattern.replaceAll('\\', '/');
  return slashed.startsWith('/') || /^[a-zA-Z]:/.test(slashed);
}

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
 * the capture records it, with the patterns `scope.exclude` leaves out, its
 * mode, base and head, the commit a `last-commit` scope diffs to or null,
 * `HEAD` and the index as the resolution found them, every changed path
 * the patterns keep, in path order, and every one they leave out, sorted.
 * Nothing is read beyond the names, so it is the capture's first half and
 * all a comparison with a captured scope needs (TD4 of fix pass
 * continuation).
 */
export interface ResolvedScope {
  readonly request: CapturedScopeRequest;
  readonly mode: ScopeMode;
  readonly base: string;
  readonly target: string | null;
  readonly guard: { readonly head: string; readonly index: string };
  readonly changes: readonly ChangedPath[];
  /** Every changed path a pattern left out, without rename detection, so both sides of a rename across the patterns' edge count. */
  readonly excluded: readonly string[];
}

/**
 * Resolve a request as the capture does, writing nothing: validate it and
 * the patterns it leaves out, spell its paths as the capture records them,
 * refuse a repository state the capture cannot record, choose the mode
 * against `HEAD` and the tree, and list every changed path the patterns
 * keep, and the ones they leave out (R10 of the configuration). Each
 * requested path must match a changed path, and one the patterns keep;
 * the change must keep a path, and no more than the capture accepts.
 * Throws what the capture throws for a request the tree refutes.
 */
export function resolveScopeRequest(repo: string, input: ScopeRequest, exclude: readonly string[] = []): ResolvedScope {
  validateRequest(input);
  validateExclude(exclude);
  // Backslashes become slashes once, here: a path typed Windows-style must
  // select the same file on every platform, and git pathspecs want slashes.
  const request = { ...normalizeRequest(input), exclude: [...exclude] };
  refuseUnsupportedState(repo);
  const guardBefore = guard(repo);
  const { mode, base, target } = chooseMode(repo, request, guardBefore.head);
  const changes = listChanges(repo, mode, base, target, request.paths, exclude);
  // The full list is a second listing, made only when a pattern can leave a path out of the first.
  const kept = new Set(changes.map((change) => change.path));
  const excluded = exclude.length === 0 ? [] : changedNames(repo, mode, base, target, request.paths).filter((path) => !kept.has(path));
  requirePathsMatched(request.paths, [...kept, ...excluded], kept, exclude);
  if (changes.length === 0) {
    throw new EmptyChangeError(excluded.length === 0 ? 'The change is empty: it has no changed path to review' : `The change has no path left to review: scope.exclude (${exclude.join(', ')}) leaves out all ${String(excluded.length)} of its changed paths`);
  }
  if (changes.length > maxScopeFiles) {
    throw new UnsupportedRepositoryStateError(`The change touches ${String(changes.length)} paths, more than the ${String(maxScopeFiles)} the capture accepts`);
  }
  return { request, mode, base, target, guard: guardBefore, changes, excluded };
}

/**
 * The commit a request's change starts from, as the capture would choose
 * it (`chooseMode`) against `HEAD` and the tree as they are now, listing
 * no path: what the configuration reads the repository's file at (R4 of
 * the configuration). A request the capture would refuse for its form is
 * refused here the same way.
 */
export function scopeBase(repo: string, input: ScopeRequest): string {
  return scopeEnds(repo, input).base;
}

/**
 * Both ends of a request's change, as the capture would choose them
 * against `HEAD` and the tree as they are now, listing no path: the commit
 * it starts from, and the commit a `last-commit` scope ends at, or null
 * for a change that ends at the working tree. `config show` names both, so
 * a line that is said again in other words cannot take the start for the
 * commit reviewed (R11 of the skill surface corrections).
 */
export function scopeEnds(repo: string, input: ScopeRequest): { readonly base: string; readonly target: string | null } {
  validateRequest(input);
  const { base, target } = chooseMode(repo, normalizeRequest(input), gitApi.head(repo));
  return { base, target };
}

/** What a capture is held to beside its request (R4, R10 of the configuration). */
export interface CaptureOptions {
  /** The patterns `scope.exclude` leaves out of the change. */
  readonly exclude?: readonly string[];
  /** The base the run's configuration was read at: a capture whose base is another refuses, since HEAD moved since. */
  readonly base?: string;
}

/**
 * Capture the change a run reviews: resolve the request to its mode and
 * every changed path the patterns of `exclude` keep
 * (`resolveScopeRequest`), freeze each kept path's before and after bytes,
 * store the patch of the kept paths, and append one `scope.captured` event
 * that names the paths left out. Nothing is written to the ledger unless
 * every check passes, the base is the one the configuration was read at,
 * and the repository did not move meanwhile.
 */
export function captureScope(checkpoint: Checkpoint, runId: string, input: ScopeRequest, options: CaptureOptions = {}): RunState {
  const state = checkpoint.fold(runId);
  if (state.status !== 'active') throw new RunClosedError(`Run ${runId} is ${state.status} and cannot capture a scope`);
  if (state.scope !== null) throw new ScopeAlreadyCapturedError(`Run ${runId} already captured its scope at sequence ${String(state.lastSequence)}`);
  const repo = state.worktree;
  if (locateCheckpoint(repo).root !== checkpoint.root) {
    throw new InvalidScopeRequestError(`Worktree ${repo} belongs to a different checkpoint than ${checkpoint.root}`);
  }
  const { request, mode, base, target, guard: guardBefore, changes, excluded } = resolveScopeRequest(repo, input, options.exclude ?? []);
  if (options.base !== undefined && base !== options.base) {
    throw new CaptureRacedError(`The change now starts from ${base}, not from ${options.base}, where the run's configuration was read: HEAD moved since; run the command again`);
  }
  const observations = observe(repo, base, changes);

  const files = observations.map((observation) => freezeObservation(checkpoint.evidence, observation));
  const patch = checkpoint.evidence.put(buildPatch(repo, mode, base, target, request.paths, request.exclude, observations));

  const guardAfter = guard(repo);
  if (guardAfter.head !== guardBefore.head || guardAfter.index !== guardBefore.index) {
    throw new CaptureRacedError(`HEAD or the index changed while the scope was being captured in ${repo}`);
  }
  for (const observation of observations) {
    const now = readWorktree(repo, observation.path);
    if (!sameEntry(observation.after, now)) throw new CaptureRacedError(`${observation.path} changed while the scope was being captured`);
  }

  const payload: ScopeState = { mode, request, base, head: guardBefore.head, files, patch, excluded: { paths: excluded.slice(0, maxExcludedNamed), count: excluded.length } };
  return checkpoint.append(runId, state.lastSequence, [{ kind: 'scope.captured', version: 2, payload }]);
}

function validateRequest(request: ScopeRequest): void {
  if (request.ref !== undefined && request.range !== undefined) throw new InvalidScopeRequestError('Choose a ref or a range, not both');
  for (const path of request.paths) validateScopePath(path);
}

/**
 * The patterns a request leaves out (R10 of the configuration): at most
 * 64, each a relative glob with no magic of its own, no `..` segment and
 * no NUL, as the settings registry takes them, held here too for a caller
 * that does not come through it.
 */
function validateExclude(exclude: readonly string[]): void {
  if (exclude.length > maxExcludePatterns) throw new InvalidScopeRequestError(`scope.exclude holds ${String(exclude.length)} patterns, more than the ${String(maxExcludePatterns)} a capture takes`);
  for (const pattern of exclude) {
    if (pattern.length === 0 || pattern.includes('\0')) throw new InvalidScopeRequestError(`Empty or NUL-containing scope.exclude pattern: ${JSON.stringify(pattern)}`);
    if (isMagicPattern(pattern)) throw new InvalidScopeRequestError(`A scope.exclude pattern must not start with ":", which git reads as pathspec magic: ${pattern}`);
    if (hasParentSegment(pattern)) throw new InvalidScopeRequestError(`A scope.exclude pattern must not have a ".." segment: ${pattern}`);
    if (isAbsolutePattern(pattern)) throw new InvalidScopeRequestError(`A scope.exclude pattern is relative to the repository root: ${pattern}`);
  }
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

/** List every changed path the patterns of `exclude` keep, tracked ones by git's diff and, outside `last-commit` mode, untracked ones, in path order; reads only names. */
function listChanges(repo: string, mode: ScopeMode, base: string, target: string | null, paths: readonly string[], exclude: readonly string[]): ChangedPath[] {
  const changes = new Map<string, ChangedPath>();
  for (const entry of gitApi.diffNameStatus(repo, base, target, paths, exclude)) changes.set(entry.path, { path: entry.path, status: statusOf(entry.code, entry.path), untracked: false });
  if (mode !== 'last-commit') {
    for (const path of gitApi.untrackedEntries(repo, paths, exclude)) {
      if (path.endsWith('/')) throw new UnsupportedRepositoryStateError(`Embedded repositories are unsupported: ${path}`);
      validateScopePath(path);
      changes.set(path, { path, status: 'added', untracked: true });
    }
  }
  return [...changes.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The name of every changed path the request names, before any pattern
 * leaves one out, sorted: the full list the paths left out are taken from
 * (R10 of the configuration). Without rename detection, so both sides of a
 * rename count, and with no check of a path, since one left out is never
 * captured.
 */
function changedNames(repo: string, mode: ScopeMode, base: string, target: string | null, paths: readonly string[]): string[] {
  const names = new Set(gitApi.diffNameStatus(repo, base, target, paths).map((entry) => entry.path));
  if (mode !== 'last-commit') for (const path of gitApi.untrackedEntries(repo, paths)) names.add(path);
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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

/**
 * Every requested path must select at least one changed path, as itself or
 * as a directory prefix, and one the patterns of `exclude` keep: a path
 * whose changes they all leave out is refused, naming them (R10 of the
 * configuration).
 */
function requirePathsMatched(paths: readonly string[], all: readonly string[], kept: ReadonlySet<string>, exclude: readonly string[]): void {
  const selects = (prefix: string) => (path: string): boolean => path === prefix || path.startsWith(`${prefix}/`);
  for (const prefix of paths) {
    if (!all.some(selects(prefix))) throw new InvalidScopeRequestError(`Scope path names nothing in the change: ${prefix}`);
    if (![...kept].some(selects(prefix))) throw new InvalidScopeRequestError(`Scope path names only changes that scope.exclude (${exclude.join(', ')}) leaves out: ${prefix}`);
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

function buildPatch(repo: string, mode: ScopeMode, base: string, target: string | null, paths: readonly string[], exclude: readonly string[], observations: readonly Observation[]): Buffer {
  const parts = [gitApi.diffPatch(repo, base, target, paths, exclude)];
  if (mode !== 'last-commit') {
    const tracked = new Set(gitApi.diffNameStatus(repo, base, target, paths, exclude).map((entry) => entry.path));
    for (const observation of observations) {
      if (!tracked.has(observation.path)) parts.push(gitApi.untrackedPatch(repo, observation.path));
    }
  }
  return Buffer.concat(parts);
}

/** A scope as a command names it, before any look at the tree: its mode, `auto` when it names none and the capture chooses by `git status`, and its request. */
export interface NamedScope {
  readonly mode: ScopeMode | 'auto';
  readonly request: ScopeRequest;
}

/**
 * Whether a command that names `named` names the scope a run captured
 * (R11, TD9 of resumable runs), compared without a look at the tree, so
 * the flags still match after the run's fixes or `commit` changed it: a
 * `last-commit` or `worktree` mode the run of that mode, `auto` a run of
 * either, a ref or a range the same one, `--branch` among the ranges, and
 * in each case the same paths as the capture spells them.
 */
export function namesScope(named: NamedScope, scope: Pick<ScopeState, 'mode' | 'request'>): boolean {
  const request = normalizeRequest(named.request);
  const recorded = scope.request;
  const paths = [...request.paths].sort();
  const recordedPaths = [...recorded.paths].sort();
  if (paths.length !== recordedPaths.length || paths.some((path, index) => path !== recordedPaths[index])) return false;
  switch (named.mode) {
    case 'last-commit':
    case 'worktree':
      return scope.mode === named.mode;
    case 'auto':
      return scope.mode === 'last-commit' || scope.mode === 'worktree';
    case 'ref':
      return scope.mode === 'ref' && recorded.ref === request.ref;
    case 'range':
      return scope.mode === 'range' && recorded.range !== undefined && request.range !== undefined && recorded.range.from === request.range.from && recorded.range.to === request.range.to && recorded.range.mergeBase === request.range.mergeBase;
  }
}

function normalizeRequest(request: ScopeRequest): ScopeRequest {
  const normalized: { ref?: string; range?: { from: string; to: string; mergeBase: boolean }; paths: string[] } = {
    paths: request.paths.map((path) => path.replaceAll('\\', '/').replace(/\/+$/, '')),
  };
  if (request.ref !== undefined) normalized.ref = request.ref;
  if (request.range !== undefined) normalized.range = { from: request.range.from, to: request.range.to, mergeBase: request.range.mergeBase };
  return normalized;
}
