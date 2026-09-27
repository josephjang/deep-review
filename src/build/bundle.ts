/**
 * The engine as it ships (R11, PD4, TD8 of the read-only review): one esbuild
 * bundle of the command, `engine/main.mjs`, with a sidecar `engine.json`
 * holding its version and the hash of its bytes, and a copy of `roles/`
 * beside it. Unminified, so a stack trace reads against the sources and a
 * rebuilt bundle's diff is reviewable; deterministic for one esbuild version
 * and one input tree, which the lock file and CI on three platforms hold.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { engineSidecarName, type EngineSidecar } from '../engine.ts';

/** The directory of an artifact that holds the engine. */
export const engineDirectoryName = 'engine';
/** The bundle's file name under it. */
export const engineBundleName = 'main.mjs';
/** The roles directory under it. */
export const engineRolesDirectoryName = 'roles';

export interface EngineBundleOptions {
  /** Absolute path of the command's entry module. */
  readonly entry: string;
  /** Absolute path of the roles directory copied beside the bundle. */
  readonly rolesRoot: string;
  /** The version the sidecar records: package.json's. */
  readonly version: string;
  /** Where `node_modules` is looked for when the entry's own tree has none, such as a temporary copy of the repository. */
  readonly nodePaths?: readonly string[];
  /** The directory esbuild resolves and names files relative to, so two checkouts give one bundle; the repository root. */
  readonly workingDirectory: string;
}

/** Bundle the engine into `<destination>/engine/`, returning the sidecar written beside it. */
export async function bundleEngine(destination: string, options: EngineBundleOptions): Promise<EngineSidecar> {
  if (!existsSync(options.entry)) throw new Error(`Engine entry does not exist: ${options.entry}`);
  if (!existsSync(options.rolesRoot)) throw new Error(`Roles root does not exist: ${options.rolesRoot}`);
  const engine = join(destination, engineDirectoryName);
  mkdirSync(engine, { recursive: true });
  const outfile = join(engine, engineBundleName);
  await build({
    entryPoints: [options.entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node26',
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    absWorkingDir: options.workingDirectory,
    ...(options.nodePaths === undefined ? {} : { nodePaths: [...options.nodePaths] }),
    logLevel: 'silent',
  });
  const bytes = readFileSync(outfile);
  const sidecar: EngineSidecar = { version: options.version, sha256: createHash('sha256').update(bytes).digest('hex') };
  writeFileSync(join(engine, engineSidecarName), `${JSON.stringify(sidecar, null, 2)}\n`);
  cpSync(options.rolesRoot, join(engine, engineRolesDirectoryName), { recursive: true, errorOnExist: true, dereference: false });
  return sidecar;
}

/** The engine bundle options of this repository: its command, its roles and its version. */
export function repositoryEngine(repositoryRoot: string): EngineBundleOptions {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) throw new Error(`${join(repositoryRoot, 'package.json')} has no version`);
  return { entry: join(repositoryRoot, 'src', 'cli.ts'), rolesRoot: join(repositoryRoot, 'roles'), version: manifest.version, workingDirectory: repositoryRoot };
}
