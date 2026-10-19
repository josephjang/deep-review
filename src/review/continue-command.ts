/**
 * The command that continues a fix pass the run budget stopped (R11, R15
 * of resumable runs), as the end of the run logs it and its report and
 * `status` print it: the same `review --fix` with the run's runtime, the
 * scope flags and paths of the run's request, and `--budget-usd` above
 * its spend, run with the engine that wrote the line, named by its path
 * as the answer command of the report names it (R9 of the skill surface
 * corrections). It names `--roles` too, when the run's roles are not the
 * engine's own.
 */
import type { ScopeState } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { engineRolesRoot } from '../engine.ts';
import { sameDirectory } from '../paths.ts';
import { terminalQuoted } from './shell.ts';

/**
 * A word of the command as typed: bare when cmd.exe, bash and PowerShell
 * all take it as it is, quoted otherwise. A `^` is cmd.exe's escape, a
 * leading `@` PowerShell's splat, a leading `~`, or one after `=` or `:`,
 * bash's home directory, and a leading `=` zsh's command path, so a bare
 * word holds no `^` and starts with a letter, a digit, `.`, `_` or `/`.
 */
const word = (text: string): string => (/^[A-Za-z0-9._/][A-Za-z0-9._/:@~=+-]*$/.test(text) && !/[=:]~/.test(text) ? text : terminalQuoted(text));

/** The flags that name a captured scope as `namesScope` matches them: its mode, its ref or range, and each path. */
function scopeFlags(scope: Pick<ScopeState, 'mode' | 'request'>): string[] {
  const { request } = scope;
  const paths = request.paths.flatMap((path) => ['--path', word(path)]);
  switch (scope.mode) {
    case 'last-commit':
      return ['--last-commit', ...paths];
    case 'worktree':
      return ['--worktree', ...paths];
    case 'ref':
      return ['--ref', word(request.ref!), ...paths];
    case 'range':
      return ['--from', word(request.range!.from), '--to', word(request.range!.to), ...(request.range!.mergeBase ? ['--merge-base'] : []), ...paths];
  }
}

/** The roles a command reviews with as the continue command names them: null for the engine's own, which it need not name. */
export const namedRoles = (rolesRoot: string): string | null => (sameDirectory(rolesRoot, engineRolesRoot()) ? null : rolesRoot);

/** The whole dollar above a spend: a `--budget-usd` above it, as continuing the run asks. */
export const budgetAbove = (spendUsd: number): number => Math.floor(spendUsd) + 1;

/**
 * The command that continues `run`, a fix pass the run budget stopped:
 * `engineEntry` is the engine that writes the line, and `rolesRoot` the
 * roles the run reviewed with when they are not the engine's own, else
 * null.
 */
export function continueCommand(run: Pick<RunState, 'scope' | 'review'>, engineEntry: string, rolesRoot: string | null, spendUsd: number): string {
  if (run.scope === null || run.review === null) throw new Error('A run continues only with its scope and its configuration');
  const args = ['review', '--runtime', run.review.configuration.runtime, ...scopeFlags(run.scope), '--fix', '--budget-usd', String(budgetAbove(spendUsd)), ...(rolesRoot === null ? [] : ['--roles', terminalQuoted(rolesRoot)])];
  return `node ${terminalQuoted(engineEntry)} ${args.join(' ')}`;
}
