// What the fake runtime CLIs answer to the preflight's probes, `--version`
// and `--help`, kept apart from fake-runtime.ts so that a probe loads no
// more than this: the engine starts two probes before every Claude worker and
// four before every Codex worker, and the scripts and answers
// fake-runtime.ts imports (zod among them) are what made a probe slow to
// start. The answers read these environment variables, which a test sets;
// fake-runtime.ts lists those a worker reads:
//   FAKE_VERSION     version output instead of the runtime's usual one
//   FAKE_UNQUALIFIED_WHEN  a file; while it exists the version output names another
//                    program, so a preflight made then fails
//   FAKE_PADDED_WHEN a file; while it exists the version output is followed by
//                    paddedVersionBytes of spaces, which the preflight trims, so
//                    the version still matches but a lower output limit fails
//   FAKE_HELP_OMIT   a flag to leave out of every help text
//   FAKE_QUALIFIED_FIRST_ON_PATH  a directory; unless it comes first on PATH the
//                    version output names another program, so a preflight made
//                    without it first fails
import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';
import type { FakeHost } from './fake-host.ts';

/** How many spaces follow the version output while FAKE_PADDED_WHEN exists: far past the help texts' few hundred bytes. */
export const paddedVersionBytes = 16 * 1024;

/**
 * What `--version` prints: another program's name while FAKE_UNQUALIFIED_WHEN
 * exists or while FAKE_QUALIFIED_FIRST_ON_PATH is not first on PATH, else
 * FAKE_VERSION or the runtime's usual output, padded with spaces while
 * FAKE_PADDED_WHEN exists.
 */
export function versionOutput(host: FakeHost, usual: string): string {
  const environment = host.environment;
  const broken = environment.FAKE_UNQUALIFIED_WHEN;
  if (broken !== undefined && existsSync(broken)) return 'an unrelated program 1.0';
  const first = environment.FAKE_QUALIFIED_FIRST_ON_PATH;
  if (first !== undefined && (environment.PATH ?? '').split(delimiter)[0] !== first) return 'an unrelated program 1.0';
  const version = environment.FAKE_VERSION ?? usual;
  const padded = environment.FAKE_PADDED_WHEN;
  return padded !== undefined && existsSync(padded) ? version + ' '.repeat(paddedVersionBytes) : version;
}

/** Print a help text listing every flag but FAKE_HELP_OMIT. */
export function printHelp(host: FakeHost, flags: readonly string[]): Promise<void> {
  const omit = host.environment.FAKE_HELP_OMIT;
  return host.write('stdout', `Usage: fake [options]\n\nOptions:\n${flags.filter((flag) => flag !== omit).map((flag) => `  ${flag} <value>  a flag\n`).join('')}`);
}
