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

/** Where a sentence starts: the start of a text, after the end of a sentence, or at the start of a line or a list item. */
const sentenceStart = /(?:^|[.!?]["')\]]*\s+|\n[ \t]*(?:[-*+][ \t]+|[0-9]+\.[ \t]+)?)$/;

/** A Korean particle with two forms, written right after a name and followed by no other Hangul letter (R5, PD7). */
const particleAfter = /^(으로|로|은|는|이|가|을|를|과|와)(?!\p{Script=Hangul})/u;

/** One id of the run in a text: where it starts and ends, a code span that holds only it included, and what it names. */
interface Slot {
  readonly start: number;
  readonly end: number;
  readonly named: NamedId;
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
      const urls = [...part.text.matchAll(urlPattern)].map((url) => ({ start: url.index, end: url.index + url[0].length }));
      for (const match of part.text.matchAll(idPattern)) {
        const named = names.get(match[0]);
        const inUrl = urls.some((url) => url.start <= match.index && match.index < url.end);
        if (named !== undefined && !inUrl) slots.push({ start: offset + match.index, end: offset + match.index + match[0].length, named });
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
    const name = sentenceStart.test(out) ? naming.starting(plain) : plain;
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

/** Whether a diagram holds an id of `names` as a token of its own, an identifier joined to an arrow as in `RIPPLE-2->>B` included, which leaves the diagram out rather than show the id. */
const holdsId = (text: string, names: ReadonlyMap<string, NamedId>): boolean => [...names.keys()].some((id) => new RegExp(`(?<![\\w-])${RegExp.escape(id)}(?!\\w)`).test(text));

/** The kind of a diagram, from its first line. */
const diagramKind = (header: string): 'flowchart' | 'sequence' | 'state' | 'other' => (/^(?:flowchart|graph)\b/.test(header) ? 'flowchart' : /^sequenceDiagram\b/.test(header) ? 'sequence' : /^stateDiagram/.test(header) ? 'state' : 'other');

/** The texts a line of a flowchart shows besides its quoted texts and its texts between bars: each as a pattern whose second group is the text. */
const flowchartTexts: readonly RegExp[] = [
  /((?:--|==|-\.)[ \t]+)([^-=."|\s][^"|]*?)([ \t]+(?:-->|==>|\.->|---|===|-\.-))/g,
  /^([ \t]*subgraph[ \t]+\S+[ \t]*\[)([^\]"]*)(\])/,
];

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
 * anywhere in it, as the identifier of a node, a participant or a state,
 * which Mermaid can show and the form cannot name.
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
  const labelled = (text: string): string => text.replace(/"[^"]*"|\|[^|]*\|/g, (shown) => `${shown.charAt(0)}${named(shown.slice(1, -1))}${shown.charAt(0)}`);
  // A shown text whose quoted parts are each named as a text of their own, and whose other parts are named as they stand.
  const quotedOrNot = (text: string): string => text.replace(/"([^"]*)"|[^"]+/g, (part, quoted?: string) => (quoted === undefined ? named(part) : `"${named(quoted)}"`));
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
    if (kind === 'flowchart') return flowchartTexts.reduce((text, pattern) => text.replace(pattern, (_whole, open: string, shown: string, close: string) => `${open}${named(shown)}${close}`), labelled(line));
    const label = kind === 'sequence' ? sequenceLabel.exec(line) : null;
    if (label !== null) return `${label[1]!}${quotedOrNot(label[2]!)}`;
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
