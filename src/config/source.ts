/**
 * Where one invocation's configuration comes from (R2 to R5, R13 of the
 * configuration): the files it reads and its flag layer, behind the two
 * passes of the resolution. The command line builds one source per
 * invocation; the controller asks it for the scope's settings when a run
 * needs a scope, and for every setting at the base of the change when it
 * configures or continues a run, or compares a resumed run with what it
 * recorded. Each file is read at most once per invocation.
 */
import type { PolicyFile } from '../review/policy.ts';
import { readRepositoryConfig, refuseProblems } from './files.ts';
import { readOperatorFiles, originHeadBranch, resolveScopeSettings, resolveSettings, type FileLocations, type FlagLayer, type RepositoryFileState, type ResolvedSettings, type ScopeSettings } from './resolve.ts';
import { fileLayers } from './settings.ts';

/** What a run asks of the configuration at the base of its change. */
export interface ResolveAt {
  readonly base: string;
  readonly policy: PolicyFile;
  readonly runtime: string;
  readonly costInUsd: boolean;
}

/** One invocation's configuration. */
export interface ConfigurationSource {
  /** The settings the invocation's flags give, dedicated flags and `--set` alike. */
  readonly flags: FlagLayer;
  /** Pass 1: `scope.default` and `review.base`, from every file but the repository's, and the flags. */
  scopeSettings(): ScopeSettings;
  /** Pass 2: every setting, the repository's file read as `base` holds it unless the invocation skips it. */
  resolve(at: ResolveAt): ResolvedSettings;
}

export interface SourceOptions {
  /** The root of the worktree: git runs there, and a relative `tools.path` entry is relative to it. */
  readonly worktree: string;
  /** The operator's, the clone's and the invocation file; null for none at all, as a library caller or a test has. */
  readonly locations: FileLocations | null;
  /** False with `--no-repository-config`, which skips the repository's file (R5, PD6). */
  readonly repositoryConfig: boolean;
  readonly flags: FlagLayer;
}

/** A function that reads its value the first time it is called and returns that value after; a read that throws is tried again on the next call. */
function once<T>(read: () => T): () => T {
  let memo: { readonly value: T } | null = null;
  return (): T => (memo ??= { value: read() }).value;
}

/**
 * The configuration of one invocation: the operator's, the clone's and
 * the invocation file read once, when first needed, refusing with every
 * problem they have; the repository's file read at each base asked for,
 * refusing likewise; and the branch `origin/HEAD` names asked of git once,
 * only when no layer gives `review.base`.
 */
export function configurationSource(options: SourceOptions): ConfigurationSource {
  const operatorFiles = once(() => (options.locations === null ? [] : readOperatorFiles(options.locations)));
  const originHead = once(() => originHeadBranch(options.worktree));
  return {
    flags: options.flags,
    scopeSettings: () => resolveScopeSettings(operatorFiles(), options.flags, originHead),
    resolve: (at) => {
      const files = [...operatorFiles()];
      let repository: Omit<RepositoryFileState, 'edited'>;
      if (!options.repositoryConfig) repository = { state: 'skipped', commit: null };
      else {
        const read = readRepositoryConfig(options.worktree, at.base);
        refuseProblems(read.problems);
        if (read.file !== null) files.push(read.file);
        repository = { state: read.file === null ? 'absent' : 'read', commit: at.base };
      }
      // The files in the order of their layers, as the record lists them.
      files.sort((a, b) => fileLayers.indexOf(a.layer) - fileLayers.indexOf(b.layer));
      return resolveSettings({ policy: at.policy, runtime: at.runtime, costInUsd: at.costInUsd, files, flags: options.flags, repository, worktree: options.worktree, originHead });
    },
  };
}
