// The process runner and probe runner a review sandbox gives the engine
// (ReviewOptions.runProcess, PreflightOptions.runProbe). A request that
// starts a fake runtime (fake-claude.ts, fake-codex.ts) or the stand-in
// check (fake-check.ts) runs that fake in the test's own process, through
// an in-process host (fake-host.ts), and costs no process start: no guard,
// no Node start, no console host on Windows. Every other request goes to
// the engine's own runProcess and runProbe, unchanged, and so does a fake
// that may start a grandchild: a test of a tree kill needs a real tree.
//
// What is the same: the fake's code, its arguments, environment, working
// directory, stdin, the files its stdout and stderr go to, its exit code,
// and a timeout that ends it as `killed`. What is not: there is no guard
// and no child process, so a test of either runs on the real runner,
// through test/helpers/launcher.ts or the command line; and a command the
// fake itself runs, a fixer's claim or snapshot, runs to its end after a
// timeout, where the real runner's tree kill would end it too.
import { closeSync, existsSync, openSync, readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { shellInvocation } from '../../src/review/checks/run.ts';
import { checkKinds, type CheckKind } from '../../src/review/vocabulary.ts';
import { comparable, spellingsOf } from '../../src/runtime/environment.ts';
import { runProbe, type ProbeRequest, type ProbeRunner } from '../../src/runtime/preflight.ts';
import { runProcess, type ProcessRequest, type ProcessResult, type ProcessRunner } from '../../src/runtime/process.ts';
import { checkFake, checkStartsGrandchild, fakeCheckCommand } from './fake-check.ts';
import { claudeFake } from './fake-claude.ts';
import { codexFake } from './fake-codex.ts';
import type { FakeHost } from './fake-host.ts';
import { runtimeStartsGrandchild } from './fake-runtime.ts';
import { fakeClaude, fakeCodex } from './launcher.ts';

/** A fake to run, its name, and the arguments after its script. */
export interface FakeCall {
  /** `claude`, `codex` or `check <kind>`. */
  readonly name: string;
  readonly run: (host: FakeHost) => Promise<number>;
  readonly args: readonly string[];
}

/** The fakes a worker or a probe starts, by the script `node` is given first. */
const runtimeFakes: ReadonlyMap<string, Omit<FakeCall, 'args'>> = new Map([
  [fakeClaude, { name: 'claude', run: claudeFake }],
  [fakeCodex, { name: 'codex', run: codexFake }],
]);

/** A path as the platform compares it: without case on Windows. */
const comparablePath = (path: string): string => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));

/** The fake a `node <script> <args>` command starts, or null for any other command: what inProcessRunProbe runs in this process. */
export function runtimeFakeOf(executable: string, args: readonly string[]): FakeCall | null {
  if (comparablePath(executable) !== comparablePath(process.execPath) || args[0] === undefined) return null;
  const fake = [...runtimeFakes].find(([script]) => comparablePath(script) === comparablePath(args[0]!))?.[1];
  return fake === undefined ? null : { ...fake, args: args.slice(1) };
}

/**
 * The kind of the stand-in check a check's request runs, or null: the
 * platform shell, as shellInvocation gives it, running exactly the
 * command fakeCheckCommand in fake-check.ts writes for one kind. Each
 * kind's request is built forward and compared, so the command's format
 * and the shell's layout of its arguments each stay in one place.
 */
function checkKindOf(request: ProcessRequest): CheckKind | null {
  const runs = (kind: CheckKind): boolean => {
    const shell = shellInvocation(fakeCheckCommand(kind), process.platform);
    return comparablePath(request.executable) === comparablePath(shell.executable) && request.args.length === shell.args.length && request.args.every((arg, at) => arg === shell.args[at]);
  };
  return checkKinds.find(runs) ?? null;
}

/** The fake a worker's or a check's request starts, unless it may start a grandchild; null to leave the request to the real runner. What inProcessRunProcess runs in this process. */
export function processFakeOf(request: ProcessRequest): FakeCall | null {
  // A working directory that is not there is the spawn's error to report, as the real runner does.
  if (!existsSync(request.cwd)) return null;
  const runtime = runtimeFakeOf(request.executable, request.args);
  if (runtime !== null) return runtimeStartsGrandchild(request.environment) ? null : runtime;
  const kind = checkKindOf(request);
  if (kind === null || checkStartsGrandchild(request.environment, kind)) return null;
  return { name: `check ${kind}`, run: checkFake, args: [kind] };
}

/** Thrown into a fake the runner has ended, at its next wait or write, as a kill ends a process. */
class FakeEnded extends Error {}

let hosts = 0;

/**
 * The environment as a child's `process.env` reads it: the variables the
 * engine gave, without those it left undefined, and on Windows found by
 * name without case, as Windows finds them. Of the spellings Windows takes
 * for one name, Node passes a child only the one that sorts first by code
 * unit (src/runtime/environment.ts), and leaves it out when its value is
 * undefined, whatever another spelling holds.
 */
function childEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const defined = (entries: [string, string | undefined][]): NodeJS.ProcessEnv => Object.fromEntries(entries.filter(([, value]) => value !== undefined));
  if (process.platform !== 'win32') return defined(Object.entries(environment));
  const passed = new Map<string, [string, string | undefined]>();
  for (const name of Object.keys(environment).sort()) {
    if (!passed.has(comparable(name, 'win32'))) passed.set(comparable(name, 'win32'), [name, environment[name]]);
  }
  const given = defined([...passed.values()]);
  const nameOf = (name: string): string | undefined => spellingsOf(given, name, 'win32')[0]?.[0];
  return new Proxy(given, {
    get: (target, name) => {
      if (typeof name !== 'string') return Reflect.get(target, name);
      const key = nameOf(name);
      return key === undefined ? undefined : target[key];
    },
    has: (target, name) => (typeof name === 'string' ? nameOf(name) !== undefined : Reflect.has(target, name)),
  });
}

/** A host inside this process: output goes to `sink`, and once `signal` aborts every wait and write rejects with FakeEnded. */
function inProcessHost(args: readonly string[], environment: NodeJS.ProcessEnv, cwd: string, stdin: () => string, sink: (stream: 'stdout' | 'stderr', bytes: Buffer) => void, signal: AbortSignal): FakeHost {
  hosts += 1;
  const ended = (): FakeEnded => new FakeEnded('the runner ended the fake');
  return {
    args,
    environment: childEnvironment(environment),
    cwd,
    pid: process.pid,
    id: `${String(process.pid)}-${String(hosts)}`,
    readStdin: stdin,
    write: (stream, bytes) => {
      if (signal.aborted) return Promise.reject(ended());
      sink(stream, Buffer.from(bytes));
      return Promise.resolve();
    },
    // Settles only on the abort, so its listener goes with it.
    hang: () =>
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(ended());
        else signal.addEventListener('abort', () => reject(ended()), { once: true });
      }),
    startGrandchild: () => {
      throw new Error('A fake in the test\'s own process cannot start a grandchild; in-process-runner.ts must leave this request to the real runner');
    },
    sleep: (ms) =>
      new Promise<void>((done, reject) => {
        if (signal.aborted) {
          reject(ended());
          return;
        }
        // Each sleep's listener goes when its timer fires, so a fake that polls leaves none behind on the signal.
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(ended());
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          done();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
  };
}

/**
 * Run `call` on `host` to its exit code, as Node ends a script: an error
 * it throws goes to stderr with its stack and exits 1. Resolves null when
 * the runner ended it.
 */
async function exitOf(call: FakeCall, host: FakeHost): Promise<number | null> {
  try {
    const code = await call.run(host);
    // An exit code as the platform reports it: 32 bits on Windows, the low 8 bits elsewhere.
    return process.platform === 'win32' ? code >>> 0 : code & 0xff;
  } catch (error) {
    if (error instanceof FakeEnded) return null;
    try {
      await host.write('stderr', `${(error as Error).stack ?? String(error)}\n`);
    } catch {
      // Ended while it wrote: the runner already settled.
    }
    return 1;
  }
}

/**
 * Run `call` on `host` to its exit code, or past `timeoutMs` end it
 * through `controller` and resolve 'timeout' once it has ended.
 */
async function endOrTimeout(call: FakeCall, host: FakeHost, controller: AbortController, timeoutMs: number): Promise<number | null | 'timeout'> {
  const exited = exitOf(call, host);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((done) => {
    timer = setTimeout(() => done('timeout'), timeoutMs);
  });
  const first = await Promise.race([exited, timedOut]);
  clearTimeout(timer);
  if (first !== 'timeout') return first;
  controller.abort();
  await exited;
  return 'timeout';
}

/** Run a fake to its end or its timeout, as runProcess runs a process, with its streams in the request's files. */
async function runInProcess(request: ProcessRequest, call: FakeCall): Promise<ProcessResult> {
  const startedAt = new Date().toISOString();
  // As runProcess: a missing input fails before an output file exists, and each output file must be new.
  closeSync(openSync(request.stdinFile, 'r'));
  const descriptors: number[] = [];
  try {
    descriptors.push(openSync(request.stdoutFile, 'wx'), openSync(request.stderrFile, 'wx'));
    const [stdout, stderr] = descriptors as [number, number];
    const controller = new AbortController();
    const host = inProcessHost(call.args, request.environment, request.cwd, () => readFileSync(request.stdinFile, 'utf8'), (stream, bytes) => writeSync(stream === 'stdout' ? stdout : stderr, bytes), controller.signal);
    const first = await endOrTimeout(call, host, controller, request.timeoutMs);
    if (first === 'timeout') {
      // What the guard reports of a tree kill: taskkill's exit code 1 on Windows, SIGKILL of the group elsewhere.
      const end = process.platform === 'win32' ? { exitCode: 1, signal: null } : { exitCode: null, signal: 'SIGKILL' };
      return { termination: 'killed', ...end, treeKillError: null, startedAt, endedAt: new Date().toISOString() };
    }
    return { termination: 'exited', exitCode: first, signal: null, startedAt, endedAt: new Date().toISOString() };
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
  }
}

/** Run a fake's probe to its stdout, refusing it as runProbe does: past the output limit or the timeout, or on an exit other than 0. */
async function probeInProcess(request: ProbeRequest, call: FakeCall): Promise<string> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let printed = 0;
  let overflowed = false;
  const controller = new AbortController();
  // As runProbe: output past the limit ends the probe at once, whatever it would do next, and is not kept.
  const sink = (stream: 'stdout' | 'stderr', bytes: Buffer): void => {
    if (overflowed) return;
    printed += bytes.length;
    if (printed > request.maxOutputBytes) {
      overflowed = true;
      controller.abort();
      return;
    }
    (stream === 'stdout' ? stdout : stderr).push(bytes);
  };
  // A probe's stdin is empty, and it runs in the engine's working directory.
  const host = inProcessHost(call.args, request.environment, process.cwd(), () => '', sink, controller.signal);
  const first = await endOrTimeout(call, host, controller, request.timeoutMs);
  if (overflowed) throw new Error(`it printed more than ${String(request.maxOutputBytes)} bytes`);
  if (first === 'timeout') throw new Error(`it did not finish within ${String(request.timeoutMs)} ms`);
  if (first === 0) return Buffer.concat(stdout).toString('utf8');
  const printedError = Buffer.concat(stderr).toString('utf8').trim();
  throw new Error(printedError === '' ? `it exited with code ${String(first)}` : printedError);
}

/** runProcess, but a fake the request starts runs in this process (see the top of this file). */
export const inProcessRunProcess: ProcessRunner = (request) => {
  const call = processFakeOf(request);
  return call === null ? runProcess(request) : runInProcess(request, call);
};

/** runProbe, but a probe of a fake runtime runs in this process. */
export const inProcessRunProbe: ProbeRunner = (request) => {
  const call = runtimeFakeOf(request.executable, request.args);
  return call === null ? runProbe(request) : probeInProcess(request, call);
};
