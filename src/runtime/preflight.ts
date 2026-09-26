import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RuntimeAdapter } from './adapter.ts';
import { PreflightError } from './errors.ts';

const execFileAsync = promisify(execFile);

/** How long one version or help probe may take. */
export const preflightTimeoutMs = 10_000;

/** Output a probe may print before it is refused; a help text is a few kilobytes. */
const maxProbeOutputBytes = 4 * 1024 * 1024;

/** Whether `text` mentions `flag` as a whole flag, so `--settings` is not found inside `--setting-sources`. */
export function mentionsFlag(text: string, flag: string): boolean {
  const escaped = flag.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(text);
}

/**
 * Qualify an executable for an adapter without invoking a model (R4, TD9):
 * its version output must match the adapter's pattern and every help text
 * must mention every flag the adapter uses. There is no version list; the
 * observed version is returned so the launch records it.
 */
export async function preflight(adapter: RuntimeAdapter, executable: string, executableArgs: readonly string[], environment: NodeJS.ProcessEnv): Promise<string> {
  const probe = async (args: readonly string[]): Promise<string> => {
    const command = [executable, ...executableArgs, ...args].join(' ');
    try {
      const { stdout } = await execFileAsync(executable, [...executableArgs, ...args], {
        encoding: 'utf8',
        env: environment,
        timeout: preflightTimeoutMs,
        maxBuffer: maxProbeOutputBytes,
        windowsHide: true,
      });
      return stdout;
    } catch (error) {
      const failure = error as { stderr?: string; message: string };
      throw new PreflightError(`The ${adapter.name} preflight could not run ${command}: ${failure.stderr?.trim() || failure.message}`);
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
