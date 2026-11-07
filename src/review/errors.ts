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

/** What a failed attempt records before the message of the structural check that refused its answer, so a later attempt can tell such a failure from any other. */
export const structuralCheckPrefix = 'structural check: ';

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

/**
 * A publication the command leaves open (R13 of the review on the pull
 * request): a post whose outcome is unknown, after a timeout, an answer of
 * 5xx or one the engine cannot read, or a settle whose read of GitHub
 * failed. Nothing more is recorded, and the next `publish` looks for the
 * review by its marker before it posts. The command exits 1 with it.
 */
export class PublicationOpenError extends EngineError {
  override readonly name = 'PublicationOpenError';
}
