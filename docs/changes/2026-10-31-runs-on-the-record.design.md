# Technical Design: Runs on the record

Product part: [2026-10-31-runs-on-the-record.requirements.md](2026-10-31-runs-on-the-record.requirements.md).

## Summary

The Claude adapter runs each worker with `--output-format stream-json --verbose` and reads its stdout one line at a time, as the Codex adapter reads its event stream. Its last `result` event is the envelope of today, read by the same rules. Both adapters also read the shell runs of the stream into `Decoded.runs`: the command, the output that the worker saw, and the exit code when the runtime gives one. The receipt of the worker carries them in memory, and the frozen stdout stays the only record of them, so no event records them twice.

A verification unit of a run configured with this change answers in `verifierOutputSchemaV2`, chosen by the unit as the repair's schema is chosen today. Each verdict gives a basis and its cited runs. While the engine records the answer, in the one append that also records the finish of the worker, a new module, `src/review/cited-runs.ts`, looks for each cited run in the receipt's runs and freezes each cited probe from the worker's scratch directory. A cited run that it does not find, or a probe that it cannot freeze, is a `StructuralCheckError`, so the unit fails its attempt and runs again, as for any structural check today. The verdicts are recorded as `verdicts.recorded@2`.

The editing workers answer in `fixerOutputSchemaV2`, whose validation entries cite runs. The engine looks for each in the same way and records what it found in `fix.recorded@5`, and it refuses no editing answer for it. The fixer's task gives the runs of each candidate. The report shows the basis and the runs in the block of each finding, in "Refuted at verification" and in the validation lines of a fix, and `--stats` counts them. `review.configured@9` marks a run with this change. No role prompt changes, so the digest of the roles stays.

## Non-Goals

### No change to the role prompts

The task text and the output schemas carry every new instruction and field (PD6). No fragment under `roles/fragments/` changes, so `rolesDigest` stays and a run that started before this change can resume under the new engine.

### No new event for the runs of a worker

The runs are read from the frozen stdout. `worker.finished` keeps its one version (TD2).

### No run of a probe by the engine

`src/review/cited-runs.ts` reads text and freezes files. It starts no process (PD1).

### No change to the brief and its forms

`briefOf`, the short form and `briefJson` version 5 do not read the basis or the runs (PD7).

### No change to the finders, the triage, the sweep, the decider or the merge and rank

Their answers, their schemas and their tasks stay. The decider and the merge and rank still get the evidence line of each candidate, as today.

## Context

Verified at `ff801690`. No uncommitted change was used.

### The Claude adapter and its envelope

`claudeCommand` in `src/runtime/claude.ts` runs a worker with `--print --output-format json`, the tools of `claudeTools` (`Read`, `Glob`, `Grep`, and `Bash` when the worker has a shell, with `Edit` and `Write` for an editor), `--permission-mode dontAsk`, no setting sources, and `--json-schema` with the compiled output schema. `claudeFlags` lists each flag of that command, and the preflight requires each in the help text of the CLI (R4 of the runtime adapter). `decodeClaude` reads `outputs.stdout` as one JSON value, the envelope, and fails the worker when stdout is longer than `maxDecodeBytes`, 16 MiB, or is not one object. Its rules, in order: the session id must be the one the ledger named; a budget stop gives `budget`; an error that names a usage limit gives `limit`; a result that is not `result`/`success` with `is_error` false fails; `structured_output` must be present; and `permission_denials` must be an array.

A probe on Claude Code 2.1.314 ran a worker with the flags of `claudeCommand` and `--output-format stream-json --verbose`, two `Bash` calls and a structured answer. Its stdout was 11,792 bytes of JSON lines, and its stderr was empty. Each `Bash` call was an `assistant` event with a `tool_use` block, `{id, name: "Bash", input: {command, description}}`. Each result was a `user` event with a `tool_result` block, `{tool_use_id, is_error, content}`. A command that exited 3 gave `is_error: true` and the content `Exit code 3\n42`. A command that passed gave `is_error: false` and its output, and its event also held `tool_use_result` with `stdout`, `stderr` and `interrupted`. The structured answer was a `tool_use` of `StructuredOutput`. The last line was a `result` event with every field of the envelope of today: `session_id`, `subtype`, `is_error`, `structured_output`, `permission_denials`, `total_cost_usd`, `usage`, `modelUsage` and `terminal_reason`. The author keeps the probe's stream outside the repository.

### The Codex adapter and its stream

`decodeCodex` in `src/runtime/codex.ts` reads `outputs.stdoutLines` one line at a time through `readStream`, which folds each event into `StreamFacts` and holds no event. `observeItem` reads `item.started` and `item.completed`. A completed `command_execution` item holds `command`, `aggregated_output`, `exit_code` and `status`, and a failed one with an exit code is survivable (`survivableFailure`). On Windows, the command of the item wraps what the model ran, as `"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command '...'` with quotes of its own, in the stream of the Codex gate run on j178/prek #2844. A Codex worker with `read-only` access gets no scratch directory: `capabilities.readOnlyScratch` is false, and `chooseScratch` in `src/runtime/scratch.ts` gives it none.

### The launcher, the decode and the receipt

The launcher freezes stdout, stderr and the final message file whole, and hands the adapter `WorkerOutputs`: `stdout` as one text, null above `maxDecodeBytes`, and `stdoutLines`, re-iterable, each line up to `maxLineBytes`, 64 MiB. `Decoded` holds `sessionIds`, `usage`, `denials` and `result`. `WorkerReceipt` gives the review the outcome, the validated `output`, the denials and the `finish` to append. In `src/review/controller.ts`, `record` appends the finish and the contribution of the worker in one append, and a failure of the contribution leaves the finish to be appended alone. `worker.launched` records the scratch directory of each worker. A worker's scratch directory is not removed after it finishes; `launcher.ts` removes one only for a launch it refused.

### The verifier's answer and its event

`verifierTask` in `src/review/tasks.ts` asks for one verdict per candidate with one `evidence` line. `outputSchemaOf` in `src/review/schemas.ts` gives the verifier `verifierOutputSchema`, `{verdicts: [{index, verdict, evidence ≤ 1000}]}`, and `invocationFor` in `src/review/phases.ts` takes the schema from the unit, so the repair of a run with the checks on the base gets `repairOutputSchema`. `contributionOf` checks a verifier's answer with `checkVerdicts` and records `verdicts.recorded@1`, `{phase, groupId, workerId, verdicts: [{id, verdict, evidence}]}`. An answer that throws `StructuralCheckError` is a failed attempt, and a verification unit whose two attempts fail gives `group.unverified`, which keeps its candidates PLAUSIBLE and marked.

### The fold and the report

`resolutionOf` in `src/review/state.ts` gives a candidate its verdict and evidence. `mergedResolution` gives a finding the evidence of the first of its candidates, primary first, that carries the merged verdict. `findingBlock` in `src/review/report.ts` prints `Evidence:` from it, and "Refuted at verification" prints each refuted candidate with its evidence. The text of a worker is quoted and escaped. `storeNameOf` in `src/checkpoint/checkpoint.ts` names a frozen file as `artifacts/<hash>`, and "About this run" says once where the store is.

### The fixer's task and its answer

`candidateLines` in `src/review/tasks.ts` gives a fixer each candidate of its finding as its summary, detail and evidence. `fixerOutputSchema` serves the fixer, the documentation worker and the answer pass, and `repairOutputSchema` extends it with the comparisons. Each finding of the answer has `validation`, at most 20 entries of `{method, source, evidence}`, with the method among `old-code`, `mutation`, `existing`, `static` and `limited`. The fixers write `fix.recorded@2`, the documentation step `@3`, and the repair of a run with the checks on the base `@4` (`carriedVersions` in `src/review/event-versions.ts`). `fixBlockLines` in `src/review/fix-report.ts` prints each entry in the block of a finding as `Validation, as <who> reports it: <method>, <source>: <evidence>`, and the block of a check in the evidence of the fix pass prints the entries of the repair in the same way.

### Replay

`src/replay/run.ts` sends the recorded prompt of each verifier again, with `verifierOutputSchema`, and checks each answer with `checkVerdicts`. A group gets one worker and one fresh retry in a sample, and a group whose two answers fail is kept PLAUSIBLE and unverified in the results, as a review records it.

### The versions and the digest

At `ff801690` the newest versions are `review.configured@8`, `verdicts.recorded@1`, `fix.recorded@4` and `report.written@7`, the vocabulary is `reviewVocabularyV9`, and the golden fixtures end at `test/fixtures/checkpoints/schema-1-16`. `rolesDigest` in `src/review/policy.ts` hashes the key and the digest of each assembled role prompt. The output schema of a role and the text of a task are not in it.

### The size of the records

The ledger of this repository's runs holds 37 runs. The frozen stdout of its completed Claude workers takes 12.2 MB in all, and the evidence store 315 MB. Counting the user and assistant messages of the transcripts that Claude Code kept for the same sessions, each as one line with about 200 bytes of the fields of a stream line, the streams would have taken about 267 MB: medians of about 128 KB for a verifier and 200 KB for a fixer, and at most 1.1 MB for one worker. Its verifiers made 2.2 shell calls each on average, and its fixers 14.0. The author keeps the scripts and their output outside the repository.

## Design

### The record of the Claude adapter (R1)

`claudeCommand` passes `--output-format stream-json --verbose` in place of `--output-format json`, and `--verbose` joins `claudeFlags`. `decodeClaude` reads `outputs.stdoutLines`. A blank line is skipped. A line that is not JSON, or not an object, fails the worker with its number, as `readStream` does for Codex. A line longer than `maxLineBytes` fails it too. The envelope is the last event whose `type` is `result`, and every rule of today applies to it unchanged. A stream with no `result` event fails with `Claude Code printed no result event`. The whole text of stdout is never read, so the cap of `maxDecodeBytes` no longer applies to a Claude worker. The reading of the stream goes to a module of its own, `src/runtime/claude-stream.ts`, since `claude.ts` keeps the command line and the rules of the envelope.

The shell runs of the stream are the `tool_use` blocks of the `assistant` events whose `name` is `Bash`, the one shell tool of `claudeTools`, in the order of the stream. Each takes its result from the `tool_result` block of a later `user` event with the same `tool_use_id`. The output is the content of the result: a string, or the `text` of each text block joined with line feeds. The exit code is 0 when `is_error` is false. When `is_error` is true and the content starts with a line `Exit code <n>`, the exit code is n. Any other error, such as a timeout of the tool, gives none. A call with no result gives a run with no output, which no lookup finds. A stream that is not well formed gives no runs, with the failure of the worker as today.

### The record of the Codex adapter (R1)

`observeItem` also keeps each completed `command_execution` item, in the order of the stream, as a shell run: its `command`, its `aggregated_output` as the output, empty when it is missing, and its `exit_code` when it is a number. The other rules of the stream do not change.

### The runs on the receipt (R1)

`src/runtime/adapter.ts` gets:

```ts
/** One shell command a worker ran, as its runtime recorded it: its place in the record is its index plus one. */
interface ShellRun {
  readonly command: string;
  readonly output: string | null;
  readonly exitCode: number | null;
}
```

`Decoded` gets `runs: readonly ShellRun[] | null`, null when the adapter read no record. `WorkerReceipt` gets the same field from the decode. Nothing records it, and the frozen stdout holds what it was read from (TD2). Each adapter declares `capabilities.shellRecord`, true for both, and a review refuses a runtime without it when it configures a run with this change, by name, as it refuses any capability that a runtime lacks before anything runs.

### The verifier's answer (R2, R3)

`src/review/schemas.ts` gets `verifierOutputSchemaV2`:

```ts
const citedRun = z.strictObject({
  command: z.string().min(1).max(2000),
  printed: z.array(z.string().min(1).max(300)).min(1).max(5),
  probe: z.string().min(1).max(400).nullable(),
});
export const verifierOutputSchemaV2 = z.strictObject({
  verdicts: z.array(z.strictObject({
    index,
    verdict: verdictSchema,
    evidence: z.string().min(1).max(1000),
    basis: verdictBasisSchema, // 'ran' | 'traced' | 'read'
    runs: z.array(citedRun).max(3),
  })),
});
```

`checkVerdicts` gets two rules for a V2 answer: a verdict whose basis is `ran` cites at least one run, and a verdict with another basis cites none. A cited line that is blank after trimming fails it too. `invocationFor` gives a verification unit of a run configured with this change `verifierOutputSchemaV2`, and every other verification unit `verifierOutputSchema`.

`verifierTask` gets a paragraph for a V2 unit. It defines the three bases, asks for each run that a verdict rests on to be cited with the command as the verifier ran it and one to five lines of its output, copied exactly, that show the result, and says that each cited run is looked up in the record of the verifier's shell runs and that an answer that cites a run not there is discarded whole and the group runs again. A unit with a scratch directory is asked to write a probe as a file there and run that file, and to name its path in `probe`. A unit with no scratch directory, a reading Codex worker, is told to run a probe as a command and to give `probe` as null. The task does not ask for a probe where the rubric does not: the rubric already says when to run one.

### The lookup (R4, R7)

`src/review/cited-runs.ts` holds the lookup, shared by the verifiers and the editing workers:

- `normalized(text)` turns CR LF and a lone CR into LF, removes the escape sequences of a terminal (CSI and OSC), and trims the spaces at the end of each line.
- `findRun(record, cited)` gives the last shell run of the record whose normalized output holds each cited line, trimmed, in the order cited, each after the end of the one before, and, when `cited.probe` is not null, whose command holds the base name of the probe. It gives the place of that run in the record, from 1, and its exit code, or null when no run holds them.
- `freezeProbe(scratch, path, evidence)` resolves `path` against the scratch directory of the worker, follows links, and freezes the file when its real path is inside the real path of that directory, it is a regular file, and it has at most 64 KiB. It gives the reference and the base name, or the reason it cannot.

The last matching run is taken because a verifier often runs a probe, changes it, and runs it again, and its answer follows its last run (TD4).

For a verifier, `contributionOf` runs the lookup after `checkVerdicts`, with the runs of the receipt and the scratch directory that `worker.launched` recorded. A cited run that `findRun` does not find throws `StructuralCheckError`, naming the index of the verdict and the first 200 characters of the command. A probe that `freezeProbe` cannot freeze throws it too, with the reason. So the attempt fails, and the unit runs again as for any structural check (PD3). A probe is frozen before the append that records the answer. A stop between the two leaves a blob that no event names, as a refused launch leaves its frozen prompt today.

For an editing worker, `contributionOf` runs the same lookup for each cited run of each validation entry and records the result. Neither a run that is not found nor a probe that cannot be frozen throws. The first records no place, and the second records no probe, with the reason in the log (PD4).

### The verdict on the ledger (R5)

`verdicts.recorded@2` holds each verdict as:

```ts
{
  id, verdict, evidence,
  basis: 'ran' | 'traced' | 'read',
  runs: { command, printed, probe: { blob: ArtifactReference; name: string } | null, at: number, exitCode: number | null }[],
}
```

`at` is the place of the run in the record, from 1. The engine writes version 2 for each answer of a V2 unit, and version 1 for every other (TD7). The fold gives the verdict of a candidate `basis`, null for version 1, and `runs`, empty for version 1. Its reducer holds the two rules of `checkVerdicts` above and `at` of at least 1, as the fold holds recorded data to the rules of its writer elsewhere. Each probe is an artifact reference, checked as each artifact reference of an event is.

`Resolution` gets `basis` and `runs`. `mergedResolution` takes them from the same candidate as the evidence, so a finding never shows the evidence of one candidate with the runs of another.

### The fixer's task (R6)

For a run configured with this change, `candidateLines` gives, after the evidence of a candidate, its basis and each of its runs: the command, the cited lines and the exit code, and, for a frozen probe, its name and the path of its blob in the evidence store, as the repair task gives the frozen path of an output today. The task of a fixer, of the documentation worker, of the repair and of an answer pass gets one paragraph. It asks for each validation entry to cite the runs that it rests on, in the form of a verifier's cited run, and says that each is looked up in the record of the worker's shell runs and that the report says which the record shows. The fixer's task adds that when a candidate's verifier ran a probe, the fixer copies the probe into its scratch directory by its name, runs it on the code before the fix and again after the fix when it can, and cites both runs in the entry whose method fits them.

### The validation on the ledger (R7)

`fixerOutputSchemaV2` is `fixerOutputSchema` with `runs`, at most 4 cited runs, in each validation entry, and `repairOutputSchemaV2` extends it with the comparisons. `invocationFor` gives them to the editing units of a run configured with this change. The fixed finding of the fold gets, in each validation entry, `runs: { command, printed, probe: { blob, name } | null, found: { at: number; exitCode: number | null } | null }[]`. `fix.recorded@5` is version 4 with those entries. By the rule of `carriedVersions`, an answer is written at version 5 when one of its entries cites a run, and at the version of today otherwise (TD7). The fold reads an entry of an earlier version as one with no runs.

### The report (R8)

`findingBlock` gives, after `Evidence:`, the line `How the verifier established it:` with the basis in fixed words: `it ran code`, `it traced the lines` or `the lines alone settle it`. It gives no such line for a verdict with no basis, from a run configured before this change. Each run follows as one line: `Shell run <at> of its record: <command> printed "<line>" / "<line>", exit <code>.`, with `The probe is <storeNameOf(blob)>, named <name>.` when it has one. The command and the lines are worker text, quoted and escaped as the evidence is. Before it quotes a cited command and its lines, here and in a validation line, the report writes each scratch directory of the run's workers as `<scratch>`, spelled as `worker.launched` recorded it or with forward slashes. "Refuted at verification" gives the same lines for a refuted candidate.

`fixBlockLines` and the evidence of the fix pass end each validation line with what the record shows: `Its record shows shell run 4 and shell run 6.`, or `Its record does not show: <command>.` for each cited run that the engine did not find, or nothing when the entry cites no run. `deep-review report --stats` gets two tables: the verdicts of each grade by basis, and the cited runs of the editing workers, found or not, by role.

### Replay (R10)

`src/replay/run.ts` gives each replayed verifier the schema of its recorded run: `verifierOutputSchemaV2` for a run configured with this change, else `verifierOutputSchema`. For a V2 answer, it runs the lookup over the runs of the replayed worker's receipt, and a run that is not found fails the attempt, as an answer that fails `checkVerdicts` does. It freezes no probe in the checkpoint of the run. The results of a sample keep the verdicts, and the summary counts them by basis.

### The events and the fold (R9)

The vocabulary freezes as `reviewVocabularyV10`, with `verdictBases`. These events get a new version:

| Event | New version | Written for |
|---|---|---|
| `review.configured` | 9 | Each run that this engine configures. The version alone marks a run with this change (TD6) |
| `verdicts.recorded` | 2 | The answer of a verification unit of a run configured with this change |
| `fix.recorded` | 5 | The answer of an editing unit of a run configured with this change, when one of its entries cites a run |

In the fold, `ConfiguredSteps` gets `cited`, true from `review.configured@9`. The reducer of `verdicts.recorded@2` refuses it in a run without `cited`, and the reducer of `verdicts.recorded@1` refuses it in a run with `cited`, so a run never mixes the two answers. A run configured before this change keeps `verifierOutputSchema` and the editing schemas of today, also when this engine resumes it, and its report shows no basis and no run. Its Claude workers that this engine launches print the stream, and the engine reads their runs into the receipt and does nothing with them. An engine before this change does not know `review.configured@9`, so it passes over a run of this engine.

### A stop (R11)

The lookup and the freezing happen in the contribution of the worker, before the append that records the finish with the answer, so a stop leaves either both or neither, as today. The fake verifier of the contract test cites a run with a probe, and its fake fixer cites the runs of its validation, so each fixed stop point and each point of `npm run resume-test` is crossed by a run that cites runs. Its part "nothing false" compares the recorded runs too.

### The fakes

`test/helpers/fake-claude.ts` prints a stream: an `assistant` event and a `user` event for each scripted shell run, then the `result` event that it prints today as the envelope. `test/helpers/fake-codex.ts` already prints `command_execution` items. The fake verifier and the fake fixer of `test/helpers/fake-runtime.ts` script their runs and cite them.

### The golden fixture

A change of the event kinds needs a new fixture: `npm run golden -- --output test/fixtures/checkpoints/schema-1-17`. Its run holds `review.configured@9`, a `verdicts.recorded@2` with a cited run and a frozen probe, and a `fix.recorded@5` with one run found and one not found. The older fixtures must still open and fold.

### Where the code goes

The reading of the Claude stream goes to `src/runtime/claude-stream.ts`, and `ShellRun` to `src/runtime/adapter.ts`. The lookup and the freezing of a probe go to `src/review/cited-runs.ts`, which `phases.ts` and `src/replay/run.ts` call. The schemas go to `src/review/schemas.ts`, the paragraphs of the tasks to `src/review/tasks.ts`, and the lines of the report to `report.ts`, `fix-report.ts` and `stats-report.ts`.

### The skills and the README

The skills show the top of the brief as the engine prints it, and the brief does not change, so their text does not change. The README gets the stream of the Claude adapter in "The runtime adapter", the basis and the cited runs in "The read-only review", the cited runs of a validation in "The fix pass", and the new lines of a finding's block in the paragraph of the report.

## Technical Decisions

### TD1: The stream of Claude Code, read a line at a time

`--output-format stream-json --verbose` is a documented form of the output of Claude Code, and its last event is the envelope of today, so the rules of the envelope move without a change. The design reads it as `readStream` reads Codex's, a line at a time, so a worker's stdout of any size is decoded with one line held at once.

The design rejects two other ways. The transcript that Claude Code keeps of each session is a file whose place and form belong to Claude Code, outside the checkpoint, and it is not what the process printed (PD2). A hook of Claude Code that logs each tool call is a setting, and the adapter turns the setting sources off so that no file of the operator reaches a worker; a hook given on the command line would be a second process for each call.

### TD2: The runs are a reading of the frozen stdout

The frozen stdout holds each run, so the receipt carries the reading in memory, and the events record only the runs that an answer cites, with their place in the record. A person who wants the whole run finds it at that place in the frozen stdout.

The design rejects a new version of `worker.finished` with every run. It would hold the outputs a second time, up to the size of the stream, for every worker, also the workers whose answers cite nothing.

### TD3: The lookup runs while the answer is recorded

`contributionOf` already turns a worker's answer into events and throws `StructuralCheckError` for an answer that the engine refuses. The lookup is one more check there, so it costs no phase, no unit and no event of its own, and it shares the one append of the finish (R11).

### TD4: A cited run is found by its printed lines, and the last such run counts

The printed lines are copied from the output that the worker saw, which is the output that the record holds, and they survive the wrapper and the quotes of the shell of Codex (PD8). The base name of a probe ties the run to the file, since a shell does not quote such a name. The last run that matches is taken, because a verifier often runs a probe again after it changes it, and its answer describes the run it saw last.

The design rejects two other keys. The text of the command differs from the record on Codex and when a model shortens it. An id of the tool call is in the record but not in what the model sees, so the model cannot cite it.

### TD5: The schema is chosen by the unit

`invocationFor` already chooses the repair's schema by its unit (TD6 of the facts before a merge). A run configured before this change keeps the schemas that it was configured with, so its verifiers never get a field that its fold cannot hold.

### TD6: `review.configured@9` marks a run with this change

The version alone marks the run, as version 8 marks the checks on the base (TD8 of the facts before a merge). The payload does not change.

### TD7: A new version only for an event that carries the new facts

`verdicts.recorded@2` is written for each answer of a V2 unit, since each of its verdicts carries a basis. `fix.recorded@5` is written only for an answer whose entry cites a run, by the rule of `carriedVersions` (TD5 of the documentation step). An answer that cites no run is written at the version of today, and a reader learns from `review.configured@9` that the run asked for cited runs.

### TD8: A probe is frozen by its real path

A path that the worker gives can name a link or a `..` that leads out of its scratch directory. The engine resolves the real path of the file and of the directory before it compares them, so it freezes no file of the reviewed tree, of the checkpoint or of the operator.

## Open Questions

### Does the lookup find the runs that the workers cite?

A model can change a line when it copies it. The metric of the cited runs found at the first answer measures it in the gate, and each miss is read against the record.

### How large is the stream of a worker?

The estimate counts the messages of the transcripts that Claude Code kept. The gate measures the store of each run.

### What does the stream of a Codex worker on Windows record for a command that the sandbox refused?

A command that the unelevated sandbox stops can give an exit code and an output that name the refusal, or no exit code. The gate reads such runs, and the lookup finds them only by what they printed.

## Test Strategy

### R1: The record

Tests of `decodeClaude` hold that a stream with a `result` event decodes as the envelope of today does, for each rule of the envelope, and that a stream with no `result` event, a line that is not JSON and a line over the limit each fail the worker. A test holds that a stdout over 16 MiB with a `result` event at its end decodes. Tests hold the runs of a stream: a call that passed, a call that exited nonzero with `Exit code <n>`, an error with no code, a call with no result, a result with text blocks, and a `tool_use` of another tool, which gives no run. Tests of `decodeCodex` hold the runs of `command_execution` items, a missing output and a missing exit code. A test holds that the preflight refuses a Claude Code whose help text lacks `--verbose`, and that a review refuses a runtime without `shellRecord` when it configures a run.

### R2, R3, R4 and R5: The verifier

Tests of `findRun` hold a match in order, a match across CR LF and colors, a line that is in the output but out of order, a probe whose name is not in the command, the last of two matching runs, and a run with no output. Tests of `freezeProbe` hold a file in the scratch directory, a path with `..`, a link that leads out, a directory, a missing file and a file over 64 KiB. A test of the review holds that a verifier whose cited run is in its record records `verdicts.recorded@2` with the place, the exit code and the frozen probe, and that one whose cited run is not there fails its attempt, runs again, and, when the second answer fails too, leaves its group unverified. A test holds the two rules of the basis in `checkVerdicts` and in the fold.

### R6 and R7: The fixer

A test of the task holds the runs of a candidate and the paragraph on the probe. A test of the review holds that a fixer's entry whose runs are found records their places, that one whose run is not found records none, and that the edits of that answer stand in both cases. A test holds the version that `carriedVersions` gives with and without a cited run.

### R8: The report

Tests of `findingBlock` hold the line of each basis, the lines of the runs with and without a probe, a merged finding whose runs come from the candidate whose evidence it shows, and no line for a verdict with no basis. Tests hold the validation lines and the two tables of `--stats`. A test holds that the brief of a run with cited runs is the brief of the same run without them.

### R9: Older runs and older engines

The fixture `schema-1-17` holds a run with this change, and every older fixture still opens and folds. A test resumes a run configured with version 8 under this engine and holds that its verifiers get `verifierOutputSchema` and that it writes no event at a version that this change adds. Tests of the fold refuse a `verdicts.recorded@1` in a run with `cited` and a `verdicts.recorded@2` in a run without it.

### R10: Replay

A test replays a run configured before this change with the old schema, and a run of this change with the lookup, a cited run that is not found failing the attempt.

### R11: A stop

The contract test holds its five parts at each stop point with runs cited by the fake verifier and the fake fixer, and `npm run resume-test` breaks at none.

### R12: The gate

The gate records each metric of the requirements for each run, and reads each cited run that was not found, and each validation entry whose run the record does not show, against the frozen stdout of its worker.

## Verification

### Implementation

The work is in pull request #93, after the proposal. It came in units, each a commit that passes typecheck and lint alone: the shell runs of a Codex worker's stream, with `ShellRun`, `Decoded.runs`, `Capabilities.shellRecord` and the runs on the receipt; the stream of a Claude Code worker and its shell runs; the ledger (`review.configured@9`, `verdicts.recorded@2`, `fix.recorded@5`, `reviewVocabularyV10`, the fold and the golden fixture `schema-1-17`), which no engine configured yet; the lookup of `src/review/cited-runs.ts`; the verifier's answer and its lookup; replay; the switch that configures new runs at version 9 and refuses a runtime without `shellRecord`; the editing workers' answers and their lookup; the report and `--stats`; the README; and the build of `dist/`.

At the head of the work, `npm run check` passed (3090 tests: 3077 passed, 0 failed, 13 skipped, against 3006 passed before the work), `npm run verify` passed, and `npm run test:contract` passed 89 of 89, against 85 before the work: a stop point between the freezing of a verifier's probe and the append of its finish joins the others, and the part "nothing false" compares each cited run of a verdict and of a validation by its place, exit code, cited lines, probe name and probe hash. `npm run resume-test` ran 984 cases on Linux, and none broke the contract. `npm run build` changed only the engine bundle of each artifact and its hash: no skill text and no role prompt changed, so the digest of the roles stays (PD6).

The event shapes of the stream were read on Claude Code 2.1.310, not the 2.1.314 of Context, by hand and through `npm run smoke`: a `Bash` call is a `tool_use` block of an `assistant` event, its result a `tool_result` block of a later `user` event, a command that exited 3 gives `is_error: true` and the content `Exit code 3` and its output, and the last line is the `result` event with every field of the envelope. `--print` refuses `stream-json` without `--verbose`. A `Bash` call with no output gives the content `(Bash completed with no output)`, and a resumed session's stream holds only the turns of its own process. The smoke run of Codex 0.164.0 on Linux gave the runs of its editor, each command wrapped as `/usr/bin/zsh -lc "..."`.

### Changes of the proposal during the work

- When a Claude Code stream has a line that is not an event and still holds a `result` event, the worker fails with the number of that line, and its finish keeps the session id, the usage and the denials of the envelope, as a malformed Codex stream keeps its thread and usage. Such a stream gives no runs.
- On Claude Code a command that exited nonzero has `Exit code <n>` as the first line of its output, as the worker saw it, and Codex records no such line. The lookup matches cited lines in order anywhere in the output, so the line does not stand in its way.
- `verdictBasisSchema` is in `src/review/vocabulary.ts`, beside `verdictSchema`.
- The fold refuses a cited run of a validation entry in a run configured before version 9, and a `found.at` below 1, as it refuses the same of a verdict.
- A frozen probe is named by the base name of the path that the worker gave. A probe of a validation run that the engine did not find is still frozen when it can be, since the place and the probe are recorded apart.
- A cited line that is blank after trimming fails a verifier's answer in `checkVerdicts`, and in an editing worker's answer makes its run not found, since a blank line is in every output.
- A run with no exit code on record reads `no exit code on record` in the report and in the fixer's task. Two cited runs of one entry found at the same place are named once.
- The second table of `--stats` counts the cited runs of the editing workers by phase, not by role: the repair and an answer pass run in the role `fixer`, so a table by role would merge them with the fixers. It has a row for each editing phase that ran.
- The summary of a replay gives the verdicts by basis only when some verdict has one, so the summary of a run configured before this change reads as before.
- A cited command and its lines are worker text and can name the scratch directory of the worker, a local path, so the report writes each scratch directory of the run's workers in them as `<scratch>`. "About this run" stays the one part of the report that names a local path, and the workers' tasks keep the paths as they are.

### A real run

A fix run on Claude Code 2.1.310, with the engine of this branch, `sonnet` as the strong model and `haiku` as the fast one, reviewed the last commit of a repository of two files made for it, whose change reads `input.length` before it tests `input == null`. It took 3 minutes 35 seconds and spent 1.20 USD. Both verifier groups answered at the first attempt: 5 verdicts with the basis `ran` cited one run each, the engine found each, as shell run 1 of its record, and froze the two probes, both named `p.mjs`. Two verdicts had the basis `read`. The validation entries of its two fixers cited 4 runs, and the engine found all 4; the entries that rest on a reading of the source cited none, and their lines name no run. The brief is the brief of the same run without cited runs, and the evidence store of the run took 1.2 MB. The report and the ledger stay outside the repository, with the author.

### The gate (R12)

No check of the gate has run yet: neither the fix run of deep-review on this pull request on Claude Code, nor the fix run on pallets/click #3878 on Codex on Windows.

## Risks & Migration

### Ledgers before this change

A ledger before this change folds as before. Its runs have no basis and no cited run, and their reports show neither.

### An older engine and a newer run

An older engine passes over a run that this engine configured, as for each new version of an event.

### Every Claude worker prints the stream

The adapter has one command line, so each Claude worker that this engine launches prints the stream, also in a run configured before this change and in replay. Its frozen stdout grows with it (the risk "The evidence store grows" of the requirements). A tool that reads a frozen stdout of a Claude worker as one JSON envelope must read the last line of a newer one.

### The fakes of the tests

The fake Claude runtime prints a stream in place of the envelope, so each test that runs a fake Claude worker crosses the new decode. A test that reads the frozen stdout of such a worker as one envelope changes with it.

### A third runtime

A runtime whose adapter reads no shell runs declares `shellRecord` false, and a review refuses it for a run with this change by name. Its adapter can add the reading later.
