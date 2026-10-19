import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { awakeClock, createAwakeClock } from '../../src/runtime/awake-clock.ts';

// R19 of resumable runs: a timeout counts only the time that the machine is awake.
describe('createAwakeClock', () => {
  const at = (start: number) => {
    let wall = start;
    const clock = createAwakeClock({ wallNow: () => wall, tickMs: 10_000, pauseMs: 60_000 });
    return { clock, move: (ms: number) => (wall += ms) };
  };

  it('keeps the awake time equal to the wall time while ticks come 10 s apart', () => {
    const { clock, move } = at(1_000_000);
    assert.equal(clock.now(), 0);
    for (let tick = 0; tick < 6; tick += 1) {
      move(10_000);
      clock.tick();
    }
    assert.equal(clock.now(), 60_000);
    move(3_500);
    assert.equal(clock.now(), 63_500, 'a read between ticks counts the time since the last one');
  });

  it('leaves out a sleep of two hours between two ticks, counting one tick of it', () => {
    const { clock, move } = at(0);
    move(10_000);
    clock.tick();
    move(2 * 60 * 60 * 1000);
    clock.tick();
    assert.equal(clock.now(), 20_000);
  });

  it('leaves out a sleep that a read meets before the next tick, so the order of the timers at a wake does not matter', () => {
    const { clock, move } = at(0);
    move(5_000);
    assert.equal(clock.now(), 5_000);
    move(9_000_000);
    assert.equal(clock.now(), 15_000, 'the read after the wake counts one tick of the gap');
    clock.tick();
    assert.equal(clock.now(), 15_000, 'and the tick after it counts nothing more');
  });

  it('counts a gap up to a tick and the longest pause of the engine as awake time, and a longer one as a sleep', () => {
    const { clock, move } = at(0);
    move(70_000);
    assert.equal(clock.now(), 70_000, 'a git call of 60 s blocked the ticks: the machine was awake');
    move(70_001);
    assert.equal(clock.now(), 80_000);
  });

  it('counts no time for a wall clock that moves back, and goes on from where it is', () => {
    const { clock, move } = at(500_000);
    move(4_000);
    assert.equal(clock.now(), 4_000);
    move(-3_600_000);
    assert.equal(clock.now(), 4_000);
    move(2_000);
    assert.equal(clock.now(), 6_000);
  });
});

describe('awakeClock', () => {
  it('follows the wall clock on an awake machine, and never goes back', async () => {
    const first = awakeClock.now();
    const wall = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = awakeClock.now();
    assert.ok(second >= first);
    assert.ok(Math.abs(second - first - (Date.now() - wall)) < 25, `${String(second - first)} ms awake over ${String(Date.now() - wall)} ms of wall time`);
  });
});
