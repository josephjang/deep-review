# Implementation plan: one edits field in the fixer's answer

Working plan for `2026-10-16-fixer-edits.md`, committed for the time the
work takes and removed by the last commit of the series. It is not part
of the proposal and records no decision; the proposal does.

Each step names every file it touches and the command that proves it.
Steps run in order; a step's checks pass before the next starts.

## 0. Branch

The pull request branch is `feat/fixer-edits`. The branch is named
before the first push (renaming a pushed branch closes its pull
request): either `git branch -m feat/fixer-edits` in this worktree, or
`git push -u origin HEAD:refs/heads/feat/fixer-edits` and
`gh pr create --head feat/fixer-edits` at step 8.

## 1. The reproducing test, failing first

File: `test/review/schemas.test.ts`, the describe of the fixer's output
schema.

- Add `it('refuses the answer of #54: a blocked finding with no files
  and a message')`: `fixerOutputSchema.safeParse(answer([finding(0, {
  status: 'blocked', files: [], requiredFiles: ['test/runtime/git-sync.test.ts'],
  message: { subject: 'fix(runtime): Bound only a detached git with the default timeout',
  body: 'Partial: no edit made. ...' } })]))` has `success === false`.
- Run: `node --import ./test/setup.ts --test test/review/schemas.test.ts`.
  Expected: this one test fails, because today the schema accepts the
  answer and only `checkFixerAnswer` refuses it. Do not continue until
  it fails for that reason.

## 2. The schema and the structural check

File: `src/review/schemas.ts`.

- In `fixerOutputSchema`, replace the `message` and `files` fields of a
  finding with
  `edits: z.strictObject({ files: z.array(reportedPath).min(1).max(200), message: z.strictObject({ subject: z.string().min(1).max(72), body: z.string().max(2000) }) }).nullable()`,
  with a doc comment: null for a finding with no edits; otherwise the
  files edited or created for it, or that hold an earlier attempt's
  edits, and their commit message, whatever the status (R1 of the
  proposal; R11 of commit series integrity).
- In `checkFixerAnswer`, delete the two pairing branches (lines 196 and
  197 today) and their comment; read the subject check from
  `finding.edits?.message`. Keep the index checks and the required-files
  check. Update the function's doc comment.
File: `src/review/fix-answer.ts`.

- `ResolvedAnswer.findings`: a named interface `ResolvedFinding`, the
  finding's fields other than `edits` plus resolved `files: readonly
  string[]`, `message` (the edits' message or null) and resolved
  `requiredFiles`, so `fixAnswerEvents` reads a flat finding as today.
- `resolveFixerAnswer`: `const files = [...new Set((finding.edits?.files ?? []).map(resolve))]`;
  `message: finding.edits?.message ?? null`; drop `edits` from the
  spread. Everything else unchanged.

File: `src/review/fix-events.ts`.

- `fixAnswerEvents`: no change needed if the resolved finding keeps
  `files` and `message`; confirm lines 191 and 192 compile. The
  `revisionMessage` reads `FixedFinding` (ledger shape), unchanged.

Run: `npm run typecheck`. Then
`node --import ./test/setup.ts --test test/review/schemas.test.ts`:
the step 1 test passes; the tests of the deleted branches fail, which
step 5 rewrites.

## 3. The prompts

File: `roles/fragments/fixer-report.md`.

- Replace the `files` bullet (lines 30 to 32) and the `message` bullet
  (lines 33 to 39) with one bullet:

  ```
  - `edits`: null when you made no edit for this finding and no earlier
    attempt left any; otherwise the `files` you edited or created for
    it, or that hold an earlier attempt's edits for it, and their
    `message`, a `subject` of at most 72 characters with no trailing
    period and a `body` that says why, in the style the repository's
    `git log` shows. A blocked or deferred finding with edits says in
    its message that the change is partial and what it waits for.
  ```

- Wrap as the file wraps today (about 72 columns). The exact bytes are
  the product: write once, do not reflow the rest of the file.

File: `roles/fragments/fixer-apply.md`, lines 21 to 23.

- "A refusal that comes after you edited leaves those edits in place:
  list them under the finding's `edits`, with a message that says the
  change is partial."

File: `src/review/tasks.ts`.

- `answerFields` (line 336): replace the `files` and `message` clauses
  with "the `edits` for it, null when you made no edit for it and no
  earlier attempt left any, otherwise the `files` you edited or created
  for it, or that hold an earlier attempt's edits for it, and their
  `message`, a `subject` of at most 72 characters with no trailing
  period and a `body` that says why, in the style `git log` shows for
  this repository, a blocked or deferred ${unit}'s saying the change is
  partial and what it waits for"; and the last sentence: "Every file you
  own whose bytes you changed must appear in some ${unit}'s `edits`".
- `earlierWork` (line 358): "for each of these you report
  `already-applied` with `edits` naming the files that hold its edits and
  the `message` its commit will carry, as for an applied ${unit}."
- `claimBlock` (line 317): "A refusal that comes after you edited leaves
  the edits in place, listed under the finding's `edits`, with a message
  that says the change is partial."
- Repair task (line 725): "The message in an applied check's `edits`
  describes what the repair changed."

Run: `npm run roles -- --output <scratch>/roles` and read the fixer
prompt once end to end for a sentence that still says `files` or
`message` as a top-level field.

## 4. The test runtime

File: `test/helpers/fake-runtime.ts`.

- `FixedFinding` (the scripted one, line 153): remove `message?: false`,
  which no test uses. Add `malformed?: 'message-without-files' |
  'files-without-message'` for the two shapes the schema now refuses.
- `fixerAnswer`: emit `edits: files.length > 0 ? { files, message } : null`,
  and for `malformed`, the refused shape (`{ files: [], message }` or
  `{ files, message: undefined }` left out of the object). Keep every
  other field.

## 5. The tests

- `test/review/schemas.test.ts`: the `finding` helper builds `edits`
  from `files` and `message` so the existing calls stay readable; the
  two "refuses, whatever the status" assertions on the deleted branches
  become schema refusals (`safeParse(...).success === false`) for a
  message with no files and files with no message; the "accepts a
  blocked or deferred finding with files and a message" test is
  unchanged; the subject tests pass `edits` with a message; the
  "compiles for both runtimes" test adds an assertion that the compiled
  `edits` property is `anyOf` of a closed object and `null`, and that
  `files` carries `minItems: 1`.
- `test/review/fix-answer.test.ts`: the `answer` helper (line 72)
  builds `edits`; the blocked cases pass `edits: null`; assertions
  unchanged.
- `test/review/fix-events.test.ts`: uses `fixerAnswer`; no change
  expected. Run it to confirm.
- `test/review/fix-pass.test.ts`: uses `fixerAnswer`; add one test, "a
  batch holding a blocked finding with no edits completes on its first
  attempt and the finding reaches the second round" (R3, R4 of the
  proposal): two clusters, cluster 1's finding blocked on cluster 2's
  file with `edits: null`, one applied finding beside it; assert no
  `attempt.failed`, the applied finding's commit carries the fixer's
  subject, the recorded blocked finding has `files: []` and `message:
  null`, and `fixes.replanned` lists it. Add one test that a `malformed:
  'message-without-files'` answer is a failed attempt whose reason
  starts with "The answer does not match the output schema", so the
  seam of step 4 is exercised. The R11 test at line 655 is unchanged.
- `test/review/tasks.test.ts`: lines 353 and 436 pin the new sentences.
- `test/roles/repository.test.ts`: lines 194, 208 and 209 pin the new
  sentences.

Run: `npm test`. Everything passes.

## 6. The documents

- `docs/changes/2026-10-09-commit-series-integrity.requirements.md`,
  R11 (line 346): append "Revised 2026-10-16: the pairing is the shape
  of the answer, one nullable `edits` field, and no longer a structural
  check (`2026-10-16-fixer-edits.md`)."
- `docs/changes/2026-10-01-fix-pass.design.md`, "Output schema and
  structural checks (R5)" (line 462): after the listing, "Revised
  2026-10-16: `message` and `files` are one nullable `edits` field, and
  the pairing check is gone (`2026-10-16-fixer-edits.md`)."
- `README.md`, lines 311 to 313: "a note, and for a finding it edited,
  the files and their commit message, which for a blocked or deferred
  finding says the change is partial".
- `docs/changes/2026-10-16-fixer-edits.md`: R7 names `README.md` too;
  Verification is filled at step 7 with what ran.

## 7. Checks, self-review, commits

- `npm run check`.
- `npm run smoke -- --claude <claude path> --codex <codex path> --codex-model <model>`
  with the smoke script's schema temporarily holding a nullable object
  whose array has `minItems: 1`, to settle D7 on Codex. Record the
  result in the proposal's Verification; if Codex refuses `minItems`,
  apply the fallback of D7 (schema `min(0)`, structural check for an
  `edits` with empty `files`) before going on.
- Self-review per the global rules: every hunk and its enclosing
  function; for each deleted line (the two check branches, the
  `message: false` seam, the old prompt sentences) name where the new
  code keeps its invariant; grep for `\.files\b` and `\.message\b` on
  fixer answers once more; `rg -n "names no file|carries none|change is partial" src roles test docs README.md`
  shows only the intended text.
- `npm run build`, then `npm run verify`.
- Commits, each passing `npm run check`:
  1. `feat(review): Carry a finding's files and message as one edits field`
     with the schema, the readers, the prompts, the test runtime, the
     tests and the document amendments (R6 of the proposal: prompt and
     schema in one commit).
  2. `chore(dist): Rebuild the engine for the edits field`.
  3. `docs(changes): Record the verification of the edits field` with
     the proposal's Verification filled in, and this plan file deleted.

## 8. The pull request

- Push: `git push -u origin feat/fixer-edits` (or the `HEAD:` form of
  step 0).
- `gh pr create --title "feat(review): Carry a finding's files and message as one edits field"`
  with a body in the Motivation / Modifications / Result form, written
  for a reader new to the repository, unwrapped lines, no local paths;
  the Mermaid figures of the proposal are reused after a render check;
  it links #54 and the proposal.
- After the pull request exists, the gate: a fix run of the engine on
  its own pull request from the rebuilt bundle, as the dogfood procedure
  does; its ledger must show no attempt refused for the pairing. The
  result goes into the proposal's Verification in a last docs commit.
