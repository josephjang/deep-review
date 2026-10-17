/**
 * The report's and `status`'s account of the settings (R7 of the
 * configuration), rendered from the fold alone like the rest of the
 * report: the header line that names the files a run read, and the lines
 * of what the run did not examine or follow because of a setting, the
 * paths `scope.exclude` left out, each repository value a higher layer
 * replaced, the repository's file skipped or edited by the change, and
 * each setting ignored. A run whose values are all defaults and flags
 * adds only the header line. A run configured before the settings has a
 * header line that says so, and no other, unless a continuation recorded
 * its fix side since.
 */
import type { ReviewConfiguration, ScopeState } from '../checkpoint/events.ts';
import { repositoryConfigPath } from '../config/files.ts';
import { fixSideNames } from '../config/record.ts';
import { fileWords, layerWords } from '../config/settings.ts';

/** The most paths left out that the report and `status` name; they count the rest. */
export const namedExcludedPaths = 50;

/** A value as a line names it: JSON, so a list, `false` and a string read apart. */
const valueWords = (value: unknown): string => JSON.stringify(value);

/** Where a record of the settings came from: the run's configuration, or the fix side a continuation recorded. */
type Sources = NonNullable<ReviewConfiguration['settings']> | NonNullable<ReviewConfiguration['fixSettings']>;

/** The files a record read, each with its layer and, for the repository's, its commit, and whether that file was skipped or edited. */
function sourcesWords(sources: Sources): string {
  const files = sources.files.map(fileWords);
  return [
    files.length === 0 ? 'no configuration file' : files.join(', '),
    ...(sources.repository.state === 'skipped' ? ['the repository\'s file skipped by --no-repository-config'] : []),
    ...(sources.repository.edited ? [`${repositoryConfigPath} edited by this change: the edit applies to later changes`] : []),
  ].join('; ');
}

/**
 * The header's line of the settings: the files the run read, each with its
 * layer and, for the repository's, the commit it was read at; whether the
 * repository's file was skipped, or edited by the change, whose edit
 * applies to later changes; or, for a run configured before the settings,
 * that its values came from the defaults and its flags. A run continued
 * into the fix pass adds what the continuation read, from which the fix
 * pass took its checks and `tools.path`.
 */
export function settingsHeaderLine(configuration: ReviewConfiguration): string {
  const { settings, fixSettings } = configuration;
  const run = settings === null ? 'recorded before the settings existed; the run\'s values came from the defaults and its flags' : sourcesWords(settings);
  return `Settings: ${run}${fixSettings === null ? '' : `; the fix pass: ${sourcesWords(fixSettings)}`}`;
}

/**
 * What the settings left unexamined or unfollowed, one sentence each,
 * without a list mark (R7, PD7): the patterns of `scope.exclude` with the
 * count of the changed paths they left out, which no worker reviewed, and
 * the first 50 of them; each repository value a higher layer replaced,
 * with the value the run used and its layer; the repository's file
 * skipped, or edited by the change; and each setting a file gave that the
 * run ignored. For a run continued into the fix pass, the continuation's
 * record speaks for the settings it holds, and each line is said once.
 */
export function settingsLimitations(configuration: ReviewConfiguration, scope: ScopeState): string[] {
  const { settings, fixSettings } = configuration;
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
  const records = [settings, fixSettings].filter((record): record is Sources => record !== null);
  if (records.length === 0) return lines;
  const notFollowed = [
    ...(settings?.notFollowed ?? []).filter((entry) => fixSettings === null || !fixSideNames.includes(entry.name)),
    ...(fixSettings?.notFollowed ?? []),
  ];
  for (const entry of notFollowed) lines.push(`Not followed: ${entry.name}: the repository's ${valueWords(entry.repository)}, this run's ${valueWords(entry.value)} from ${layerWords[entry.layer]}.`);
  if (settings?.repository.state === 'skipped') lines.push('The repository\'s file was skipped by --no-repository-config, so the run did not apply the policy of the repository.');
  else if (fixSettings?.repository.state === 'skipped') lines.push('The repository\'s file was skipped by --no-repository-config for the fix pass, so its checks did not follow the policy of the repository.');
  if (records.some((record) => record.repository.edited)) lines.push(`This change edits ${repositoryConfigPath}; the edit applies to later changes, and this review read the file as its base holds it.`);
  const ignored = new Map(records.flatMap((record) => record.ignored).map((entry) => [JSON.stringify([entry.layer, entry.path, entry.name]), entry]));
  for (const entry of ignored.values()) lines.push(`Ignored: ${entry.name} in ${entry.path}: ${entry.reason}.`);
  return lines;
}
