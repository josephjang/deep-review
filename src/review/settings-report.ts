/**
 * The report's and `status`'s account of the settings (R7 of the
 * configuration), rendered from the fold alone like the rest of the
 * report: the header line that names the files a run read, and the lines
 * of what the run did not examine or follow because of a setting, the
 * paths `scope.exclude` left out, each repository value a higher layer
 * replaced, the repository's file skipped or edited by the change, and
 * each setting ignored. A run whose values are all defaults and flags
 * adds only the header line. A run configured before the settings has a
 * header line that says so, and no other.
 */
import type { ReviewConfiguration, ScopeState } from '../checkpoint/events.ts';
import { repositoryConfigPath } from '../config/files.ts';
import { layerWords } from '../config/settings.ts';

/** The most paths left out that the report and `status` name; they count the rest. */
export const namedExcludedPaths = 50;

/** A value as a line names it: JSON, so a list, `false` and a string read apart. */
const valueWords = (value: unknown): string => JSON.stringify(value);

/**
 * The header's line of the settings: the files the run read, each with its
 * layer and, for the repository's, the commit it was read at; whether the
 * repository's file was skipped, or edited by the change, whose edit
 * applies to later changes; or, for a run configured before the settings,
 * that its values came from the defaults and its flags.
 */
export function settingsHeaderLine(configuration: ReviewConfiguration): string {
  const settings = configuration.settings;
  if (settings === null) return 'Settings: recorded before the settings existed; the run\'s values came from the defaults and its flags';
  const files = settings.files.map((file) => `${layerWords[file.layer]} ${file.path}${file.commit === null ? '' : ` at ${file.commit}`}`);
  return [
    `Settings: ${files.length === 0 ? 'no configuration file' : files.join(', ')}`,
    ...(settings.repository.state === 'skipped' ? ['the repository\'s file skipped by --no-repository-config'] : []),
    ...(settings.repository.edited ? [`${repositoryConfigPath} edited by this change: the edit applies to later changes`] : []),
  ].join('; ');
}

/**
 * What the settings left unexamined or unfollowed, one sentence each,
 * without a list mark (R7, PD7): the patterns of `scope.exclude` with the
 * count of the changed paths they left out, which no worker reviewed, and
 * the first 50 of them; each repository value a higher layer replaced,
 * with the value the run used and its layer; the repository's file
 * skipped, or edited by the change; and each setting a file gave that the
 * run ignored.
 */
export function settingsLimitations(configuration: ReviewConfiguration, scope: ScopeState): string[] {
  const settings = configuration.settings;
  const lines: string[] = [];
  const patterns = scope.request.exclude;
  if (patterns.length > 0) {
    const { paths, count } = scope.excluded;
    const named = paths.slice(0, namedExcludedPaths);
    const more = count - named.length;
    lines.push(count === 0
      ? `scope.exclude (${patterns.join(', ')}) left out no changed path.`
      : `scope.exclude (${patterns.join(', ')}) left out ${String(count)} changed path${count === 1 ? '' : 's'}, which no worker reviewed: ${named.join(', ')}${more > 0 ? `, and ${String(more)} more` : ''}.`);
  }
  if (settings === null) return lines;
  for (const entry of settings.notFollowed) lines.push(`Not followed: ${entry.name}: the repository's ${valueWords(entry.repository)}, this run's ${valueWords(entry.value)} from ${layerWords[entry.layer]}.`);
  if (settings.repository.state === 'skipped') lines.push('The repository\'s file was skipped by --no-repository-config, so the run did not apply the policy of the repository.');
  if (settings.repository.edited) lines.push(`This change edits ${repositoryConfigPath}; the edit applies to later changes, and this review read the file as its base holds it.`);
  for (const entry of settings.ignored) lines.push(`Ignored: ${entry.name} in ${entry.path}: ${entry.reason}.`);
  return lines;
}
