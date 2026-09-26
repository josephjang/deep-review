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

export interface BuildOptions {
  /** Absolute path of the repository checkout. */
  readonly repositoryRoot: string;
  /** `true` compares against the committed dist/ and writes nothing; `false` replaces dist/. */
  readonly verify: boolean;
  /** Targets to build; defaults to every runtime the repository ships. */
  readonly targets?: readonly ArtifactTarget[];
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
 * Assemble every target into a temporary staging directory, then either
 * compare each with its committed dist/ tree (verify) or replace that tree
 * with the staged one (build). Staging is removed whatever happens, so a
 * failed run leaves nothing behind but the unchanged repository.
 */
export function runBuild(options: BuildOptions): BuildOutcome {
  const repositoryRoot = resolve(options.repositoryRoot);
  const targets = options.targets ?? artifactTargets;
  const staging = mkdtempSync(join(tmpdir(), 'deep-review-build-'));
  try {
    const outcomes: TargetOutcome[] = [];
    for (const target of targets) {
      const staged = assembleArtifact(repositoryRoot, target, staging);
      const assembled = digestTree(staged);
      const destination = join(repositoryRoot, target.destination);
      const committed = existsSync(destination) ? digestTree(destination) : new Map<string, string>();
      const differences = compareTrees(assembled, committed);
      if (!options.verify) publishArtifact(repositoryRoot, target, staged);
      outcomes.push({ target, files: assembled.size, differences, published: !options.verify });
    }
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
