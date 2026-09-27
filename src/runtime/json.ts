/**
 * Whether a parsed JSON value is an object with named members: not null,
 * and not an array, whose indices would otherwise pass for members.
 */
export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
