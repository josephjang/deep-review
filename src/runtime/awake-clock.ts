/**
 * The clock a child's timeout counts on (R19 of resumable runs): the time
 * the machine is awake, in milliseconds since the clock was made. A timer
 * of Node counts the time a Windows machine sleeps, and the wall clock
 * counts it on every system, so a deadline on either kills, at the wake,
 * every child that ran when the machine went to sleep.
 *
 * The clock reads the wall clock and ticks every `tickMs`. Two readings
 * further apart than a tick and the longest pause of the engine itself
 * (`pauseMs`) mean the machine slept, or did not run the engine, for the
 * time past a tick; the clock leaves that time out. Every read makes the
 * same check, so the order of the timers at a wake does not matter. A wall
 * clock that moves back counts as no time.
 */
import { gitTimeoutMs } from './git-sync.ts';

/** What a deadline reads: the awake time now, in milliseconds. */
export interface AwakeClock {
  now(): number;
}

/** An awake clock with its tick, which a test calls by hand. */
export interface TickingClock extends AwakeClock {
  tick(): void;
}

export interface AwakeClockOptions {
  /** The wall clock, in milliseconds since the epoch. */
  readonly wallNow: () => number;
  /** How far apart the ticks come while the engine runs. */
  readonly tickMs: number;
  /** The longest the engine itself blocks its ticks, which still counts as awake time. */
  readonly pauseMs: number;
}

/** An awake clock over `wallNow`, which counts a gap past `tickMs + pauseMs` as one tick. */
export function createAwakeClock({ wallNow, tickMs, pauseMs }: AwakeClockOptions): TickingClock {
  let lastWall = wallNow();
  let awake = 0;
  const advance = (): void => {
    const wall = wallNow();
    const gap = wall - lastWall;
    lastWall = wall;
    if (gap <= 0) return;
    awake += gap > tickMs + pauseMs ? tickMs : gap;
  };
  return {
    now: () => {
      advance();
      return awake;
    },
    tick: advance,
  };
}

const tickMs = 10_000;

let shared: TickingClock | null = null;

/**
 * The engine's awake clock. Its ticks start at its first read, so a process
 * that never times a child, such as a guard, runs no timer, and they do not
 * keep the engine alive. The longest pause of the engine is a call of git,
 * which `gitTimeoutMs` ends.
 */
export const awakeClock: AwakeClock = {
  now: () => {
    if (shared === null) {
      const clock = createAwakeClock({ wallNow: Date.now, tickMs, pauseMs: gitTimeoutMs });
      setInterval(clock.tick, tickMs).unref();
      shared = clock;
    }
    return shared.now();
  },
};
