/**
 * What a run's records of the settings say about one setting (R6 of the
 * configuration): the one rule of what a run recorded, which the fold's
 * check of a plan of checks, `settingOf` and the controller's check
 * settings all read, so a change to the precedence of the fix side or to
 * what counts as recorded reaches them alike.
 */
import type { ReviewConfiguration, SettingsRecorded } from './events.ts';

/** The layer a record names for a setting. */
export type RecordedLayer = NonNullable<SettingsRecorded['layers'][keyof SettingsRecorded['layers']]>;

/**
 * One setting as the records hold it: from the fix side a continuation's
 * `fix.pinned@2` recorded, for a setting it records, else from the
 * configuration's settings block; its layer, and the value the record
 * holds, undefined for one whose value a version 5 field or the pin's
 * `checks` holds instead. Undefined for a setting no record names: any
 * setting of a run configured before the settings, and a check setting
 * of a run that does not fix.
 */
export function recordedSetting(configuration: ReviewConfiguration, name: string): { readonly value: unknown; readonly layer: RecordedLayer } | undefined {
  const fixSide = configuration.fixSettings;
  const record = fixSide !== null && Object.hasOwn(fixSide.layers, name) ? fixSide : configuration.settings;
  const layer = (record?.layers as Readonly<Partial<Record<string, RecordedLayer>>> | undefined)?.[name];
  if (record === null || layer === undefined) return undefined;
  return { value: (record.values as Readonly<Partial<Record<string, unknown>>>)[name], layer };
}
