/**
 * The cleaning of each text that the engine did not write before a review
 * on the pull request posts it (R11, "The cleaning (R11)" of the design of
 * the review on the pull request): the words of the workers and the
 * writer's prose, in this order. Secrets of a known form and the values of
 * the environment's secret variables become a mark that names their kind;
 * the places of the machine become marks or paths from the root of the
 * repository; and outside code, what GitHub would turn into a notice, a
 * mention, a reference or, in the writer's prose, a link, is written as
 * code. The cleaning is pure: it reads no file system and no environment
 * of its own; `machineContextOf`, which gathers what it cleans of, reads
 * the entries of the root of the machine.
 */
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import type { RunState } from '../checkpoint/fold.ts';
import { scratchSpellings } from './fix-report.ts';
import { codeParts, codeSpan, escapedText, windowsPath, withoutScratch } from './markdown.ts';

/** What the machine that ran the review holds, which no posted text may name. */
export interface MachineContext {
  /** The worktree that the run recorded; a path under it is written from the root of the repository. */
  readonly worktree: string;
  /** The checkpoint root, written `<checkpoint>`. */
  readonly checkpoint: string;
  /** The git common directory, written `<git>`. */
  readonly gitCommon: string;
  /** The directory of the engine, written `<engine>`. */
  readonly engine: string;
  /** The scratch directories of the run's workers as `scratchSpellings` gives them, written `<scratch>`. */
  readonly scratch: readonly string[];
  /** The command's environment, whose secret variables' values are redacted. */
  readonly environment: NodeJS.ProcessEnv;
  /** The operator's home directory, written `<local path>` with the path after it, before any other path: a name in it can hold a space, where the generic rule would end the path. */
  readonly home: string;
  /**
   * The names that the root of the machine holds, such as `home` and `tmp`;
   * a path that starts at one of them is local. Null when the root could
   * not be read, and then every path from the root is local: a route such
   * as `/pulls/42` posted as a mark loses a word, while a path of the
   * machine posted as written cannot be taken back.
   */
  readonly rootEntries: readonly string[] | null;
}

/** What `machineContextOf` gathers the machine of a run from. */
export interface MachineFacts {
  /** The worktree that the run recorded. */
  readonly worktree: string;
  /** The checkpoint root. */
  readonly checkpoint: string;
  /** The git common directory of the repository. */
  readonly gitCommon: string;
  /** The directory of the engine: the one that holds its entry. */
  readonly engine: string;
  /** The run's workers, whose scratch directories `scratchSpellings` spells. */
  readonly workers: RunState['workers'];
  /** The command's environment, the variables that hold a token for gh included. */
  readonly environment: NodeJS.ProcessEnv;
  /** The platform of the machine, which says where its root is. */
  readonly platform: NodeJS.Platform;
  /** The operator's home directory; the process's by default. */
  readonly home?: string | undefined;
  /** The names a directory holds, or null when it cannot be read; the root's are read once a process with the default. */
  readonly readDirectory?: (directory: string) => readonly string[] | null;
}

/** The names each root directory held when this process first read it, since the root of a machine does not change while a command runs. */
const readRoots = new Map<string, readonly string[] | null>();

/** The names a root directory holds, read once a process; null for one this process cannot read. */
function rootDirectoryEntries(directory: string): readonly string[] | null {
  if (readRoots.has(directory)) return readRoots.get(directory)!;
  let entries: readonly string[] | null;
  try {
    entries = readdirSync(directory);
  } catch {
    entries = null;
  }
  readRoots.set(directory, entries);
  return entries;
}

/**
 * The names a path from the root of the machine can start with (R11): off
 * Windows, the entries of `/`. On Windows a path from the root resolves on
 * a drive, so they are the letter of each drive that a place of the run or
 * the system drive is on, as a shell such as Git Bash spells a drive
 * (`/c/Users`), and the entries of the root of each such drive (`/Users`).
 * A UNC share is no drive, and its paths are cleaned as shares. Null when
 * a root cannot be read, so every path from the root counts as local.
 */
function rootEntriesOf(facts: MachineFacts): string[] | null {
  const read = facts.readDirectory ?? rootDirectoryEntries;
  if (facts.platform !== 'win32') {
    const entries = read('/');
    return entries === null ? null : [...entries];
  }
  const places = [facts.worktree, facts.checkpoint, facts.gitCommon, facts.engine, ...(facts.environment.SystemDrive === undefined ? [] : [`${facts.environment.SystemDrive}\\`])];
  const drives = [...new Set(places.flatMap((place) => /^([A-Za-z]):/.exec(place)?.[1]?.toUpperCase() ?? []))].sort();
  const roots = drives.map((drive) => read(`${drive}:\\`));
  if (roots.includes(null)) return null;
  return [...new Set([...drives.map((drive) => drive.toLowerCase()), ...roots.flatMap((entries) => entries ?? [])])];
}

/**
 * The machine a review cleans each text of (R11, "The cleaning (R11)" of
 * the design of the review on the pull request): the places of the run,
 * the spellings of the scratch directories of its workers, the command's
 * environment, whose secret values it redacts, the operator's home
 * directory, and the names a path from the root of the machine starts
 * with. The writer's task and `publish`
 * build theirs with it, so both clean alike.
 */
export function machineContextOf(facts: MachineFacts): MachineContext {
  return {
    worktree: facts.worktree,
    checkpoint: facts.checkpoint,
    gitCommon: facts.gitCommon,
    engine: facts.engine,
    scratch: scratchSpellings(facts.workers),
    environment: facts.environment,
    home: facts.home ?? homedir(),
    rootEntries: rootEntriesOf(facts),
  };
}

/** A cleaned text and the count of the secrets it no longer holds; never a value. */
export interface PublicText {
  readonly text: string;
  readonly secrets: number;
}

/**
 * A worker's words as a review posts them: cleaned, escaped as the report
 * escapes them, and with nothing that notifies an account or another
 * issue. What is code is read from the text as given, so the caller gives
 * it in the shape it posts it in: a text that it puts on one line or
 * splits into paragraphs is put on one line or split first, since a fence
 * joined onto one line or split in two is no longer code.
 */
export function publicWords(text: string, machine: MachineContext): PublicText {
  return cleaned(text, machine, 'words');
}

/** The writer's prose as a review posts it: as `publicWords`, and with no link and no image, since the review's links are the ones the engine builds. */
export function publicProse(text: string, machine: MachineContext): PublicText {
  return cleaned(text, machine, 'prose');
}

/**
 * A text that the caller writes as code, a cited command or a diagram,
 * cleaned of secrets and places only, since nothing in code notifies. The
 * caller chooses the delimiter of the code from the cleaned text, since a
 * place written as its mark can join two runs of backticks into a longer
 * one.
 */
export function publicCode(text: string, machine: MachineContext): PublicText {
  return withoutMachine(text, machine);
}

type Voice = 'words' | 'prose';

/**
 * A text cleaned in the design's order: secrets, then places
 * (`withoutMachine`), then what would notify. `escapedText` escapes each
 * plain part of `markdownParts`, so a span is read as the mentions are.
 */
function cleaned(text: string, machine: MachineContext, voice: Voice): PublicText {
  const { text: placed, secrets } = withoutMachine(text, machine);
  const parts = markdownParts(placed);
  const quiet = parts.map((part, index) => {
    if (part.code) return part.text;
    // A span written at the edge of plain text would join the backticks of
    // the code span beside it into one run; a space keeps the two apart.
    const plain = escapedText(quietPlain(part.text, voice));
    return `${parts[index - 1]?.code === true && plain.startsWith('`') ? ' ' : ''}${plain}${parts[index + 1]?.code === true && plain.endsWith('`') ? ' ' : ''}`;
  });
  return { text: quiet.join(''), secrets };
}

/**
 * A text with its secrets and the places of the machine written as marks,
 * the first two steps of the cleaning. The scratch directories go before
 * the other places, since the engine makes them under the system's
 * temporary directory, apart from the others, and `withoutScratch` takes a
 * prefix such as macOS's `/private` with them.
 */
function withoutMachine(text: string, machine: MachineContext): PublicText {
  const compiled = compiledOf(machine);
  let secrets = 0;
  const redact = (from: string, pattern: RegExp, mark: (found: string) => string): string => from.replace(pattern, (found) => {
    secrets += 1;
    return mark(found);
  });
  let redacted = secretForms.reduce((from, [kind, pattern]) => redact(from, pattern, () => `[redacted ${kind}]`), text);
  if (compiled.secretValues !== null) redacted = redact(redacted, compiled.secretValues, (value) => `[redacted value of ${compiled.secretNames.get(value)!}]`);
  const placed = compiled.places.reduce((from, [pattern, mark]) => from.replace(pattern, mark), withoutScratch(redacted, machine.scratch));
  return { text: withoutLocalPaths(compiled.home.reduce((from, pattern) => from.replace(pattern, localPathMark), placed), compiled.roots), secrets };
}

/**
 * The tokens of a known form, each with the kind its mark names. A private
 * key block goes first, since its body can hold any of the others, and an
 * Anthropic key before an OpenAI one, whose `sk-` it starts with. A block
 * cut before its end is redacted to the end of the text.
 */
const secretForms: readonly (readonly [kind: string, pattern: RegExp])[] = [
  ['private key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g],
  ['GitHub token', /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['Anthropic key', /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI key', /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g],
  ['AWS access key id', /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g],
  ['Slack token', /(?<![A-Za-z0-9_-])xox[A-Za-z]-[A-Za-z0-9-]{10,}/g],
];

/** A variable whose name says that it holds a secret. */
const secretName = /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL/i;

interface Compiled {
  /** The values of the environment's secret variables, longest first, or none. */
  readonly secretValues: RegExp | null;
  readonly secretNames: ReadonlyMap<string, string>;
  /** The checkpoint, the git common directory and the engine, longest first, each with its mark, then the worktree with a separator after it, which gives way to the path from the root. */
  readonly places: readonly (readonly [pattern: RegExp, mark: string])[];
  /** Each spelling of the home directory with the path after it, after the places and before the generic rule of `withoutLocalPaths`. */
  readonly home: readonly RegExp[];
  /** The root entries in lower case, or null when every path from the root is local. */
  readonly roots: ReadonlySet<string> | null;
}

/** The patterns of each machine, compiled once: a review cleans every text it posts with one context. */
const compiledContexts = new WeakMap<MachineContext, Compiled>();

function compiledOf(machine: MachineContext): Compiled {
  const known = compiledContexts.get(machine);
  if (known !== undefined) return known;
  const secretNames = new Map<string, string>();
  for (const [name, value] of Object.entries(machine.environment)) {
    if (value !== undefined && value.length >= 8 && secretName.test(name) && !secretNames.has(value)) secretNames.set(value, name);
  }
  const values = [...secretNames.keys()].sort((a, b) => b.length - a.length);
  const marked = ([[machine.checkpoint, '<checkpoint>'], [machine.gitCommon, '<git>'], [machine.engine, '<engine>']] as const)
    .flatMap(([directory, mark]) => spellings(directory).map((spelling) => [spelling, mark] as const))
    .sort(([a], [b]) => b.length - a.length);
  const places = [
    ...marked.map(([spelling, mark]) => [placePattern(spelling, String.raw`(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}_-])`), mark] as const),
    ...spellings(machine.worktree).map((spelling) => [placePattern(spelling, String.raw`[/\\]`), ''] as const),
  ];
  const compiled: Compiled = {
    secretValues: values.length === 0 ? null : new RegExp(values.map((value) => RegExp.escape(value)).join('|'), 'g'),
    secretNames,
    places,
    home: spellings(machine.home).map((spelling) => placePattern(spelling, String.raw`(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}_-])${rest}`)),
    roots: machine.rootEntries === null ? null : new Set(machine.rootEntries.map((entry) => entry.toLowerCase())),
  };
  compiledContexts.set(machine, compiled);
  return compiled;
}

/** A directory as recorded and with forward slashes, without a trailing separator; none for an empty one. */
function spellings(directory: string): string[] {
  const trimmed = directory.replace(/[\\/]+$/, '');
  return trimmed === '' ? [] : [...new Set([trimmed, trimmed.replaceAll('\\', '/')])];
}

/**
 * A directory where a path starts, not inside a longer name or path, and
 * followed by `after`. A Windows spelling matches in any case, as
 * `withoutScratch` matches one.
 */
function placePattern(spelling: string, after: string): RegExp {
  const escaped = RegExp.escape(spelling);
  return new RegExp(String.raw`(?<![\p{L}\p{N}_.~/\\-])${windowsPath(spelling) ? `(?i:${escaped})` : escaped}${after}`, 'gu');
}

/** One name of a path: no blank, separator, quote, bracket or other mark that ends a path in prose. */
const segment = String.raw`[^\s/\\'"\x60<>|:;,()[\]{}*?]+`;
const rest = String.raw`(?:[/\\]+${segment})*[/\\]*`;

/**
 * Each path left that starts at the root of the machine, at a drive
 * letter, at a UNC share or at `~`. One that starts at the root counts only
 * when the root holds its first name, compared in any case since a macOS
 * or Windows root ignores it, so a route such as `/pulls/42` stays, or
 * when the root could not be read. A path
 * inside a longer name or path, or after a mark such as `<git>`, is not
 * one; a URL's host is the first name of what follows its `//`, so a URL
 * stays as a whole. A separator may be doubled, as a path in a JSON
 * string spells a backslash, and a UNC share starts at a host's name.
 */
const localPath = new RegExp([
  String.raw`(?<![\p{L}\p{N}_.~>-])/(?<first>${segment})${rest}`,
  String.raw`(?<![\p{L}\p{N}_])[A-Za-z]:[/\\]+(?:${segment}${rest})?`,
  String.raw`(?<!\\)\\{2,}[A-Za-z0-9_.$-]+[/\\]+${segment}${rest}`,
  String.raw`(?<![\p{L}\p{N}_.~/\\-])~[A-Za-z0-9_.-]*[/\\]+(?:${segment}${rest})?`,
].join('|'), 'gu');

function withoutLocalPaths(text: string, roots: ReadonlySet<string> | null): string {
  return text.replace(localPath, (path: string, ...args: unknown[]) => {
    const { first } = args.at(-1) as { first: string | undefined };
    if (first !== undefined && roots !== null && !roots.has(first.replace(/[.!]+$/, '').toLowerCase())) return path;
    return localPathMark(path);
  });
}

/** A local path as its mark, with the marks that end a sentence after it, which a name can also end with. */
const localPathMark = (path: string): string => `<local path>${/[.!]*$/.exec(path)![0]}`;

/**
 * The parts of a text that GitHub shows as code and as Markdown: each fenced
 * block that closes, and in each paragraph outside them, the code spans of
 * `codeParts`. A span is matched within its paragraph, as CommonMark does,
 * and a fence that does not close is plain, so a doubt reads as plain text,
 * where a mention is then written as code.
 */
function markdownParts(text: string): { readonly code: boolean; readonly text: string }[] {
  const lines = text.split(/(?<=\n)/);
  const parts: { readonly code: boolean; readonly text: string }[] = [];
  let plain = '';
  const flush = (): void => {
    for (const paragraph of plain.split(/(\r?\n(?:[ \t]*\r?\n)+)/)) parts.push(...codeParts(paragraph));
    plain = '';
  };
  for (let at = 0; at < lines.length; at += 1) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[at]!);
    const fence = open?.[1];
    if (fence !== undefined && !(fence.startsWith('`') && lines[at]!.slice(open![0].length).includes('`'))) {
      const closer = new RegExp(`^ {0,3}${fence.charAt(0)}{${String(fence.length)},}[ \\t]*\\r?\\n?$`);
      const close = lines.findIndex((line, index) => index > at && closer.test(line));
      if (close !== -1) {
        flush();
        parts.push({ code: true, text: lines.slice(at, close + 1).join('') });
        at = close;
        continue;
      }
    }
    plain += lines[at];
  }
  flush();
  return parts;
}

/** The URL of an issue, a pull request or a discussion on any host, and what follows it, such as a comment's anchor. */
const issueUrl = String.raw`https?://[^\s/<>\x60]+/[^\s/<>\x60]+/[^\s/<>\x60]+/(?:issues|pull|pulls|discussions)/\d+[^\s<>\x60]*`;

/** Any URL that GitHub links. */
const anyUrl = String.raw`(?:(?:https?|ftp)://|www\.)[^\s<>\x60]+`;

/** A cross-repository reference, a `GH-<n>`, a `#<n>`, and an `@name` or team that does not follow a letter, a digit, a period or a slash. A `#<n>` after an ampersand is one too, since `plainMarks` escapes the ampersand, so no `#<n>` is part of an entity. */
const references = [
  String.raw`(?<![\p{L}\p{N}_./-])[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+#\d+(?![\p{L}\p{N}_])`,
  String.raw`(?<![\p{L}\p{N}_])[Gg][Hh]-\d+(?![\p{L}\p{N}_])`,
  String.raw`(?<![\p{L}\p{N}_])#\d+(?![\p{L}\p{N}_])`,
  String.raw`(?<![\p{L}\p{N}./])@[A-Za-z0-9_][A-Za-z0-9_-]*(?:/[A-Za-z0-9_][A-Za-z0-9_-]*)?`,
].join('|');

/** What each voice writes as code, after the run of backslashes before it, which `quietPlain` keeps from escaping the span's first backtick. */
const tokens: Readonly<Record<Voice, RegExp>> = {
  words: new RegExp(String.raw`(?<escape>\\*)(?:(?<url>${issueUrl})|${references})`, 'gu'),
  prose: new RegExp(String.raw`(?<escape>\\*)(?:(?<url>${anyUrl})|${references})`, 'gu'),
};

/** The ampersand of an HTML entity as CommonMark reads one, named, decimal or hexadecimal and ended by a semicolon; an ampersand before anything else is text. */
const entityAmpersand = String.raw`&(?=#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[A-Za-z][A-Za-z0-9]{1,31};)`;

/**
 * The marks that each voice escapes outside code: a backtick, which the
 * paragraph holds alone and which could join a span written next to it;
 * the ampersand of an HTML entity, which GitHub decodes after the
 * cleaning, such as `&#64;` into the `@` of a mention or `&#35;` into the
 * `#` of a reference; and in the writer's prose `[`, which opens a link or
 * an image. A mark that a backslash already escapes stays. The report
 * leaves an entity as written (TD6 of the report for the person), so only
 * the text a review posts escapes it.
 */
const plainMarks: Readonly<Record<Voice, RegExp>> = {
  words: new RegExp(String.raw`(?<!\\)((?:\\\\)*)(\x60|${entityAmpersand})`, 'g'),
  prose: new RegExp(String.raw`(?<!\\)((?:\\\\)*)(\[|\x60|${entityAmpersand})`, 'g'),
};

/**
 * Plain text with each token of its voice written as code (`codeSpan`,
 * whose delimiter is longer than any backtick run inside) and its plain
 * marks escaped. A URL keeps out the punctuation that ends a sentence and a
 * closing bracket it does not open, as GitHub does. An odd run of
 * backslashes before a token gets one more, so the run escapes itself and
 * not the span's backtick.
 */
function quietPlain(text: string, voice: Voice): string {
  // The marks are found in the whole text, since the entity an ampersand opens can go on into a token, as `&#35;` does into `#35`.
  const marks = [...text.matchAll(plainMarks[voice])];
  const marked = (from: number, to: number): string => {
    let escaped = '';
    let at = from;
    for (const mark of marks) {
      if (mark.index < from || mark.index >= to) continue;
      escaped += `${text.slice(at, mark.index)}${mark[1]!}\\${mark[2]!}`;
      at = mark.index + mark[0].length;
    }
    return escaped + text.slice(at, to);
  };
  let quiet = '';
  let at = 0;
  for (const match of text.matchAll(tokens[voice])) {
    const escape = match.groups!.escape!;
    const token = match[0].slice(escape.length);
    const code = match.groups!.url === undefined ? token : urlOf(token);
    quiet += `${marked(at, match.index)}${escape}${escape.length % 2 === 1 ? '\\' : ''}${codeSpan(code)}${token.slice(code.length)}`;
    at = match.index + match[0].length;
  }
  return quiet + marked(at, text.length);
}

/** A URL without the punctuation after it that ends a sentence, and without a closing bracket that it does not open. */
function urlOf(text: string): string {
  let url = text;
  for (;;) {
    const last = url.slice(-1);
    const unopened = (open: string): boolean => url.split(last).length > url.split(open).length;
    if (/[.,:;!?'"*_~]/.test(last) || (last === ')' && unopened('(')) || (last === ']' && unopened('['))) url = url.slice(0, -1);
    else return url;
  }
}
