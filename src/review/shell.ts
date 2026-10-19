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
 *
 * No quoting all three shells take exists for some words, and this one
 * line does not protect them: a `!`, which interactive bash expands as
 * history inside double quotes; a `%`, which cmd.exe expands inside
 * double quotes; a trailing `\`, which escapes the closing quote under
 * Windows argv parsing, and a `\\`, which bash halves inside double
 * quotes; and a word holding both a `'` and a `$` or backtick, which
 * `shellQuoted` puts in double quotes, where bash and PowerShell expand
 * them.
 */
export const terminalQuoted = (path: string): string => (/[$`"]/.test(path) ? shellQuoted(path) : `"${path}"`);
