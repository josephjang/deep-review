# Report: Fixer time and cost on the zod gate runs

Written 2026-10-03, from the fix pass's R16 gate runs on zod #6530
(see the Verification of `docs/changes/2026-10-01-fix-pass.design.md`).
It records where the fixers' wall time and tokens went, and the ways to
reduce them, so they can be weighed and acted on later. Nothing here has
been changed in the engine yet; each lever names what it would take and
how to tell whether it worked.

## Summary

- A fixer's wall time is mostly the model's, not its tools'. On Claude
  Code the model's share is 73 to 75% and grows with the output tokens
  (about 90 per second); on Codex it is about 90%, at a median of 19 to
  28 s per turn whatever the turn writes, so a Codex batch's time is
  about its turn count times 25 s.
- On Claude Code, a fixer's list-price cost is 42% cache writes, 32%
  output (38% of it thinking) and 26% cache reads. Cache writes are
  billed at the one-hour rate, twice the base input price, because
  Claude Code defaults to a one-hour cache on a subscription login.
- 58% of every fixer's 65 KB prompt is the whole reviewed diff, which
  every turn of every batch carries.
- Every batch is a fresh session: it writes its base context to the
  cache again and spends 2 to 15 turns orienting, largely re-reading
  files earlier batches already read, before its first edit.
- On Codex for Windows every batch met 3 to 14 `EPERM` failures trying
  to run the build or tests, each costing at least one 25 s turn.
- The batches of one cluster touch the same files, so running them in
  parallel is not available as a lever.

The cheapest lever with no quality risk is a five-minute cache TTL for
Claude workers (about 16% of fixer cost, verified by a probe). Telling
Codex fixers up front that the sandbox forbids the build and tests, and
dropping the reviewed diff from the fixer prompt, come next. Narrowing
the fixers' validation, a larger batch on Claude and a lower fixer
effort each trade some quality and need an A/B gate run.

## Data and method

Four gate runs, all on zod #6530 (range `eca96871`..`e48a0055`), on one
Windows 11 machine:

| Run | Engine | Runtime | Fixer batches | Fix phase |
|---|---|---|---|---|
| `0e53023f` | first amendment (`bd944e7`) | claude 2.1.287, opus at high effort | 10 (4 clusters, one second round) | 23 applied, 1 already applied |
| `2aacbf44` | first amendment (`bd944e7`) | codex-cli 0.157.1, gpt-6-astra at high effort | 16 (7 clusters, two second-round batches) | 29 applied, 8 already applied, 1 deferred |
| `42bce9f8` | second amendment (`91f8022`) | claude 2.1.287, opus at high effort | 6 (2 clusters) | 11 applied, 6 already applied, 3 deferred |
| `509e520e` | second amendment (`91f8022`) | codex-cli 0.157.1, gpt-6-astra at high effort | 8 (1 cluster of 7 batches, one retried) | 21 applied, 5 already applied |

Sources, per fixer and repair worker:

- The run's ledger: `worker.launched` (label, model, effort, prompt
  size), `worker.finished` (start, end, session ids, usage as the
  runtime reported it), `fix.recorded` and `fixes.planned`.
- The runtime's own per-turn transcript, which the engine does not
  freeze: Claude Code's session file under
  `~/.claude/projects/<worktree key>/<session id>.jsonl`, and Codex's
  rollout file under `$CODEX_HOME/sessions/<date>/rollout-*-<session
  id>.jsonl`. Both carry a timestamp on every tool call and tool
  result, and per-turn token usage.

How each figure was taken:

- **Tool time** is the union of the intervals from each tool call to
  its result, so parallel calls count once. **Model time** is the
  worker's wall time minus its tool time.
- **A turn** is one model response that calls tools. **Model latency
  per turn** is the gap from a tool result to the next tool call.
- **Categories** come from each call: Read, Grep and Glob are reads,
  Edit and Write (or Codex's `apply_patch`) are edits, and a shell
  command is classed by the heaviest work it names, in the order test,
  build, typecheck, lint, snapshot, probe (a node or tsx run), git, read
  and other.
- **Claude's per-token prices** were fitted by least squares to the
  `total_cost_usd` of 17 fixer and repair workers of the two Claude
  runs, all opus: cache writes 8.00, cache reads 0.20 and output 20.00
  USD per million tokens, with no residual over the 17. Uncached input
  was a few dozen tokens per worker and is left out. These are list
  prices: on a subscription the figure is the runtime's estimate, not a
  bill.
- Codex reports tokens only, so its cost is in tokens.

Limits of the method: one repository, one change, one machine, and two
runs per runtime; the categories are heuristic; and a Codex `exec` call
can run several commands, which are classed together.

## Measurements

### Per run

| Run | Fixer workers | Wall s (sum) | Model s | Tool s | Test s | Tool calls | List cost USD |
|---|---|---|---|---|---|---|---|
| Claude `0e53023f` | 10 | 3268 | 2428 | 840 | 764 | 376 | 14.85 |
| Claude `42bce9f8` | 6 | 2009 | 1461 | 548 | 501 | 229 | 9.07 |
| Codex `2aacbf44` | 16 | 7632 | 6862 | 770 | 465 | 316 | not reported |
| Codex `509e520e` | 8 | 9400 | 8561 | 839 | 541 | 307 | not reported |

The fixes phase's wall time is shorter than the sum where clusters ran
in parallel; on `509e520e` the one cluster ran its batches one after
another, so the sum is the phase.

### Per batch, the latest runs

Claude Code, run `42bce9f8`:

| Batch | Wall s | Model s | Tool s | Turns | Median s per turn | First edit | Output tokens (thinking) | USD |
|---|---|---|---|---|---|---|---|---|
| c1-1 | 528 | 422 | 106 | 49 | 4.0 | 251 s, after 11 turns | 39379 (19561) | 2.17 |
| c2-1 | 159 | 88 | 71 | 24 | 3.1 | 26 s, after 6 turns | 8718 (980) | 0.81 |
| c1-2 | 283 | 195 | 87 | 44 | 3.1 | 35 s, after 8 turns | 20709 (4266) | 1.44 |
| c1-3 | 295 | 185 | 110 | 31 | 3.8 | 84 s, after 9 turns | 19426 (7331) | 1.21 |
| c1-4 | 314 | 235 | 80 | 32 | 4.6 | 122 s, after 9 turns | 23656 (10055) | 1.33 |
| c1-5 | 430 | 336 | 94 | 49 | 5.2 | 106 s, after 6 turns | 35019 (13933) | 2.10 |

Codex, run `509e520e`:

| Batch | Outcome | Wall s | Model s | Tool s | Turns | Median s per turn | EPERM results | Input tokens (cached) | Output tokens (reasoning) |
|---|---|---|---|---|---|---|---|---|---|
| c1-1 | completed | 1637 | 1433 | 204 | 46 | 28.1 | 8 | 4.05 M (3.90 M) | 31818 (11843) |
| c1-2 | completed | 1173 | 1016 | 157 | 40 | 22.4 | 7 | 3.38 M (3.18 M) | 22620 (7620) |
| c1-3 | timeout | 1800 | 1646 | 154 | 57 | 25.5 | 6 | 5.47 M (5.33 M) | 37073 (18471) |
| c1-3 retry | completed | 473 | 447 | 25 | 23 | 14.4 | 5 | 1.68 M (1.59 M) | 8729 (1357) |
| c1-4 | completed | 1467 | 1366 | 101 | 43 | 27.3 | 7 | 3.63 M (3.35 M) | 23893 (7751) |
| c1-5 | completed | 1119 | 1073 | 47 | 34 | 24.7 | 5 | 2.78 M (2.67 M) | 24098 (10142) |
| c1-6 | completed | 1010 | 911 | 99 | 37 | 19.3 | 7 | 3.22 M (3.09 M) | 20427 (5251) |
| c1-7 | completed | 721 | 669 | 52 | 27 | 18.8 | 3 | 2.05 M (1.96 M) | 14947 (4265) |

The first attempt of c1-4, lost when the engine was stopped, is not in
the table.

### Where the wall time goes

- **Claude Code:** model time is 73 to 75% of a fixer's wall time, and
  it tracks the output tokens: c1-1 wrote 39379 tokens in 422 s of model
  time, about 93 per second. Of the tool time, tests are about 90%
  (501 of 548 s on `42bce9f8`, 764 of 840 s on `0e53023f`). A median turn is 3 to 5 s.
- **Codex:** model time is about 90%, and the median turn takes 19 to
  28 s on `509e520e`'s batches and 9 to 31 s on `2aacbf44`'s, largely
  independent of how much the turn writes: c1-1
  wrote 31818 tokens over 46 turns in 1433 s, about 22 per second. A
  Codex turn reads a context of about 100k tokens, and its time goes
  with the number of turns more than with their output.

### Where Claude's money goes

Over the 17 fixer and repair workers of the two Claude runs (24.29 USD
at list price): cache writes 42%, output 32%, cache reads 26%. Thinking
is 38% of the output tokens.

Cache writes are what a session adds to its context: its base context
on the first turn, then every tool result and every model output once.
Every write was billed at the one-hour rate: the session usage shows
`ephemeral_1h_input_tokens` for all of them and none in
`ephemeral_5m_input_tokens`. Claude Code chooses the one-hour cache by
default on a subscription login and the five-minute one on an API key
([prompt caching](https://code.claude.com/docs/en/prompt-caching.md));
the adapter sets neither. A fixer's turns are seconds apart (the longest
gap measured was 157 s), well inside five minutes.

A probe on claude 2.1.287 with the same one-line prompt: by default the
write went to `ephemeral_1h_input_tokens` (18271 tokens) at 0.076 USD;
with `CLAUDE_CODE_PROMPT_CACHE_TTL=5m` it went to
`ephemeral_5m_input_tokens` (18359 tokens) at 0.049 USD.

### What fills the context

- **The prompt.** A fixer's prompt is 60 to 68 KB. On `42bce9f8` c1-1's
  67016 bytes are 38898 of the reviewed diff (58%), 11534 of the task
  (the findings' briefs and the batch), and the rest the role's text.
  The diff is the same in every batch of the run, and every turn
  carries it. The first turn's cache write, the base context with
  Claude Code's own system prompt and tools, was about 36k tokens.
- **Tool results.** On Claude `42bce9f8` the fixers' tool results came
  to 332k characters: reads 68%, git (mostly diffs) 16%, tests 7%,
  edits 6%. On Codex `509e520e` they came to 1747k characters: test
  runs 35% (mostly failures and their retries), reads 29%, git 15%,
  probes 6%, builds 5%.
- **Re-reading.** On `42bce9f8` each batch after the first read 15k to
  24k characters of files, nearly all of them files an earlier batch
  had read, since each batch is a fresh session. Before its first edit
  a batch spent 6 to 11 turns and 26 to 251 s on Claude, and 2 to 9
  turns and 50 to 191 s on Codex.
- **Shell noise on Codex.** Every Codex shell result begins with mise's
  warning that its PowerShell hook needs PowerShell 7: 62 times in c1-1
  alone, about 18.5k characters. The adapter drops WindowsApps from
  `PATH`, so a worker's shell is Windows PowerShell 5.1.

### Codex and the sandbox

Every Codex fixer met `spawn EPERM` running the build or the tests (48
such results over the eight batches of `509e520e`, 92 over the sixteen
of `2aacbf44`), and tried other ways in: a native Vitest config, a
scratch config, `tsc` directly. Test-class calls were 124 of the 307
tool calls of `509e520e`. Issue
[#10](https://github.com/josephjang/deep-review/issues/10) has the
cause and the elevated sandbox's own obstacles.

### The batches of one cluster

On `509e520e` every batch of the one cluster touched three to six of
the same seven files (`memoizer.ts`, `util.ts`, `schemas.ts`,
`compile.ts` and their tests); on `42bce9f8` every batch of `c1`
touched `util.ts`. Ownership keeps a file to one worker at a time, so
these batches cannot run side by side, and the serial order is what
kept `509e520e`'s fixes phase at 9400 s.

## Levers

Each lever: what to change, the evidence, the expected effect, the risk,
what it takes, and how to check it.

### 1. A five-minute cache TTL for Claude workers

- **Change.** The Claude adapter sets `CLAUDE_CODE_PROMPT_CACHE_TTL=5m`
  in every worker's environment, or makes it a policy setting.
- **Evidence.** Cache writes are 42% of fixer cost at 8.00 USD per
  million; a five-minute write is 1.25 times the base input price
  against 2 times, so 5.00. Verified by the probe above.
- **Effect.** About 16% off a fixer's list cost (42% times 37.5%), and
  a similar share of every other Claude worker's, since every role
  writes its context the same way. No change in what a worker does.
- **Risk.** A worker idle for more than five minutes between turns
  pays a fresh write; none was measured. On a subscription the cost is
  an estimate, and what the TTL does to plan usage is not documented
  and was not measured.
- **Takes.** The adapter's environment, its test, and a change
  proposal, since the budget's arithmetic changes.
- **Check.** A gate run's workers show `ephemeral_5m_input_tokens` and
  a lower cost per worker at a similar token count.

### 2. Tell Codex fixers what the sandbox forbids

- **Change.** When the runtime is Codex on Windows with the unelevated
  sandbox, the fixer's and the repair's tasks say that no process their
  shell starts can start another, so the build, the tests and most
  package scripts cannot run; that a fix is validated by direct node
  probes; and that the engine's checks are the judge. Until issue #10
  is resolved, or instead of it.
- **Evidence.** 48 `EPERM` results on `509e520e` and 92 on
  `2aacbf44`, and test-class calls at 40% of `509e520e`'s tool calls,
  most of them failing or working around the failure.
- **Effect.** At least one 25 s turn per `EPERM` result, about 1200 s
  or 13% of `509e520e`'s fixes phase; up to the 40% the test-class
  calls take if the workarounds go too.
- **Risk.** Weaker validation on Codex for Windows than elsewhere,
  which is already the case in practice. A machine where Codex can run
  them (another platform, or elevated once #10 is done) must not get
  the sentence.
- **Takes.** A condition in the task text on runtime and sandbox, its
  tests, and a change proposal.
- **Check.** `EPERM` results per batch fall to near zero, and turns and
  wall time per batch fall with them.
- **Corrected 2026-10-04.** The sentence the change proposes rests on a
  wrong cause. A later probe found that under the unelevated sandbox a
  process cannot create a named pipe, and Node gives a child its piped
  stdio through one, so a Node process cannot start a child whose
  output it captures; processes started with stdio `inherit` or a file
  run. The build, the tests and package scripts fail all the same, so
  the lever holds with that cause, and
  `docs/changes/2026-10-04-codex-sandbox.requirements.md` takes it up
  (R6) beside a setting that lets the build run.

### 3. Leave the reviewed diff out of the fixer prompt

- **Change.** A fixer's prompt carries the diff hunks of its own
  cluster's files only, or the path of the frozen patch for the fixer
  to read when it needs more, as reader prompts already do above
  256 KiB.
- **Evidence.** 58% of the prompt, about 10k tokens, in every turn of
  every batch.
- **Effect.** On Claude about 0.16 USD a batch, written once (0.08)
  and read on each of about 40 turns (0.08), about 10% of a 1.51 USD
  batch; on Codex about a tenth less context per turn.
- **Risk.** The fixer sees less of the change's intent; the finding
  briefs carry most of what a fix needs.
- **Takes.** The fixer task's scope block, its tests, and a change
  proposal; the role prompt does not change.
- **Check.** Prompt size per fixer, cost per batch, and whether fixes
  that needed context from other files of the change still land.

### 4. Narrow the fixers' validation

- **Change.** A fixer runs the tests it added or touched, not the
  whole suite, since the engine's checks run the suite after the
  fixes; and gives one form of evidence per finding (the test failing
  on the old code), keeping the mutation run for a test it wrote
  itself.
- **Evidence.** Tests are 23 to 25% of a Claude fixer's wall time (764
  of 3268 s, 501 of 2009 s), and each piece of evidence costs a
  revert, a run and a restore, several turns: c1-1 of `42bce9f8` gave
  seven pieces of evidence over 49 turns.
- **Effect.** Fewer turns and less test time on both runtimes; on
  Codex, where the turn is the unit of time, the larger gain.
- **Risk.** Less proof that each fix is covered; a regression the
  fixer would have caught surfaces only in the checks phase, where one
  repair worker meets every failure at once.
- **Takes.** The fixer's role text (`roles/fragments/`, a prompt-text
  commit of its own) and the task text, and a change proposal.
- **Check.** An A/B gate run: turns, wall time and cost per batch, the
  checks phase's failures and the repair's outcome.

### 5. A larger batch on Claude

- **Change.** `fixes.batchSize` per runtime: 8 on Claude Code, 4 on
  Codex.
- **Evidence.** Every batch pays a base context write (about 36k
  tokens, 0.29 USD at the one-hour rate) and 2 to 15 orientation turns
  re-reading files. Claude's longest batch took 663 s against a 1800 s
  timeout; Codex's took 1637 s and one timed out.
- **Effect.** About half the Claude sessions, and their fixed costs.
- **Risk.** A larger context per session makes each later turn dearer
  to read, and a failed batch loses more work. Codex cannot take it.
- **Takes.** The policy schema (a per-runtime setting), the pin on the
  run, and a change proposal.
- **Check.** An A/B gate run on Claude: cost and wall time of the
  fixes phase, timeouts, and the fixes' outcomes.

### 6. A lower fixer effort

- **Change.** The fixer role's effort from `high` to `medium`, on one
  runtime or both.
- **Evidence.** Thinking is 38% of Claude's fixer output, output 32%
  of the cost, and Claude's model time goes with its output: c1-1's
  19561 thinking tokens are about 210 of its 422 s.
- **Effect.** Up to about 12% of the cost and a share of the model
  time on Claude; on Codex the per-turn latency may fall too.
- **Risk.** Fix quality; the fixer's job is the one where reasoning
  pays most.
- **Takes.** `roles/policy.json`, and an A/B gate run before it ships.
- **Check.** The A/B run's fixes: applied, deferred and blocked
  counts, the checks phase, and a reading of the diffs.

### 7. Quiet the Codex shell

- **Change.** Give Codex workers PowerShell 7 or an environment that
  silences mise's hook (`MISE_PWSH_CHPWD_WARNING=0`, as the warning
  itself suggests).
- **Evidence.** 62 warnings, about 18.5k characters, in one batch.
- **Effect.** A few thousand tokens per batch; small.
- **Risk.** The environment is the user's; the adapter would be
  reaching into a tool it does not own.
- **Takes.** The adapter's environment, or a note in the README.
- **Check.** No warning in a worker's shell results.

## Not a lever here

- **Running a cluster's batches in parallel.** Every batch of a
  cluster touched the same files on both runs, and two workers editing
  one file is what ownership exists to prevent.
- **A bigger fixer timeout.** It lets a slow batch finish but saves
  nothing; R25 already raised it to 1800 s.

## Open questions

- What a five-minute TTL does to a subscription's plan usage, as
  opposed to the list-price estimate.
- Whether Codex's per-turn latency falls with a smaller context or a
  lower effort, or is mostly fixed per request.
- Whether the numbers hold on another repository, with smaller files,
  a faster suite or no failing baseline.

## Related

- Issue [#9](https://github.com/josephjang/deep-review/issues/9): an
  already-applied finding with edits gets the fallback commit message.
- Issue [#10](https://github.com/josephjang/deep-review/issues/10):
  Codex fixers cannot run the build or tests on Windows.
- `docs/changes/2026-10-01-fix-pass.design.md`, Verification: the gate
  runs these numbers come from.
