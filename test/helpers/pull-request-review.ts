// The review of a pull request as the form renders it, for the tests of the
// form and of the tables of its words: a read-only run of a pull request
// with a fix, a question and a refuted candidate, the writer's answer for
// it, the files GitHub gives, and the machine the cleaning works against.
import assert from 'node:assert/strict';
import type { RunState } from '../../src/checkpoint/fold.ts';
import type { PullRequestFile } from '../../src/github/pull-request.ts';
import type { RecordedAnswer } from '../../src/review/explanation.ts';
import { placeFindings, pullRequestForm, type FormRefusal, type PullRequestForm, type PullRequestFormInput } from '../../src/review/pull-request-form.ts';
import type { MachineContext } from '../../src/review/public-text.ts';
import { answerableDecisions, candidate, changeReading, explanation, History, pullRequestScope, readOnlyReported, settingsBlockV2, withBaseChecks, withCitedRuns, withDocumentationStep, withPullRequest, worker } from './review-history.ts';

/** The patch of `src/a.ts` GitHub gives: lines 1 to 3 of the new side are context, line 4 added, 5 and 6 context. */
const patchOfA = '@@ -1,5 +1,6 @@\n line 1\n line 2\n line 3\n+added 4\n line 5\n line 6';

/** The files of the pull request: `src/a.ts` with `patch`, and `src/big.ts` with none, as GitHub gives a large file. */
export const filesWith = (patch: string | null = patchOfA): PullRequestFile[] => [
  { path: 'src/a.ts', status: 'modified', previousPath: null, patch },
  { path: 'src/big.ts', status: 'modified', previousPath: null, patch: null },
];

/** The history with each event `change` gives a new payload for, at its version, the others as they are. */
export function rewritten(history: History, change: (kind: string, payload: Record<string, unknown>) => unknown): History {
  const result = new History();
  for (const event of history.events) result.add(event.kind, change(event.kind, event.payload as Record<string, unknown>) ?? event.payload, event.version);
  return result;
}

/** A run with a refuted candidate beside the findings: RIPPLE-2 at `src/a.ts:9`, which the verifier of RIPPLE-1 refuted. */
const withRefuted = (history: History): History => rewritten(history, (kind, payload) => {
  if (kind === 'candidates.recorded' && payload.key === 'RIPPLE') return { ...payload, candidates: [...(payload.candidates as unknown[]), candidate('RIPPLE-2', 'RIPPLE', { line: 9, rawLine: 9, summary: 'a stale cache entry after logout' })] };
  if (kind === 'verification.planned' && payload.phase === 'verification') return { ...payload, groups: [{ id: 'g1', candidateIds: ['RIPPLE-1', 'RIPPLE-2'] }] };
  if (kind === 'verdicts.recorded' && payload.phase === 'verification') return { ...payload, verdicts: [...(payload.verdicts as unknown[]), { id: 'RIPPLE-2', verdict: 'REFUTED', evidence: 'a guard on line 2 clears the entry first' }] };
  return undefined;
});

/** The history with its `review.configured` given the settings' `values` and `layers` over those of `settingsBlockV2`. */
export const withSettings = (history: History, values: Record<string, unknown>, layers: Record<string, unknown> = {}): History => rewritten(history, (kind, payload) => {
  if (kind !== 'review.configured') return undefined;
  const block = settingsBlockV2() as { values: Record<string, unknown>; layers: Record<string, unknown> };
  return { ...payload, settings: { ...block, values: { ...block.values, ...values }, layers: { ...block.layers, ...layers } } };
});

/** The run before its pull request: decided as `decided` says, with a refuted candidate, its report written. */
const decidedRun = (decided: readonly unknown[]): History => withCitedRuns(withBaseChecks(withDocumentationStep(withRefuted(readOnlyReported(decided)), null)));

/**
 * A read-only run of the pull request, decided as `decided` says, a fix
 * against a written rule on RIPPLE-1 and a question on SWEEP-1 by
 * default, with a refuted candidate, explained as `recorded` records it,
 * its report written.
 */
export const pullRequestRun = (decided: readonly unknown[] = answerableDecisions(), recorded: Record<string, unknown> = explanation(worker(60))): History =>
  withPullRequest(decidedRun(decided), (history) => history.worker(60, 'writer explanation:explanation').add('explanation.recorded', recorded));

/** A read-only run of the pull request as an engine before the explanation recorded one: its scope captured at version 3 and configured at version 9, so it plans no writer. */
export function pullRequestRunBeforeExplanation(): History {
  const result = new History();
  for (const event of decidedRun(answerableDecisions()).events) result.add(event.kind, event.kind === 'scope.captured' ? pullRequestScope : event.payload, event.kind === 'scope.captured' ? 3 : event.version);
  return result;
}

/** The run's state with the triage's account of the change, which the histories here record none of. */
export const withAccount = (state: RunState): RunState => ({ ...state, review: { ...state.review!, change: { kind: 'given', reading: changeReading as never } } });

/** A recorded answer that kept its conclusion and its account. */
export type WholeAnswer = Omit<RecordedAnswer, 'conclusion' | 'account'> & { conclusion: NonNullable<RecordedAnswer['conclusion']>; account: NonNullable<RecordedAnswer['account']> };

/** The writer's answer for a run whose fix is RIPPLE-1 and whose question is SWEEP-1: every part passed, and SWEEP-1 marked unexplained. */
export const writerAnswer = (): WholeAnswer => ({
  conclusion: {
    why: 'An empty input still crashes parse(), and the author must choose how parse treats one.',
    actions: [{ id: 'SWEEP-1', sentence: 'Choose whether parse accepts an empty input.' }, { id: 'RIPPLE-1', sentence: 'Guard the null before parse reads it.' }],
    diagram: 'flowchart LR\n  A["empty input"] --> B["parse()"]',
  },
  account: {
    terms: [{ term: '`parse()`', meaning: 'reads a file into a value.' }],
    problem: { text: 'An empty file made parse() throw.', diagram: 'flowchart LR\n  E["empty file"] --> T["throw"]' },
    change: { text: 'parse() returns null for an empty file.', diagram: null },
  },
  findings: [
    {
      id: 'RIPPLE-1',
      unexplained: false,
      title: 'parse() reads the null before any guard.',
      problem: 'A caller that passes an empty file meets a crash.',
      cases: [{ sentence: 'An empty file reaches the read on line 4', lines: { side: 'head', path: 'src/a.ts', from: 3, to: 4 } }, { sentence: 'The removed guard stood here', lines: { side: 'base', path: 'src/gone.ts', from: 2, to: 2 } }],
      diagram: 'sequenceDiagram\n  Caller->>parse: an empty file\n  parse-->>Caller: crash',
      decision: 'deep-review would guard the null once, so every caller is safe.',
    },
    { id: 'SWEEP-1', unexplained: true, reason: 'Its evidence names no line of the head.' },
  ],
});

/** The writer's answer with one area for RIPPLE-1, the major fix, drawn by `diagram`. */
export function answerWithArea(diagram: string | null): WholeAnswer {
  return { ...writerAnswer(), areas: [{ title: 'Parsing an empty input', intro: 'What parse() does with an empty file.', diagram, findings: ['RIPPLE-1'] }] };
}

/** The machine of the histories here, whose worktree is `/w`. */
export const machine: MachineContext = { worktree: '/w', checkpoint: '/w/.git/deep-review-checkpoint', gitCommon: '/w/.git', engine: '/opt/deep-review', scratch: [], environment: {}, home: '/home/me', rootEntries: ['home', 'opt', 'tmp', 'w'] };

/** The form of a state against the files given, refused or not. */
export function renderedOf(state: RunState, answer: RecordedAnswer | null = writerAnswer(), files: PullRequestFile[] = filesWith(), change: Partial<PullRequestFormInput> = {}): PullRequestForm | FormRefusal {
  return pullRequestForm({ state, answer, places: placeFindings(state.review!, files), machine, engine: '0.0.0+dev', serial: 1, ...change });
}

/** The same, which must be rendered. */
export function formOf(...args: Parameters<typeof renderedOf>): PullRequestForm {
  const form = renderedOf(...args);
  assert.equal(form.kind, 'rendered', JSON.stringify(form));
  return form as PullRequestForm;
}
