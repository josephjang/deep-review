import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256Hex } from '../evidence/store.ts';
import { InvalidRoleFragmentError, InvalidRoleManifestError } from './errors.ts';
import { fragmentNameSchema, parseRoleManifest, type RoleManifest } from './manifest.ts';

/** The manifest's file name under the roles root. */
export const manifestFileName = 'manifest.json';
/** The directory under the roles root that holds every fragment. */
export const fragmentsDirectoryName = 'fragments';

/** One fragment as a role uses it: its file name and the SHA-256 of its bytes. */
export interface RoleFragment {
  readonly name: string;
  readonly sha256: string;
}

/** One role's prompt, assembled from its fragments in manifest order. */
export interface AssembledRole {
  readonly key: string;
  readonly fragments: readonly RoleFragment[];
  /** The fragments' text joined with one blank line between each pair. */
  readonly prompt: string;
  /** SHA-256 of the prompt's UTF-8 bytes: what a run pins a role's text by. */
  readonly sha256: string;
}

/** The `roles/` directory of this checkout, resolved relative to this source file as `engineVersion` resolves package.json. */
export function repositoryRolesRoot(): string {
  return resolve(import.meta.dirname, '..', '..', 'roles');
}

/**
 * The first key that `text`, already known to be JSON, gives twice in one
 * object, or undefined. JSON.parse keeps the last of two equal keys without
 * a word and a reviver sees only that one, so the text itself is scanned: a
 * string followed by a colon is a key, compared by its decoded value so an
 * escape cannot hide a repeat.
 */
function repeatedJsonKey(text: string): string | undefined {
  // The keys seen in each object still open, innermost last; an open array holds null.
  const open: (Set<string> | null)[] = [];
  // JSON allows only space, tab, LF and CR between a key and its colon.
  const colon = /[ \t\n\r]*:/y;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') open.push(new Set());
    else if (char === '[') open.push(null);
    else if (char === '}' || char === ']') open.pop();
    else if (char === '"') {
      // Step over the string; a backslash escapes the character after it.
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const token = text.slice(index, end + 1);
      index = end;
      colon.lastIndex = end + 1;
      if (!colon.test(text)) continue;
      const key = JSON.parse(token) as string;
      const keys = open.at(-1);
      if (keys?.has(key)) return key;
      keys?.add(key);
    }
  }
  return undefined;
}

/** Read and validate `<rolesRoot>/manifest.json`, refusing a key given twice in one object. */
export function readRoleManifest(rolesRoot: string): RoleManifest {
  const path = join(rolesRoot, manifestFileName);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new InvalidRoleManifestError(`Cannot read the role manifest at ${path}: ${(error as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new InvalidRoleManifestError(`The role manifest at ${path} is not JSON: ${(error as Error).message}`);
  }
  const repeated = repeatedJsonKey(text);
  if (repeated !== undefined) {
    throw new InvalidRoleManifestError(`The role manifest at ${path} gives the key ${JSON.stringify(repeated)} twice in one object, and JSON keeps only the last`);
  }
  return parseRoleManifest(value);
}

/** Strict UTF-8: a byte sequence that is not UTF-8 throws instead of becoming U+FFFD. The BOM is kept so it can be refused by name. */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * A character no fragment may hold: a control character other than tab and
 * line feed (a carriage return is refused before this, by name), a line or
 * paragraph separator, which breaks a line as LF does, and U+FEFF after the
 * start, a byte order mark out of place. None shows as itself where a reader
 * looks at the text (an escape sequence can even hide the text around it),
 * so each could reach a worker unnoticed.
 */
const forbiddenCharacter = /(?![\t\n])\p{Cc}|[\u2028\u2029\uFEFF]/u;

/**
 * An include marker as the proof of concept wrote one, `<!-- include: path -->`
 * at a line start, however it is indented, spaced or cased. A marker within a
 * line is prose about markers and is not matched.
 */
const includeMarker = /^[^\S\n]*<!--\s*include\s*:/im;

/** One fragment as read: its name and the hash of the bytes read, and its text. */
interface LoadedFragment {
  readonly fragment: RoleFragment;
  readonly text: string;
}

/**
 * Read one fragment by its name, which must be a fragment name (R4) so it
 * cannot leave `fragments/`, and refuse it unless it is a regular file, in
 * a `fragments/` that is not a link, of UTF-8 text that
 * `refuseMalformedFragmentText` accepts (R3). Each
 * violation is refused naming the fragment, so a stray CRLF or a stale
 * marker never reaches a worker. Returns the fragment's text.
 */
export function readRoleFragment(rolesRoot: string, name: string): string {
  return loadRoleFragment(rolesRoot, name).text;
}

/** Read and check one fragment as `readRoleFragment` does, and hash the bytes it read. */
function loadRoleFragment(rolesRoot: string, name: string): LoadedFragment {
  // The name is checked here as well as in the manifest, so no caller can reach outside fragments/ with a directory part.
  const named = fragmentNameSchema.safeParse(name);
  if (!named.success) throw new InvalidRoleFragmentError(name, `is not a valid fragment name: ${named.error.issues.map((issue) => issue.message).join('; ')}`);
  const directory = join(rolesRoot, fragmentsDirectoryName);
  const path = join(directory, name);
  // Only ENOENT means the fragment is missing; any other failure (EACCES, ENOTDIR, ELOOP) is reported as it is.
  // assembleRoles refuses a missing fragment before this, when it compares the manifest with fragments/, so "does not
  // exist" comes from a fragment read on its own, or one removed between that comparison and the read.
  const examine = <T>(inspect: () => T): T => {
    try {
      return inspect();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new InvalidRoleFragmentError(name, 'does not exist');
      throw new InvalidRoleFragmentError(name, `cannot be read: ${(error as Error).message}`);
    }
  };
  // fragments/ is examined as well as the file, since text read through a link in either place is not the roles directory's own.
  // The roles directory itself may be reached through a link, as a checkout or a temporary directory may be.
  if (examine(() => lstatSync(directory).isSymbolicLink())) {
    throw new InvalidRoleFragmentError(name, `is in a ${fragmentsDirectoryName}/ that is a link; fragments live in the roles directory itself`);
  }
  if (!examine(() => lstatSync(path).isFile())) throw new InvalidRoleFragmentError(name, 'is not a regular file');
  // Reading and decoding fail for different reasons, so each is caught on its own.
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new InvalidRoleFragmentError(name, `cannot be read: ${(error as Error).message}`);
  }
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new InvalidRoleFragmentError(name, 'is not UTF-8');
  }
  refuseMalformedFragmentText(name, text);
  return { fragment: { name, sha256: sha256Hex(bytes) }, text };
}

/**
 * Hold a fragment's decoded text to the invariants the assembly relies on
 * (R3): no byte order mark, not empty, LF line endings, no control
 * character but tab and line feed and no line or paragraph separator,
 * ending in exactly one newline and starting with text, with no blank or
 * whitespace-only line at either edge, carrying no front matter and no
 * include marker. Each violation is refused naming the fragment. It takes
 * text, not a path, so the rules hold whatever the text was read from.
 */
export function refuseMalformedFragmentText(name: string, text: string): void {
  if (text.startsWith('\uFEFF')) throw new InvalidRoleFragmentError(name, 'starts with a byte order mark');
  if (text.length === 0) throw new InvalidRoleFragmentError(name, 'is empty');
  if (text.includes('\r')) throw new InvalidRoleFragmentError(name, 'contains a carriage return; fragments are LF text');
  const forbidden = forbiddenCharacter.exec(text);
  if (forbidden !== null) {
    // Every character the pattern matches is one UTF-16 code unit, so its first code unit is its code point.
    const codePoint = forbidden[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
    const line = text.slice(0, forbidden.index).split('\n').length;
    throw new InvalidRoleFragmentError(name, `contains U+${codePoint} on line ${line}; fragments are plain LF text`);
  }
  if (!text.endsWith('\n')) throw new InvalidRoleFragmentError(name, 'does not end with a newline');
  // A line of only whitespace (spaces, tabs) reads as blank, so it counts as one at either edge.
  if (/\n[^\S\n]*\n$/.test(text)) throw new InvalidRoleFragmentError(name, 'ends with a blank line; the assembly separates fragments itself');
  if (/^[^\S\n]*\n/.test(text)) throw new InvalidRoleFragmentError(name, 'starts with a blank line');
  if (text.startsWith('---\n')) throw new InvalidRoleFragmentError(name, 'starts with front matter; a fragment is prompt text only');
  if (includeMarker.test(text)) throw new InvalidRoleFragmentError(name, 'contains an include marker; composition is declared in the manifest only');
}

/**
 * Compare the fragments the manifest names with the entries `fragments/`
 * holds, before any fragment is read, and refuse any difference: a fragment
 * some role names that is not there, and an entry no role names. Both are
 * reported together in one error, so a renamed fragment shows its old and
 * new names at once, and a name that differs only by case is reported the
 * same way on a file system that ignores case as on one that does not.
 * `fragments/` itself must be a directory that is not a link.
 */
function reconcileFragments(rolesRoot: string, manifest: RoleManifest): void {
  const fragmentsDirectory = join(rolesRoot, fragmentsDirectoryName);
  // A missing fragments/, one that is a file, or one that cannot be read all fail here, before any fragment is.
  const list = <T>(inspect: () => T): T => {
    try {
      return inspect();
    } catch (error) {
      throw new InvalidRoleManifestError(`Cannot list ${fragmentsDirectory}: ${(error as Error).message}`);
    }
  };
  // Checked before listing, since a listing follows a link; a link whose target is gone is refused as a link, not as missing.
  if (list(() => lstatSync(fragmentsDirectory).isSymbolicLink())) {
    throw new InvalidRoleManifestError(`The fragments directory ${fragmentsDirectory} is a link; fragments live in the roles directory itself`);
  }
  const entries = list(() => readdirSync(fragmentsDirectory));
  const named = new Set(Object.values(manifest.roles).flat());
  const present = new Set(entries);
  const missing = [...named].filter((name) => !present.has(name)).sort();
  const stray = entries.filter((entry) => !named.has(entry)).sort();
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`Fragments that roles name but ${fragmentsDirectoryName}/ does not hold: ${missing.join(', ')}`);
  if (stray.length > 0) problems.push(`Entries under ${fragmentsDirectoryName}/ that no role names: ${stray.join(', ')}`);
  if (problems.length > 0) throw new InvalidRoleManifestError(problems.join('; '));
}

/**
 * Assemble every role under `rolesRoot` (R2): the manifest names the
 * roles and their fragments, each fragment is read once, and a role's
 * prompt is its fragments joined with one blank line. Before any fragment
 * is read, the manifest and `fragments/` must agree exactly: every
 * fragment a role names is there, and every entry there is named by some
 * role, so a fragment cannot fall out of use unnoticed and a stray file
 * cannot be mistaken for one.
 */
export function assembleRoles(rolesRoot: string): readonly AssembledRole[] {
  const manifest = readRoleManifest(rolesRoot);
  reconcileFragments(rolesRoot, manifest);
  // Each fragment is read and hashed once, however many roles name it.
  const loaded = new Map<string, LoadedFragment>();
  const load = (name: string): LoadedFragment => {
    let fragment = loaded.get(name);
    if (fragment === undefined) {
      fragment = loadRoleFragment(rolesRoot, name);
      loaded.set(name, fragment);
    }
    return fragment;
  };
  return Object.entries(manifest.roles).map(([key, names]): AssembledRole => {
    const parts = names.map(load);
    const prompt = parts.map((part) => part.text).join('\n');
    return { key, fragments: parts.map((part) => part.fragment), prompt, sha256: sha256Hex(Buffer.from(prompt, 'utf8')) };
  });
}
