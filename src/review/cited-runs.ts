/**
 * The lookup of the runs a worker cites in its own record (R4, R5, R7 of
 * runs on the record), shared by the verifiers, the editing workers and
 * replay. A cited run is found by the lines it printed, in the output the
 * runtime recorded for one of the worker's shell runs (PD8, TD4), and a
 * cited probe is frozen from the worker's scratch directory by its real
 * path (PD9, TD8). It reads text and files and starts no process (PD1).
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ArtifactReference, EvidenceStore } from '../evidence/store.ts';
import { isInside } from '../paths.ts';
import type { ShellRun } from '../runtime/adapter.ts';

/** A run as a worker cites it: the command as it ran it, one to five lines of what it printed, and the path of its probe file, or null for a probe run as a command. */
export interface CitedRun {
  readonly command: string;
  readonly printed: readonly string[];
  readonly probe: string | null;
}

/** Where a cited run was found in the worker's record: its place, from 1, and its exit code when the record gives one. */
export interface FoundRun {
  readonly at: number;
  readonly exitCode: number | null;
}

/** A probe frozen in the evidence store, with the base name the worker gave it. */
export interface FrozenProbe {
  readonly blob: ArtifactReference;
  readonly name: string;
}

/** What `freezeProbe` made of a cited probe: frozen, or refused with the reason. */
export type ProbeFreeze = { readonly kind: 'frozen'; readonly probe: FrozenProbe } | { readonly kind: 'refused'; readonly reason: string };

/** The largest probe the engine freezes (R5, PD9 of runs on the record). */
export const probeLimitBytes = 64 * 1024;

/** The escape sequences of a terminal: a control sequence (CSI) and an operating system command (OSC), ended by BEL or ST. */
const terminalEscapes = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/**
 * Text as the lookup compares it: CR LF and a lone CR read as LF, the
 * escape sequences of a terminal are removed, and the spaces at the end of
 * each line are trimmed, so a line the worker copied matches the output
 * whatever the runtime's line endings and colors (R4 of runs on the record).
 */
export function normalized(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(terminalEscapes, '').replace(/[ \t]+$/gm, '');
}

/** The last segment of a path, by either separator, since a worker on Windows names its probe with backslashes. */
const baseName = (path: string): string => path.split(/[\\/]/).filter((part) => part !== '').at(-1) ?? '';

/** Whether `output` holds each line of `lines`, in order, each after the end of the one before. */
function holdsInOrder(output: string, lines: readonly string[]): boolean {
  let from = 0;
  for (const line of lines) {
    const at = output.indexOf(line, from);
    if (at < 0) return false;
    from = at + line.length;
  }
  return true;
}

/**
 * The run of `record` that `cited` names, or null when none does: the
 * last whose normalized output holds each cited line, normalized and
 * trimmed, in the order cited, and, for a cited probe, whose command holds
 * the probe's base name. The last is taken because a worker often runs a
 * probe, changes it and runs it again, and its answer follows the run it
 * saw last (TD4 of runs on the record). A run with no output is never
 * found.
 */
export function findRun(record: readonly ShellRun[], cited: CitedRun): FoundRun | null {
  const lines = cited.printed.map((line) => normalized(line).trim());
  const name = cited.probe === null ? null : baseName(cited.probe);
  for (let index = record.length - 1; index >= 0; index -= 1) {
    const run = record[index]!;
    if (run.output === null) continue;
    if (name !== null && !run.command.includes(name)) continue;
    if (holdsInOrder(normalized(run.output), lines)) return { at: index + 1, exitCode: run.exitCode };
  }
  return null;
}

/**
 * Freeze the probe a worker cites at `path` (R5, PD9, TD8 of runs on the
 * record): resolved against its scratch directory, links followed, and
 * frozen only when its real path lies inside the real path of that
 * directory, it is a regular file, and it holds at most `probeLimitBytes`.
 * Anything else is refused with the reason, as is a probe of a worker
 * given no scratch directory, so no file of the reviewed tree, the
 * checkpoint or the operator is ever frozen.
 */
export function freezeProbe(scratch: string | null, path: string, evidence: Pick<EvidenceStore, 'put'>): ProbeFreeze {
  const refused = (reason: string): ProbeFreeze => ({ kind: 'refused', reason: `the probe ${path} ${reason}` });
  if (scratch === null) return refused('cannot be frozen: the worker had no scratch directory');
  let real: string;
  try {
    real = realpathSync.native(resolve(scratch, path));
  } catch {
    return refused('names no file');
  }
  if (!isInside(scratch, real)) return refused(`is outside the scratch directory ${scratch}`);
  const stat = statSync(real);
  if (!stat.isFile()) return refused('is not a regular file');
  if (stat.size > probeLimitBytes) return refused(`holds ${String(stat.size)} bytes, more than the ${String(probeLimitBytes)} a probe may`);
  const bytes = readFileSync(real);
  if (bytes.length > probeLimitBytes) return refused(`holds ${String(bytes.length)} bytes, more than the ${String(probeLimitBytes)} a probe may`);
  return { kind: 'frozen', probe: { blob: evidence.put(bytes), name: baseName(path) } };
}
