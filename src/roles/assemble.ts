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

/** Read and validate `<rolesRoot>/manifest.json`. */
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
  return parseRoleManifest(value);
}

/** Strict UTF-8: a byte sequence that is not UTF-8 throws instead of becoming U+FFFD. The BOM is kept so it can be refused by name. */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** One fragment as read: its name and the hash of the bytes read, and its text. */
interface LoadedFragment {
  readonly fragment: RoleFragment;
  readonly text: string;
}

/**
 * Read one fragment by its name, which must be a fragment name (R4) so it
 * cannot leave `fragments/`, and hold it to the invariants the assembly
 * relies on (R3): a regular file of UTF-8 text without a byte order mark,
 * LF line endings, no NUL, not empty, ending in exactly one newline and
 * starting with text, with no blank or whitespace-only line at either
 * edge, carrying no front matter and no include marker. Each violation is
 * refused naming the fragment, so a stray CRLF or a stale marker never
 * reaches a worker. Returns the fragment's text.
 */
export function readRoleFragment(rolesRoot: string, name: string): string {
  return loadRoleFragment(rolesRoot, name).text;
}

/** Read and check one fragment as `readRoleFragment` does, and hash the bytes it read. */
function loadRoleFragment(rolesRoot: string, name: string): LoadedFragment {
  // The name is checked here as well as in the manifest, so no caller can reach outside fragments/ with a directory part.
  const named = fragmentNameSchema.safeParse(name);
  if (!named.success) throw new InvalidRoleFragmentError(name, `is not a valid fragment name: ${named.error.issues.map((issue) => issue.message).join('; ')}`);
  const path = join(rolesRoot, fragmentsDirectoryName, name);
  // Only ENOENT means the fragment is missing; any other failure (EACCES, ENOTDIR, ELOOP) is reported as it is.
  let regular: boolean;
  try {
    regular = lstatSync(path).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new InvalidRoleFragmentError(name, 'does not exist');
    throw new InvalidRoleFragmentError(name, `cannot be read: ${(error as Error).message}`);
  }
  if (!regular) throw new InvalidRoleFragmentError(name, 'is not a regular file');
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
  if (text.startsWith('﻿')) throw new InvalidRoleFragmentError(name, 'starts with a byte order mark');
  if (text.length === 0) throw new InvalidRoleFragmentError(name, 'is empty');
  if (text.includes('\r')) throw new InvalidRoleFragmentError(name, 'contains a carriage return; fragments are LF text');
  if (text.includes('\0')) throw new InvalidRoleFragmentError(name, 'contains a NUL character');
  if (!text.endsWith('\n')) throw new InvalidRoleFragmentError(name, 'does not end with a newline');
  // A line of only whitespace (spaces, tabs) reads as blank, so it counts as one at either edge.
  if (/\n[^\S\n]*\n$/.test(text)) throw new InvalidRoleFragmentError(name, 'ends with a blank line; the assembly separates fragments itself');
  if (/^[^\S\n]*\n/.test(text)) throw new InvalidRoleFragmentError(name, 'starts with a blank line');
  if (text.startsWith('---\n')) throw new InvalidRoleFragmentError(name, 'starts with front matter; a fragment is prompt text only');
  if (/^<!-- include:/m.test(text)) throw new InvalidRoleFragmentError(name, 'contains an include marker; composition is declared in the manifest only');
  return { fragment: { name, sha256: sha256Hex(bytes) }, text };
}

/**
 * Assemble every role under `rolesRoot` (R2): the manifest names the
 * roles and their fragments, each fragment is read once, and a role's
 * prompt is its fragments joined with one blank line. Every file under
 * `fragments/` must be named by some role and nothing else may sit there,
 * so a fragment cannot fall out of use unnoticed and a stray file cannot
 * be mistaken for one.
 */
export function assembleRoles(rolesRoot: string): readonly AssembledRole[] {
  const manifest = readRoleManifest(rolesRoot);
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
  const roles = Object.entries(manifest.roles).map(([key, names]): AssembledRole => {
    const parts = names.map(load);
    const prompt = parts.map((part) => part.text).join('\n');
    return { key, fragments: parts.map((part) => part.fragment), prompt, sha256: sha256Hex(Buffer.from(prompt, 'utf8')) };
  });
  const fragmentsDirectory = join(rolesRoot, fragmentsDirectoryName);
  let entries: string[];
  try {
    entries = readdirSync(fragmentsDirectory);
  } catch (error) {
    throw new InvalidRoleManifestError(`Cannot list ${fragmentsDirectory}: ${(error as Error).message}`);
  }
  const named = new Set(Object.values(manifest.roles).flat());
  const stray = entries.filter((entry) => !named.has(entry)).sort();
  if (stray.length > 0) throw new InvalidRoleManifestError(`Entries under ${fragmentsDirectoryName}/ that no role names: ${stray.join(', ')}`);
  return roles;
}
