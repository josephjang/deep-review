import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { describe, it } from 'node:test';
import { lowerPriority, type PriorityControl } from './helpers/priority.ts';

const { PRIORITY_NORMAL, PRIORITY_BELOW_NORMAL, PRIORITY_LOW } = os.constants.priority;

/** A process priority that starts at `initial`, records each change, and throws `failure` on a change when given one. */
function control(initial: number, failure?: Error): PriorityControl & { readonly set: number[] } {
  const set: number[] = [];
  return {
    set,
    getPriority: () => set.at(-1) ?? initial,
    setPriority: (priority) => {
      if (failure !== undefined) throw failure;
      set.push(priority);
    },
  };
}

/** The error Node's os.setPriority throws when the system refuses with `code`. */
function refusal(code: string): Error {
  return Object.assign(new Error(`A system error occurred: uv_os_setpriority returned ${code}`), { code: 'ERR_SYSTEM_ERROR', info: { code, syscall: 'uv_os_setpriority' } });
}

describe('lowerPriority', () => {
  it('lowers a process at normal priority to below normal', () => {
    const priority = control(PRIORITY_NORMAL);
    lowerPriority(priority);
    assert.deepEqual(priority.set, [PRIORITY_BELOW_NORMAL]);
  });

  it('leaves a process already at below normal, or lower, where it is', () => {
    for (const initial of [PRIORITY_BELOW_NORMAL, PRIORITY_LOW]) {
      const priority = control(initial);
      lowerPriority(priority);
      assert.deepEqual(priority.set, [], `priority ${initial}`);
    }
  });

  it('keeps the priority a system refuses to change, as EPERM or EACCES', () => {
    for (const code of ['EPERM', 'EACCES']) assert.doesNotThrow(() => lowerPriority(control(PRIORITY_NORMAL, refusal(code))), code);
  });

  it('throws any other failure', () => {
    assert.throws(() => lowerPriority(control(PRIORITY_NORMAL, refusal('ESRCH'))), /ESRCH/);
    assert.throws(() => lowerPriority(control(PRIORITY_NORMAL, new Error('unexpected'))), /unexpected/);
  });

  it('reads the refusal where the real os.setPriority error carries it', () => {
    // A process id that cannot exist: the real refusal, with its real shape, which lowerPriority rethrows.
    assert.throws(() => lowerPriority({ getPriority: () => PRIORITY_NORMAL, setPriority: (priority) => os.setPriority(2_147_483_646, priority) }), (error: Error & { code?: string; info?: { code?: string } }) => error.code === 'ERR_SYSTEM_ERROR' && error.info?.code === 'ESRCH');
  });
});

describe('the priority of a test run', () => {
  it('runs this test process below normal priority, which test/setup.ts set, or lower', () => {
    assert.ok(os.getPriority() >= PRIORITY_BELOW_NORMAL, `priority ${os.getPriority()}`);
  });

  it('passes the priority on to a process a test starts', () => {
    const child = spawnSync(process.execPath, ['-e', "process.stdout.write(String(require('node:os').getPriority()))"], { encoding: 'utf8', windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(Number(child.stdout), os.getPriority());
  });
});
