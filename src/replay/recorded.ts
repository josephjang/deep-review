/**
 * What a recorded run holds that a verifier replay needs: each planned
 * verification group with its candidates, and the launch whose frozen
 * prompt the group's verifier was sent.
 */
import type { WorkerLaunch } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import type { CandidateState } from '../checkpoint/review-fold.ts';
import { parseUnitLabel } from '../review/labels.ts';
import { groupCandidates } from '../review/phases.ts';
import { verificationPhases, type VerificationPhase } from '../review/vocabulary.ts';
import { ReplayRefusedError } from './errors.ts';

/** The role whose workers a verification phase launches. */
export const verifierRole = 'verifier';

/** One planned verification group of a recorded run. */
export interface RecordedGroup {
  readonly phase: VerificationPhase;
  readonly id: string;
  /** The group's candidates, in the order its verifier's task numbered them. */
  readonly candidates: readonly CandidateState[];
  /**
   * The launch whose prompt a replay sends again: the one whose answer the
   * run recorded, else the group's last, since every attempt of a group is
   * sent the same task; null when the run launched no verifier for it.
   */
  readonly launch: WorkerLaunch | null;
}

/** A group a replay can run: one the recorded run launched a verifier for. */
export type ReplayableGroup = RecordedGroup & { readonly launch: WorkerLaunch };

export const isReplayable = (group: RecordedGroup): group is ReplayableGroup => group.launch !== null;

/** `<phase>:<group id>`, which names a group across a run's two verification phases, whose group ids both start at `g1`. */
export const groupKey = (group: Pick<RecordedGroup, 'phase' | 'id'>): string => `${group.phase}:${group.id}`;

/** Every verification group a recorded run planned, first pool then sweep, in the plan's order. */
export function recordedGroups(state: RunState): RecordedGroup[] {
  const review = state.review;
  if (review === null) throw new ReplayRefusedError(`Run ${state.id} is not a review, so it has no verification to replay`);
  const launches = Object.values(state.workers).map((worker) => ({ launch: worker.launch, unit: parseUnitLabel(worker.launch.label) }));
  return verificationPhases.flatMap((phase) =>
    (review.plans[phase] ?? []).map((group): RecordedGroup => {
      const answeredBy = review.units[phase][group.id]?.answeredBy ?? null;
      const ofGroup = launches.filter(({ unit }) => unit !== null && unit.role === verifierRole && unit.phase === phase && unit.key === group.id).map(({ launch }) => launch);
      const launch = ofGroup.find((candidate) => candidate.workerId === answeredBy) ?? ofGroup.at(-1) ?? null;
      return { phase, id: group.id, candidates: groupCandidates(review, phase, group.id), launch };
    }));
}
