/**
 * The reviewer's own rules files (R3, PD7 of the repository survey): the
 * user-level `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`. They are the
 * reviewer's preferences, not the repository's, and the pinned policy
 * says whether they are convention sources: never, always, or when the
 * surveyor has grounds. Which files of the repository state its
 * conventions is the surveyor's reading, and no list of names here
 * decides it.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isFile } from '../paths.ts';

/** The user-level rules files, relative to the home directory. */
export const userConventionFiles = ['.claude/CLAUDE.md', '.codex/AGENTS.md'] as const;

/** The absolute path of each user-level rules file that exists under `home`, in the order `userConventionFiles` lists them. */
export function existingUserRulesFiles(home: string = homedir()): string[] {
  return userConventionFiles.map((relative) => join(home, ...relative.split('/'))).filter(isFile);
}
