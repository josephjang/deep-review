import type { DeniedTool, Effort } from '../checkpoint/events.ts';
import type { CompiledSchema, Invocation } from './contract.ts';

/**
 * What a runtime can and cannot do, declared once per adapter (TD4). The
 * launcher refuses an invocation that needs a missing capability before
 * anything runs, and the receipt states a missing kind of evidence as
 * `null` instead of approximating it.
 */
export interface Capabilities {
  /** The engine chooses the session id before launch, so the ledger names the transcript before the process exists. */
  readonly assignsSessionId: boolean;
  /** The runtime stops the worker at a spending limit it is given. */
  readonly budgetCap: boolean;
  /** The runtime reports every tool call it refused. */
  readonly denialEvidence: boolean;
  /** A worker can be run without a shell. */
  readonly withholdShell: boolean;
  /** A read-only worker can still be allowed to write into its scratch directory. */
  readonly readOnlyScratch: boolean;
  /** The effort levels the runtime has. */
  readonly effortLevels: readonly Effort[];
  /** A recorded session can be continued with a follow-up message. */
  readonly resume: boolean;
  /**
   * The runtime reports what a worker cost in US dollars, so `summarizeUsage`
   * can give a `costUsd`. A capability rather than an inference from one
   * worker's summary (TD10 of the read-only review): a worker that failed
   * before reporting anything has a null cost on any runtime, and that
   * says nothing about what the runtime can report.
   */
  readonly costInUsd: boolean;
}

/**
 * Usage in runtime-neutral terms, read from the usage a runtime reported
 * (R6 of the read-only review). Each number is null when the runtime does
 * not report it, or reported it as something other than a finite number;
 * a summary never throws. `inputTokens` counts every input token, cached
 * ones included, so two runtimes' inputs compare like for like.
 */
export interface UsageSummary {
  readonly costUsd: number | null;
  /** Every input token, including those read from and written to a cache. */
  readonly inputTokens: number | null;
  /** The input tokens read from a cache, which `inputTokens` also counts. */
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
}

/** A summary that says nothing, for a usage that was never reported or cannot be read. */
export const emptyUsageSummary: UsageSummary = { costUsd: null, inputTokens: null, cachedInputTokens: null, outputTokens: null };

/** One help text to read and the flags it must mention. */
export interface HelpProbe {
  /** Arguments after the executable's own, such as `['exec', '--help']`. */
  readonly args: readonly string[];
  readonly flags: readonly string[];
}

/**
 * How an executable is qualified without a model call (R4, TD9): its
 * version output must match `pattern`, whose first group is the version
 * recorded, and each help text must mention every flag the adapter uses.
 */
export interface Qualification {
  readonly version: { readonly args: readonly string[]; readonly pattern: RegExp };
  readonly help: readonly HelpProbe[];
}

/** What the launcher decided for one worker, handed to the adapter to build its command and read its answer. */
export interface LaunchPlan {
  /** The id the session runs under when it is known before launch: pinned for a fresh worker, or the one being continued. */
  readonly sessionId: string | null;
  /** The session being continued, or null for a fresh worker. */
  readonly resume: string | null;
  /** Absolute scratch directory the runtime must allow writes to, or null when the worker has none. */
  readonly scratch: string | null;
  readonly schema: CompiledSchema;
  /** Absolute path of a file holding `schema.text`, for a runtime that reads its schema from a file. */
  readonly schemaFile: string;
  /** Absolute path a runtime may write its final answer to, for a runtime that separates it from its event stream. */
  readonly finalMessageFile: string;
  readonly platform: NodeJS.Platform;
  /** The caller's environment, which the adapter adjusts for its runtime. */
  readonly environment: NodeJS.ProcessEnv;
  /**
   * The run's pinned options for this runtime, its entry of
   * `PinnedRuntimeOptions`, applied over the adapter's own for this launch
   * only; null or absent when the run pins none. Untyped here because each
   * runtime's shape is its own: an adapter a run can pin options for
   * validates its entry and refuses one it does not understand, rather than
   * run its worker otherwise than the ledger says; one with nothing to pin,
   * such as Claude Code's, ignores it.
   */
  readonly runtimeOptions?: unknown;
}

/** The runtime's part of a command line: what follows the executable and its literal arguments, and the environment. */
export interface WorkerCommand {
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

/**
 * The most bytes of stderr, of a final message, or of stdout read whole, that
 * the launcher decodes as one text; above it the output is not decoded, but
 * it is still frozen as evidence. stdout read a line at a time has no such
 * limit; only each of its lines does, `maxLineBytes`.
 */
export const maxDecodeBytes = 16 * 1024 * 1024;

/**
 * The most bytes of one stdout line decoded as text. Above `maxDecodeBytes`,
 * because a single Codex event can carry all a command printed; bounded,
 * because a line is held as a string and then parsed, and a string has a
 * size limit of its own.
 */
export const maxLineBytes = 64 * 1024 * 1024;

/**
 * The lines of `bytes`, decoded as UTF-8 one at a time while they are
 * iterated, and again on every iteration, so no more than one line is held
 * as text at once. A line ends at a line feed, which is not part of it; the
 * bytes after the last line feed are one more line when there are any; and
 * a carriage return that ends a line is dropped too. A line longer than
 * `maxBytes` bytes, not counting what is dropped, is null, never decoded.
 */
export function outputLines(bytes: Buffer, maxBytes: number = maxLineBytes): Iterable<string | null> {
  return {
    *[Symbol.iterator]() {
      for (let start = 0; start < bytes.length; ) {
        const newline = bytes.indexOf(0x0a, start);
        const end = newline === -1 ? bytes.length : newline;
        const stop = end > start && bytes[end - 1] === 0x0d ? end - 1 : end;
        yield stop - start > maxBytes ? null : bytes.toString('utf8', start, stop);
        start = end + 1;
      }
    },
  };
}

/** What a finished worker left behind, as text. */
export interface WorkerOutputs {
  /** All of stdout as one text, or null when it is longer than `maxDecodeBytes`, which `stdoutLines` still reads. */
  readonly stdout: string | null;
  /** stdout a line at a time, as `outputLines` gives it: re-iterable, and a line longer than `maxLineBytes` is null. */
  readonly stdoutLines: Iterable<string | null>;
  readonly stderr: string;
  /** The file at `finalMessageFile`, or null when the runtime did not write it. */
  readonly finalMessage: string | null;
}

/**
 * How a worker's outputs end, as the adapter reads them; exactly one of
 * three, so a decoder cannot report an answer and an error at once.
 */
export type DecodedResult =
  /** The structured answer, not yet checked against the schema. */
  | { readonly kind: 'answer'; readonly value: unknown }
  /** The runtime stopped at the budget it was given, and why it says so. */
  | { readonly kind: 'budget'; readonly error: string }
  /** Why the outputs are not a successful answer. */
  | { readonly kind: 'failed'; readonly error: string };

/** What an adapter read from a worker's outputs, before the launcher validates the answer and decides the outcome. */
export interface Decoded {
  /**
   * Every session id the outputs name, in the order they name them. The
   * launcher adds the pinned or continued id itself, so a worker that never
   * answered still names its transcript; an adapter reports only what it read.
   */
  readonly sessionIds: readonly string[];
  /** Usage as the runtime reported it, or null. Any JSON value. */
  readonly usage: unknown;
  /** Refused tool calls, or null when the runtime gives no evidence either way. */
  readonly denials: readonly DeniedTool[] | null;
  readonly result: DecodedResult;
}

/**
 * One runtime behind the runtime-neutral contract (TD1): a command builder
 * and a decoder that never touch a process, a capability table and a
 * qualification recipe. The launcher owns spawning, timeouts, evidence and
 * the ledger for every runtime alike.
 */
export interface RuntimeAdapter {
  /** The registered name; lowercase words joined by dashes. */
  readonly name: string;
  readonly capabilities: Capabilities;
  readonly qualification: Qualification;
  /** Translate an invocation the launcher already checked against the capabilities. May refuse the caller's environment. */
  command(invocation: Invocation, plan: LaunchPlan): WorkerCommand;
  /** Read the worker's outputs. Never throws for a malformed answer; that is a `failed` result. */
  decode(invocation: Invocation, plan: LaunchPlan, outputs: WorkerOutputs): Decoded;
  /**
   * The runtime-neutral view of usage `decode` reported, or of the same
   * usage parsed back from a finish's `usage` text, so a live receipt and a
   * replayed ledger read alike. Pure, and never throws: a shape it does not
   * know gives nulls.
   */
  summarizeUsage(usage: unknown): UsageSummary;
}
