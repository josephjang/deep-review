/**
 * The claims a settle of the fixes phase records (R3, R6 of commit series
 * integrity; review F1, F9, F13): every marker of the round's claims
 * directory the ledger holds neither as a claim nor as a lost claim,
 * whichever unit made it, as `files.claimed@1` under the marker's own unit,
 * or as `claims.lost@1` when the fold would refuse it; and, for an answer,
 * the files it names that nobody holds, claimed late. The events are folded
 * here as the ledger will fold them, so what the engine judges an answer and
 * an attempt by is exactly what the fold checks them against (TD5).
 */
import type { NewEvent } from '../checkpoint/checkpoint.ts';
import type { ClaimsLost, FilesClaimed } from '../checkpoint/events.ts';
import { batchOf, claimRefusal, claimsOfRound, holdersKeyedBy, roundOf, settledClusters, type FixState, type SpelledHolder } from '../checkpoint/fix-state.ts';
import { applyEvent, type RunState } from '../checkpoint/fold.ts';
import { markerHash, pathKey, type LiveClaim } from './claims.ts';
import { StructuralCheckError } from './errors.ts';
import { resolveReportedPath } from './fix-answer.ts';
import { worktreeLookup, type RepoLookup } from './locations.ts';
import type { LostClaimReason } from './vocabulary.ts';

/** The round's claims directory as a settle reads it: its markers, and whether the worktree's file system folds case, which the markers' names follow. */
export interface LiveClaims {
  readonly markers: readonly LiveClaim[];
  readonly caseInsensitive: boolean;
}

/** Where the engine reads a fixes-phase unit's claims: its round's directory, null where there is none to read, such as a resumed engine's before its first launch; and whether the worktree's file system folds case, known with a directory or without one. */
export interface ClaimsAccess {
  readonly live: (key: string) => LiveClaims | null;
  readonly caseInsensitive: () => boolean;
}

/** What a settle records of the claims, and the run as the fold will hold it after them. */
export interface ClaimSettle {
  /** `claims.lost@1` first, then `files.claimed@1`, to append before the unit's own outcome. */
  readonly events: readonly NewEvent[];
  /** The run with the events folded. */
  readonly state: RunState;
  /** The names of markers not yet whole, each a path a sibling is still claiming, which the next settle reads again (F13). */
  readonly pending: ReadonlySet<string>;
  /** Whether the worktree's file system folds case, which a pending marker's name hashes by. */
  readonly caseInsensitive: boolean;
}

/** The settle of a unit with no directory to read: nothing recorded, nothing pending, and paths compared as the worktree's file system compares them, as a late claim compares them. */
export const settledNothing = (state: RunState, caseInsensitive: boolean): ClaimSettle => ({ events: [], state, pending: new Set(), caseInsensitive });

function requireFix(state: RunState): FixState {
  const fix = state.review?.fix ?? null;
  if (fix === null) throw new Error(`Run ${state.id} is not configured with the fix pass`);
  return fix;
}

/** The events folded onto the run as the ledger would fold them after its last event. */
export function foldedWith(state: RunState, events: readonly NewEvent[]): RunState {
  return events.reduce((current, event, index) => applyEvent(current, { sequence: state.lastSequence + index + 1, runId: state.id, kind: event.kind, version: event.version, payload: event.payload, recordedAt: new Date().toISOString(), engine: 'claims' }), state);
}

/**
 * A lookup of the worktree that, for a file it does not hold, a deleted or
 * a new one, gives instead the spelling a holder of the round records under
 * the same key (TD4): so a path is spelled one way before it reaches the
 * fold, whose exact comparisons then agree with the engine's keyed ones.
 * `holders` is read at each lookup, so a holder added meanwhile counts.
 */
export function holderSpelled(lookup: RepoLookup, holders: ReadonlyMap<string, SpelledHolder>, keyOf: (path: string) => string): RepoLookup {
  return (path) => {
    const held = lookup(path);
    if (held.length > 0) return held;
    const holder = holders.get(keyOf(path));
    return holder === undefined ? [] : [holder.path];
  };
}

/**
 * A marker's path in the worktree's own spelling, as an answer's paths are
 * resolved, or else a holder's, so one file never has two holders through
 * two spellings; where the file system does not fold case, the path as the
 * marker names it, which is already the file's own exact name, since the
 * worktree's lookup matches names case-insensitively and would give a new
 * `src/Util.ts` the existing `src/util.ts`.
 */
function resolvedPath(worktree: string, lookup: RepoLookup, path: string, caseInsensitive: boolean): string {
  if (!caseInsensitive) return path;
  try {
    return resolveReportedPath(worktree, lookup, path);
  } catch (error) {
    if (error instanceof StructuralCheckError) return path;
    throw error;
  }
}

/** One claim of a settle, under the unit the marker named. */
interface Accepted {
  readonly unit: string;
  readonly cluster: string;
  readonly path: string;
  readonly claimedAt: string | null;
}

/** One marker the fold would refuse, with why and who holds its path. */
interface Lost extends Accepted {
  readonly reason: LostClaimReason;
  readonly holder: string | null;
}

/**
 * Group claims into `files.claimed@1` events, one per claiming unit where
 * the order allows: a claim joins its unit's last event unless a later
 * event of the settle claimed the same path, so the events fold in the
 * order the claims were judged in.
 */
function claimedEvents(accepted: readonly Accepted[]): NewEvent[] {
  const events: { unit: string; cluster: string; files: { path: string; claimedAt: string | null }[]; paths: Set<string> }[] = [];
  for (const claim of accepted) {
    const lastOfUnit = events.findLastIndex((event) => event.unit === claim.unit);
    const lastOfPath = events.findLastIndex((event) => event.paths.has(claim.path));
    const target = lastOfUnit >= 0 && lastOfUnit >= lastOfPath && !events[lastOfUnit]!.paths.has(claim.path) ? events[lastOfUnit]! : null;
    if (target === null) events.push({ unit: claim.unit, cluster: claim.cluster, files: [{ path: claim.path, claimedAt: claim.claimedAt }], paths: new Set([claim.path]) });
    else {
      target.files.push({ path: claim.path, claimedAt: claim.claimedAt });
      target.paths.add(claim.path);
    }
  }
  return events.map((event): NewEvent => ({ kind: 'files.claimed', version: 1, payload: { phase: 'fixes', key: event.unit, cluster: event.cluster, files: event.files } satisfies FilesClaimed }));
}

/** Group lost markers into `claims.lost@1` events, one per unit and cluster the markers named, in the order they were judged. */
function lostEvents(lost: readonly Lost[]): NewEvent[] {
  const groups = new Map<string, Lost[]>();
  for (const marker of lost) {
    const name = `${marker.unit}\0${marker.cluster}`;
    groups.set(name, [...(groups.get(name) ?? []), marker]);
  }
  return [...groups.values()].map((markers): NewEvent => ({
    kind: 'claims.lost',
    version: 1,
    payload: { phase: 'fixes', unit: markers[0]!.unit, cluster: markers[0]!.cluster, files: markers.map(({ path, claimedAt, reason, holder }) => ({ path, claimedAt, reason, holder })) } satisfies ClaimsLost,
  }));
}

/** Order markers as they were made: a path's generations in turn, then by time, a time-less seeded one first. */
const madeOrder = (a: LiveClaim & { whole: true }, b: LiveClaim & { whole: true }): number =>
  a.generation - b.generation || compareText(a.claimedAt ?? '', b.claimedAt ?? '') || compareText(a.hash, b.hash);

/** Two texts in code-unit order, as ISO times and hex hashes sort, whatever the locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The claims a settle of a fixes-phase unit records (R3, review F1, F9):
 * every whole marker of the round's directory the ledger holds neither as
 * a claim nor as a lost claim of the same path, cluster, unit and time,
 * judged in the order the markers were made against the fold's holders of
 * the round, by the reducer's own `claimRefusal`. A marker from a unit the
 * plan lacks in this round, or under a cluster not its batch's, is lost as
 * `unplanned`; one on a path a cluster of the round owns as `owned`; one
 * on a path another unsettled cluster, or its own, already holds as
 * `held`. Every other is a claim, its path, where the file system folds
 * case, resolved to the worktree's spelling, or for a file the worktree
 * does not hold to a holder's spelling of it. Markers not yet whole are
 * left for the next settle and returned as pending. A unit with no
 * directory to read settles as `settledNothing`.
 */
export function settleClaims(state: RunState, key: string, live: LiveClaims, worktree: string): ClaimSettle {
  const fix = requireFix(state);
  const round = roundOf(fix, key);
  const { caseInsensitive } = live;
  const keyOf = (path: string): string => pathKey(path, caseInsensitive);
  const marked = (path: string, cluster: string, unit: string, claimedAt: string | null): string => `${keyOf(path)}\0${cluster}\0${unit}\0${claimedAt ?? ''}`;
  const known = new Set([
    ...claimsOfRound(fix, round).map((claim) => marked(claim.path, claim.cluster, claim.key, claim.claimedAt)),
    ...fix.lostClaims.map((claim) => marked(claim.path, claim.cluster, claim.unit, claim.claimedAt)),
  ]);
  const holders = holdersKeyedBy(fix, round, keyOf);
  const settled = settledClusters(fix, round);
  const lookup = holderSpelled(worktreeLookup(worktree), holders, keyOf);
  const accepted: Accepted[] = [];
  const lost: Lost[] = [];
  const whole = live.markers.filter((marker): marker is LiveClaim & { whole: true } => marker.whole).sort(madeOrder);
  for (const marker of whole) {
    const path = resolvedPath(worktree, lookup, marker.path, caseInsensitive);
    if (known.has(marked(path, marker.cluster, marker.unit, marker.claimedAt))) continue;
    const claim: Accepted = { unit: marker.unit, cluster: marker.cluster, path, claimedAt: marker.claimedAt };
    const batch = batchOf(fix, marker.unit);
    if (batch === null || roundOf(fix, marker.unit) !== round || batch.cluster !== marker.cluster) {
      lost.push({ ...claim, reason: 'unplanned', holder: null });
      continue;
    }
    const holder = holders.get(keyOf(path));
    const refusal = claimRefusal(holder, marker.cluster, settled);
    if (refusal !== null) lost.push({ ...claim, reason: refusal, holder: holder!.cluster });
    else {
      accepted.push(claim);
      holders.set(keyOf(path), { path, cluster: marker.cluster, by: 'claim' });
    }
  }
  const events = [...lostEvents(lost), ...claimedEvents(accepted)];
  const pending = new Set(live.markers.filter((marker) => !marker.whole).map((marker) => marker.hash));
  return { events, state: foldedWith(state, events), pending, caseInsensitive };
}

/** Whether a settle left a path pending: a sibling's marker for it not yet whole, so held by a cluster not yet known (F13). */
export function isPending(settle: ClaimSettle, path: string): boolean {
  return settle.pending.size > 0 && settle.pending.has(markerHash(path, settle.caseInsensitive));
}

/**
 * The late claim of an answer (R6): each file it names that nobody holds
 * in its round once the settle's claims are folded, or that only a settled
 * cluster held by claim, as `claimRefusal` frees it, claimed for the answering batch's cluster with no
 * time, since it was edited before it was claimed. A path the settle left
 * pending is held by a cluster not yet known (F13), so it is neither
 * claimed late nor, with no holder on the ledger, a violation; its marker
 * settles at the next settle. Null when there is none.
 */
export function lateClaim(settle: ClaimSettle, key: string, named: Iterable<string>): NewEvent | null {
  const fix = requireFix(settle.state);
  const batch = batchOf(fix, key);
  if (batch === null) throw new Error(`The fix plan has no batch ${key}`);
  const round = roundOf(fix, key);
  const keyOf = (path: string): string => pathKey(path, settle.caseInsensitive);
  const holders = holdersKeyedBy(fix, round, keyOf);
  const settled = settledClusters(fix, round);
  const free = [...new Set(named)].filter((path) => !isPending(settle, path) && claimRefusal(holders.get(keyOf(path)), batch.cluster, settled) === null).sort();
  if (free.length === 0) return null;
  return { kind: 'files.claimed', version: 1, payload: { phase: 'fixes', key, cluster: batch.cluster, files: free.map((path) => ({ path, claimedAt: null })) } satisfies FilesClaimed };
}
