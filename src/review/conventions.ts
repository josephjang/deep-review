/**
 * The reviewer's own rules files (R3, PD7 of the repository survey): the
 * user-level `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`. They are the
 * reviewer's preferences, not the repository's, and the pinned policy
 * says whether they are convention sources: never, always, or when the
 * surveyor has grounds. Which files of the repository state its
 * conventions is the surveyor's reading, and no list of names here
 * decides it.
 *
 * Whether the repository is the reviewer's own work is one ground the
 * surveyor may apply them on, and the one fact it cannot see: a worker
 * runs isolated from the reviewer's git configuration, and on the first
 * gate a surveyor read a commit's author as the configured email. So the
 * engine counts, with the operator's own git, how many recent commits the
 * reviewer authored, and the task carries the counts, never the address.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isFile } from '../paths.ts';
import { gitText } from '../scope/git.ts';

/** The user-level rules files, relative to the home directory. */
export const userConventionFiles = ['.claude/CLAUDE.md', '.codex/AGENTS.md'] as const;

/** The absolute path of each user-level rules file that exists under `home`, in the order `userConventionFiles` lists them. */
export function existingUserRulesFiles(home: string = homedir()): string[] {
  return userConventionFiles.map((relative) => join(home, ...relative.split('/'))).filter(isFile);
}

/** How many commits back from HEAD the reviewer's authorship is counted over. */
export const authorshipWindow = 200;

/**
 * What the reviewer's git identity says of the repository's recent
 * history: no `user.email` configured for it, or how many of the last
 * commits on HEAD, at most `authorshipWindow`, were authored with that
 * email, compared without regard to case.
 */
export type ReviewerAuthorship =
  | { readonly identity: 'unset' }
  | { readonly identity: 'set'; readonly commits: number; readonly byReviewer: number };

/** The reviewer's authorship of the worktree's recent history, read with the operator's own git configuration. */
export function reviewerAuthorship(worktree: string): ReviewerAuthorship {
  // `git config` exits 1 for a key that is not set.
  const email = gitText(worktree, ['config', '--get', 'user.email'], { okExitCodes: [1] }).trim().toLowerCase();
  if (email === '') return { identity: 'unset' };
  // One line per commit: `--no-show-signature` overrides a configured
  // `log.showSignature`, whose verification lines would otherwise share
  // stdout with the emails and be counted as commits. `--` keeps HEAD a
  // revision when the repository also tracks a file named HEAD.
  const authors = gitText(worktree, ['log', `-${String(authorshipWindow)}`, '--no-show-signature', '--format=%ae', 'HEAD', '--']).split(/\r?\n/).filter((line) => line.length > 0);
  return { identity: 'set', commits: authors.length, byReviewer: authors.filter((author) => author.trim().toLowerCase() === email).length };
}
