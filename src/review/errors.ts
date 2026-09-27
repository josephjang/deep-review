import { EngineError } from '../errors.ts';

/** The role policy cannot be read, fails its schema, disagrees with the manifest or the runtime, or a flag that changes it is malformed. */
export class InvalidPolicyError extends EngineError {
  override readonly name = 'InvalidPolicyError';
}

/**
 * A worker's answer passed its output schema but not the structural checks
 * the schema cannot express (R4 of the read-only review): a lead missing
 * for an angle, an index outside the numbered input, an index in two
 * groups, a verdict twice or missing. Treated exactly like a schema
 * rejection: the attempt failed, with this message as the reason.
 */
export class StructuralCheckError extends EngineError {
  override readonly name = 'StructuralCheckError';
}

/** The review cannot start or continue for a reason the operator must act on before anything is recorded: a held lock, an unqualified runtime, two active runs, an active run pinned to another runtime or started in another worktree. The command exits 2 with it. */
export class ReviewRefusedError extends EngineError {
  override readonly name = 'ReviewRefusedError';
  /** The blocker code the refusal prints, when it has one. */
  readonly code: string | null;
  constructor(message: string, code: string | null = null) {
    super(message);
    this.code = code;
  }
}
