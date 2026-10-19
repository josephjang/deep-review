/**
 * The guard of one child (R8, TD5 of resumable runs): `node <engine entry>
 * guard <request file>`, which `runProcess` starts for every worker and
 * every check, and nothing else does. It starts the child the request file
 * names and waits for it, holding a pipe from the engine on its standard
 * input. Its standard output and error are the child's files, which the
 * engine opened, and its environment is the child's, so no secret of the
 * environment goes to disk.
 *
 * When the child ends, or cannot start, the guard writes the result file
 * beside the request (`guardResultFile`); the engine reads the end of the
 * child from that file, not from the exit of the guard. A child that ended
 * can leave processes behind. On POSIX the guard then ends its process
 * group, which holds them, and itself with it. On Windows it exits with the
 * child's code, and nothing ends them: the job of libuv permits silent
 * breakaway, so the child's descendants leave the guard's job, and once the
 * child is gone no handle reaches them (Risks & Migration of the design).
 * When its standard input closes first, the engine ended without ending it,
 * and the guard kills the child's tree and exits with no result file: on
 * POSIX the process group it leads, which holds the child, on Windows the
 * tree `taskkill /T` walks from the child.
 *
 * Its only import is `process.ts`, so it starts in a fraction of a second:
 * `src/cli.ts` dispatches it before it loads the command.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { guardResultFile, killTreeNow, parseGuardRequest, type GuardRequest, type GuardResult } from './process.ts';

/** Run the guard on `argv`, the arguments after `guard`, and give its exit code. */
export async function runGuard(argv: readonly string[]): Promise<number> {
  if (argv.length !== 1) {
    process.stderr.write('deep-review guard: the engine starts this with one request file, and nothing else does\n');
    return 2;
  }
  const requestFile = argv[0]!;
  const resultFile = guardResultFile(requestFile);
  let request: GuardRequest;
  let stdin: number;
  try {
    request = parseGuardRequest(readFileSync(requestFile, 'utf8'));
    stdin = openSync(request.stdinFile, 'r');
  } catch (error) {
    writeResult(resultFile, { termination: 'not-started', error: `the guard could not prepare the child: ${(error as Error).message}` });
    return 1;
  }
  try {
    let child: ChildProcess;
    try {
      child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: process.env,
        stdio: [stdin, 'inherit', 'inherit'],
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: request.verbatimArguments,
      });
    } catch (error) {
      // A synchronous refusal, such as an argument Node will not pass: the child never existed.
      writeResult(resultFile, { termination: 'not-started', error: (error as Error).message });
      return 1;
    }
    return await new Promise<number>((resolve) => {
      let started = false;
      let settled = false;
      const settle = (code: number): void => {
        settled = true;
        // The engine's pipe would keep the guard alive past the child's end.
        process.stdin.destroy();
        resolve(code);
      };
      child.once('spawn', () => {
        started = true;
      });
      child.on('error', (error) => {
        // After a successful spawn an error (such as a failed kill) is not the end; 'close' still follows.
        if (started || settled) return;
        writeResult(resultFile, { termination: 'not-started', error: error.message });
        settle(1);
      });
      child.once('close', (exitCode, signal) => {
        if (!started || settled) return;
        const written = writeResult(resultFile, { termination: 'exited', exitCode, signal });
        // What the child left in the group ends with the guard, once the result is whole on disk or cannot be (R8 of resumable runs).
        if (process.platform !== 'win32') endOwnGroup();
        settle(written ? (exitCode ?? 1) : 1);
      });
      const engineGone = (): void => {
        if (settled) return;
        killGuardedTree(child);
        settle(1);
      };
      process.stdin.once('end', engineGone);
      process.stdin.once('close', engineGone);
      // A pipe that breaks with its engine reads as an error on some systems, and is the same end.
      process.stdin.once('error', engineGone);
      process.stdin.resume();
    });
  } finally {
    closeSync(stdin);
  }
}

/**
 * Kill the child's tree when the engine is gone. On POSIX the guard leads
 * the process group the child belongs to, so the group's kill reaches the
 * child and its descendants, and the guard with them; on Windows
 * `taskkill /T` walks the tree from the child.
 */
function killGuardedTree(child: ChildProcess): void {
  if (process.platform === 'win32') {
    killTreeNow(child);
    return;
  }
  try {
    process.kill(-process.pid, 'SIGKILL');
  } catch {
    // The group could not be addressed; end at least the child.
    killTreeNow(child);
  }
}

/**
 * End the process group the guard leads on POSIX, which holds whatever its
 * child left behind, and the guard with it. Windows has no counterpart: the
 * child's descendants left the guard's job, and nothing reaches them.
 */
function endOwnGroup(): void {
  try {
    process.kill(-process.pid, 'SIGKILL');
  } catch {
    // No group to address, so nothing the child left is in one; the guard exits as on Windows.
  }
}

/**
 * Write the result whole, through a rename, so the engine never reads half
 * of one, and tell whether it was written. A result that cannot be written,
 * as on a full disk, goes to the guard's standard error, the child's file,
 * rather than throw past the guard's own end: the engine then reads no
 * result, as from a guard a kill ended.
 */
function writeResult(resultFile: string, result: GuardResult): boolean {
  const partial = `${resultFile}.partial`;
  try {
    writeFileSync(partial, JSON.stringify(result));
    renameSync(partial, resultFile);
    return true;
  } catch (error) {
    process.stderr.write(`deep-review guard: could not write the result ${JSON.stringify(result)}: ${(error as Error).message}\n`);
    return false;
  }
}
