/**
 * Replaying a recorded run's writer, to measure the writer's answer on
 * real runs before the engine builds on it (PD9, OQ1 of the review in the
 * writer's words), and to measure a later change of the writer's prompt
 * against recorded runs, as principle 10 of the vision note asks of a
 * rubric. The run's ledger is read up to the start of its explanation
 * phase, the writer's task is built again by this engine at the version
 * given, which may be one the run was not configured for, one writer is
 * launched with the prompt and the schema of that version, and its answer
 * is checked as the explanation phase checks it. What the replay writes is
 * the size of the answer, its time, its cost and each part that failed.
 *
 * A measurement tool, not part of a review: it reads a copy of the
 * recorded ledger and never writes to the recorded checkpoint, records its
 * own worker in a checkpoint of its own under the output directory, and
 * calls a real model when given a real runtime.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Checkpoint, evidenceDirectoryName } from '../checkpoint/checkpoint.ts';
import { workerLaunchedV1, type DroppedPart, type ScopeState, type WorkerLaunch } from '../checkpoint/events.ts';
import { firstUnknownEvent, foldRun, type DecodedEvent, type RunState } from '../checkpoint/fold.ts';
import { locateCheckpoint } from '../checkpoint/locate.ts';
import { changeReadingOf, explanationVersionOf, type ExplanationVersion } from '../checkpoint/review-fold.ts';
import { conventionsKnown } from '../checkpoint/survey-state.ts';
import { EvidenceStore } from '../evidence/store.ts';
import { ghTokenVariables } from '../github/gh.ts';
import { isInside } from '../paths.ts';
import { changeShapeOf } from '../review/brief.ts';
import { checkedAnswers, checkedAnswersV4, findingsLeftAsIs, findingsToExplain, mergeAnswers, mergeAnswersV4, partNameOf, reviewLanguage, type AnyWriterOutput } from '../review/explanation.ts';
import { parseUnitLabel, unitLabel } from '../review/labels.ts';
import { pinnedRole, readPolicy, resolvePolicy, type ResolvedPolicy } from '../review/policy.ts';
import { composeWorkerPrompt, scopeBlock } from '../review/prompts.ts';
import { machineContextOf } from '../review/public-text.ts';
import { writerOutputSchemaOf, type WriterOutputV4 } from '../review/schemas.ts';
import { settledWorkers, spendOf } from '../review/spend.ts';
import type { ChangeMessages } from '../review/tasks.ts';
import { singleUnitKey } from '../review/vocabulary.ts';
import { hasCore, writerTask } from '../review/writer-task.ts';
import { assembleRoles } from '../roles/assemble.ts';
import { withoutVariables } from '../runtime/environment.ts';
import { runWorker } from '../runtime/launcher.ts';
import type { RuntimeAdapter } from '../runtime/adapter.ts';
import type { WindowsSandbox } from '../runtime/codex.ts';
import type { RuntimeRegistry } from '../runtime/registry.ts';
import { defaultRuntimes } from '../runtime/runtimes.ts';
import { commitMessages } from '../scope/git.ts';
import { readRecordedRun, type RecordedRun } from './decider.ts';
import { ReplayRefusedError } from './errors.ts';
import { replayCheckpointDirectoryName, treeDifferences, writeWhole } from './run.ts';

/** The file of the output directory that holds what the measure reads. */
export const writerFactsFileName = 'facts.json';

/** The file of the output directory that holds the writer's prompt, its task included. */
export const writerPromptFileName = 'prompt.md';

/** The file of the output directory that holds the writer's answer as it gave it. */
export const writerAnswerFileName = 'answer.json';

/** The role and the unit the replayed writer runs as, those of the explanation phase. */
const role = 'writer';
const unitKey = singleUnitKey('explanation');

/**
 * The run folded as its explanation phase starts: every event up to and
 * with the first start of that phase, so the writer's task is built from
 * the state it was built from in the run, which holds no answer of a
 * writer, no answer of the author and no continuation (TD6 of the review
 * in the writer's words). Refused when the run holds an event this engine
 * cannot read there, when it does not explain its review, or when it never
 * reached the explanation phase.
 */
export function foldAtExplanation(run: RecordedRun): RunState {
  const start = run.events.findIndex((event) => event.kind === 'phase.started' && (event.payload as { readonly phase?: unknown }).phase === 'explanation');
  if (start === -1) throw new ReplayRefusedError(`Run ${run.runId} never reached the explanation phase, so it has no writer to replay`);
  const prefix: readonly DecodedEvent[] = run.events.slice(0, start + 1);
  const unknown = firstUnknownEvent(prefix);
  if (unknown !== null) throw new ReplayRefusedError(`Run ${run.runId} holds ${unknown.kind}@${String(unknown.version)} at sequence ${String(unknown.sequence)}, written by engine ${unknown.engine}, before its explanation, which this engine cannot read`);
  const state = foldRun(prefix);
  if (state.review === null || !state.review.explanationStep) throw new ReplayRefusedError(`Run ${run.runId} does not explain its review, so it has no writer to replay`);
  return state;
}

/** The scope block the writer receives (`scopeBlockFor` of the controller): the conventions the survey recorded, the triage's account of the change, and the patch. */
function scopeBlockOf(state: RunState, scope: ScopeState, tree: string, evidence: EvidenceStore): string {
  const review = state.review!;
  const conventions = conventionsKnown(review.survey);
  // A run that explains its review is surveyed, so its conventions never predate the survey.
  if (conventions.status === 'predates-survey') throw new Error(`Run ${state.id} explains its review and predates the survey`);
  return scopeBlock({ worktree: tree, scope, evidence, conventions, change: changeReadingOf(review.change) });
}

/** The commit messages of the change, as the controller reads them for the writer (`changeMessages`), from the tree, which holds the run's commits. */
function changeMessagesOf(scope: ScopeState, tree: string): ChangeMessages {
  const shape = changeShapeOf(scope);
  if (shape === 'working-tree') return { kind: 'working-tree' };
  try {
    return { kind: 'read', messages: commitMessages(tree, scope.base, scope.head), withTree: shape === 'commits-and-tree' };
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The settings a replayed writer runs with, and whether they are the recorded writer's launch's or the role policy's. */
export interface WriterSettings {
  readonly from: 'recorded' | 'policy';
  readonly model: string;
  readonly effort: WorkerLaunch['effort'];
  readonly timeoutMs: number;
  readonly budgetUsd: number | null;
  readonly pinned: { readonly codex?: { readonly windowsSandbox: WindowsSandbox } };
}

/** The first writer the run launched in its explanation phase, read from its `worker.launched` event past the cut, or null when it launched none. */
function recordedWriterLaunch(run: RecordedRun): WorkerLaunch | null {
  for (const event of run.events) {
    if (event.kind !== 'worker.launched') continue;
    const parsed = workerLaunchedV1.safeParse(event.payload);
    if (!parsed.success) continue;
    const unit = parseUnitLabel(parsed.data.label);
    if (unit?.role === role && unit.phase === 'explanation') return parsed.data;
  }
  return null;
}

/**
 * The settings the replayed writer runs with, as the decider's replay
 * takes them: on the runtime the run's writer ran on, what that writer's
 * launch recorded, so the replay differs from the record in the prompt,
 * the task and the schema alone; on another runtime, or for a run that
 * recorded no writer launch, the role policy's for the runtime.
 */
function writerSettings(resolved: ResolvedPolicy, adapter: RuntimeAdapter, state: RunState, recorded: WorkerLaunch | null): WriterSettings {
  const policy = pinnedRole(resolved.roles, role);
  const policyCodex = resolved.codex === null ? {} : { codex: resolved.codex };
  if (recorded === null || recorded.runtime !== adapter.name) return { from: 'policy', model: policy.model, effort: policy.effort, timeoutMs: policy.timeoutMs, budgetUsd: policy.budgetUsd, pinned: policyCodex };
  if (!adapter.capabilities.effortLevels.includes(recorded.effort)) throw new ReplayRefusedError(`The run's writer ran at effort ${recorded.effort}, which runtime ${adapter.name} no longer has; it has ${adapter.capabilities.effortLevels.join(', ')}`);
  const recordedCodex = state.review?.configuration.codex ?? null;
  return {
    from: 'recorded',
    model: recorded.model,
    effort: recorded.effort,
    timeoutMs: recorded.timeoutMs,
    budgetUsd: adapter.capabilities.budgetCap ? (recorded.budgetUsd ?? policy.budgetUsd) : null,
    pinned: recordedCodex === null ? policyCodex : { codex: recordedCodex },
  };
}

/** A part of the answer that failed the checks, by the name the retry's task gives it, with its failures. */
export interface FailedPart {
  readonly part: string;
  readonly failures: readonly string[];
}

/** What the measure reads of one replayed writer (OQ1 of the review in the writer's words). */
export interface WriterFacts {
  readonly run: string;
  readonly version: ExplanationVersion;
  /** The language the writer was asked to write in, the run's unless the replay was given another. */
  readonly language: string;
  readonly runtime: string;
  readonly model: string;
  readonly effort: WorkerLaunch['effort'];
  readonly settingsFrom: WriterSettings['from'];
  readonly timeoutMs: number;
  readonly budgetUsd: number | null;
  /** The findings the writer explains, those left as is, and every ranked finding. */
  readonly findings: { readonly explained: number; readonly left: number; readonly ranked: number };
  /** The prompt's size, its task included, in bytes. */
  readonly promptBytes: number;
  /** What became of the worker: its outcome and, when it gave none, why. */
  readonly outcome: string;
  readonly error: string | null;
  /** The answer as JSON, in bytes, and the characters of every text in it; null when the worker gave no answer. */
  readonly answerBytes: number | null;
  readonly answerCharacters: number | null;
  /** The wall time of the worker's process, in seconds, and what it cost, or null on a runtime that reports none. */
  readonly seconds: number;
  readonly costUsd: number | null;
  /** Each part of the answer the checks would drop, with its failures; empty when every part passed or no answer came. */
  readonly failed: readonly FailedPart[];
}

/** The characters of every text an answer holds, as Unicode code points, keys left out: how much the writer wrote. */
export function textCharacters(value: unknown): number {
  if (typeof value === 'string') return [...value].length;
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + textCharacters(item), 0);
  if (value !== null && typeof value === 'object') return Object.values(value).reduce<number>((sum, item) => sum + textCharacters(item), 0);
  return 0;
}

export interface WriterReplayOptions {
  /** The `deep-review-checkpoint` directory that holds the recorded run. Only a copy of its ledger is read, and its evidence. */
  readonly checkpoint: string;
  /** The id of the run, or the start of it. */
  readonly run: string;
  /** A checkout of the repository at the commit the run reviewed, holding no change and the run's commits: where the writer runs. */
  readonly tree: string;
  /** A directory that is absent or empty, for the replay's files and its own checkpoint. */
  readonly output: string;
  readonly runtime: string;
  readonly executable: string;
  readonly executableArgs?: readonly string[];
  /** The roles directory whose writer prompt the replay runs with. Its policy gives the launch settings only on another runtime than the run's writer ran on, or for a run that recorded no writer launch. */
  readonly rolesRoot: string;
  /** The version of the answer to ask for: 4 by default, or the version the run was configured for. */
  readonly version?: ExplanationVersion;
  /** The language to ask the writer to write in, as a language tag: the run's by default. */
  readonly language?: string;
  /** Write the prompt and launch nothing. */
  readonly printTask?: boolean;
  /** The engine version the replay's own checkpoint names. */
  readonly engine: string;
  readonly log: (line: string) => void;
  readonly runtimes?: RuntimeRegistry;
  readonly environment?: NodeJS.ProcessEnv;
  readonly scratchRoot?: string;
  readonly platform?: NodeJS.Platform;
}

export interface WriterReplayOutcome {
  readonly runId: string;
  /** What the measure reads, or null when the prompt was only printed. */
  readonly facts: WriterFacts | null;
}

/**
 * Replay the writer of a recorded run. In order: read the run up to the
 * start of its explanation phase and refuse one that never reached it;
 * refuse a version the run can neither be asked for nor checked at, a tree
 * that is not the reviewed commit, unchanged, and an output directory
 * inside it or holding anything; build the prompt with the roles given and
 * the task of the version asked for, in the language asked for; then, unless only printing the task,
 * launch one writer, check its answer as the explanation phase would, and
 * write the answer and the facts. The prompt and the answer are written as
 * they are made. Nothing is appended to the recorded run's ledger.
 */
export async function replayWriter(options: WriterReplayOptions): Promise<WriterReplayOutcome> {
  const { log } = options;
  const platform = options.platform ?? process.platform;
  const root = resolve(options.checkpoint);
  const recorded = readRecordedRun(root, options.run);
  const state = foldAtExplanation(recorded);
  const review = state.review!;
  const scope = state.scope!;
  const evidence = new EvidenceStore(join(root, evidenceDirectoryName));
  const version = options.version ?? 4;
  const configured = explanationVersionOf(review);
  if (version !== 4 && version !== configured) throw new ReplayRefusedError(`Run ${state.id} was configured for the writer's answer of version ${String(configured)}, so the replay asks it for that version or for version 4, not for version ${String(version)}`);
  if (scope.pullRequest === null) throw new ReplayRefusedError(`Run ${state.id} reviewed no pull request, so its writer wrote no review to replay`);

  const tree = locateCheckpoint(options.tree).worktree;
  const differences = treeDifferences(state, tree);
  if (differences.length > 0) throw new ReplayRefusedError(`${tree} is not the tree run ${state.id} reviewed: ${differences.join('; ')}`);
  const output = resolve(options.output);
  if (isInside(tree, output)) throw new ReplayRefusedError(`The output directory ${output} is inside the tree ${tree}, where the writer would read the replay's files and they would read as changes to the tree; give it an output directory outside the tree`);
  if (existsSync(output) && readdirSync(output).length > 0) throw new ReplayRefusedError(`The output directory ${output} is not empty; give each replay a directory of its own`);

  const runtimes = options.runtimes ?? defaultRuntimes();
  const adapter = runtimes.get(options.runtime);
  const roles = assembleRoles(options.rolesRoot);
  const assembled = roles.find((candidate) => candidate.key === role);
  if (assembled === undefined) throw new ReplayRefusedError(`The roles directory ${options.rolesRoot} assembles no ${role} role`);
  const settings = writerSettings(resolvePolicy(readPolicy(options.rolesRoot), roles, adapter, {}, platform), adapter, state, recordedWriterLaunch(recorded));
  const machine = machineContextOf({ worktree: state.worktree, checkpoint: root, gitCommon: locateCheckpoint(tree).commonDir, engine: join(import.meta.dirname, '..'), workers: state.workers, environment: options.environment ?? process.env, platform });
  const language = options.language ?? reviewLanguage(review);
  const task = writerTask(state, { worktree: tree, evidence, machine, commitMessages: hasCore(version) ? changeMessagesOf(scope, tree) : null, version, language });
  const prompt = composeWorkerPrompt(assembled.prompt, { role, phase: 'explanation', unitKey, task }, scopeBlockOf(state, scope, tree, evidence));
  const ids = findingsToExplain(review);
  const findings = { explained: ids.length, left: findingsLeftAsIs(review).length, ranked: (review.ranking ?? []).length };

  log(`replaying the writer of run ${state.id} at version ${String(version)} of its answer, in ${language}${language === reviewLanguage(review) ? '' : ` rather than the run's ${reviewLanguage(review)}`}: ${String(findings.explained)} findings to explain, ${String(findings.left)} left as is, read up to sequence ${String(state.lastSequence)}, as its explanation phase started`);
  log(`the writer runs with this engine and the roles in ${options.rolesRoot}, on ${adapter.name} ${settings.model} at effort ${settings.effort}, a timeout of ${String(Math.round(settings.timeoutMs / 60_000))} minutes and ${settings.budgetUsd === null ? 'no budget cap' : `a budget of ${String(settings.budgetUsd)} USD`}, ${settings.from === 'recorded' ? 'as the run\'s writer ran' : 'as the roles\' policy has it, since the run recorded no writer launch on this runtime'}`);
  mkdirSync(output, { recursive: true });
  const write = (name: string, text: string): string => {
    const path = join(output, name);
    writeWhole(path, text);
    return path;
  };
  const promptPath = write(writerPromptFileName, prompt);
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (options.printTask === true) {
    log(`print task: the prompt, ${String(promptBytes)} bytes, at ${promptPath}; nothing was launched`);
    return { runId: state.id, facts: null };
  }

  const replay = Checkpoint.open(join(output, replayCheckpointDirectoryName), { engine: options.engine });
  try {
    const run = replay.createRun({ worktree: tree });
    // Every worker of a run of a pull request is launched without the variables that hold a token for gh, as the review launched them (R15 of the review on the pull request).
    const environment = withoutVariables(options.environment ?? process.env, ghTokenVariables, platform);
    const receipt = await runWorker(replay, run.id, {
      runtime: adapter.name,
      executable: options.executable,
      executableArgs: [...(options.executableArgs ?? [])],
      model: settings.model,
      effort: settings.effort,
      access: 'read-only',
      shell: !adapter.capabilities.withholdShell,
      prompt,
      outputSchema: writerOutputSchemaOf(version),
      timeoutMs: settings.timeoutMs,
      ...(settings.budgetUsd === null ? {} : { budgetUsd: settings.budgetUsd }),
      label: unitLabel(role, 'explanation', unitKey),
    }, {
      runtimes,
      pinned: settings.pinned,
      platform,
      environment,
      ...(options.scratchRoot === undefined ? {} : { scratchRoot: options.scratchRoot }),
    });
    const answered = receipt.outcome === 'completed' && receipt.output !== null;
    const answerText = answered ? `${JSON.stringify(receipt.output, null, 2)}\n` : null;
    if (answerText !== null) write(writerAnswerFileName, answerText);
    let dropped: readonly DroppedPart[] = [];
    if (answered) {
      const context = { worktree: tree, evidence };
      dropped = version === 4
        ? mergeAnswersV4(checkedAnswersV4(state, review, context, ids, [receipt.output as WriterOutputV4]), ids).dropped
        : mergeAnswers(version, checkedAnswers(state, review, context, ids, receipt.output as AnyWriterOutput), ids).dropped;
    }
    const settled = settledWorkers(replay.fold(run.id)).filter((worker) => worker.launch.workerId === receipt.workerId);
    const spend = spendOf(settled, adapter);
    const facts: WriterFacts = {
      run: state.id,
      version,
      language,
      runtime: adapter.name,
      model: settings.model,
      effort: settings.effort,
      settingsFrom: settings.from,
      timeoutMs: settings.timeoutMs,
      budgetUsd: settings.budgetUsd,
      findings,
      promptBytes,
      outcome: receipt.outcome,
      error: receipt.error,
      answerBytes: answered ? Buffer.byteLength(JSON.stringify(receipt.output), 'utf8') : null,
      answerCharacters: answered ? textCharacters(receipt.output) : null,
      seconds: spend.seconds,
      costUsd: spend.costUsd,
      failed: dropped.map((part) => ({ part: partNameOf(part), failures: part.failures })),
    };
    write(writerFactsFileName, `${JSON.stringify(facts, null, 2)}\n`);
    log(`the writer ${receipt.outcome === 'completed' ? 'answered' : `ended ${receipt.outcome}: ${receipt.error ?? 'no reason recorded'}`} in ${String(spend.seconds)} s, ${spend.costUsd === null ? 'no cost reported' : `${spend.costUsd.toFixed(2)} USD`}${facts.answerBytes === null ? '' : `, an answer of ${String(facts.answerBytes)} bytes`}`);
    for (const part of facts.failed) log(`would drop ${part.part}: ${part.failures.join('; ')}`);
    return { runId: state.id, facts };
  } finally {
    replay.close();
  }
}
