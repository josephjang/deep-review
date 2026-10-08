/**
 * The one place the test suite runs git, and the environment it runs git
 * in. A git command that runs another program, as `git rebase --exec` does,
 * or a git hook, leaves variables in that program's environment that name
 * the repository the command was working on. Inherited by a test's git,
 * they make it act on that repository instead of the temporary one the test
 * made: https://github.com/josephjang/deep-review/issues/27
 *
 * So no git the suite starts may see them. Importing this module deletes
 * them from `process.env`, which covers the engine's own git calls in a
 * test process and every process a test starts; test/setup.ts imports it
 * into every test process `npm test` starts, and the repository helpers
 * import it too, so a test file run on its own with `node --test` is
 * covered as well. `git` below also builds its environment without them,
 * whatever `process.env` holds by then. ESLint flags any other spawn under
 * test/ that names git by a string literal (see eslint.config.mjs); one that
 * names git any other way, through a variable, a template literal or a
 * shell, is not caught, and only the deletion from `process.env` above
 * covers it.
 */
import { execFileSync } from 'node:child_process';
import { comparable } from '../../src/runtime/environment.ts';

/**
 * Variables that name a repository, or part of one, or that carry settings
 * into it. Every name but GIT_NAMESPACE is one `git rev-parse
 * --local-env-vars` prints with git 2.55: git's own list of the variables
 * it clears when it moves to another repository. A test holds this list to
 * that output, so a newer git that adds one fails it.
 */
export const repositoryVariables: readonly string[] = [
  // The repository: the git directory, which overrides any directory git
  // would find from its working directory, and the common directory a
  // linked worktree shares, which holds the config, the refs and the ledger.
  'GIT_DIR',
  'GIT_COMMON_DIR',
  // The working tree and the index that go with the repository, and git's
  // note to its children that the working tree was implied, not named.
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  // Where objects are written and read.
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  // Files and refs that change the history git reads: shallow boundaries,
  // grafts, and replace refs.
  'GIT_SHALLOW_FILE',
  'GIT_GRAFT_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  // The subdirectory of the enclosing repository's working tree the command
  // ran in, which means nothing in another repository.
  'GIT_PREFIX',
  // Settings carried in: a config file read in place of the repository's
  // own, the `git -c` settings of the enclosing command, and the count of
  // GIT_CONFIG_KEY_<n> and GIT_CONFIG_VALUE_<n> pairs, which isRepositoryVariable
  // drops by prefix.
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  // Not on git's list: it puts every ref a command reads or writes under
  // refs/namespaces/<name>, so a branch a test makes is not where it looks.
  'GIT_NAMESPACE',
];

/** The numbered settings GIT_CONFIG_COUNT counts. */
const repositoryVariablePrefixes: readonly string[] = ['GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_'];

/** Whether `name` is one of the repository variables, compared as the platform compares names: without case on Windows. */
export function isRepositoryVariable(name: string, platform: NodeJS.Platform = process.platform): boolean {
  const candidate = comparable(name, platform);
  return repositoryVariables.some((variable) => comparable(variable, platform) === candidate)
    || repositoryVariablePrefixes.some((prefix) => candidate.startsWith(comparable(prefix, platform)));
}

/** A copy of the environment without any repository variable. */
export function withoutRepositoryVariables(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !isRepositoryVariable(name, platform)));
}

/** Delete every repository variable from `environment` in place. */
export function deleteRepositoryVariables(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): void {
  for (const name of Object.keys(environment)) if (isRepositoryVariable(name, platform)) Reflect.deleteProperty(environment, name);
}

deleteRepositoryVariables(process.env);

/** Run git in `cwd` without any repository variable and return its trimmed text output. */
export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: withoutRepositoryVariables(process.env) }).trim();
