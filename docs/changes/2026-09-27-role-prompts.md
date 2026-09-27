# Change Proposal: Role prompts

## Summary

The prompts the engine gives its workers become sources this repository
owns. The proof of concept assembled twenty-one role prompts from the
prompt-only `deep-review` skill in `agent-skills`: six agent definitions
and eighteen reference files, composed by include markers inside the agent
files and by a manifest beside them. Here they are twenty-eight fragments
under `roles/fragments/` and one manifest, `roles/manifest.json`, that
lists for each role the fragments its prompt is joined from, in order; one
assembler reads them, holds each fragment to a few invariants, and hands
the engine each role's prompt and its hash. The move keeps every prompt as
the proof of concept produced it, and a second commit then replaces the
wording that named Claude Code's subagent mechanism and tools with
runtime-neutral wording, and nothing else. Which model tier, effort,
access, shell, budget and timeout a role runs with, what it must return,
and whether a runtime needs a different setting are decided with the
phases that first run each role.

## Problem

The plan's fifth principle is that role prompts are owned by this
repository, and until now no engine carried its prompts.

- The proof of concept's `roles.json` pointed at files of the prompt-only
  skill (`skills/deep-review/references/` and
  `skills/deep-review/runtimes/plugin/agents/`), so a prompt changed
  whenever that skill did, and the engine knew which text a run used only
  by a hash computed at build time.
- Composition was declared in two places at once: `<!-- include: -->`
  markers inside each agent file and a `sources` list per role in the
  manifest. Nothing checked that the two agreed, and the `documentation`
  role got the fixer's documentation section twice, once through the
  fixer agent's marker and once from its `sources`. Nobody noticed,
  because the assembled text was never read.
- The text addresses a Claude Code subagent. It tells the reader to spawn
  `Agent` calls with a `subagent_type`, to call `AskUserQuestion`, to
  `Grep`, that "the orchestrator" reads its final message, and that rules
  live "in the agent definition" which "the runtime delivers". The proof
  of concept's Codex workers received the same text. The runtime adapter
  removed the last Claude tool names from the engine's contract (its TD3);
  the prompts are the last Claude-shaped piece.
- No invariant held the sources. A fragment saved with CRLF, without a
  final newline, with a byte order mark, or with a marker the assembler
  did not resolve would have reached a worker as it was.

This is the fourth element of the plan and the last before the first
end-to-end review, which will run these prompts through the runtime
adapter for the first time. It was read at `agent-skills` commit
`822986e`, whose role sources and assembled roles were last changed at
`53f7012`, and written against `8c2a15c` of this repository.

## Goals

- Every prompt a worker receives is assembled from files in this
  repository, and one file states each role's composition.
- The prompts a worker receives after the move are what the proof of
  concept produced, and the proof of that is recorded.
- The prompts name no mechanism, tool or file of one runtime that a
  worker on another runtime lacks.
- A fragment that breaks the assembly's invariants is refused by name,
  before any prompt is assembled.
- A reader can produce and read the assembled prompt of any role without
  running a review.

## Non-Goals

- No role policy. Which model tier, effort, access, shell, budget and
  timeout each role runs with is decided when the phase that runs it is
  implemented, with a real run to measure against; the proof of concept's
  values are recorded under D6 for that decision.
- No per-runtime policy overrides. The proof of concept lowered
  `deduplication` and raised `verifier` on Codex only; the reasons it gave
  hold for both runtimes or for neither, so the overrides are not carried,
  and the question is reconsidered with the policy (D6).
- No output schemas. What a role must return is defined by the phase that
  reads it, and a schema with no consumer cannot be tested against
  anything (D9).
- No rewriting of the phase narration. Several fragments were written for
  the driver of the prompt-only skill and describe its bookkeeping:
  checkpoint files such as `fixes.md` and `audit.md`, dispatch order, file
  ownership, "Phase 0" and "Phase R". Under the engine a worker does none
  of that. Deciding what each worker needs to know is the job of the
  element that defines that worker's task and output; here only the
  wording that names a mechanism the worker does not have changes (D5).
- No change to what the `CONVENTIONS` angle reviews. Its text names
  `CLAUDE.md` files only; widening it to `AGENTS.md` and other instruction
  files changes what the angle finds, and is decided with the first real
  run.
- No shipping. How the roles reach an installed engine is the first
  end-to-end element's question, as it is for the engine itself (runtime
  adapter, Non-Goals).
- No ledger event. A role policy is pinned when a run exists to pin it on,
  and the assembled prompt is already frozen as evidence by every worker
  launch.
- The four references only the prompt-only driver included
  (`overview.md`, `phase0-scope.md`, `resume.md`, `report.md`) are not
  moved. The engine is the driver; the element that needs one of them
  takes it then.
- The Claude continuation budget question and the runtime-neutral usage
  view (runtime adapter, Open Questions) stay with the first end-to-end
  element.

## Requirements

- R1: `roles/manifest.json` lists every role and, per role, the ordered
  names of the fragments its prompt is joined from; `roles/fragments/`
  holds the fragments; the manifest is the only composition rule, and a
  fragment that carries an include marker is refused.
- R2: One function assembles every role and returns, in manifest order,
  each role's key, its fragments with the SHA-256 of each, its prompt,
  which is the fragments' text joined with one blank line, and the
  SHA-256 of the prompt.
- R3: A fragment is a regular file of UTF-8 text without a byte order
  mark, with LF line endings and no NUL, not empty, ending in exactly one
  newline, not starting with a blank line, with no front matter and no
  include marker; each violation is refused naming the fragment.
- R4: A manifest has schema version 1 and at least one role; a role key
  is letters, digits and single dashes, starting with a letter and ending
  with a letter or digit; a fragment name is lower-case words joined by
  single dashes with the `.md` extension and no directory part; a role
  names at least one fragment and none twice; every entry under
  `fragments/` is a fragment some role names.
- R5: At the move commit, each role's assembled prompt equals the proof of
  concept's assembled role after leading, trailing and repeated blank
  lines are collapsed, with one named exception: `documentation` is equal
  once the second copy of the fixer's documentation section is removed
  from the proof of concept's text. The comparison and the hashes are
  recorded under Verification.
- R6: After the wording commit, no fragment says `subagent`, `Agent` call,
  `subagent_type`, `AskUserQuestion`, `orchestrator`, `agent` for a
  worker, `agent definition`, `Grep`, `tier table`, or the name of a Claude
  Code subagent (`deep-review-lead` and the others), and a test holds every
  fragment to that list.
- R7: `npm run roles` prints one line per role with its key, fragment
  count, size and hash; `--output DIR` also writes each prompt to
  `DIR/<key>.md` and refuses a directory that exists.
- R8: The commit that moves the text changes no prompt text; the commit
  that changes wording changes nothing under `roles/` but that wording, and
  carries the test that pins it.
- R9: The README describes `roles/`, and the suite covers R2, R3, R4, R6
  and R7 on Windows, macOS and Linux.

## Decisions

- **D1: Composition lives in the manifest alone.** Include markers inside
  fragments, which the proof of concept had, were rejected: with markers a
  role's final text is the sum of a manifest entry and whatever markers
  the named files carry, at any depth, and the duplicated section in
  `documentation` is what that produces. With the manifest alone, one
  entry is the whole composition, a reviewer reads it in one place, and
  the assembler refuses a marker outright.

- **D2: Each agent file is split at its markers into fragments, and its
  front matter is not moved.** The proof of concept's agent files
  interleaved their own text with markers: the lead's brief, then the
  output contract, then its verify instructions, then the rubrics. Under
  D1 the text between markers becomes fragments of its own, and the
  manifest lists them in the original order. The twenty-eight fragments
  are, from the agent files, `lead-brief`, `lead-verify`, `analyst-brief`,
  `scout-brief`, `conventions-brief`, `auditor-brief`, `fixer-role`,
  `fixer-apply`, `fixer-tests` and `fixer-report`, and from the
  references, under their own names, `finder-lead`, `finder-output`,
  `angles-scan`, `angles-analyst`, `angles-scout`, `angles-conventions`,
  `rubrics`, `phase1-finders`, `phase2-verify`, `phase3-sweep`,
  `phase4-list`, `postreview-fix-test`, `fixer-brief`,
  `fixer-documentation`, `fixer-validation`, `step3-audit`,
  `step3-verdicts` and `step3-actions`. The front matter, a Claude Code
  subagent's name, description, model, effort and tools, was never part
  of a prompt: the proof of concept's assembler stripped it before
  joining. It is the role policy this element leaves out, and its values
  are in D6.

- **D3: Fragments are joined with one blank line, and a fragment ends in
  exactly one newline.** The proof of concept produced one blank line at
  a marker and two between an agent file and a source, several references
  ended in a blank line of their own, and the stripped front matter left
  a blank first line, so its prompts had runs of two and three blank lines
  at the seams and started with one. One rule replaces that. The cost is
  that the move is not byte-identical at the seams, which is why R5
  compares after collapsing blank lines and says so.

- **D4: The move and the wording change are separate commits.** AGENTS.md
  separates a commit that changes what a skill says from one that changes
  where its text lives. A role prompt is a prompt in the same sense, its
  bytes are what a worker receives, and the rule applies. A reviewer of
  the first commit checks that nothing is said differently, which R5
  proves mechanically; a reviewer of the second sees only wording.

- **D5: The wording change is the smallest that removes what is false
  under the engine.** Three kinds of text change and nothing else.
  Identity: a "subagent of the deep-review skill" becomes a "worker of the
  deep-review engine", "the orchestrator" becomes "the engine", an "agent"
  that means a worker becomes a "worker", and "the agent definition" that
  "the runtime delivers" becomes "the role prompt" every worker of that
  role receives. Mechanism: an `Agent` call with a `subagent_type`, "a
  single message block" and "the tier table above" become a worker,
  workers run in parallel, and no table; the `AskUserQuestion` passage
  becomes a statement about an interactive run, with the engine
  continuing the worker with the answers; a `deep-review-fixer` to
  dispatch becomes a fixer. Tools: "Grep for" becomes "search for".
  Everything else stays, including the driver's bookkeeping named in
  Non-Goals and every mention of `CLAUDE.md`. Rewriting each prompt for
  its worker was rejected here because the pilots validated these
  semantics and nothing has run them under this engine yet; that rewrite
  belongs after the first real run, with its evidence. Per-runtime
  variants of each prompt were rejected because the differences are a
  handful of words and two copies of 115 KB of text would drift.

- **D6: Role policy is deferred, and the proof of concept's values are
  recorded here for that decision.** The agent front matter gave each
  role a Claude Code model, an effort and a tool list; in the runtime
  adapter's terms every role but the fixer's is read-only with a shell,
  and the fixer's are edit with a shell.

  | Agent file | Roles | Model | Effort | Tools |
  |---|---|---|---|---|
  | lead | triage, angle-decision, finder-SCAN, deduplication, verifier, sweep, merge-rank, test-assessment | opus | high | Bash, Read, Grep, Glob |
  | analyst | finder-REMOVALS, finder-DESIGN, finder-ALTITUDE | opus | high | Bash, Read, Grep, Glob |
  | scout | finder-RIPPLE, finder-FOOTGUNS, finder-WRAPPERS, finder-EFFICIENCY, finder-DUPLICATION | sonnet | high | Bash, Read, Grep, Glob |
  | conventions | finder-CONVENTIONS | sonnet | medium | Bash, Read, Grep, Glob |
  | fixer | fixer, documentation, answer | opus | high | Bash, Read, Grep, Glob, Edit, Write |
  | auditor | auditor | opus | xhigh | Bash, Read, Grep, Glob |

  Every worker also ran with a budget of 8 USD and a timeout of 600
  seconds, the proof of concept's run-level defaults, not a per-role
  choice. On Codex only, `deduplication` was lowered to the fast tier at
  medium effort and `verifier` raised to xhigh effort. The reasons the
  code gave, that exact-location grouping cannot refute a finding and
  that the verifier can dismiss one, do not depend on the runtime, so if
  they hold they hold for both runtimes; whether they hold is decided
  with the policy, against a real run. Writing a policy now was rejected
  because every value would be a guess with nothing to measure it
  against, and the runtime adapter requires each value as an explicit
  input, so an unmeasured default would still be a decision.

- **D7: All twenty-one roles move now.** Moving only the roles the first
  end-to-end element needs, the read-only ones, was rejected: the
  fragments are shared across roles, a second move later would be a
  second "where the text lives" change over the same files, and a role
  that turns out unnecessary is removed then, with any fragment only it
  named refused as unused by R4.

- **D8: The duplicate in `documentation` is dropped at the move.**
  Keeping it would need the manifest to allow a fragment twice in one
  role, a rule with no other use, and a prompt that repeats a section
  says nothing more. This is the one place the move changes what a prompt
  contains, and R5 names it.

- **D9: Output schemas arrive with the phases that read them.** Defining
  all twenty-one schemas here was rejected: a schema is the contract
  between a worker and the phase that consumes its answer, it is shaped by
  that consumer, and without one it can be tested only against itself.
  The prompts describe each answer in prose; the phase that adds the
  schema holds the two together.

- **D10: A worker that runs a role is labelled with its role key.** The
  runtime adapter left the meaning of `label` to this element. The role
  key is what every later phase needs to know about a worker on the
  ledger, and it is the key the prompt's hash is looked up by.

- **D11: The sources live at `roles/`, not under `skill/`, and assembled
  prompts are not committed.** `skill/` holds the installable artifacts
  that `npm run verify` compares byte for byte with `dist/`; the roles
  are engine assets the engine reads, and how they ship is the next
  element's decision. Committing assembled prompts beside the fragments
  was rejected as a second copy of the same text that a build would have
  to keep in step; `npm run roles` produces them on demand.

- **D12: Unified form.** The Split form is for a change whose technical
  side needs its own review. The technical side here is a manifest, a
  join and a list of invariants, and it fits in the decisions above.

## Risks

- Wording changes with no run to observe them. Accepted and contained: D5
  limits the change to what is false under the engine, R6 pins it, and
  the first end-to-end element's real run is the check.
- The driver's bookkeeping stays in worker prompts. A finder reads
  instructions about checkpoint files it will never write, which costs
  tokens and may confuse it. Accepted until the element that defines each
  worker's task decides what that worker needs.
- Two copies of the text now exist, the prompt-only skill's in
  `agent-skills` and this repository's, and they will diverge. Accepted;
  the starting decision to carry only the engine-driven skill implies it.
- The `CONVENTIONS` angle reads `CLAUDE.md` only, so a worker reviewing a
  repository governed by `AGENTS.md` returns nothing for that angle.
  Accepted until the first real run.
- A repeated key in `manifest.json` is not an error to `JSON.parse`; the
  last definition wins silently. Mitigated by the test that pins the exact
  list of role keys.
- The comparison of R5 is a one-time check, not a permanent test, because
  the wording commit changes the prompts on purpose. Its result is
  recorded under Verification with the proof of concept's commit, so it
  can be repeated.

## Verification

Run on the author's Windows 11 machine on 2026-09-27, Node 26.10.0,
against the two commits of this element, `362a89f` (the move) and
`a9971c2` (the wording).

- `npm run check` passes at both commits: lint, typecheck and every test,
  with the 3 symlink cases skipped that this Windows account has always
  skipped. `npm run verify` matches both artifacts, as `dist/` is
  untouched.
- The move (R5): at `362a89f` every role was assembled by `assembleRoles`
  and compared with the proof of concept's assembled role
  (`dist/deep-review-node/plugin/driver/roles/<key>.md` in `agent-skills`
  at `822986e`, whose assembled `manifest.json` has SHA-256
  `1f2a0f007bd1d3331be8de0607c6813170fd453524c82e1e8a345939f0bab422`)
  after leading, trailing and repeated blank lines were collapsed. Twenty
  of twenty-one are equal. `documentation` is equal once the second copy
  of `fixer-documentation` is removed from the proof of concept's text,
  where the 1400-byte section appears twice (12404 bytes against 10998).
  The byte differences in the table are the blank lines of D3.

  | Role | POC bytes | Bytes | SHA-256 at the move |
  |---|---|---|---|
  | triage | 26615 | 26602 | `8db71990846a5b7cb41635d2a7bc190c04da79cb4755290c8cddc860a2e7b498` |
  | angle-decision | 26615 | 26602 | `8db71990846a5b7cb41635d2a7bc190c04da79cb4755290c8cddc860a2e7b498` |
  | finder-SCAN | 12467 | 12461 | `c034a18ba74d8c7512e688fc5e16ed2b802f73cb83ddd22638f66ce847e40198` |
  | finder-REMOVALS | 5203 | 5198 | `c3c2e31e5ef9d3b20258fca1a6293753bf1f5278cce227f5a835d2bcb53e7390` |
  | finder-RIPPLE | 7095 | 7090 | `d8a76612a53e348673fd0859386162b0b025760d2a6fcf8aabb19232b9edb8f5` |
  | finder-FOOTGUNS | 7095 | 7090 | `d8a76612a53e348673fd0859386162b0b025760d2a6fcf8aabb19232b9edb8f5` |
  | finder-WRAPPERS | 7095 | 7090 | `d8a76612a53e348673fd0859386162b0b025760d2a6fcf8aabb19232b9edb8f5` |
  | finder-EFFICIENCY | 7095 | 7090 | `d8a76612a53e348673fd0859386162b0b025760d2a6fcf8aabb19232b9edb8f5` |
  | finder-DESIGN | 5203 | 5198 | `c3c2e31e5ef9d3b20258fca1a6293753bf1f5278cce227f5a835d2bcb53e7390` |
  | finder-DUPLICATION | 7095 | 7090 | `d8a76612a53e348673fd0859386162b0b025760d2a6fcf8aabb19232b9edb8f5` |
  | finder-ALTITUDE | 5203 | 5198 | `c3c2e31e5ef9d3b20258fca1a6293753bf1f5278cce227f5a835d2bcb53e7390` |
  | finder-CONVENTIONS | 3457 | 3452 | `66ad022dd13453363e944aec8cb483487cbded6a072358e5e8a62322acc7294f` |
  | deduplication | 14756 | 14751 | `647f8a021629a8819deb7277f64839fda2c6531300c91099a657cf01834932ba` |
  | verifier | 14756 | 14751 | `647f8a021629a8819deb7277f64839fda2c6531300c91099a657cf01834932ba` |
  | sweep | 22226 | 22213 | `31df6dd877ebd627fab64136a4d845a220c7399b44d8051e6ab9cb5cae753b6e` |
  | merge-rank | 30106 | 30099 | `f29209bee02e28cb32d1253facdcbe74e7c9f67c082f4c34a941f0776c0ef38e` |
  | fixer | 11002 | 10998 | `c6532f3989892a1e913292f840817115e64c9bef03cafd6f234862822206163c` |
  | documentation | 12404 | 10998 | `c6532f3989892a1e913292f840817115e64c9bef03cafd6f234862822206163c` |
  | test-assessment | 30776 | 30770 | `5a9e04b535b772abfc7d7abf9edbf487657f88f235bb571a145343d7046a1416` |
  | auditor | 15931 | 15924 | `94c31f049c2ea9e3c2e73f64d4d3447ace50fb0871c028d415c6299a2de4ff7a` |
  | answer | 16195 | 16189 | `15d94f59881d083678ebdc194c86219d65b984843afa762f1ae58eec67429616` |

  The prompts of `triage` and `angle-decision`, of `deduplication` and
  `verifier`, and of `fixer` and `documentation` are identical pairs, as
  they were in the proof of concept once its duplicate is removed; the
  three analyst angles share one prompt and the five scout angles
  another. What distinguishes such roles is the task the phase gives
  them, which the first end-to-end element defines.
- The wording (R6): `a9971c2` makes 45 exact-string replacements from the
  D5 list, one more the inventory of D5 missed ("in one message block" on
  a line naming nothing else), and re-wraps three passages without
  changing a word. A search of the fragments for every D5 word is empty
  afterwards, and the test that pins it fails when "orchestrator" is put
  back into one fragment and passes on the committed text.
- Tests checked to fail when the behavior they guard is removed: the
  wording guard as above; the assembler's invariants each have a case
  that plants the violation and asserts the refusal names the fragment;
  the unused-fragment check is asserted against a planted stray file and
  a stray directory; the script's refusal of an existing output directory
  is asserted against one.
- Continuous integration on the three platforms: not yet run; recorded
  here when the pull request runs.
