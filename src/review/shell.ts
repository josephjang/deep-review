/**
 * One of the engine's own paths quoted for a shell: single quotes, which
 * bash and PowerShell alike take as written, so a space, `$`, a backtick
 * or `\` in a scratch or install path reaches the command intact; double
 * quotes only for a path that itself holds a `'`, which neither shell can
 * put inside single quotes without an escape of its own.
 */
export const shellQuoted = (path: string): string => (path.includes("'") ? `"${path}"` : `'${path}'`);

/**
 * A path, or a word of a command, as a person's terminal takes it: in
 * double quotes, which cmd.exe, bash and PowerShell all unquote, unless
 * it holds a `$`, a backtick or a `"`, which bash or PowerShell would
 * expand or end inside double quotes; such a word is quoted by
 * `shellQuoted` instead.
 */
export const terminalQuoted = (path: string): string => (/[$`"]/.test(path) ? shellQuoted(path) : `"${path}"`);
