import { EngineError } from '../errors.ts';

/** The manifest is missing or malformed, names a fragment that does not exist, or leaves a file under fragments/ that no role names. */
export class InvalidRoleManifestError extends EngineError {
  override readonly name = 'InvalidRoleManifestError';
}

/** A fragment breaks an invariant the assembly relies on: not a regular file, not UTF-8 text, a stray CR, no final newline, an include marker. */
export class InvalidRoleFragmentError extends EngineError {
  override readonly name = 'InvalidRoleFragmentError';
  readonly fragment: string;
  constructor(fragment: string, reason: string) {
    super(`Role fragment ${fragment} ${reason}`);
    this.fragment = fragment;
  }
}
