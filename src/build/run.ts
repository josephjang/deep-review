import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  artifactTargets,
  assembleArtifact,
  compareTrees,
  digestTree,
  publishArtifact,
  type ArtifactTarget,
  type TreeDifference,
} from './artifacts.ts';
import { bundleEngine, repositoryEngine, type EngineBundleOptions } from './bundle.ts';

export interface BuildOptions {
  /** Absolute path of the repository checkout. */
  readonly repositoryRoot: string;
  /** `true` compares against the committed dist/ and writes nothing; `false` replaces dist/. */
  readonly verify: boolean;
  /** Targets to build; defaults to every runtime the repository ships. */
  readonly targets?: readonly ArtifactTarget[];
  /** Directory the temporary staging tree is created under; defaults to the OS temp directory. */
  readonly stagingParent?: string;
  /** The engine bundled into every artifact; the repository's own by default, or null for artifacts without an engine. */
  readonly engine?: EngineBundleOptions | null;
}

export interface TargetOutcome {
  readonly target: ArtifactTarget;
  /** Files in the freshly assembled artifact. */
  readonly files: number;
  /** How the committed dist/ differs from the assembled artifact; empty when they match. */
  readonly differences: readonly TreeDifference[];
  /** Whether dist/ was replaced with the assembled artifact. */
  readonly published: boolean;
}

export interface BuildOutcome {
  /** In verify mode, whether every target matched dist/. In build mode, always `true`. */
  readonly ok: boolean;
  readonly outcomes: readonly TargetOutcome[];
}

/**
 * Assemble every target into a temporary staging directory, with the engine
 * bundled into each, then either compare each with its committed dist/ tree
 * (verify) or replace those trees with the staged ones (build). Every target
 * is assembled before any is published, so a source that cannot be assembled
 * leaves dist/ untouched. Staging is removed whatever happens, so a failed
 * run leaves nothing behind but the unchanged repository.
 */
export async function runBuild(options: BuildOptions): Promise<BuildOutcome> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const targets = options.targets ?? artifactTargets;
  const engine = options.engine === undefined ? repositoryEngine(repositoryRoot) : options.engine;
  const staging = mkdtempSync(join(options.stagingParent ?? tmpdir(), 'deep-review-build-'));
  try {
    const assembled = [];
    for (const target of targets) {
      const staged = assembleArtifact(repositoryRoot, target, staging);
      if (engine !== null) await bundleEngine(staged, engine);
      const digest = digestTree(staged);
      const destination = join(repositoryRoot, target.destination);
      const committed = existsSync(destination) ? digestTree(destination) : new Map<string, string>();
      assembled.push({ target, staged, files: digest.size, differences: compareTrees(digest, committed) });
    }
    if (!options.verify) for (const { target, staged } of assembled) publishArtifact(repositoryRoot, target, staged);
    const outcomes = assembled.map(({ target, files, differences }) => ({ target, files, differences, published: !options.verify }));
    return { ok: !options.verify || outcomes.every((outcome) => outcome.differences.length === 0), outcomes };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** One line per target, plus one indented line per difference, for the terminal. */
export function formatOutcome(outcome: BuildOutcome): string {
  const lines: string[] = [];
  for (const { target, files, differences, published } of outcome.outcomes) {
    const noun = files === 1 ? 'file' : 'files';
    if (published) {
      lines.push(differences.length === 0
        ? `${target.name}: ${files} ${noun}, ${target.destination} unchanged`
        : `${target.name}: ${files} ${noun}, wrote ${target.destination} (${differences.length} changed)`);
    } else {
      lines.push(differences.length === 0
        ? `${target.name}: ${files} ${noun}, matches ${target.destination}`
        : `${target.name}: ${files} ${noun}, differs from ${target.destination}`);
    }
    for (const difference of differences) lines.push(`  ${difference.kind.padEnd(7)} ${difference.path}`);
  }
  if (!outcome.ok) lines.push('dist/ is out of date: run `npm run build` and commit the result');
  return lines.join('\n');
}
