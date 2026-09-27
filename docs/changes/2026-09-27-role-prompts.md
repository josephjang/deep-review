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
runtime-neutral wording, and nothing else. A review of those two commits
later corrected, each in a commit of its own, the replacements that
turned out wrong or were missed, the references to other text that the
manifest's order made false or that no prompt carries, the place of the
`documentation` role's own section, and gaps in the assembler, the
manifest rules and the script; they are recorded under D5, D8 and
Verification. Which model tier, effort, access, shell, budget and
timeout a role runs with, what it must return, and whether a runtime
needs a different setting are decided with the phases that first run
each role.

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
  wording that names a mechanism the worker does not have changes, with
  the few sentences review found false about the engine or the
  manifest's order, and the two that pointed at a checkpoint discipline
  no fragment defines (D5).
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
  takes it then. Review found that phase 1 and phase 2 still saved
  their checkpoint sections "under the checkpoint discipline above",
  which `resume.md` defined, and those pointers are gone (D5).
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
- R3: A fragment is a regular file, in a `fragments/` that is not a
  link, of UTF-8 text without a byte order mark, with LF line endings,
  no control character but tab and LF, no line or paragraph separator
  (U+2028, U+2029) and no U+FEFF anywhere, not empty, ending in exactly
  one newline, neither starting nor ending with a blank line (a line of
  only spaces and tabs counts as blank), with no front matter and no
  include marker at a line start, however it is indented, spaced or
  cased; each violation is refused naming the fragment, and a forbidden
  character also by its code point and line. The roles directory itself
  may be reached through a link, as a checkout may be. A fragment is
  read only by a valid fragment name (R4), checked before any file is
  touched, so no caller reaches outside `fragments/`; only a fragment
  that is not there is called missing, and one that cannot be read is
  refused with the reason the system gave.
- R4: A manifest has schema version 1 and at least one role, and gives
  no key twice in one object, of which `JSON.parse` would keep the last
  without a word; a role key is letters, digits and single dashes,
  starting with a letter and ending with a letter or digit, and no two
  keys differ only by case, since each names a prompt file; a role key
  `__proto__`, which `JSON.parse` makes but a record drops, is refused
  by that rule rather than lost; a fragment name is lower-case words
  joined by single dashes with the `.md` extension and no directory
  part; a role names at least one fragment and none twice; every entry
  under `fragments/` is a fragment some role names.
- R5: At the move commit, each role's assembled prompt equals the proof of
  concept's assembled role after leading, trailing and repeated blank
  lines are collapsed, with one named exception: `documentation` is equal
  once the second copy of the fixer's documentation section is removed
  from the proof of concept's text. The comparison and the hashes are
  recorded under Verification.
- R6: After the wording commit, no fragment says `subagent`, `Agent` call,
  `subagent_type`, `AskUserQuestion`, `orchestrator`, `agent` for a
  worker, `agent definition`, `Grep`, `tier table`, `message block` or
  the `same block` that pointed back at one, `deep-review skill`,
  `driver` for the engine, or the name of a Claude Code subagent
  (`deep-review-lead` and the others), and a test holds every assembled
  prompt, and so every fragment, to that list. The test matches each
  phrase across line wraps and in any case, except `Grep`, since a
  lower-case `grep` is the shell command every runtime has; `AGENTS.md`,
  an instruction file, is not an agent, and the backticked `Driver lead`
  label a finder receives is not a name for the engine.
- R7: `npm run roles` prints one line per role with its key, fragment
  count, size and hash; `--output DIR` also writes each prompt to
  `DIR/<key>.md`. It refuses a `DIR` that is the roles directory or
  inside it, where the prompts would become stray fragments or files to
  commit, and a `DIR` that exists, by creating it with a call that fails
  when anything is already there, so a directory made in the meantime is
  never written into.
- R8: The commit that moves the text changes no prompt text; the commit
  that changes wording changes nothing under `roles/` but that wording, and
  carries the test that pins it. Each correction made after review is a
  commit of its own that names what was false (D5, D8).
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
  proves mechanically; a reviewer of the second sees only wording. After
  review, AGENTS.md states this rule, and its exemption of prompt text
  from the writing conventions, for role prompts as well as skills.

- **D5: The wording change is the smallest that removes what is false
  under the engine.** Three kinds of text change and nothing else.
  Identity: a "subagent of the deep-review skill" becomes a "worker of
  the deep-review engine", "the orchestrator" becomes "the engine", an
  "agent" that means a worker becomes a "worker", and "the agent
  definition" that "the runtime delivers" becomes "the role prompt"
  every worker of that role receives. Mechanism: an `Agent` call with a
  `subagent_type`, "a single message block" and "the tier table above"
  become a worker, workers run in parallel, and no table; the
  `AskUserQuestion` passage says that the worker cannot ask the author
  itself, so it finishes its independent work and returns the open
  questions to the engine, which asks them and continues the worker with
  the answers; a `deep-review-fixer` to dispatch becomes a fixer. Tools:
  "Grep for" becomes "search for". Everything else stays, including the
  driver's bookkeeping named in Non-Goals and every mention of
  `CLAUDE.md`. Rewriting each prompt for its worker was rejected here
  because the pilots validated these semantics and nothing has run them
  under this engine yet; that rewrite belongs after the first real run,
  with its evidence. Per-runtime variants of each prompt were rejected
  because the differences are a handful of words and two copies of the
  fragments, about 80 KB of text (79617 bytes at the wording commit),
  would drift.

  Review of the wording commit found it short of this rule, and eight
  later commits correct it, each changing under `roles/` only the
  sentences it names. Three replacements were wrong: "the runtime
  agent/task handle" had become "the runtime session id", a different
  identifier, and is "the runtime worker/task handle" again (`aa8ade7`);
  the `AskUserQuestion` passage had become "If you can ask the author
  directly, do", a branch no worker can take, and now reads as above
  (`892e066`); "the engine reads your report on every subsequent turn"
  was false of an engine that has no turns, and the fixer's line limit
  now gives the reason that its report is carried into later passes
  (`3038650`). Two passages still said "in the same block as" the
  dispatch, pointing back at the removed message block, and now say "at
  the same time as" it (`0ea14e1`). References in three fragments said
  other text comes "below" or "after the angles" where the manifest puts
  it earlier, and now point at it without a direction (`2eb8f65`); they
  were false already in the proof of concept's prompts, whose order the
  move kept, and the wording commit had reworded two of them and kept
  "below". Three sentences named "the driver", the prompt-only skill's
  name for what is now the engine. One, in the fixer's documentation
  section, stood beside "the engine" and now names the engine
  (`2a27151`). In phase 1 an overridden skip used "the driver's"
  verified reason, handing the reader's own reason to someone else, and
  now uses "your verified reason"; the post-review steps said a fixer's
  SUITE line "is not a driver run" and now say it "is not the aggregate
  run", the run the same step defines (`b418db4`). Two sentences, in
  phase 1 and phase 2, saved a checkpoint section "under the checkpoint
  discipline above", which lived in the prompt-only skill's `resume.md`
  and is not moved (Non-Goals), so the `triage`, `angle-decision`,
  `deduplication` and `verifier` prompts pointed at text they do not
  carry; they now say inline what still holds, that the section is
  terminated and written without waiting to batch it (`a0b43b4`). The
  `Driver lead` label a finder may receive stays: it is the protocol
  between the angle decision and the finders, part of the bookkeeping
  kept above, and the guard of R6 passes it only in backticks.

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

  The move kept the copy the fixer's text carried, in the middle of the
  prompt, and dropped the one the proof of concept appended after the
  fixer's return format, so `documentation` came out byte-identical to
  `fixer` and its reconciliation rule no longer came last. Review named
  `fixer-documentation` last in `documentation` instead (`fb1bb9d`): the
  prompt ends as the proof of concept's did, and is its text with the
  first copy removed rather than the second. `fixer` and `answer` are
  unchanged, and a test pins that the reconciliation rule follows the
  last return format.

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
  worker's task decides what that worker needs. Only the pointers to a
  checkpoint discipline no fragment defines were removed after review,
  because they sent a worker to text its prompt does not carry (D5).
- Two copies of the text now exist, the prompt-only skill's in
  `agent-skills` and this repository's, and they will diverge. Accepted;
  the starting decision to carry only the engine-driven skill implies it.
- The `CONVENTIONS` angle reads `CLAUDE.md` only, so a worker reviewing a
  repository governed by `AGENTS.md` returns nothing for that angle.
  Accepted until the first real run.
- The comparison of R5 is a one-time check, not a permanent test, because
  the wording commit changes the prompts on purpose. Its result is
  recorded under Verification with the proof of concept's commit, so it
  can be repeated.

## Verification

Run on the author's Windows 11 machine on 2026-09-27, Node 26.10.0,
against the two commits of this element, `362a89f` (the move) and
`a9971c2` (the wording).

- `npm run check` passes at both commits: lint, typecheck and every test
  that runs here, with 10 skipped (493 tests at `362a89f`, 494 at
  `a9971c2`). Six are the POSIX signal cases, which skip on every Windows
  machine, and four are symlink cases, which skip because this Windows
  account may not create symlinks. Three of the four predate this
  element; the fourth is this element's own "refuses a fragment that is
  a symlink". A directory planted as a fragment is refused here, but the
  refusal of a symlinked fragment, the reason R3 checks the entry itself
  and not what it points to, has not run on this machine and is proven
  only where symlinks can be made. `npm run verify` matches both
  artifacts, as `dist/` is untouched.
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
  them, which the first end-to-end element defines. The `fixer` and
  `documentation` pair holds at the move only: since `fb1bb9d` the two
  carry the same fragments in a different order (D8).
- The wording (R6): `a9971c2` makes 45 exact-string replacements from the
  D5 list, one more the inventory of D5 missed ("in one message block" on
  a line naming nothing else), and re-wraps three passages without
  changing a word. A search of the fragments for every D5 word is empty
  afterwards, and the test that pins it fails when "orchestrator" is put
  back into one fragment and passes on the committed text. Review later
  found three of the replacements wrong, two "same block" passages
  missed and one "the driver" left beside "the engine" (D5); the guard
  as it stood after that review, run against the fragments of
  `a9971c2`, found only the two "same block" passages. A second pass
  found two more sentences naming the driver and added "driver" outside
  backticks to the guard (`b418db4`); the guard as it stands now, run
  against the fragments of `a9971c2`, finds the two "same block"
  passages and those three "driver" sentences, and nothing else.
- Tests checked to fail when the behavior they guard is removed: the
  wording guard as above; the assembler's invariants each have a case
  that plants the violation and asserts the refusal names the fragment,
  and every such case ran here except the symlink one, skipped as above;
  the unused-fragment check is asserted against a planted stray file and
  a stray directory; the script's refusal of an existing output directory
  is asserted against one.
- Continuous integration on the three platforms: not yet run; recorded
  here when the pull request runs.

The review of the pull request added twenty-one commits after its
verification record, `795e146`, from `6823119` to `5b8410c`, and then
the documentation commits that bring this proposal in line with them.
They were checked on the same machine on 2026-09-27, Node 26.10.0.

- `npm run check` passed before each of those commits, and after the
  last runs 535 tests: 523 pass and 12 skip. Ten are the skips above.
  The other two are new assembler cases that cannot occur on Windows: a
  `fragments/` that is a file, which Windows reports as missing rather
  than as a path through a file, and a fragment whose file mode denies
  reading, which Windows file modes cannot express and which also skips
  when run as root. So three of R3's refusals, the symlinked fragment
  and these two read failures, run only where continuous integration
  runs them. `npm run verify` matches both artifacts, as `dist/` is
  untouched.
- The manifest (R4): a role key `__proto__` is refused by the role key
  rule instead of dropped (`6823119`); keys that differ only by case are
  refused, naming both (`fdf6c94`); the test of an empty role asserts
  the reason, not only the key (`ad13de8`).
- The assembler (R3): a fragment that cannot be examined or read is
  refused with the system's reason, and only a decoding failure says
  "is not UTF-8" (`8df7eba`); a whitespace-only line at either edge
  counts as blank (`860fe28`); a fragment name with a directory part is
  refused before any file is touched (`75bc89b`). Without changing
  behavior, each fragment is hashed once from the bytes read
  (`b273d88`), the unused-fragment check takes the named fragments from
  the manifest (`0b86570`), the error classes say what raises them
  (`8a40b93`) and the byte order mark is written as an escape in the
  source (`e246084`).
- The script (R7): an `--output` that is the roles directory or inside
  it is refused before anything is created (`0633cbc`); an existing
  `--output` is refused by the create itself, which also refuses a file
  there and a file system root (`7302680`); the canonical path
  containment check it uses is shared with the scratch-directory check
  in `src/paths.ts` (`5b8410c`, no behavior change).
- The wording (R6, D5): the six corrections of D5 (`aa8ade7`,
  `892e066`, `3038650`, `0ea14e1`, `2eb8f65`, `2a27151`); the guard
  matches whole prompts, across line wraps and in any case, and has
  tests of its own (`c76433f`); and every sentence of a fragment that
  says text comes below it, or that a role's prompt carries some text,
  is pinned against the manifest, as is each finder's definition of its
  own angle (`2eb8f65`, `e0ee651`).
- Tests checked to fail before their fix, or with the behavior they
  guard removed: the new manifest cases; the report of a read failure
  on a path the file system refuses; the refusal of an `--output` inside
  the roles directory; the guard's own tests against the per-line guard
  it replaced; and the manifest-order pins against a manifest changed to
  break each.

A second pass of the review added eight commits after `2b622ee`, the
documentation commit above, and `b14767e`, which states in AGENTS.md
that role prompt fragments are prompts (D4): five to the assembler and
three to the roles. They were checked on the same machine on
2026-09-27, Node 26.10.0.

- `npm run check` passed before each of those commits, and after the
  last runs 562 tests: 550 pass and 12 skip, the twelve skips above and
  no new one. The new cases for a `fragments/` that is a link plant a
  junction, which Windows makes without the right to create symlinks,
  so they run here: a junction to a valid directory and one whose
  target is gone are refused, and a roles directory reached through a
  junction is accepted. `npm run verify` matches both artifacts, as
  `dist/` is untouched.
- The assembler (R3): without changing behavior, the rules on a
  fragment's decoded text are one exported function apart from the
  read, and the tests hold each string case to it directly as well as
  through `assembleRoles` (`9f5ae0a`); an include marker is refused at a
  line start however it is indented, spaced or cased, while a marker
  within a line and comments such as `<!-- END -->` stay accepted
  (`97724bb`); every control character but tab and LF, U+2028, U+2029
  and a U+FEFF anywhere are refused, naming the code point and its line,
  after the carriage return and leading byte order mark checks that
  name those two (`60eeb87`); a fragment read through a `fragments/`
  that is a link is refused, through both `assembleRoles` and
  `readRoleFragment` (`c17f0a2`).
- The manifest (R4): a key given twice in one object is refused, naming
  it, whether a role key or a top-level key, spelled with an escape or
  with whitespace before its colon; a quote or colon inside a string is
  not taken for a key (`113a318`). The Risks section had called a
  repeated key mitigated by the test that pins the list of role keys,
  which could not see it, since a repeated key keeps its first position;
  that bullet is removed.
- The composition (D8): `documentation` names `fixer-documentation`
  last (`fb1bb9d`). The fragments of `362a89f` assembled with that order
  equal the proof of concept's `documentation` with its first copy of
  the section removed, after blank lines are collapsed as in R5, and do
  not equal it with the second copy removed. At `a0b43b4`, `fixer` and
  `documentation` are both 10988 bytes, with SHA-256
  `7bf949eb3a7a45d4da5d96082a4d50f12ca4f89ee9b472f041eaeb3beb69c9e3` and
  `60566945effaa835e2d632c8f7f9a587747395c71bb6b88e8e865ab4344e0082`.
- The wording (R6, D5): the two remaining "driver" sentences and the
  guard's new pattern, with a test that it finds the word in prose and
  passes the backticked label (`b418db4`); the dropped pointers to a
  checkpoint discipline, with a test that no prompt mentions one
  (`a0b43b4`).
- Tests checked to fail before their fix: every new refusal of the
  assembler and the manifest; the reconciliation-order pin, on a
  `documentation` whose last return format came after its
  reconciliation rule; the "driver" guard, on `triage`,
  `angle-decision`, `merge-rank` and `test-assessment`; and the
  checkpoint-discipline pin, on `triage`, `angle-decision`,
  `deduplication` and `verifier`.
