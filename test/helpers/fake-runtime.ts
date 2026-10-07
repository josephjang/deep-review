// What the fake runtime CLIs share. A fake is run as `node fake-<runtime>.ts
// <args>`, so the launcher spawns it exactly as it spawns a real CLI, and
// is steered by environment variables the test sets:
//   FAKE_VERSION     version output instead of the runtime's usual one
//   FAKE_UNQUALIFIED_WHEN  a file; while it exists the version output names another
//                    program, so a preflight made then fails
//   FAKE_HELP_OMIT   a flag to leave out of every help text
//   FAKE_RECORD      file to write what the fake received as JSON
//   FAKE_WAIT_FOR    file to wait for before answering
//   FAKE_STDOUT      stdout to print instead of a successful answer; {session} becomes the session id
//   FAKE_STDERR      stderr to print
//   FAKE_EXIT        exit code
//   FAKE_HUGE        print this many bytes of filler: on stdout after FAKE_STDOUT (or
//                    nothing) instead of an answer, or on stderr after the answer
//   FAKE_HUGE_STREAM `stderr` to print FAKE_HUGE there; stdout by default
//   FAKE_HANG        start a grandchild, write its pid to this file, and never exit
//   FAKE_SCRIPT      a JSON file scripting the answer per review role and unit; see scriptedStep
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTaskHeader } from '../../src/review/prompts.ts';
import { finderAngles } from '../../src/review/vocabulary.ts';

export const environment = process.env;

/**
 * One edit a scripted fixer makes before it answers, in order: files
 * written and removed, relative to its working directory (the worktree),
 * then, when `snapshot` names a finding's index, the snapshot command its
 * prompt quotes, run for that index.
 */
export interface ScriptEdit {
  readonly writes?: Readonly<Record<string, string>>;
  readonly deletes?: readonly string[];
  readonly snapshot?: number;
}

/**
 * One scripted answer of a review worker. A list of steps is consumed one
 * per attempt of the same unit, the last one repeating, so a test can say
 * "fail once, then answer".
 */
export interface ScriptStep {
  /** The edits a fixer makes before answering (or before waiting, with `waitFor`), so a test sees the tree a fixer leaves. */
  readonly edits?: readonly ScriptEdit[];
  /** The structured answer; the role's empty answer when absent. */
  readonly output?: unknown;
  /** Answer with text that is not the schema's shape, so the launcher fails the worker. */
  readonly malformed?: boolean;
  /** Exit with this code instead of 0. */
  readonly exit?: number;
  /** Never exit, so the launcher kills the worker at its timeout. */
  readonly hang?: boolean;
  /** The cost the fake reports (Claude only). */
  readonly costUsd?: number;
  /** A file to wait for before answering, so a test can act between phases. */
  readonly waitFor?: string;
  readonly stderr?: string;
}

/** The script: steps by `<role>:<phase>:<unit>`, `<role>:<unit>`, `<role>` or `*`, the most specific key winning. */
export type Script = Readonly<Record<string, ScriptStep | readonly ScriptStep[]>>;

/** How many attempts of `key` this script has answered before, kept beside the script so every fake process sees the same count. */
function nextAttempt(script: string, key: string): number {
  const directory = `${script}.counts`;
  mkdirSync(directory, { recursive: true });
  const file = join(directory, key.replaceAll(/[^A-Za-z0-9_-]/g, '_'));
  const count = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  writeWhole(file, String(count + 1));
  return count;
}

/** The count in the prompt's "numbered [0] to [n]", plus one, or 0 when the task numbers nothing. */
function numberedCount(prompt: string): number {
  const match = /numbered \[0\] to \[(\d+)\]/.exec(prompt);
  return match === null ? 0 : Number(match[1]) + 1;
}

/**
 * The surveyor's empty answer to its task: no convention source, every
 * offered user-level file not applied, and for each kind the task asks to
 * choose no command; in a run that does not fix, no checks.
 */
export function surveyorAnswer(prompt: string): unknown {
  const offered = /^User-level rules files offered:\n((?:- .+\n)+)/m.exec(prompt)?.[1]?.trim().split('\n').map((line) => line.slice(2)) ?? [];
  const kinds = /^Kinds to choose: (.+)$/m.exec(prompt)?.[1] ?? '';
  const checks = kinds.startsWith('none; ') ? null : kinds === 'none' ? [] : kinds.split(', ').map((kind) => ({ kind, command: null, basis: null, source: null, missingTool: null, reason: 'fake: the repository states none' }));
  return { conventions: [], userRules: offered.map((path) => ({ path, applied: false, reason: 'fake: no grounds' })), checks, note: '' };
}

/** The empty, valid answer of a review role: what a worker that found nothing returns. */
export function defaultOutput(role: string, prompt: string): unknown {
  if (role === 'surveyor') return surveyorAnswer(prompt);
  if (role === 'triage') return { candidates: [], leads: finderAngles.map((angle) => ({ angle, lead: null })) };
  if (role.startsWith('finder-') || role === 'sweep') return { candidates: [] };
  if (role === 'deduplication') return { groups: [] };
  if (role === 'verifier') return { verdicts: Array.from({ length: numberedCount(prompt) }, (_, index) => ({ index, verdict: 'PLAUSIBLE', evidence: `fake evidence for [${String(index)}]` })) };
  if (role === 'merge-rank') return { findings: Array.from({ length: numberedCount(prompt) }, (_, index) => ({ primary: index, members: [], severity: 'minor', summary: `fake finding [${String(index)}]`, reason: 'fake reason' })) };
  if (role === 'decider') return deciderAnswer(Array.from({ length: numberedCount(prompt) }, () => ({})));
  if (role === 'fixer') return fixerAnswer(Array.from({ length: numberedCount(prompt) }, () => ({})));
  return { answer: 'ok' };
}

/**
 * What a scripted decider decides of one finding: `fix` unless a kind is
 * given; a `leave` with its reason and, when superseded, the index of the
 * finding that supersedes it; an `ask` whose applied default edits the
 * code unless `edits` says it keeps it.
 */
export interface DecidedFinding {
  readonly decision?: 'fix' | 'leave' | 'ask';
  readonly reason?: 'outside-change-not-regression' | 'superseded' | 'intended';
  readonly supersededBy?: number;
  readonly edits?: boolean;
  readonly departs?: boolean;
}

/** A decider's answer with one decision per finding, by index, in the shape its output schema demands. */
export function deciderAnswer(findings: readonly DecidedFinding[]): unknown {
  return {
    decisions: findings.map((finding, index) => {
      const decision = finding.decision ?? 'fix';
      return {
        index,
        decision,
        grounds: `fake grounds for [${String(index)}]`,
        fix: decision === 'fix' ? { approach: `fake approach for [${String(index)}]`, rejected: [{ option: `fake alternative for [${String(index)}]`, reason: 'fake reason it was rejected' }] } : null,
        leave: decision === 'leave' ? { reason: finding.reason ?? 'outside-change-not-regression', supersededBy: finding.supersededBy ?? null } : null,
        ask: decision === 'ask'
          ? {
              question: `fake question for [${String(index)}]?`,
              options: [
                { option: 'fake default', cost: 'fake cost of the default', rule: 'fake rule for the default', edits: finding.edits ?? true },
                { option: 'fake other way', cost: 'fake cost of the other way', rule: 'fake rule for the other way', edits: true },
              ],
              recommended: 1,
              applied: 0,
              searched: ['fake place looked in'],
            }
          : null,
        departure: finding.departs === true ? { rule: 'fake rule departed from', source: 'fake source', reason: 'fake reason the rule does not reach the case' } : null,
      };
    }),
  };
}

/** What a scripted fixer says of one finding; every field but the ones given is a plain applied finding's. */
export interface FixedFinding {
  readonly status?: 'applied' | 'already-applied' | 'deferred' | 'blocked';
  readonly files?: readonly string[];
  readonly requiredFiles?: readonly string[];
  readonly subject?: string;
  readonly note?: string;
}

/** A fixer's answer with one entry per finding, by index, in the shape its output schema demands. */
export function fixerAnswer(findings: readonly FixedFinding[]): unknown {
  return {
    findings: findings.map((finding, index) => {
      const status = finding.status ?? 'applied';
      return {
        index,
        status,
        file: finding.files?.[0] ?? 'src/a.ts',
        line: 1,
        note: finding.note ?? `fake ${status} [${String(index)}]`,
        // An applied finding always carries a message; an already-applied one only when the script gives its subject, as a retry verifying an earlier attempt's edits does.
        message: status === 'applied' || (status === 'already-applied' && finding.subject !== undefined) ? { subject: finding.subject ?? `fix: Apply finding ${String(index)}`, body: `Why finding ${String(index)} changed.` } : null,
        files: [...(finding.files ?? [])],
        corrections: [],
        validation: [{ method: 'existing', source: 'tests', evidence: 'fake evidence' }],
        requiredFiles: [...(finding.requiredFiles ?? [])],
      };
    }),
    drift: [],
    tests: [],
    suite: { result: 'pass', command: 'fake suite', failures: '' },
  };
}

/** The snapshot command a fixer's prompt quotes: the engine's entry and the directory, with `<index>` for the finding's index. */
function snapshotCommand(prompt: string): { entry: string; into: string } {
  const match = /^ {4}node "([^"]+)" snapshot --finding <index> --into "([^"]+)"$/m.exec(prompt);
  if (match === null) throw new Error('The prompt quotes no snapshot command');
  return { entry: match[1]!, into: match[2]! };
}

/** Make a scripted fixer's edits in its working directory, running the snapshot command its prompt quotes where a step asks. */
export function applyEdits(edits: readonly ScriptEdit[], prompt: string): void {
  for (const edit of edits) {
    for (const [path, content] of Object.entries(edit.writes ?? {})) {
      const file = join(process.cwd(), ...path.split('/'));
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, content);
    }
    for (const path of edit.deletes ?? []) rmSync(join(process.cwd(), ...path.split('/')), { force: true });
    if (edit.snapshot !== undefined) {
      const { entry, into } = snapshotCommand(prompt);
      execFileSync(process.execPath, [entry, 'snapshot', '--finding', String(edit.snapshot), '--into', into], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
    }
  }
}

/**
 * The scripted step for the review worker whose prompt this is, from the
 * FAKE_SCRIPT file, with the role's empty answer as the step when the
 * script names none; null when the fake is not scripted or the prompt is
 * not a review worker's.
 */
export function scriptedStep(prompt: string): { readonly role: string; readonly unit: string; readonly step: ScriptStep & { readonly output: unknown } } | null {
  const file = environment.FAKE_SCRIPT;
  if (file === undefined) return null;
  const header = readTaskHeader(prompt);
  if (header === null) return null;
  const script = JSON.parse(readFileSync(file, 'utf8')) as Script;
  const key = [`${header.role}:${header.phase}:${header.unitKey}`, `${header.role}:${header.unitKey}`, header.role, '*'].find((candidate) => Object.hasOwn(script, candidate));
  const entry = key === undefined ? {} : script[key]!;
  const step = Array.isArray(entry) ? (entry[Math.min(nextAttempt(file, `${header.role}:${header.phase}:${header.unitKey}`), entry.length - 1)] ?? {}) : (entry as ScriptStep);
  return { role: header.role, unit: header.unitKey, step: { ...step, output: step.output ?? defaultOutput(header.role, prompt) } };
}

/** The thread id fake-codex.ts reports for a fresh worker, unless FAKE_THREAD names another. */
export const freshThread = '0199a3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b';

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

/** Write a file whole, under a temporary name and then renamed, so a polling test never reads it empty or half written. */
function writeWhole(file: string, text: string): void {
  const temporary = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

/** Write what the fake was given, for the test to assert on. */
export function record(argv: readonly string[], stdin: string): void {
  const file = environment.FAKE_RECORD;
  if (file === undefined) return;
  const pinned = ['TEMP', 'TMP', 'TMPDIR', 'MSBUILDDISABLENODEREUSE', 'DOTNET_CLI_USE_MSBUILD_SERVER', 'UseSharedCompilation', 'UseRazorBuildServer', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'Path', 'PATH'];
  const seen = Object.fromEntries(Object.entries(process.env).filter(([name]) => pinned.some((pin) => pin.toUpperCase() === name.toUpperCase())));
  writeWhole(file, JSON.stringify({ argv, stdin, cwd: process.cwd(), environment: seen }));
}

/** Block until the marker file exists. */
export async function waitForMarker(marker: string | undefined = environment.FAKE_WAIT_FOR): Promise<void> {
  if (marker === undefined) return;
  while (!existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * Do what a scripted step asks before the answer is printed: edit the
 * tree, wait, hang, or print stderr. Returns the exit code the step asks
 * for.
 */
export async function beginScriptedStep(step: ScriptStep, prompt: string): Promise<number> {
  applyEdits(step.edits ?? [], prompt);
  await waitForMarker(step.waitFor);
  if (step.hang === true) {
    setInterval(() => {}, 1000);
    await new Promise<never>(() => {});
  }
  if (step.stderr !== undefined) process.stderr.write(step.stderr);
  return step.exit ?? 0;
}

/**
 * Start a grandchild that never exits, write its pid, and never exit either.
 * On Windows the grandchild is detached: libuv otherwise puts it in a job
 * that dies with the fake, so it would die even if the launcher killed only
 * the fake, and the test could not tell a tree kill from a root kill. On
 * POSIX it stays in the fake's process group, which is what the launcher kills.
 */
export function hangWithGrandchild(pidFile: string): void {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' });
  if (grandchild.pid === undefined) throw new Error('The grandchild did not start');
  writeWhole(pidFile, String(grandchild.pid));
  setInterval(() => {}, 1000);
}

/** Read all of stdin: the prompt the launcher wrote to a file. */
export function readStdin(): string {
  return readFileSync(0, 'utf8');
}

/** The value after `flag` in argv, or undefined. */
export function option(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

/** Write to a stream and wait until it has taken the bytes. */
function write(stream: NodeJS.WriteStream, bytes: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => stream.write(bytes, (error) => (error ? reject(error) : resolve())));
}

/**
 * Do what the environment asks after the fake has received its input:
 * hang, print a huge stream, or print the scripted or default answer,
 * then exit with the scripted code.
 */
export async function answer(defaultStdout: () => string, session: string): Promise<void> {
  await waitForMarker();
  if (environment.FAKE_HANG !== undefined) {
    hangWithGrandchild(environment.FAKE_HANG);
    return;
  }
  if (environment.FAKE_STDERR !== undefined) process.stderr.write(environment.FAKE_STDERR);
  const huge = environment.FAKE_HUGE === undefined ? null : Number(environment.FAKE_HUGE);
  const hugeStream = environment.FAKE_HUGE_STREAM === 'stderr' ? process.stderr : process.stdout;
  const stdout = environment.FAKE_STDOUT ?? (huge !== null && hugeStream === process.stdout ? '' : defaultStdout());
  await write(process.stdout, stdout.replaceAll('{session}', session));
  if (huge !== null) {
    const chunk = Buffer.alloc(1024 * 1024, 'x');
    for (let left = huge; left > 0; left -= chunk.length) await write(hugeStream, chunk.subarray(0, Math.min(left, chunk.length)));
  }
  process.exitCode = Number(environment.FAKE_EXIT ?? '0');
}
