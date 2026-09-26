import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The version in package.json: what every event records as the engine that
 * wrote it. Resolved relative to this source file, so the element that
 * bundles the engine for distribution has to supply the version another way.
 */
export function engineVersion(): string {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) throw new Error('package.json has no version');
  return manifest.version;
}
