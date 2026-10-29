/**
 * The lines `report --fixes` prints (R6 of the questions in the chat):
 * one for each fix of the run, for a person who asks what the run
 * changed. The chat form names the command and leaves the fixes to it
 * (PD9 of the report for the person); the brief's table gives them too.
 */
import type { RunState } from '../checkpoint/fold.ts';
import { briefOf, cutAtWord, fateWordsOf, firstSentence, fixFateWords, shortLineLimit } from './brief.ts';
import { lastFixAnswer } from './fix-report.ts';
import { findingWords, inlineText } from './markdown.ts';

/**
 * One line for each fix of a fix run that a fixer was given, in rank
 * order: its number, what became of it, and the subject of the commit
 * message of the answer that gave its last outcome; for an answer with no
 * message, the first sentence of its note; with no answer, why no fixer
 * attempted it. Each line is cut at a word at `shortLineLimit`. A run that
 * only reviewed gets one sentence that says what it would fix, and a fix
 * run that gave no finding to a fixer a sentence that says it applied
 * none.
 */
export function fixLines(state: RunState): string[] {
  const brief = briefOf(state);
  const review = state.review!;
  const fix = review.fix;
  const left = brief.findings.filter((finding) => finding.status === 'left').map((finding) => finding.number);
  const leftWords = left.length === 0 ? '' : ` It left ${findingWords(left)} as is.`;
  if (fix === null) {
    const planned = brief.findings.filter((finding) => finding.status === 'planned' || finding.status === 'planned-against-rule').map((finding) => finding.number);
    return [`This run only reviewed: it changed nothing.${planned.length === 0 ? '' : ` It would fix ${findingWords(planned)}.`}${leftWords}`];
  }
  // The fixes are the brief's findings, in rank order, whose last outcome has a fate in the brief's words.
  const fixes = brief.findings.flatMap(({ number, id }) => {
    const { outcome, answer, reason } = lastFixAnswer(review, fix, id);
    const fate = fateWordsOf[outcome];
    return fate === undefined ? [] : [{ number, fate, answer, reason }];
  });
  if (fixes.length === 0) return [`This run gave no finding to a fixer, so it applied no fix.${leftWords}`];
  return fixes.map(({ number, fate, answer, reason }) => {
    const words = answer === null ? reason ?? 'no fixer answered for it' : answer.message === null ? firstSentence(answer.note) : answer.message.subject;
    return cutAtWord(`Finding ${String(number)}, ${fixFateWords[fate]}: ${inlineText(words)}`, shortLineLimit);
  });
}
