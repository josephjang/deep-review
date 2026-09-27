import { EngineError } from '../errors.ts';

/**
 * The manifest cannot be read, is not JSON, gives a key twice in one object
 * or fails its schema; or, as the assembly compares it with fragments/
 * before reading any fragment, fragments/ cannot be listed or is a link, a
 * fragment some role names is not in fragments/, or a visible entry under
 * fragments/ is one no role names.
 */
export class InvalidRoleManifestError extends EngineError {
  override readonly name = 'InvalidRoleManifestError';
}

/**
 * A fragment is asked for by a name that is not a fragment name, cannot be
 * read, or breaks an invariant the assembly relies on: not a regular file,
 * in a fragments/ that is a link, not UTF-8 text, a byte order mark, empty,
 * a stray CR, a control character other than tab and LF, a line or
 * paragraph separator, no final newline, a blank line at either edge, front
 * matter, an include marker. A fragment read on its own is also refused
 * when it is missing; the assembly refuses a missing fragment earlier, as a
 * manifest error, before it reads any.
 */
export class InvalidRoleFragmentError extends EngineError {
  override readonly name = 'InvalidRoleFragmentError';
  readonly fragment: string;
  constructor(fragment: string, reason: string) {
    super(`Role fragment ${fragment} ${reason}`);
    this.fragment = fragment;
  }
}
