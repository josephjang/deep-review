// What the fake runtime CLIs share. A fake is run as `node fake-<runtime>.ts
// <args>`, so the launcher spawns it exactly as it spawns a real CLI, or
// in the test's own process by in-process-runner.ts, through the host it is
// given (fake-host.ts). It is steered by environment variables the test sets:
//   FAKE_RECORD      file to write what the fake received as JSON
//   FAKE_RECORD_ROLE record only a worker of this review role, so a later worker of another role does not replace it
//   FAKE_WAIT_FOR    file to wait for before answering
//   FAKE_STDOUT      stdout to print instead of a successful answer; {session} becomes the session id
//   FAKE_STDERR      stderr to print
//   FAKE_EXIT        exit code
//   FAKE_HUGE        print this many bytes of filler: on stdout after FAKE_STDOUT (or
//                    nothing) instead of an answer, or on stderr after the answer
//   FAKE_HUGE_STREAM `stderr` to print FAKE_HUGE there; stdout by default
//   FAKE_HANG        start a grandchild, write its pid to this file, and never exit
//   FAKE_SCRIPT      a JSON file scripting the answer per review role and unit; see scriptedStep
//   FAKE_START_DIR   a directory whose `starts` file records each scripted worker's start
//   FAKE_HOLD        the start of a scripted worker that holds there; see holdIfNamed in fake-host.ts
// The answers to the preflight's probes are in fake-probe.ts, which lists the
// variables they read; a fake loads this module only to act as a worker.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTaskHeader } from '../../src/review/prompts.ts';
import { citingValidationWords } from '../../src/review/tasks.ts';
import { finderAngles, type LeaveReason, type SettleStep } from '../../src/review/vocabulary.ts';
import type { ShellRun } from '../../src/runtime/adapter.ts';
import { holdIfNamed, waitForFile, writeWhole, type FakeHost } from './fake-host.ts';

/**
 * One edit a scripted fixer makes before it answers, in order: the files
 * it claims, through the claim command its prompt quotes; files written
 * and removed, relative to its working directory (the worktree); then,
 * when `snapshot` names a finding's index, the snapshot command its prompt
 * quotes, run for that index.
 */
export interface ScriptEdit {
  /** A file to wait for before this edit, so a test can order one fixer's claim after a sibling's. */
  readonly waitFor?: string;
  readonly claims?: readonly string[];
  /** What each claim must come to, so a timing slip fails the fake loudly rather than passing; any outcome when absent. */
  readonly expectClaim?: 'claimed' | 'refused';
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
  /** The structured answer; the role's empty answer when absent. A repair answer that names no `comparisons` compares nothing (see answerFor). */
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
  /** Answer as Claude Code does at a usage or session limit (Claude only): a result with `is_error` true, these words in `result`, and no structured output (R14 of resumable runs). */
  readonly limit?: string;
  /**
   * The shell runs the worker's stream records before its answer, each
   * printed as its runtime prints one, so the decode reads them back as
   * given, but for what each runtime adds: Claude Code puts the line
   * `Exit code <n>` before the output of a command that exited nonzero, as
   * its worker sees it, and gives a run with a null output no result, so its
   * exit code reads back null too; Codex reads a null output back as empty,
   * and fails the worker for a null exit code, as for a command that never
   * ran.
   */
  readonly runs?: readonly ShellRun[];
  /** Files the worker writes in its scratch directory, by name, before it answers, as a verifier writes the probes its runs run. */
  readonly probes?: Readonly<Record<string, string>>;
}

/** The script: steps by `<role>:<phase>:<unit>`, `<role>:<unit>`, `<role>` or `*`, the most specific key winning. */
export type Script = Readonly<Record<string, ScriptStep | readonly ScriptStep[]>>;

/** How many attempts of `key` this script has answered before, kept beside the script so every fake process sees the same count. */
function nextAttempt(script: string, key: string, id: string): number {
  const directory = `${script}.counts`;
  mkdirSync(directory, { recursive: true });
  const file = join(directory, key.replaceAll(/[^A-Za-z0-9_-]/g, '_'));
  const count = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  writeWhole(file, String(count + 1), id);
  return count;
}

/** The count in the prompt's "numbered [0] to [n]", plus one, or 0 when the task numbers nothing. */
function numberedCount(prompt: string): number {
  const match = /numbered \[0\] to \[(\d+)\]/.exec(prompt);
  return match === null ? 0 : Number(match[1]) + 1;
}

/** The words a verifier's task holds when its answer gives each verdict a basis and cites its runs (R2 of runs on the record). */
const citingWords = 'Give each verdict a `basis`';

/** The words a verifier's task holds when its answer gives each verdict its two notes (R7, R9 of the review that reads as a report). */
const notesWords = 'Give each verdict `unconfirmed` and `authorChoice`';

/** The words a writer's task ends with when it answers in the form of the review that reads as a report (TD2). */
const reportFormWords = 'Return `conclusion`, `areas`, `findings` and `refuted`';

/** The words a writer's task ends with when it also gives the core of the change and the conditions (TD2 of the core of the change on the pull request). */
const coreFormWords = 'Return `conclusion`, `areas`, `findings`, `refuted`, `core` and `conditions`';

/** The words a writer's task ends with when it answers in the fourth form, in which it writes every sentence of the review (TD2 of the review in the writer's words). */
const writtenFormWords = 'Return `core`, `conditions`, `summary`, `areas`, `findings`, `left`, `refuted` and `notExamined`';

/** The conditions a writer's task asks it to explain, by name, none when it asks for none. */
const conditionsOf = (prompt: string): string[] => [...prompt.matchAll(/^- `(public-interface|wide-effect)`, /gm)].map((match) => match[1]!);

/**
 * A writer's answer that also gives the core of the change and the
 * conditions, from one scripted in an earlier form (`reportFormAnswer`):
 * a core that states no reason, unless the script gives the core, and an
 * explanation of each condition the task lists, unless the script gives
 * the conditions.
 */
function coreFormAnswer(output: Record<string, unknown>, prompt: string): Record<string, unknown> {
  return {
    ...reportFormAnswer(output, prompt),
    core: output.core ?? { title: 'fake: what the change is', what: 'fake: what the change does, from its code.', why: null, whyFrom: [], diagram: null },
    conditions: output.conditions ?? conditionsOf(prompt).map((condition) => ({ condition, explanation: `fake: what the code shows of ${condition}.`, unexplained: null })),
  };
}

/** The ids a writer's task lists after `pattern`, none when it lists none. */
const listedIds = (prompt: string, pattern: RegExp): string[] => pattern.exec(prompt)?.[1]?.split(', ') ?? [];

/** The decision of finding `id` as the writer's task gives it: a fix, against a written rule or not, or a question with the count of its options. */
function taskDecision(prompt: string, id: string): { readonly kind: 'fix' | 'ask' | 'other'; readonly departs: boolean; readonly options: number } {
  const start = prompt.search(new RegExp(`^#### \\d+\\. ${id}: `, 'm'));
  if (start === -1) return { kind: 'other', departs: false, options: 0 };
  const rest = prompt.slice(start + 5);
  const block = rest.slice(0, rest.search(/^####? /m) === -1 ? undefined : rest.search(/^####? /m));
  if (/^ {4}decision: fix/m.test(block)) return { kind: 'fix', departs: /^ {4}decision: fix, against a written rule$/m.test(block), options: 0 };
  if (/^ {4}decision: ask the author$/m.test(block)) return { kind: 'ask', departs: false, options: [...block.matchAll(/^ {8}option \d+: /gm)].length };
  return { kind: 'other', departs: false, options: 0 };
}

/**
 * A writer's answer in the fourth form (TD2 of the review in the writer's
 * words), from one scripted in an earlier form (`coreFormAnswer`): the
 * summary from the conclusion; on each explanation that gives none, its
 * action from the conclusion, a fix for a finding decided fix, with a
 * departure when it departs from a rule, or a question with one option
 * for each the decision records, and the reason a verdict is not
 * confirmed for each finding the task lists; a title and a reason for
 * each finding the task lists as left as is; and what the review did not
 * examine; each unless the script gives it.
 */
function writtenFormAnswer(output: Record<string, unknown>, prompt: string): Record<string, unknown> {
  const { conclusion, ...cored } = coreFormAnswer(output, prompt);
  const actions = ((conclusion as { readonly actions?: readonly { readonly id: string; readonly sentence: string }[] } | undefined)?.actions ?? []);
  const unconfirmed = listedIds(prompt, /^Say in `unconfirmed` why each of these \d+ findings? is not CONFIRMED, as its verifier recorded, and give it null for every other: (.+?)\. /m);
  const left = listedIds(prompt, /^Give one entry of `left` for each of these \d+ findings? left as is, by its id, and for no other: (.+)\.$/m);
  const findings = (cored.findings as readonly { readonly id: string; readonly explanation: Record<string, unknown> | null; readonly unexplained: string | null }[]).map((entry) => {
    if (entry.explanation === null || Object.hasOwn(entry.explanation, 'action')) return entry;
    // The fourth form has no `decision`: each finding carries its action and its fix or its question instead.
    const explanation = Object.fromEntries(Object.entries(entry.explanation).filter(([key]) => key !== 'decision'));
    const decided = taskDecision(prompt, entry.id);
    const action = actions.find((given) => given.id === entry.id)?.sentence ?? `fake: what deep-review would do about ${entry.id}.`;
    const fix = decided.kind === 'fix' ? { text: `fake: what the fix of ${entry.id} changes.`, departure: decided.departs ? `fake: the rule ${entry.id} departs from, and why.` : null } : null;
    const ask = decided.kind === 'ask' ? { question: `fake: what ${entry.id} asks.`, options: Array.from({ length: decided.options }, (_, index) => ({ number: index + 1, means: `fake: option ${String(index + 1)}.`, cost: 'fake: its cost.', rule: 'fake: its rule.' })), recommendation: 'fake: why this option.' } : null;
    return { ...entry, explanation: { ...explanation, action, unconfirmed: unconfirmed.includes(entry.id) ? `fake: why ${entry.id} is not confirmed.` : null, fix, ask } };
  });
  return {
    ...cored,
    summary: output.summary ?? (conclusion as { readonly why?: string } | undefined)?.why ?? 'fake: what the review found.',
    findings,
    left: output.left ?? left.map((id) => ({ id, title: `fake: what ${id} is.`, why: `fake: why deep-review leaves ${id}.` })),
    notExamined: output.notExamined ?? 'fake: what the review did not examine, and where to look.',
  };
}

/**
 * A writer's answer in the form of the review that reads as a report,
 * from one scripted in the first form: no account; one area that holds
 * every major finding the task lists, unless the script gives the areas;
 * on each explanation one line of how it was checked and, for a minor
 * finding the task lists, the kind `code`, unless the script gives them;
 * and a line for each refuted candidate the task lists, unless the script
 * gives the lines.
 */
function reportFormAnswer({ account: _account, ...rest }: Record<string, unknown>, prompt: string): Record<string, unknown> {
  const major = listedIds(prompt, /^Put each of these \d+ major findings? in exactly one area of `areas`, and no other finding in any: (.+)\.$/m);
  const minor = listedIds(prompt, /^Give each of these \d+ minor findings? a `kind`, and every other finding none: (.+)\.$/m);
  const refuted = listedIds(prompt, /^Give one line in `refuted` for each of these \d+ refuted candidates?, by its id, and for no other: (.+)\.$/m);
  const findings = (rest.findings as readonly { readonly id: string; readonly explanation: Record<string, unknown> | null }[]).map((entry) =>
    entry.explanation === null || Object.hasOwn(entry.explanation, 'checked') ? entry : { ...entry, explanation: { ...entry.explanation, checked: `fake: the verifier read the lines of ${entry.id}.`, kind: minor.includes(entry.id) ? 'code' : null } });
  return {
    ...rest,
    areas: rest.areas ?? (major.length === 0 ? [] : [{ title: 'fake: what goes wrong for a caller', intro: 'fake: the findings of one area.', diagram: null, findings: major }]),
    findings,
    refuted: rest.refuted ?? refuted.map((id) => ({ id, claim: `fake: the claim of ${id}.`, why: `fake: why ${id} was refuted.` })),
  };
}

/** The scratch directory the prompt names, or null when it names none. */
function scratchOf(prompt: string): string | null {
  return /^Your scratch directory is (.+)\. Write temporary files there/m.exec(prompt)?.[1] ?? null;
}

/**
 * The step of a verifier whose task asks it to cite its runs and whose
 * script gives no answer: for each candidate, a probe written in its
 * scratch directory and run there, or run as a command when it has none,
 * and a PLAUSIBLE verdict that rests on that run and cites it.
 */
function citingVerifierStep(prompt: string): Pick<ScriptStep, 'output' | 'runs' | 'probes'> {
  const scratch = scratchOf(prompt);
  const indexes = Array.from({ length: numberedCount(prompt) }, (_, index) => index);
  const printed = (index: number): string => `fake probe for [${String(index)}] ran`;
  const probe = (index: number): string | null => (scratch === null ? null : join(scratch, `probe-${String(index)}.mjs`));
  const command = (index: number): string => `node ${probe(index) ?? `-e "console.log('${printed(index)}')"`}`;
  return {
    probes: scratch === null ? {} : Object.fromEntries(indexes.map((index) => [`probe-${String(index)}.mjs`, `console.log(${JSON.stringify(printed(index))});\n`])),
    runs: indexes.map((index) => ({ command: command(index), output: `${printed(index)}\n`, exitCode: 0 })),
    output: { verdicts: indexes.map((index) => ({ index, verdict: 'PLAUSIBLE', evidence: `fake evidence for [${String(index)}]`, basis: 'ran', runs: [{ command: command(index), printed: [printed(index)], probe: probe(index) }] })) },
  };
}

/**
 * The record an editing worker asked to cite the runs of its validation
 * leaves when its script names no runs: one test it ran, whose output its
 * validation cites (R7 of runs on the record).
 */
const fakeValidationRecord: readonly ShellRun[] = [{ command: 'node fake-test.mjs', output: 'fake test ran\nfake test passed\n', exitCode: 0 }];

/** What each validation entry such a worker gives cites when its script cites nothing: the test of its record, which the engine finds, and a run it never made, which the engine does not. */
const fakeValidationCites = [
  { command: 'node fake-test.mjs', printed: ['fake test passed'], probe: null },
  { command: 'node fake-test-never-run.mjs', printed: ['fake output never printed'], probe: null },
];

/**
 * An editing worker's answer as its task in a run with runs on the record
 * asks for it: each validation entry that names no `runs` cites the runs
 * of `fakeValidationRecord` when the worker's record is that one, and none
 * when its script gave the record, so a test that scripts the runs scripts
 * what they cite too.
 */
function citingValidation(output: unknown, record: 'default' | 'scripted'): unknown {
  if (typeof output !== 'object' || output === null || !Object.hasOwn(output, 'findings')) return output;
  const findings = (output as { readonly findings: readonly { readonly validation?: readonly object[] }[] }).findings;
  return { ...output, findings: findings.map((finding) => ({ ...finding, validation: (finding.validation ?? []).map((entry) => ('runs' in entry ? entry : { ...entry, runs: record === 'default' ? fakeValidationCites : [] })) })) };
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
  if (role === 'triage') return { candidates: [], leads: finderAngles.map((angle) => ({ angle, lead: null })), change: null };
  if (role.startsWith('finder-') || role === 'sweep') return { candidates: [] };
  if (role === 'deduplication') return { groups: [] };
  if (role === 'verifier') return { verdicts: Array.from({ length: numberedCount(prompt) }, (_, index) => ({ index, verdict: 'PLAUSIBLE', evidence: `fake evidence for [${String(index)}]` })) };
  if (role === 'merge-rank') return { findings: Array.from({ length: numberedCount(prompt) }, (_, index) => ({ primary: index, members: [], severity: 'minor', summary: `fake finding [${String(index)}]`, reason: 'fake reason' })) };
  if (role === 'decider') return deciderAnswer(Array.from({ length: numberedCount(prompt) }, () => ({})));
  if (role === 'fixer') return fixerAnswer(Array.from({ length: numberedCount(prompt) }, () => ({})));
  // The documentation worker finds every document already in line, so it edits nothing unless a script says it does.
  if (role === 'documentation') return fixerAnswer(Array.from({ length: numberedCount(prompt) }, () => ({ status: 'already-applied' as const })));
  if (role === 'writer') return writerAnswer(findingsToExplainOf(prompt));
  return { answer: 'ok' };
}

/** The ids of the findings the writer's task asks it to explain, none when it asks for none. */
export function findingsToExplainOf(prompt: string): string[] {
  return /^Explain these \d+ findings?, each by its id, .*?: (.+?)\.(?: Every other finding|$)/m.exec(prompt)?.[1]?.split(', ') ?? [];
}

/**
 * A writer's answer that passes the engine's checks: a conclusion with an
 * action for each finding of `ids`, an account, and each finding marked
 * unexplained with its reason, which cites no line, so the answer passes
 * whatever the tree holds; `explained` gives an explanation instead for a
 * finding it names.
 */
export function writerAnswer(ids: readonly string[], explained: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    conclusion: { why: 'fake: the pull request needs what its findings ask before a merge.', actions: ids.map((id) => ({ id, sentence: `fake: act on ${id} as decided.` })), diagram: null },
    account: { terms: [], problem: { text: 'fake: the problem before the change.', diagram: null }, change: { text: 'fake: what the change does.', diagram: null } },
    findings: ids.map((id) => (Object.hasOwn(explained, id) ? { id, explanation: explained[id], unexplained: null } : { id, explanation: null, unexplained: `fake: the evidence of ${id} names no line to cite.` })),
  };
}

/**
 * What a scripted decider decides of one finding: `fix` unless a kind is
 * given; a `leave` with its reason and, when superseded, the index of the
 * finding that supersedes it; an `ask` whose applied default edits the
 * code unless `edits` says it keeps it; and the step of the choice it
 * settles, which a leave as `settled` gives as `shape` unless told
 * otherwise, and no other decision gives unless told, for the candidates
 * `settledFor` names, none unless told.
 */
export interface DecidedFinding {
  readonly decision?: 'fix' | 'leave' | 'ask';
  readonly reason?: LeaveReason;
  readonly supersededBy?: number;
  readonly edits?: boolean;
  readonly departs?: boolean;
  readonly settledBy?: SettleStep | null;
  readonly settledFor?: readonly string[];
}

/** The settled choices a scripted decision gives: one by the step it names, or by `shape` for a leave as `settled`, which always gives one; none otherwise. */
function settledOf(finding: DecidedFinding, index: number): { for: readonly string[]; choice: string; by: SettleStep; source: string }[] {
  const by = finding.settledBy === undefined ? (finding.decision === 'leave' && finding.reason === 'settled' ? 'shape' : null) : finding.settledBy;
  return by === null ? [] : [{ for: finding.settledFor ?? [], choice: `fake choice settled for [${String(index)}]`, by, source: `fake source of the step for [${String(index)}]` }];
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
        settled: settledOf(finding, index),
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
  readonly body?: string;
  readonly note?: string;
  /**
   * A shape of `edits` the output schema refuses, as the fixer of #54
   * wrote it: a message with an empty `files`.
   */
  readonly malformed?: 'message-without-files';
}

/** A `drift` line of a scripted fixer: the document and the stale fact. */
export interface DriftLine {
  readonly file: string;
  readonly what: string;
}

/** A fixer's answer with one entry per finding, by index, in the shape its output schema demands, and the `drift` lines given, none by default. */
export function fixerAnswer(findings: readonly FixedFinding[], drift: readonly DriftLine[] = []): unknown {
  return {
    findings: findings.map((finding, index) => {
      const status = finding.status ?? 'applied';
      const files = [...(finding.files ?? [])];
      const message = { subject: finding.subject ?? `fix: Apply finding ${String(index)}`, body: finding.body ?? `Why finding ${String(index)} changed.` };
      return {
        index,
        status,
        file: files[0] ?? 'src/a.ts',
        line: 1,
        note: finding.note ?? `fake ${status} [${String(index)}]`,
        // A finding with files carries them and their message, whatever its status, and one with none carries null (R1 of fixer edits); `malformed` writes a shape the schema refuses instead.
        edits: finding.malformed === 'message-without-files' ? { files: [], message } : files.length > 0 ? { files, message } : null,
        corrections: [],
        validation: [{ method: 'existing', source: 'tests', evidence: 'fake evidence' }],
        requiredFiles: [...(finding.requiredFiles ?? [])],
      };
    }),
    drift: [...drift],
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

/** The claim command a fixer's prompt quotes: the engine's entry, the unit and the directory, with `<path>` for the file; a test's scratch holds no `'`, so both paths are single-quoted. */
function claimCommand(prompt: string): { entry: string; unit: string; into: string } {
  const match = /^ {4}node '([^']+)' claim --path '<path>' --unit (\S+) --in '([^']+)'$/m.exec(prompt);
  if (match === null) throw new Error('The prompt quotes no claim command');
  return { entry: match[1]!, unit: match[2]!, into: match[3]! };
}

/**
 * Run Node with `args` from the fake's working directory and environment,
 * as a fixer runs a command its prompt quotes, and give its exit code and
 * stderr. It does not block: a fake in the test's own process would
 * otherwise stop every other fake, and the engine, until it ended.
 */
function runNode(host: FakeHost, args: readonly string[]): Promise<{ readonly status: number | null; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], { cwd: host.cwd, env: host.environment, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (status) => {
      resolve({ status, stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

/** Claim one file as a fixer does, from its working directory, and throw when the outcome is not the one the script expects. */
async function claim(host: FakeHost, prompt: string, path: string, expected: ScriptEdit['expectClaim']): Promise<void> {
  const { entry, unit, into } = claimCommand(prompt);
  const result = await runNode(host, [entry, 'claim', '--path', path, '--unit', unit, '--in', into]);
  const outcome = result.status === 0 ? 'claimed' : result.status === 2 ? 'refused' : null;
  if (outcome === null || (expected !== undefined && outcome !== expected)) throw new Error(`The claim of ${path} by ${unit} exited ${String(result.status)}, not as the script expects (${expected ?? 'claimed or refused'}): ${result.stderr}`);
}

/** Make a scripted fixer's edits in its working directory, running the claim and snapshot commands its prompt quotes where a step asks. */
export async function applyEdits(host: FakeHost, edits: readonly ScriptEdit[], prompt: string): Promise<void> {
  for (const edit of edits) {
    if (edit.waitFor !== undefined) await waitForFile(host, edit.waitFor);
    for (const path of edit.claims ?? []) await claim(host, prompt, path, edit.expectClaim);
    for (const [path, content] of Object.entries(edit.writes ?? {})) {
      const file = join(host.cwd, ...path.split('/'));
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, content);
    }
    for (const path of edit.deletes ?? []) rmSync(join(host.cwd, ...path.split('/')), { force: true });
    if (edit.snapshot !== undefined) {
      const { entry, into } = snapshotCommand(prompt);
      const result = await runNode(host, [entry, 'snapshot', '--finding', String(edit.snapshot), '--into', into]);
      // The snapshot's own errors go where a fixer's would: its stderr.
      if (result.stderr !== '') await host.write('stderr', result.stderr);
      if (result.status !== 0) throw new Error(`The snapshot of finding ${String(edit.snapshot)} exited ${String(result.status)}`);
    }
  }
}

/**
 * The answer as the worker whose prompt this is gives it. The repair of a
 * run with the checks on the base answers in a schema that asks for
 * `comparisons`, which its task names, so an answer that names none there
 * compares nothing: a test scripts a repair answer as a fixer's and gives
 * `comparisons` only when it compares. Likewise a verifier of a run with
 * runs on the record gives each verdict a basis and its runs, so a
 * scripted verdict that names no basis is one that traced the lines and
 * cites no run; and a verifier of a run whose review reads as a report
 * gives each verdict its notes, so a scripted verdict that names none is
 * PLAUSIBLE for a fact not settled, or has no note, and leaves the author
 * no choice. A writer of such a run answers in its form
 * (`reportFormAnswer`), one of a run whose review opens with the core
 * of the change also gives the core and the conditions
 * (`coreFormAnswer`), and one of a run whose writer writes the review
 * answers in the fourth form (`writtenFormAnswer`).
 */
function answerFor(output: unknown, prompt: string): unknown {
  if (typeof output !== 'object' || output === null) return output;
  if (prompt.includes(citingWords) && Object.hasOwn(output, 'verdicts')) {
    const noted = (verdict: Record<string, unknown>): object => (!prompt.includes(notesWords) || 'unconfirmed' in verdict ? verdict : { ...verdict, unconfirmed: verdict.verdict === 'PLAUSIBLE' ? { kind: 'fact', text: 'fake: one condition is not settled here.' } : null, authorChoice: null });
    return { ...output, verdicts: (output as { readonly verdicts: readonly Record<string, unknown>[] }).verdicts.map((verdict) => noted('basis' in verdict ? verdict : { ...verdict, basis: 'traced', runs: [] })) };
  }
  if (prompt.includes(writtenFormWords) && Object.hasOwn(output, 'findings') && Object.hasOwn(output, 'conclusion')) return writtenFormAnswer(output as Record<string, unknown>, prompt);
  if (prompt.includes(coreFormWords) && Object.hasOwn(output, 'findings') && Object.hasOwn(output, 'conclusion')) return coreFormAnswer(output as Record<string, unknown>, prompt);
  if (prompt.includes(reportFormWords) && Object.hasOwn(output, 'findings') && Object.hasOwn(output, 'conclusion')) return reportFormAnswer(output as Record<string, unknown>, prompt);
  if (!prompt.includes('Return `comparisons`') || Object.hasOwn(output, 'comparisons')) return output;
  return { ...output, comparisons: [] };
}

/**
 * The scripted step for the review worker whose prompt this is, from the
 * FAKE_SCRIPT file, with the role's empty answer as the step when the
 * script names none; null when the fake is not scripted or the prompt is
 * not a review worker's.
 */
export function scriptedStep(host: FakeHost, prompt: string): { readonly role: string; readonly unit: string; readonly step: ScriptStep & { readonly output: unknown } } | null {
  const file = host.environment.FAKE_SCRIPT;
  if (file === undefined) return null;
  const header = readTaskHeader(prompt);
  if (header === null) return null;
  const script = JSON.parse(readFileSync(file, 'utf8')) as Script;
  const key = [`${header.role}:${header.phase}:${header.unitKey}`, `${header.role}:${header.unitKey}`, header.role, '*'].find((candidate) => Object.hasOwn(script, candidate));
  const entry = key === undefined ? {} : script[key]!;
  const step = Array.isArray(entry) ? (entry[Math.min(nextAttempt(file, `${header.role}:${header.phase}:${header.unitKey}`, host.id), entry.length - 1)] ?? {}) : (entry as ScriptStep);
  // A verifier asked to cite its runs and scripted no answer runs a probe per candidate and cites it, so every run that cites runs crosses the lookup.
  const defaults = step.output === undefined && header.role === 'verifier' && prompt.includes(citingWords) ? citingVerifierStep(prompt) : { output: defaultOutput(header.role, prompt) };
  const output = answerFor(step.output ?? defaults.output, prompt);
  // An editing worker asked to cite the runs of its validation runs a test and cites it, with a run it never made, so every run that cites runs crosses both outcomes of the lookup.
  if (!prompt.includes(citingValidationWords)) return { role: header.role, unit: header.unitKey, step: { ...defaults, ...step, output } };
  return { role: header.role, unit: header.unitKey, step: { ...defaults, ...step, runs: step.runs ?? fakeValidationRecord, output: citingValidation(output, step.runs === undefined ? 'default' : 'scripted') } };
}

/** The thread id fake-codex.ts reports for a fresh worker, unless FAKE_THREAD names another. */
export const freshThread = '0199a3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b';

/** Write what the fake was given, for the test to assert on: each invocation in turn, or only a worker of FAKE_RECORD_ROLE when it is set. */
export function record(host: FakeHost, stdin: string): void {
  const file = host.environment.FAKE_RECORD;
  if (file === undefined) return;
  const role = host.environment.FAKE_RECORD_ROLE;
  if (role !== undefined && readTaskHeader(stdin)?.role !== role) return;
  const pinned = ['TEMP', 'TMP', 'TMPDIR', 'MSBUILDDISABLENODEREUSE', 'DOTNET_CLI_USE_MSBUILD_SERVER', 'UseSharedCompilation', 'UseRazorBuildServer', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'Path', 'PATH', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
  const seen = Object.fromEntries(Object.entries(host.environment).filter(([name]) => pinned.some((pin) => pin.toUpperCase() === name.toUpperCase())));
  writeWhole(file, JSON.stringify({ argv: host.args, stdin, cwd: host.cwd, environment: seen }), host.id);
}

/** Wait until the marker file exists: FAKE_WAIT_FOR by default, nothing to wait for when it is unset. */
export async function waitForMarker(host: FakeHost, marker: string | undefined = host.environment.FAKE_WAIT_FOR): Promise<void> {
  if (marker === undefined) return;
  await waitForFile(host, marker);
}

/**
 * Do what a scripted step asks before the answer is printed: edit the
 * tree, write its probes, hold where FAKE_HOLD names this start, wait,
 * hang, or print stderr. Returns the exit code the step asks for.
 */
export async function beginScriptedStep(host: FakeHost, step: ScriptStep, prompt: string): Promise<number> {
  await applyEdits(host, step.edits ?? [], prompt);
  const probes = Object.entries(step.probes ?? {});
  const scratch = scratchOf(prompt);
  if (probes.length > 0 && scratch === null) throw new Error('A scripted step writes probes, but the prompt names no scratch directory');
  for (const [name, content] of probes) writeFileSync(join(scratch!, name), content);
  const header = readTaskHeader(prompt);
  if (header !== null) await holdIfNamed(host, `${header.role} ${header.phase}:${header.unitKey}`);
  await waitForMarker(host, step.waitFor);
  if (step.hang === true) await host.hang();
  if (step.stderr !== undefined) await host.write('stderr', step.stderr);
  return step.exit ?? 0;
}

/** Start a grandchild that never exits, write its pid, and never end either (see FakeHost.startGrandchild). */
export function hangWithGrandchild(host: FakeHost, pidFile: string): Promise<never> {
  const grandchild = host.startGrandchild('setInterval(() => {}, 1000)');
  writeWhole(pidFile, String(grandchild), host.id);
  return host.hang();
}

/**
 * Whether a fake runtime may start a grandchild under `environment`:
 * FAKE_HANG, under which it hangs with one (hangWithGrandchild), or
 * FAKE_START_DIR, under which a worker FAKE_HOLD names holds with one
 * (holdIfNamed in fake-host.ts). Only a fake in a process of its own has
 * a tree for the engine to kill (see FakeHost.startGrandchild).
 */
export function runtimeStartsGrandchild(environment: NodeJS.ProcessEnv): boolean {
  return environment.FAKE_HANG !== undefined || environment.FAKE_START_DIR !== undefined;
}

/** The value after `flag` in argv, or undefined. */
export function option(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

/**
 * Do what the environment asks after the fake has received its input:
 * hang, print a huge stream, or print the scripted or default answer;
 * returns the exit code FAKE_EXIT asks for.
 */
export async function answer(host: FakeHost, defaultStdout: () => string, session: string): Promise<number> {
  const environment = host.environment;
  await waitForMarker(host);
  if (environment.FAKE_HANG !== undefined) return hangWithGrandchild(host, environment.FAKE_HANG);
  if (environment.FAKE_STDERR !== undefined) await host.write('stderr', environment.FAKE_STDERR);
  const huge = environment.FAKE_HUGE === undefined ? null : Number(environment.FAKE_HUGE);
  const hugeStream = environment.FAKE_HUGE_STREAM === 'stderr' ? 'stderr' : 'stdout';
  const stdout = environment.FAKE_STDOUT ?? (huge !== null && hugeStream === 'stdout' ? '' : defaultStdout());
  await host.write('stdout', stdout.replaceAll('{session}', session));
  if (huge !== null) {
    const chunk = Buffer.alloc(1024 * 1024, 'x');
    for (let left = huge; left > 0; left -= chunk.length) await host.write(hugeStream, chunk.subarray(0, Math.min(left, chunk.length)));
  }
  return Number(environment.FAKE_EXIT ?? '0');
}
