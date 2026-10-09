// What the fake runtime CLIs answer to the preflight's probes, `--version`
// and `--help`, kept apart from fake-runtime.ts so that a probe loads no
// more than this: the engine starts two probes before every worker, and the
// scripts and answers fake-runtime.ts imports (zod among them) are what
// made a probe slow to start. See fake-runtime.ts for the variables a test
// steers the fakes with; these read FAKE_VERSION, FAKE_UNQUALIFIED_WHEN and
// FAKE_HELP_OMIT.
import { existsSync } from 'node:fs';

export const environment = process.env;

/** What `--version` prints: another program's name while FAKE_UNQUALIFIED_WHEN exists, else FAKE_VERSION or the runtime's usual output. */
export function versionOutput(usual: string): string {
  const broken = environment.FAKE_UNQUALIFIED_WHEN;
  if (broken !== undefined && existsSync(broken)) return 'an unrelated program 1.0';
  return environment.FAKE_VERSION ?? usual;
}

/** Print a help text listing every flag but FAKE_HELP_OMIT. */
export function printHelp(flags: readonly string[]): void {
  const omit = environment.FAKE_HELP_OMIT;
  process.stdout.write(`Usage: fake [options]\n\nOptions:\n${flags.filter((flag) => flag !== omit).map((flag) => `  ${flag} <value>  a flag\n`).join('')}`);
}
