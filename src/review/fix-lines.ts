/**
 * The lines `report --fixes` prints (R6 of the questions in the chat):
 * one for each fix of the run, for a person who asks what the run
 * changed. The fixes stay in the evidence, after what the person must
 * know and decide (PD3), so neither the brief nor its short form lists
 * them.
 */
import type { RunState } from '../checkpoint/fold.ts';
import { briefOf, cutAtWord, fateWordsOf, firstSentence, fixFateWords, idWords, readOnlyChangedSentence, shortLineLimit, type BriefChanged } from './brief.ts';
import { lastFixAnswer } from './fix-report.ts';
import { counted, inlineText } from './markdown.ts';
import { rankedFindings } from './state.ts';

/** What a fix run that gave no finding to a fixer changed, as one sentence: no fix, and what it left. */
const noFixSentence = (changed: BriefChanged): string => {
  const left = changed.left.length === 0 ? '' : ` It left ${counted(changed.left.length, 'finding', 'findings')}: ${idWords(changed.left)}.`;
  return `This run gave no finding to a fixer, so it applied no fix.${left}`;
};

/**
 * One line for each fix that the part "What deep-review changed" counts,
 * in rank order: its id, what became of it, and the subject of the commit
 * message of the answer that gave its last outcome; for an answer with no
 * message, the first sentence of its note; with no answer, why no fixer
 * attempted it. Each line is cut at a word at `shortLineLimit`. A run that
 * only reviewed gets the sentence of the brief that says so, and a fix run
 * that gave no finding to a fixer a sentence that says it applied none.
 */
export function fixLines(state: RunState): string[] {
  const { changed } = briefOf(state);
  const review = state.review!;
  const fix = review.fix;
  if (fix === null) return [readOnlyChangedSentence(changed, (id) => id)];
  // The fixes the part counts are the ranked findings whose last outcome has a fate in the brief's words, as its lists read them.
  const fixes = rankedFindings(review).flatMap(({ finding }) => {
    const { outcome, answer, reason } = lastFixAnswer(review, fix, finding.id);
    const fate = fateWordsOf[outcome];
    return fate === undefined ? [] : [{ id: finding.id, fate, answer, reason }];
  });
  if (fixes.length === 0) return [noFixSentence(changed)];
  return fixes.map(({ id, fate, answer, reason }) => {
    const words = answer === null ? reason ?? 'no fixer answered for it' : answer.message === null ? firstSentence(answer.note) : answer.message.subject;
    return cutAtWord(`${id}, ${fixFateWords[fate]}: ${inlineText(words)}`, shortLineLimit);
  });
}
