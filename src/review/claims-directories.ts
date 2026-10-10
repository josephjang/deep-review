/**
 * The claims directories of one engine's fixes phase (R2, R3, R12 of
 * commit series integrity; TD2): where each round's directory lies in the
 * run's scratch, which of them this engine prepared, and the first of those
 * it found removed, which stops the phase. A directory this engine has not
 * prepared, as a resumed engine's before its first launch, has no claims to
 * read; the next launch seeds it from the ledger. One it prepared and finds
 * no longer intact, gone or emptied of its `held.json`, is lost, once, and
 * stays lost.
 */
import { claimsOfRound, roundOf } from '../checkpoint/fix-state.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { heldOf, type ClaimsAccess } from './claim-events.ts';
import { claimsDirectoryFor, claimsDirectoryIntact, ClaimsDirectoryLostError, heldFileName, prepareClaims, readClaims } from './claims.ts';
import type { ClaimsContext } from './phases.ts';

/** What the claims directories of a run are kept with. */
export interface ClaimsDirectoriesOptions {
  /** This checkpoint's scratch, under which each round's directory lies. */
  readonly scratchBase: string;
  readonly runId: string;
  readonly worktree: string;
  /** The run as the fold has it now. */
  readonly state: () => RunState;
  /** Whether the worktree's file system folds case, which every claim's marker name follows (TD4). */
  readonly caseInsensitive: () => boolean;
  /** The command a fixer runs to claim a file, for its unit and its round's directory. */
  readonly command: (key: string, directory: string) => string;
  readonly log: (line: string) => void;
  /** Stands in for the file system's rename of `held.json` in tests. */
  readonly rename?: (from: string, to: string) => void;
}

/** What a settling fixes-phase unit is recorded with, both from one reading of its round's directory. */
export interface SettleReading {
  /** The claims as that reading found them, other units' directories read afresh. */
  readonly access: ClaimsAccess;
  /** Whether a claims directory is lost once that reading is taken, so the unit ran without one. */
  readonly lost: boolean;
}

/** A run's claims directories, as one engine prepares and reads them. */
export interface ClaimsDirectories {
  /** Where fixes-phase units claim files and what their directories hold now; a directory found no longer intact after this engine prepared it is lost. */
  readonly claims: ClaimsContext;
  /**
   * Prepare a fixes-phase unit's round's directory, before its launch and
   * again once it settles: what the claim command is told of the round, as
   * the fold has it now, and every claim of the round the ledger holds,
   * seeded back where the directory lost it. False, the loss recorded, when
   * this engine prepared it before and it is no longer intact. An earlier
   * `held.json` that stayed busy is kept and logged, and the unit goes on.
   */
  readonly prepare: (key: string) => boolean;
  /**
   * What a settling fixes-phase unit is recorded with: its round's
   * directory read once, now, a reading that finds it gone latching the
   * loss, and the loss as it stands after that reading, so whether the unit
   * ran without its directory and what its settle records come from the
   * same call.
   */
  readonly settleReading: (key: string) => SettleReading;
  /** The directory found removed, which stops the phase, or null while none is. */
  readonly lost: () => string | null;
}

export function claimsDirectories(options: ClaimsDirectoriesOptions): ClaimsDirectories {
  const { caseInsensitive, log } = options;
  const directoryOf = (key: string): string => claimsDirectoryFor(options.scratchBase, options.runId, roundOf(options.state().review!.fix!, key));
  const prepared = new Set<string>();
  let lost: string | null = null;
  const lose = (directory: string): void => {
    if (lost !== null) return;
    lost = directory;
    log(`phase fixes: the claims directory ${directory} is gone; no more launches, the running units will be recorded as failed attempts`);
  };
  const claims: ClaimsContext = {
    directoryOf,
    command: options.command,
    live: (key) => {
      const directory = directoryOf(key);
      try {
        if (claimsDirectoryIntact(directory)) return { markers: readClaims(directory, caseInsensitive()), caseInsensitive: caseInsensitive() };
      } catch (error) {
        if (!(error instanceof ClaimsDirectoryLostError)) throw error;
      }
      if (prepared.has(directory)) lose(directory);
      return null;
    },
    caseInsensitive,
  };
  const prepare = (key: string): boolean => {
    const fix = options.state().review!.fix!;
    const round = roundOf(fix, key);
    const directory = directoryOf(key);
    try {
      const refreshed = prepareClaims(directory, heldOf(fix, round, options.worktree, caseInsensitive()), claimsOfRound(fix, round).map((claim) => ({ path: claim.path, cluster: claim.cluster, unit: claim.key, claimedAt: claim.claimedAt })), prepared.has(directory), options.rename);
      if (!refreshed) log(`phase fixes: ${heldFileName} in ${directory} stayed busy and was not refreshed for ${key}; claims read the earlier one until the next prepare`);
    } catch (error) {
      if (!(error instanceof ClaimsDirectoryLostError)) throw error;
      lose(error.directory);
      return false;
    }
    prepared.add(directory);
    return true;
  };
  const settleReading = (key: string): SettleReading => {
    const reading = claims.live(key);
    return { access: { live: (asked) => (asked === key ? reading : claims.live(asked)), caseInsensitive }, lost: lost !== null };
  };
  return { claims, prepare, settleReading, lost: () => lost };
}
