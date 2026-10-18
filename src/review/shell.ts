/**
 * One of the engine's own paths quoted for a shell: single quotes, which
 * bash and PowerShell alike take as written, so a space, `$`, a backtick
 * or `\` in a scratch or install path reaches the command intact; double
 * quotes only for a path that itself holds a `'`, which neither shell can
 * put inside single quotes without an escape of its own.
 */
export const shellQuoted = (path: string): string => (path.includes("'") ? `"${path}"` : `'${path}'`);
