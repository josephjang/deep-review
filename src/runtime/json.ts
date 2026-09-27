/**
 * Whether a parsed JSON value is an object with named members: not null,
 * and not an array, whose indices would otherwise pass for members.
 */
export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** `value` when it is a finite number, else null: what a usage field must be to be summed. */
export const finiteNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** The sum of the given numbers, or null when any of them is null, so a partial report is never mistaken for a total. */
export function sumOrNull(...values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}
