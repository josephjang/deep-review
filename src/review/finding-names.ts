/**
 * The names the review on a pull request gives the findings that a
 * worker's text names by id (the finding names in the review): each id of
 * the run in place of which the form writes the finding's name, in the
 * review's language, as the reader sees it numbered.
 */
import { codeParts } from './markdown.ts';

/** What an id of the run names: a numbered finding, the one a merged candidate joined included, or a candidate the verifiers refuted. */
export type NamedId = { readonly kind: 'finding'; readonly number: number } | { readonly kind: 'refuted' };

/** How a language names a finding in a worker's text (R1, R2, R5 of the finding names in the review). */
export interface FindingNaming {
  /** A numbered finding, as `finding 3`, or its number alone after the text `before` it that already says finding. */
  readonly finding: (number: number, before: string) => string;
  /** A candidate the verifiers refuted, which has no number, taking the article of the text `before` it and the noun of the text `after` it when they give one. */
  readonly refuted: (before: string, after: string) => string;
  /** A name that starts a sentence, as English capitalizes it. */
  readonly starting: (name: string) => string;
  /** The form of the particle right after a name that agrees with how the name is read; the particle as given in a language that has none. */
  readonly particle: (name: string, particle: string) => string;
}

/** An id of a finding or a candidate as the engine gives it, outside a path, a URL or a word: an angle's name in capitals, a hyphen and a whole number from 1. */
const idPattern = /(?<![\w/\\.#-])[A-Z]+-[1-9][0-9]*(?![\w-]|\/|\.\w)/g;

/** A URL in a text: a scheme and `://`, up to a space, an angle bracket or a parenthesis that closes no parenthesis of its own, as the one that ends a Markdown link's target. */
const urlPattern = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()]*(?:\([^\s<>()]*\)[^\s<>()]*)*/gi;

/** What can open a sentence before its first word: Markdown emphasis, an opening parenthesis or bracket, and an opening quote, as in `**RIPPLE-2** crashes` or `|"RIPPLE-2"|`. */
const sentenceOpening = String.raw`[*_(\["'“‘]*`;

/** Where a sentence starts: the start of a text, after the end of a sentence, or at the start of a line or a list item, past what opens the sentence. */
const sentenceStart = new RegExp(String.raw`(?:^|[.!?]["')\]]*\s+|\n[ \t]*(?:[-*+][ \t]+|[0-9]+\.[ \t]+)?)${sentenceOpening}$`);

/** A common abbreviation that ends in a period and goes on with its sentence, as `e.g.`, right before a name or what opens it: no sentence starts after it. */
const abbreviationBefore = new RegExp(String.raw`(?<![\p{L}\p{N}.])(?:i\.e|e\.g|vs|cf|etc|viz)\.\s+${sentenceOpening}$`, 'iu');

/** A Korean particle with two forms, written right after a name and followed by no other Hangul letter (R5, PD7). */
const particleAfter = /^(으로|로|은|는|이|가|을|를|과|와)(?!\p{Script=Hangul})/u;

/** One id of the run in a text: where it starts and ends, a code span that holds only it included, and what it names. */
interface Slot {
  readonly start: number;
  readonly end: number;
  readonly named: NamedId;
}

/** The matches of `pattern`, a global pattern, in a text outside code spans that start in no URL. */
function outsideUrls(text: string, pattern: RegExp): RegExpExecArray[] {
  const urls = [...text.matchAll(urlPattern)].map((url) => ({ start: url.index, end: url.index + url[0].length }));
  return [...text.matchAll(pattern)].filter((match) => !urls.some((url) => url.start <= match.index && match.index < url.end));
}

/** The ids of `names` in a text, in order: each outside code spans and URLs, and each code span whose whole text is one. */
function slotsOf(text: string, names: ReadonlyMap<string, NamedId>): Slot[] {
  const slots: Slot[] = [];
  let offset = 0;
  for (const part of codeParts(text)) {
    if (part.code) {
      const named = names.get(part.text.replace(/^`+ ?| ?`+$/g, ''));
      if (named !== undefined) slots.push({ start: offset, end: offset + part.text.length, named });
    } else {
      for (const match of outsideUrls(part.text, idPattern)) {
        const named = names.get(match[0]);
        if (named !== undefined) slots.push({ start: offset + match.index, end: offset + match.index + match[0].length, named });
      }
    }
    offset += part.text.length;
  }
  return slots;
}

/**
 * A worker's text as the review on a pull request posts it, each id of
 * the run in `names` replaced by its name (R1 to R3, R5 of the finding
 * names in the review): outside code spans, and for a code span whose
 * whole text is one such id, in place of the span. A name that starts a
 * sentence reads as one, a word around the id that already says what it
 * names is not said twice, and a Korean particle right after the id or
 * its span agrees with the name. Any other code, a word shaped like an id
 * that the run does not hold, such as `UTF-8`, and an id inside a path or
 * a URL stay as they are.
 */
export function namedFindings(text: string, names: ReadonlyMap<string, NamedId>, naming: FindingNaming): string {
  if (names.size === 0) return text;
  let out = '';
  let at = 0;
  for (const slot of slotsOf(text, names)) {
    out += text.slice(at, slot.start);
    const after = text.slice(slot.end);
    const plain = slot.named.kind === 'finding' ? naming.finding(slot.named.number, out) : naming.refuted(out, after);
    const name = sentenceStart.test(out) && !abbreviationBefore.test(out) ? naming.starting(plain) : plain;
    out += name;
    at = slot.end;
    const particle = particleAfter.exec(after);
    if (particle !== null) {
      out += naming.particle(name, particle[1]!);
      at += particle[1]!.length;
    }
  }
  return out + text.slice(at);
}

/**
 * Whether a diagram holds an id of `names` as an identifier, which leaves
 * the diagram out rather than show the id: an id joined to an arrow or an
 * edge on either side, as in `RIPPLE-2->>B`, `A---RIPPLE-2` or
 * `--RIPPLE-2`, included. An id that prose keeps (R3), inside a path, a
 * URL, a word or a code span longer than it, is no identifier, and
 * neither is one on a comment line, `%%`, which Mermaid does not show and
 * `diagramFailures` skips.
 */
function holdsId(diagram: string, names: ReadonlyMap<string, NamedId>): boolean {
  const leftover = new RegExp(String.raw`(?<![\w/\\.#])(?:${[...names.keys()].map((id) => RegExp.escape(id)).join('|')})(?![\w/]|\.\w)`, 'g');
  return diagram.split('\n').some((line) => !line.trim().startsWith('%%') && codeParts(line).some((part) => !part.code && outsideUrls(part.text, leftover).length > 0));
}

/** The kind of a diagram, from its first line. */
const diagramKind = (header: string): 'flowchart' | 'sequence' | 'state' | 'other' => (/^(?:flowchart|graph)\b/.test(header) ? 'flowchart' : /^sequenceDiagram\b/.test(header) ? 'sequence' : /^stateDiagram/.test(header) ? 'state' : 'other');

/**
 * A text a diagram shows between quotes or between bars, its marks
 * included, named as a text of its own. A quoted Mermaid markdown string,
 * whose whole text is between backticks as in "`RIPPLE-2 crashes`", is
 * named inside its backticks, unless its text is one id alone, which is
 * named whole as such a code span is in prose. A quoted text between bars
 * is named as a quoted text.
 */
function shownNamed(shown: string, named: (text: string) => string): string {
  const inner = shown.slice(1, -1);
  if (shown.startsWith('|')) {
    const quoted = /^(\s*)("[^"]*")(\s*)$/.exec(inner);
    return `|${quoted === null ? named(inner) : `${quoted[1]!}${shownNamed(quoted[2]!, named)}${quoted[3]!}`}|`;
  }
  const markdown = /^`([^`]+)`$/.exec(inner);
  return `"${markdown === null || /^ ?[A-Z]+-[1-9][0-9]* ?$/.test(markdown[1]!) ? named(inner) : `\`${named(markdown[1]!)}\``}"`;
}

/** A text of a diagram with each of its quoted texts, and with `bars` each of its texts between bars, named as a text of its own, and each other part named as it stands. */
function partsNamed(text: string, named: (text: string) => string, bars: boolean): string {
  return text.replace(bars ? /"[^"]*"|\|[^|]*\||[^"|]+/g : /"[^"]*"|[^"]+/g, (part) => (part.startsWith('"') || (bars && part.startsWith('|')) ? shownNamed(part, named) : named(part)));
}

/** The lines of a flowchart that style or link what is drawn, and its comments: `diagramFailures` reads no label in them. */
const flowchartUnread = /^\s*(?:(?:style|classDef|class|linkStyle|click)\b|%%)/;
/** The id of a node in a flowchart, as `diagramFailures` reads it. */
const nodeId = /^[\p{L}\p{N}_]+/u;
/** The opening of the text of an edge, as `diagramFailures` reads it: `--`, `-.` or `==` that is no part of a longer arrow, and no cross or circle arrow such as `--x`. */
const edgeTextOpening = /(?<![-=.<])<?(?:(?:--|==)(?![-=.>xo])|-\.(?![-=.>]))/y;
/** The second half of the arrow that ends the text of an edge, as `diagramFailures` reads it. */
const edgeTextClosing = /(?:-{2,}|={2,}|\.-+)[>ox]?/y;
/** The value of `label:` in the body of a node's `@{ ... }` shape, outside its quoted texts. */
const shapeLabel = /((?:^|[\s,])label\s*:)([^,]*)/;
/** The title of a subgraph given between brackets after its id, as `subgraph S [title]`. */
const subgraphBracketed = /^([ \t]+[^\s"[]+[ \t]*\[)([^\]"]*)(\].*)$/;

/** The text of an edge whose opening is at `at`, as `diagramFailures` reads it: where its text starts and ends, past each quoted text and text between bars, and where its closing arrow ends; null when none opens there or none closes. */
function edgeTextAt(line: string, at: number): { readonly start: number; readonly end: number; readonly closed: number } | null {
  edgeTextOpening.lastIndex = at;
  const opening = edgeTextOpening.exec(line);
  if (opening === null) return null;
  const start = at + opening[0].length;
  let end = start;
  while (end < line.length) {
    const char = line.charAt(end);
    if (char === '"' || char === '|') {
      const close = line.indexOf(char, end + 1);
      if (close === -1) return null;
      end = close + 1;
      continue;
    }
    edgeTextClosing.lastIndex = end;
    const closing = edgeTextClosing.exec(line);
    if (closing !== null) return { start, end, closed: end + closing[0].length };
    end += 1;
  }
  return null;
}

/**
 * A line of a flowchart with each text it shows named, walked as
 * `diagramFailures` walks it: each quoted text, each text between bars,
 * the text of each edge, the label of a node's `@{ ... }` shape, and the
 * title of a subgraph, between brackets or, with none, the rest of its
 * line. Node ids are left as they are.
 */
function flowchartLineNamed(line: string, named: (text: string) => string): string {
  if (flowchartUnread.test(line)) return line.replace(/"[^"]*"|\|[^|]*\|/g, (shown) => shownNamed(shown, named));
  const subgraph = /^([ \t]*subgraph\b)(.*)$/.exec(line);
  if (subgraph !== null) {
    const rest = subgraph[2]!;
    const bracketed = subgraphBracketed.exec(rest);
    if (bracketed !== null) return `${subgraph[1]!}${bracketed[1]!}${named(bracketed[2]!)}${bracketed[3]!}`;
    // A title alone is shown whole; an id with a quoted title between brackets keeps its id.
    return `${subgraph[1]!}${rest.includes('[') ? rest.replace(/"[^"]*"/g, (quoted) => shownNamed(quoted, named)) : partsNamed(rest, named, false)}`;
  }
  let out = '';
  let at = 0;
  while (at < line.length) {
    const edge = edgeTextAt(line, at);
    if (edge !== null) {
      out += `${line.slice(at, edge.start)}${partsNamed(line.slice(edge.start, edge.end), named, true)}${line.slice(edge.end, edge.closed)}`;
      at = edge.closed;
      continue;
    }
    const char = line.charAt(at);
    if (char === '"' || char === '|') {
      const close = line.indexOf(char, at + 1);
      if (close === -1) return `${out}${line.slice(at)}`;
      out += shownNamed(line.slice(at, close + 1), named);
      at = close + 1;
      continue;
    }
    const id = nodeId.exec(line.slice(at));
    if (id === null) {
      out += char;
      at += 1;
      continue;
    }
    out += id[0];
    at += id[0].length;
    if (!line.startsWith('@{', at)) continue;
    // The body of the shape runs to the first `}` outside a quoted text.
    let close = at + 2;
    while (close < line.length && line.charAt(close) !== '}') close = line.charAt(close) === '"' ? line.indexOf('"', close + 1) + 1 || line.length : close + 1;
    if (close === line.length) return `${out}${line.slice(at)}`;
    const body = line.slice(at + 2, close).replace(/"[^"]*"|[^"]+/g, (part) => (part.startsWith('"') ? shownNamed(part, named) : part.replace(shapeLabel, (_whole, open: string, value: string) => `${open}${named(value)}`)));
    out += `@{${body}}`;
    at = close + 1;
  }
  return out;
}

/** A line of a sequence diagram whose text after its keyword is shown whole, colons included: the label of a block, the alias of a participant, or the title. */
const sequenceLabel = /^([ \t]*(?:(?:loop|alt|else|opt|par|and|critical|option|break|box|title)[ \t]+|(?:participant|actor)[ \t]+\S+[ \t]+as[ \t]+))(.+)$/;

/** Where the first colon of a line outside its quoted texts is, which starts the text after the colon; -1 when it has none. */
function colonOf(line: string): number {
  for (const match of line.matchAll(/"[^"]*"|:/g)) if (match[0] === ':') return match.index;
  return -1;
}

/**
 * A diagram as the review posts it, each id of the run in `names`
 * replaced by its name in each text the diagram shows, as `diagramFailures`
 * reads them (R4 of the finding names in the review), each named as prose
 * is and as the start of a sentence; or null when an id of the run is left
 * in it as the identifier of a node, a participant or a state, which
 * Mermaid can show and the form cannot name. An id left where prose keeps
 * one, in a path, a URL or longer code, or on a comment line, does not
 * leave the diagram out.
 */
export function namedInDiagram(diagram: string, names: ReadonlyMap<string, NamedId>, naming: FindingNaming): string | null {
  if (names.size === 0) return diagram;
  const lines = diagram.split('\n');
  const headerAt = lines.findIndex((line) => line.trim() !== '');
  const kind = diagramKind(lines[headerAt]?.trim() ?? '');
  const named = (text: string): string => {
    const lead = /^\s*/.exec(text)![0];
    return `${lead}${namedFindings(text.slice(lead.length), names, naming)}`;
  };
  const labelled = (text: string): string => text.replace(/"[^"]*"|\|[^|]*\|/g, (shown) => shownNamed(shown, named));
  let inNote = false;
  const result = lines.map((line, index) => {
    if (index <= headerAt) return line;
    if (inNote) {
      if (/^\s*end\s+note\s*$/i.test(line)) inNote = false;
      else return named(line);
      return line;
    }
    if (kind === 'state' && /^\s*note\s/i.test(line) && !line.includes(':')) {
      inNote = true;
      return line;
    }
    if (kind === 'flowchart') return flowchartLineNamed(line, named);
    const label = kind === 'sequence' ? sequenceLabel.exec(line) : null;
    if (label !== null) return `${label[1]!}${partsNamed(label[2]!, named, false)}`;
    const colon = colonOf(line);
    if (colon !== -1) return `${labelled(line.slice(0, colon))}:${named(line.slice(colon + 1))}`;
    return labelled(line);
  }).join('\n');
  return holdsId(result, names) ? null : result;
}

/** The final consonant of how a Korean reader reads a whole number from 1, in Sino-Korean: none, `ㄹ`, or another, from the reading of its last digit or of its last power of ten. */
function numberFinal(digits: string): 'none' | 'rieul' | 'other' {
  const last = digits.at(-1)!;
  // 10, 100, 1000 and 10000 read 십, 백, 천 and 만, each with a final consonant other than ㄹ.
  if (last === '0') return 'other';
  return '2459'.includes(last) ? 'none' : '178'.includes(last) ? 'rieul' : 'other';
}

/** The final consonant of how a Korean reader reads the end of a name: its number, or its last Hangul syllable. */
function koreanFinal(name: string): 'none' | 'rieul' | 'other' {
  const digits = /[0-9]+$/.exec(name);
  if (digits !== null) return numberFinal(digits[0]);
  const code = name.charCodeAt(name.length - 1) - 0xac00;
  if (code < 0 || code > 11171) return 'other';
  const final = code % 28;
  return final === 0 ? 'none' : final === 8 ? 'rieul' : 'other';
}

/** The two forms of each Korean particle with two: after a final consonant, and after a vowel. */
const koreanForms: Readonly<Record<string, readonly [consonant: string, vowel: string]>> = {
  은: ['은', '는'], 는: ['은', '는'],
  이: ['이', '가'], 가: ['이', '가'],
  을: ['을', '를'], 를: ['을', '를'],
  과: ['과', '와'], 와: ['과', '와'],
  으로: ['으로', '로'], 로: ['으로', '로'],
};

/** The form of a Korean particle that agrees with how a name is read: `로`, not `으로`, after `ㄹ`. */
export function koreanParticle(name: string, particle: string): string {
  const forms = koreanForms[particle];
  if (forms === undefined) return particle;
  const final = koreanFinal(name);
  if (final === 'none') return forms[1];
  if (final === 'rieul' && forms[0] === '으로') return '로';
  return forms[0];
}
