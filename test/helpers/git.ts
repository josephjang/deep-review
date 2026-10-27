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
import { isRepositoryVariable, runGitSync, withoutRepositoryVariables } from '../../src/runtime/git-sync.ts';

export { isRepositoryVariable, repositoryVariables, withoutRepositoryVariables } from '../../src/runtime/git-sync.ts';

/** Delete every repository variable from `environment` in place. */
export function deleteRepositoryVariables(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): void {
  for (const name of Object.keys(environment)) if (isRepositoryVariable(name, platform)) Reflect.deleteProperty(environment, name);
}

deleteRepositoryVariables(process.env);

/** Run git in `cwd` without any repository variable and return its trimmed text output. */
export const git = (cwd: string, ...args: string[]): string =>
  runGitSync(args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: withoutRepositoryVariables(process.env) }).trim();
