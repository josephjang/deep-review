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
}

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
}

/** The runtime's part of a command line: what follows the executable and its literal arguments, and the environment. */
export interface WorkerCommand {
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

/** What a finished worker left behind, as text. */
export interface WorkerOutputs {
  readonly stdout: string;
  readonly stderr: string;
  /** The file at `finalMessageFile`, or null when the runtime did not write it. */
  readonly finalMessage: string | null;
}

/** What an adapter read from a worker's outputs, before the launcher validates the answer and decides the outcome. */
export interface Decoded {
  /** Every session the worker ran under; includes a pinned or continued id even when the runtime never answered. */
  readonly sessionIds: readonly string[];
  /** Usage as the runtime reported it, or null. Any JSON value. */
  readonly usage: unknown;
  /** Refused tool calls, or null when the runtime gives no evidence either way. */
  readonly denials: readonly DeniedTool[] | null;
  /** The structured answer, not yet checked against the schema, or null when there is none. */
  readonly answer: { readonly value: unknown } | null;
  /** The runtime stopped at the budget it was given. */
  readonly budgetStop: boolean;
  /** Why the outputs are not a successful answer, or null. */
  readonly error: string | null;
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
  /** Read the worker's outputs. Never throws for a malformed answer; that is `error`. */
  decode(invocation: Invocation, plan: LaunchPlan, outputs: WorkerOutputs): Decoded;
}
