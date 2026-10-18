/**
 * The marks of the known failures of the contract test of resumable runs
 * (R2 of resumable runs): each names the points and ways it covers, the
 * systems that show it, the part of the contract that fails there, and the
 * requirement that closes it. A marked case must fail its part, so a case
 * that starts to pass fails the test until the step that closed it removes
 * its mark. The suite (test/review/resume-contract.test.ts) and
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

/** The posix systems CI runs the suite on. */
const posix: readonly NodeJS.Platform[] = ['linux', 'darwin'];
const everySystem: readonly NodeJS.Platform[] = ['win32', ...posix];

/** The ways between two appends, where the engine stops on its own path or is killed with every child it has. */
const stops: readonly StopWay[] = ['signal', 'kill', 'tree'];

/** The marks of one failure: one per part it breaks, for the same points, ways, systems and requirement. */
const failing = (points: readonly string[], ways: readonly StopWay[], systems: readonly NodeJS.Platform[], parts: readonly ContractPart[], closedBy: string): Mark[] =>
  parts.map((part) => ({ points, ways, systems, part, closedBy }));

/**
 * The known failures of the engine as it was before resumable runs, as the
 * first runs of `npm run resume-test` showed them on Windows; the ones on
 * POSIX follow from how the processes end there and wait for CI to show
 * them.
 */
export const marks: readonly Mark[] = [
  // W5: a stop between the end of a worker and the record of its answer launches it again.
  // RIPPLE's first worker fails, and a unit's failed attempt is launched again by design.
  ...failing(['worker.finished *', '!worker.finished finder-RIPPLE finders:RIPPLE'], stops, everySystem, ['launches'], 'R6'),
  // W1 and #25: a worker or a check that a kill ends first, with a kill mark, is recorded failed, which degrades the unit or makes the check's result false.
  ...failing(['child finder-RIPPLE finders:RIPPLE#2', 'child check *'], ['child'], everySystem, ['nothing false', 'report'], 'R4'),
  // W4: a check that rewrote a file and that a stop cut leaves an unrecorded write, which blocks the next command on drift.
  ...failing(['child check lint#2'], stops, everySystem, ['exit', 'report'], 'R7'),
  ...failing(['child check typecheck#2'], ['child'], everySystem, ['exit'], 'R7'),
  // W8: the edit of a person while the engine is down goes into the revision of the lost fixer.
  ...failing(['child fixer fixes:c1-1#1'], stops, everySystem, ['nothing false', 'report'], 'R10'),
  // W6: a stop after commit moved the branch leaves commits the ledger does not hold, and the next commit refuses.
  ...failing(['update-ref after'], stops, everySystem, ['exit', 'nothing false'], 'R9'),
  // W3: on Windows the descendants of a child outlive a hard kill of the engine alone; W2: on POSIX each child, in its own process group, outlives every kill but the engine's own.
  ...failing(['child *'], ['kill'], ['win32'], ['no orphan'], 'R8'),
  ...failing(['child *'], ['kill', 'tree', 'child'], posix, ['no orphan'], 'R8'),
];

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


