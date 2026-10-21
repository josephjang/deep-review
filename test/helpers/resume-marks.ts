/**
 * The marks of the known failures of the contract test of resumable runs
 * (R2 of resumable runs): each names the points and ways it covers, the
 * systems that show it, the part of the contract that fails there, and the
 * requirement that closes it. A marked case must fail its part, so a case
 * that starts to pass fails the test until the step that closed it removes
 * its mark. `npm run test:contract` (test/review/resumable-runs.contract.ts) and
 * `npm run resume-test` read the same marks.
 */
import type { ContractPart, StopWay } from './resume-contract.ts';

export interface Mark {
  /** The points the mark covers, by name: a name that ends in `*` covers every point it begins, and one that begins with `!` leaves its point out. */
  readonly points: readonly string[];
  readonly ways: readonly StopWay[];
  readonly systems: readonly NodeJS.Platform[];
  readonly part: ContractPart;
  /** The requirement of resumable runs whose work closes the failure. */
  readonly closedBy: string;
}

/**
 * The known failures of the engine, as the runs of `npm run resume-test`
 * showed them on Windows before resumable runs and the steps that closed
 * each removed them. None is left; a failure a later run shows, on any
 * system, is marked here with the requirement whose work closes it.
 */
export const marks: readonly Mark[] = [];

/** Whether the mark covers the case. */
function covers(mark: Mark, point: string, way: StopWay, platform: NodeJS.Platform): boolean {
  const named = (name: string): boolean => (name.endsWith('*') ? point.startsWith(name.slice(0, -1)) : point === name);
  const kept = mark.points.filter((name) => !name.startsWith('!'));
  const left = mark.points.filter((name) => name.startsWith('!')).map((name) => name.slice(1));
  return mark.ways.includes(way) && mark.systems.includes(platform) && kept.some(named) && !left.some(named);
}

/** The marks that cover a case. */
export const marksOf = (point: string, way: StopWay, platform: NodeJS.Platform): Mark[] => marks.filter((mark) => covers(mark, point, way, platform));

/**
 * What a case came to that the marks do not expect: each part it broke
 * that no mark covers, and each covering mark whose part held. Empty when
 * the case is as the marks say.
 */
export function unexpected(point: string, way: StopWay, platform: NodeJS.Platform, broken: ReadonlyMap<ContractPart, string>): string[] {
  const covering = marksOf(point, way, platform);
  return [
    ...[...broken.entries()].filter(([part]) => !covering.some((mark) => mark.part === part)).map(([part, why]) => `${part} broke with no mark: ${why}`),
    ...covering.filter((mark) => !broken.has(mark.part)).map((mark) => `${mark.part} held, but a mark for ${mark.closedBy} expects it to fail`),
  ];
}
