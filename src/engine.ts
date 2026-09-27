import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repositoryRolesRoot } from './roles/assemble.ts';

/**
 * The version in package.json: what every event records as the engine that
 * wrote it when the engine runs from its sources. Resolved relative to this
 * source file; the bundle carries its version in a sidecar instead.
 */
export function engineVersion(): string {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) throw new Error('package.json has no version');
  return manifest.version;
}

/** The file the build writes beside the bundle: its version and the hash of its bytes (TD8 of the read-only review). */
export const engineSidecarName = 'engine.json';

export interface EngineSidecar {
  readonly version: string;
  readonly sha256: string;
}

/** The sidecar beside `directory`'s module, or null when the engine runs from its sources, where none exists. */
export function readEngineSidecar(directory: string = import.meta.dirname): EngineSidecar | null {
  const path = join(directory, engineSidecarName);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; sha256?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version.length === 0 || typeof parsed.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.sha256)) {
    throw new Error(`${path} is not an engine sidecar: it needs a version and a sha256`);
  }
  return { version: parsed.version, sha256: parsed.sha256 };
}

/**
 * What every event records as the engine that wrote it (R11 of the
 * read-only review): `<version>+<first twelve hex digits of the bundle's
 * hash>` for the bundle, whose identity is its content, and
 * `<version>+dev` for the sources.
 */
export function engineIdentity(directory: string = import.meta.dirname): string {
  const sidecar = readEngineSidecar(directory);
  return sidecar === null ? `${engineVersion()}+dev` : `${sidecar.version}+${sidecar.sha256.slice(0, 12)}`;
}

/** The roles the engine reads: `roles/` beside the bundle, or the repository's when running from the sources. */
export function engineRolesRoot(directory: string = import.meta.dirname): string {
  return readEngineSidecar(directory) === null ? repositoryRolesRoot() : join(directory, 'roles');
}
