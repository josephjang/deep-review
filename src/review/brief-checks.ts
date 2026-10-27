/**
 * The facts of a fix run's checks and fixes that the brief gives before a
 * merge (R3 to R7 of the facts before a merge), each computed from the
 * fold alone, so nothing records them and a run an engine before that
 * change configured gets them too (TD9): the sentence on how the fixers
 * validated the fixes they applied.
 */
import type { ValidationMethod } from './vocabulary.ts';

/**
 * How strongly a fixer validated a fix, the strongest first (TD12 of the
 * facts before a merge): a test that fails on the code before the fix or
 * on a mutation of it, the tests that already exist, a check of the
 * source, a limit the fixer named, or no validation at all.
 */
export const validationStrengths = ['test', 'existing', 'static', 'limited', 'none'] as const;
export type ValidationStrength = (typeof validationStrengths)[number];

/** The strength of each method a fixer reports (fixer-validation.md). */
const strengthOfMethod: Readonly<Record<ValidationMethod, Exclude<ValidationStrength, 'none'>>> = {
  'old-code': 'test',
  mutation: 'test',
  existing: 'existing',
  static: 'static',
  limited: 'limited',
};

/** The applied fixes under the strongest validation of each, in the order they are given (R7). */
export type BriefValidation = Readonly<Record<ValidationStrength, readonly string[]>>;

/** Each applied fix under the strongest method of the validation that applied it, or `none` when that answer gave no entry (TD12). */
export function validationOf(applied: readonly { readonly id: string; readonly methods: readonly ValidationMethod[] }[]): BriefValidation {
  const strongest = (methods: readonly ValidationMethod[]): ValidationStrength => validationStrengths.find((strength) => methods.some((method) => strengthOfMethod[method] === strength)) ?? 'none';
  const byFix = applied.map((fix) => ({ id: fix.id, strength: strongest(fix.methods) }));
  return Object.fromEntries(validationStrengths.map((strength) => [strength, byFix.filter((fix) => fix.strength === strength).map((fix) => fix.id)])) as Record<ValidationStrength, string[]>;
}

/** What a fix validated less strongly than by a test rests on, after its ids, for one id and for several (R7); a check of the source can run a source assertion as well as read the source. */
const restsOn: Readonly<Record<Exclude<ValidationStrength, 'test'>, readonly [one: string, many: string]>> = {
  existing: ['rests on the tests that already exist', 'rest on the tests that already exist'],
  static: ['rests on a check of the source', 'rest on a check of the source'],
  limited: ['rests on a limit that its fixer named', 'rest on limits that their fixers named'],
  none: ['has no validation that its fixer reported', 'have no validation that their fixers reported'],
};

/**
 * The sentence of "What deep-review changed" on the validation of the
 * applied fixes (R7, PD6 of the facts before a merge), marked as what the
 * fixers report: how many of them a test validated, then the others by
 * the strongest validation of each, their ids as `list` gives them, which
 * the brief shows at most 8 of and counts the rest. None for a run that
 * applied no fix.
 */
export function validationSentence(validation: BriefValidation, list: (ids: readonly string[]) => string): string | null {
  const total = validationStrengths.reduce((sum, strength) => sum + validation[strength].length, 0);
  if (total === 0) return null;
  const tested = validation.test.length;
  const fixes = total === 1 ? 'the fix' : `${tested === total ? 'each' : tested === 0 ? 'none' : String(tested)} of the ${String(total)} fixes`;
  const lead = tested === 0 && total === 1
    ? 'The fixers report that no test validated the fix.'
    : `The fixers report that a test validated ${fixes}${tested === 0 ? '.' : ': it fails on the code before the fix, or on a mutation of the fix.'}`;
  const rest = (['existing', 'static', 'limited', 'none'] as const).flatMap((strength) => {
    const ids = validation[strength];
    return ids.length === 0 ? [] : [`${list(ids)} ${restsOn[strength][ids.length === 1 ? 0 : 1]}.`];
  });
  return [lead, ...rest].join(' ');
}
