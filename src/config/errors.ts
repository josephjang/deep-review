import { EngineError } from '../errors.ts';

/**
 * A setting flag the command line cannot take (R13, TD9 of the
 * configuration): a `--set` without a name, a name the registry does not
 * hold, a value its setting's schema refuses, or two flags for one
 * setting. A command-line mistake, refused with the usage before the
 * engine reads any file.
 */
export class SettingFlagError extends EngineError {
  override readonly name = 'SettingFlagError';
}
