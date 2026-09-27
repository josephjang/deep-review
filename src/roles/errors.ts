import { EngineError } from '../errors.ts';

/** The manifest cannot be read, is not JSON or fails its schema, the fragments/ directory cannot be listed, or an entry under fragments/ is one no role names. */
export class InvalidRoleManifestError extends EngineError {
  override readonly name = 'InvalidRoleManifestError';
}

/**
 * A fragment is asked for by a name that is not a fragment name, or is
 * missing, cannot be read, or breaks an invariant the assembly relies on:
 * not a regular file, in a fragments/ that is a link, not UTF-8 text, a byte order mark, empty, a stray CR,
 * a control character other than tab and LF, a line or paragraph
 * separator, no final newline, a blank line at either edge, front matter,
 * an include marker.
 */
export class InvalidRoleFragmentError extends EngineError {
  override readonly name = 'InvalidRoleFragmentError';
  readonly fragment: string;
  constructor(fragment: string, reason: string) {
    super(`Role fragment ${fragment} ${reason}`);
    this.fragment = fragment;
  }
}
