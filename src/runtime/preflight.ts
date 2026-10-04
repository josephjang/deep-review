import { spawn, type ChildProcess } from 'node:child_process';
import type { RuntimeAdapter } from './adapter.ts';
import { PreflightError } from './errors.ts';
import { killTree, superviseChild } from './process.ts';

/** How long one version or help probe may take. */
export const preflightTimeoutMs = 10_000;

/** Output a probe may print before it is refused; a help text is a few kilobytes. */
const maxProbeOutputBytes = 4 * 1024 * 1024;

/** Limits on each probe; the defaults are what a launch uses, and tests shorten them. */
export interface PreflightOptions {
  /** How long one probe may take before it is killed with its process tree. */
  readonly timeoutMs?: number;
  /** How many bytes one probe may print on stdout and stderr together before it is killed with its process tree. */
  readonly maxOutputBytes?: number;
}

/** Whether `text` mentions `flag` as a whole flag, so `--settings` is not found inside `--setting-sources`. */
export function mentionsFlag(text: string, flag: string): boolean {
  return new RegExp(`(?<![\\w-])${RegExp.escape(flag)}(?![\\w-])`).test(text);
}

/** Refuse a limit that is not a positive whole number, which would end every probe at once or never. */
function positiveLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`The preflight ${name} must be a positive whole number, not ${String(value)}`);
  return value;
}

/**
 * Run one probe to its end and return its stdout, or reject with why it
 * failed. At the timeout, or once its output passes the limit, the probe is
 * killed with its whole process tree, like a worker (TD13): a CLI that is a
 * wrapper around another process would otherwise leave that process running,
 * and holding the output pipes, after a kill that reached only the wrapper.
 * On POSIX the probe leads its own process group, which is what `killTree`
 * addresses; on Windows `killTree` walks the tree. The rejection waits for
 * the kill, not for the pipes to close, so a descendant that escaped the
 * kill cannot hold the preflight open. Stdin is empty, so a probe that reads
 * its input sees the end at once instead of waiting. While it runs the probe
 * is supervised like a worker (`superviseChild`): if the engine exits or,
 * on POSIX, is interrupted, the probe is killed with its tree, which its own
 * process group would otherwise keep out of reach of the terminal's signals.
 */
function runProbe(executable: string, args: readonly string[], environment: NodeJS.ProcessEnv, timeoutMs: number, maxOutputBytes: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], {
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      // A synchronous refusal, such as an argument Node will not pass: the probe never existed.
      reject(error as Error);
      return;
    }
    // Like a worker, a probe is killed with its tree if the engine exits or is interrupted meanwhile.
    superviseChild(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let printed = 0;
    let settled = false;

    const stop = (reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      void killTree(child).finally(() => {
        reject(new Error(reason));
      });
    };
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      if (settled) return;
      printed += chunk.length;
      if (printed > maxOutputBytes) {
        stop(`it printed more than ${String(maxOutputBytes)} bytes`);
        return;
      }
      into.push(chunk);
    };

    const timer = setTimeout(() => {
      stop(`it did not finish within ${String(timeoutMs)} ms`);
    }, timeoutMs);
    child.stdout?.on('data', collect(stdout));
    child.stderr?.on('data', collect(stderr));
    child.on('error', (error) => {
      // Before the spawn this is why the probe never started; after it (a
      // failed kill) the probe is already settled or 'close' still follows.
      if (settled || child.pid !== undefined) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      const printedError = Buffer.concat(stderr).toString('utf8').trim();
      const ending = code === null ? `it was ended by signal ${String(signal)}` : `it exited with code ${String(code)}`;
      reject(new Error(printedError === '' ? ending : printedError));
    });
  });
}

/**
 * Qualify an executable for an adapter without invoking a model (R4, TD9):
 * its version output must match the adapter's pattern and every help text
 * must mention every flag the adapter uses. There is no version list; the
 * observed version is returned so the launch records it.
 */
export async function preflight(
  adapter: RuntimeAdapter,
  executable: string,
  executableArgs: readonly string[],
  environment: NodeJS.ProcessEnv,
  options: PreflightOptions = {},
): Promise<string> {
  const timeoutMs = positiveLimit('timeout', options.timeoutMs ?? preflightTimeoutMs);
  const maxOutputBytes = positiveLimit('output limit', options.maxOutputBytes ?? maxProbeOutputBytes);
  const probe = async (args: readonly string[]): Promise<string> => {
    const argv = [...executableArgs, ...args];
    try {
      return await runProbe(executable, argv, environment, timeoutMs, maxOutputBytes);
    } catch (error) {
      throw new PreflightError(`The ${adapter.name} preflight could not run ${[executable, ...argv].join(' ')}: ${(error as Error).message}`);
    }
  };

  const { version, help } = adapter.qualification;
  const versionOutput = (await probe(version.args)).trim();
  const observed = version.pattern.exec(versionOutput)?.[1];
  if (observed === undefined || observed.length === 0) {
    throw new PreflightError(`${executable} does not identify itself as ${adapter.name}: its version output is ${JSON.stringify(versionOutput)}`);
  }
  const texts = await Promise.all(help.map((entry) => probe(entry.args)));
  const missing = help.flatMap((entry, index) => entry.flags.filter((flag) => !mentionsFlag(texts[index]!, flag)).map((flag) => `${flag} (in ${entry.args.join(' ')})`));
  if (missing.length > 0) throw new PreflightError(`${adapter.name} ${observed} at ${executable} lacks flags the adapter uses: ${missing.join(', ')}`);
  return observed;
}
