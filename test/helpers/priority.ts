/**
 * The scheduling priority of a test run. The suite saturates every core for
 * the first third of a run, and while it does, a developer's other programs
 * wait behind it: a process start took 3 times as long and a small write
 * twice as long (docs/reports/2026-10-14-test-and-ci-time.md, finding 6).
 * Below normal priority, the suite yields to them and costs itself 1 to 3%
 * of its wall time. test/setup.ts lowers it through lowerPriority, in the
 * test runner and in every test process; each process they start inherits
 * it: the priority class on Windows, the nice value elsewhere.
 */
import os from 'node:os';

/** The part of node:os lowerPriority uses; a test passes a stand-in. */
export interface PriorityControl {
  getPriority(): number;
  setPriority(priority: number): void;
}

/**
 * Lower this process to `PRIORITY_BELOW_NORMAL` (BELOW_NORMAL_PRIORITY_CLASS
 * on Windows, nice 10 elsewhere), unless it already runs at that priority or
 * lower, which it keeps: a run started under `nice -n 19` is not raised.
 * Priorities run the other way from their numbers, so a lower priority is a
 * larger number. A system that refuses the change (EPERM or EACCES, as a
 * container may) leaves the run at the priority it has. Node reports the
 * refusal as an ERR_SYSTEM_ERROR whose `info.code` names it.
 *
 * On Linux a nice value belongs to a thread, and the change reaches only the
 * calling thread and each thread or process started after it. Threads Node
 * had already started, such as V8's, keep their priority. In the test runner
 * that leaves those threads at normal priority, but every test process starts
 * after the change and runs below normal in all its threads.
 */
export function lowerPriority(control: PriorityControl = os): void {
  const belowNormal = os.constants.priority.PRIORITY_BELOW_NORMAL;
  if (control.getPriority() >= belowNormal) return;
  try {
    control.setPriority(belowNormal);
  } catch (error) {
    const refusal = (error as { info?: { code?: unknown } }).info?.code;
    if (refusal !== 'EPERM' && refusal !== 'EACCES') throw error;
  }
}
