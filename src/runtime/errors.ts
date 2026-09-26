import { CheckpointError } from '../checkpoint/errors.ts';

/** The invocation is malformed or contradicts the run it names: a bad field, a scratch directory inside the reviewed tree, a session that cannot be continued. */
export class InvalidInvocationError extends CheckpointError {
  override readonly name = 'InvalidInvocationError';
}

/** No adapter is registered under the runtime name the invocation gives. */
export class UnknownRuntimeError extends CheckpointError {
  override readonly name = 'UnknownRuntimeError';
  readonly runtime: string;
  constructor(runtime: string, known: readonly string[]) {
    super(`Unknown runtime ${runtime}; registered: ${known.length === 0 ? 'none' : known.join(', ')}`);
    this.runtime = runtime;
  }
}

/** The invocation needs something the runtime cannot do; it is refused before anything runs rather than approximated (TD4). */
export class UnsupportedCapabilityError extends CheckpointError {
  override readonly name = 'UnsupportedCapabilityError';
  readonly runtime: string;
  /** The key of the missing capability in the adapter's capability table. */
  readonly capability: string;
  constructor(runtime: string, capability: string, action: string) {
    super(`Runtime ${runtime} cannot ${action} (capability ${capability})`);
    this.runtime = runtime;
    this.capability = capability;
  }
}

/** The caller's environment sets a variable that would override the pinned policy of the worker (R8). */
export class InheritedOverrideError extends CheckpointError {
  override readonly name = 'InheritedOverrideError';
  readonly variable: string;
  constructor(variable: string, reason: string) {
    super(`Inherited environment variable ${variable} ${reason}; unset it before launching a worker`);
    this.variable = variable;
  }
}

/** The executable did not qualify: it did not run, its version output is not the runtime's, or its help lacks a flag the adapter uses (R4). */
export class PreflightError extends CheckpointError {
  override readonly name = 'PreflightError';
}
