/**
 * Replaying a recorded run's verifiers: every verification group the run
 * planned is sent again to a fresh verifier worker, on the recorded
 * runtime or another, with the prompt the recorded one was sent
 * (`replayPrompt`), in a clean checkout of the commit the run reviewed.
 * Each pass over the groups is a sample; the verdicts of every sample are
 * kept beside the ones the run recorded, so how stable a verdict is, and
 * how two runtimes judge the same candidates, can be counted.
 *
 * A measurement tool, not part of a review: it reads the recorded
 * checkpoint and never writes to it, records its own workers in a
 * checkpoint of its own under the output directory, and calls real models
 * when given a real runtime.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Checkpoint } from '../checkpoint/checkpoint.ts';
import type { Effort, WorkerLaunch } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { locateCheckpoint } from '../checkpoint/locate.ts';
import { collectArtifactReferences } from '../evidence/references.ts';
import { sha256Hex } from '../evidence/store.ts';
import { ReviewRefusedError, StructuralCheckError } from '../review/errors.ts';
import { parseUnitLabel, unitLabel } from '../review/labels.ts';
import { acquireStartLock, type ReleaseLock } from '../review/lock.ts';
import { pinnedRole, readPolicy, resolvePolicy } from '../review/policy.ts';
import { checkVerdicts, verifierOutputSchema, type VerifierOutput } from '../review/schemas.ts';
import { budgetSpendOf, settledWorkers, spendOf } from '../review/spend.ts';
import { assembleRoles, type AssembledRole } from '../roles/assemble.ts';
import type { RuntimeAdapter } from '../runtime/adapter.ts';
import type { InvocationInput } from '../runtime/contract.ts';
import { runWorker } from '../runtime/launcher.ts';
import type { RuntimeRegistry } from '../runtime/registry.ts';
import { defaultRuntimes, type PinnedRuntimeOptions } from '../runtime/runtimes.ts';
import { compareWorktree } from '../scope/compare.ts';
import { head } from '../scope/git.ts';
import { ReplayRefusedError } from './errors.ts';
import { replayPrompt, splitRoleText, type FrozenBlob } from './prompt.ts';
import { groupKey, isReplayable, recordedGroups, verifierRole, type ReplayableGroup } from './recorded.ts';
import { countsOf, nextSampleName, parseResults, recordedResults, renderSummary, sampledVerdict, withSample, withSpend, withVerdicts, type ReplayResults, type RoleTextChoice, type SampledVerdict, type SampleSpend } from './samples.ts';

/** The file of an output directory that holds every sample's verdicts. */
export const resultsFileName = 'results.json';

/** The file of an output directory that holds the summary rendered from the results. */
export const summaryFileName = 'summary.md';

/** The directory of an output directory that holds the checkpoint the replay's own workers are recorded in. */
export const replayCheckpointDirectoryName = 'checkpoint';

/** The directory of an output directory a dry run writes the prompts to. */
export const promptsDirectoryName = 'prompts';

/** The attempts a group gets in one sample, as a review gives a unit: one worker and one fresh retry. */
export const attemptsPerGroup = 2;

export interface ReplayOptions {
  /** The checkpoint that holds the recorded run. Only read. */
  readonly source: Checkpoint;
  readonly runId: string;
  /** A checkout of the repository at the commit the run reviewed, holding no change: where the replay's workers run. */
  readonly tree: string;
  /** The directory the replay keeps its results, its summary and its own checkpoint in; a later replay of the same run adds its samples there. */
  readonly output: string;
  readonly runtime: string;
  readonly executable: string;
  readonly executableArgs?: readonly string[];
  /** The roles directory: its policy gives a runtime's verifier settings, and its verifier prompt is the `current` role prompt. */
  readonly rolesRoot: string;
  readonly roleText: RoleTextChoice;
  /** How many samples to take: passes over every group. */
  readonly repeat: number;
  /** Workers at once; the policy's by default. */
  readonly concurrency?: number;
  /** The USD after which no worker is launched, on a runtime that reports cost; none by default. */
  readonly budgetUsd?: number | null;
  /** The verifier's model; by default the recorded one on the recorded runtime, else the policy's for the runtime. */
  readonly model?: string;
  /** The verifier's effort; by default the recorded one on the recorded runtime, else the policy's. */
  readonly effort?: Effort;
  /** The groups to replay, as `<phase>:<group id>`; every replayable group by default. */
  readonly groups?: readonly string[];
  /** Build and write every prompt, check the tree, and launch nothing. */
  readonly dryRun?: boolean;
  /** The engine version the replay's own checkpoint records. */
  readonly engine: string;
  readonly log: (line: string) => void;
  readonly runtimes?: RuntimeRegistry;
  readonly environment?: NodeJS.ProcessEnv;
  readonly scratchRoot?: string;
  readonly platform?: NodeJS.Platform;
}

export interface ReplayOutcome {
  /** The results after this replay, or the results it started from when it was a dry run. */
  readonly results: ReplayResults;
  /** The samples this replay added, in order. */
  readonly samples: readonly string[];
  /** The groups of the run no verifier was ever launched for, which cannot be replayed. */
  readonly unreplayable: readonly string[];
  /** The group passes not launched because the budget was reached, as `<sample> <phase>:<group id>`. */
  readonly notLaunched: readonly string[];
  /**
   * The group passes in which no attempt gave verdicts, as
   * `<sample> <phase>:<group id>`: their candidates carry an unverified
   * `PLAUSIBLE` in the results, as a review would record them. A sample
   * that holds one is not a pass over every candidate, whatever the cause:
   * a verifier that timed out twice, or a runtime that began refusing
   * workers at a usage limit partway through.
   */
  readonly unverified: readonly string[];
  /**
   * The samples of this replay in which no verifier answered: every group
   * they reached went unverified, as when the runtime refuses every worker
   * at a usage limit. Such a sample says nothing of the verifier, though it
   * stays in the results.
   */
  readonly unjudged: readonly string[];
  /** What differs between the tree and the reviewed commit after the workers ran; empty when they left it as it was. */
  readonly treeChanges: readonly string[];
  /** What this replay's workers spent together. */
  readonly spend: SampleSpend;
}

/** What one sample's verifiers are launched with. */
interface VerifierSettings {
  readonly model: string;
  readonly effort: Effort;
  readonly timeoutMs: number;
  readonly budgetUsd: number | null;
  readonly pinned: PinnedRuntimeOptions;
  readonly concurrency: number;
}

/** What differs between a tree and the scope a run captured: a head that moved, a scope file that changed, a change outside the scope. */
function treeDifferences(state: RunState, tree: string): string[] {
  const scope = state.scope;
  if (scope === null) throw new ReplayRefusedError(`Run ${state.id} captured no scope, so there is no tree to replay it in`);
  const at = head(tree);
  const comparison = compareWorktree(scope, tree);
  return [
    ...(at === scope.head ? [] : [`HEAD is ${at}, not the reviewed ${scope.head}`]),
    ...comparison.files.filter((file) => file.outcome !== 'unchanged').map((file) => `${file.path} is ${file.outcome}`),
    ...comparison.outside.map((path) => `${path} is changed or untracked`),
  ];
}

/**
 * The settings a sample's verifiers run with: on the recorded runtime, what
 * the recorded verifiers ran with, so a replay differs from the record in
 * nothing but the sample; on another runtime, the role policy's for it.
 * `model` and `effort` override either.
 */
function settingsOf(options: ReplayOptions, roles: readonly AssembledRole[], adapter: RuntimeAdapter, state: RunState, recorded: WorkerLaunch, platform: NodeJS.Platform): VerifierSettings {
  const resolved = resolvePolicy(readPolicy(options.rolesRoot), roles, adapter, {}, platform);
  const policy = pinnedRole(resolved.roles, verifierRole);
  const same = recorded.runtime === adapter.name;
  const effort = options.effort ?? (same ? recorded.effort : policy.effort);
  if (!adapter.capabilities.effortLevels.includes(effort)) throw new ReplayRefusedError(`Runtime ${adapter.name} has no effort ${effort}; it has ${adapter.capabilities.effortLevels.join(', ')}`);
  const recordedCodex = state.review?.configuration.codex ?? null;
  return {
    model: options.model ?? (same ? recorded.model : policy.model),
    effort,
    timeoutMs: same ? recorded.timeoutMs : policy.timeoutMs,
    budgetUsd: adapter.capabilities.budgetCap ? ((same ? recorded.budgetUsd : null) ?? policy.budgetUsd) : null,
    pinned: same && recordedCodex !== null ? { codex: recordedCodex } : resolved.codex === null ? {} : { codex: resolved.codex },
    concurrency: options.concurrency ?? resolved.concurrency,
  };
}

/** What a set of workers of a run spent, as a sample keeps it. */
function spendOfWorkers(state: RunState, adapter: RuntimeAdapter, workerIds: ReadonlySet<string>): SampleSpend {
  const spend = spendOf(settledWorkers(state).filter((worker) => workerIds.has(worker.launch.workerId)), adapter);
  return { workers: spend.workers, seconds: spend.seconds, costUsd: spend.costUsd };
}

/** Write a file whole: to a temporary name beside it, then renamed over it, so a reader never sees half of it. */
function writeWhole(path: string, text: string): void {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

/**
 * Hold an output directory for one replay: the start lock of the replay's
 * own checkpoint there, which a second replay into the same directory is
 * refused while this one runs. Two at once would each write the results
 * from what it read, and the later write would drop the other's samples.
 */
function holdOutput(output: string): ReleaseLock {
  try {
    return acquireStartLock(join(output, replayCheckpointDirectoryName));
  } catch (error) {
    if (error instanceof ReviewRefusedError && error.code === 'lock-held') throw new ReplayRefusedError(`Another replay is writing to ${output}; wait for it to end, or give this one another output directory`, { cause: error });
    throw error;
  }
}

/** The results of an output directory, or null when it holds none yet; results of another run are refused. */
function existingResults(output: string, state: RunState): ReplayResults | null {
  const path = join(output, resultsFileName);
  if (!existsSync(path)) return null;
  const results = parseResults(readFileSync(path, 'utf8'));
  if (results.source.runId !== state.id) throw new ReplayRefusedError(`${path} holds the replay of run ${results.source.runId}, not of ${state.id}; give each run its own output directory`);
  return results;
}

/** What taking samples needs, settled before the first launch. */
interface SamplingPlan {
  readonly options: ReplayOptions;
  /** The recorded run. */
  readonly state: RunState;
  readonly tree: string;
  readonly output: string;
  readonly platform: NodeJS.Platform;
  readonly runtimes: RuntimeRegistry;
  readonly adapter: RuntimeAdapter;
  readonly settings: VerifierSettings;
  readonly groups: readonly ReplayableGroup[];
  /** Each group's prompt, by `groupKey`. */
  readonly prompts: ReadonlyMap<string, string>;
  /** The SHA-256 of the role prompt those prompts open with. */
  readonly rolePromptSha256: string;
  /** The results the samples are added to. */
  readonly results: ReplayResults;
  /** The checkpoint the samples' workers are recorded in. */
  readonly replay: Checkpoint;
}

/** One group's pass in one sample. */
interface SamplingUnit {
  readonly sample: string;
  readonly group: ReplayableGroup;
}

/**
 * Take the samples of a plan: every group once per sample, at most the
 * settings' concurrency at once, each group getting up to
 * `attemptsPerGroup` workers and recorded unverified when all of them
 * fail. The results and the summary are written after every group, so
 * nothing a worker was paid for is lost to a later failure. A launch the
 * launcher refuses ends the sampling with that error once the workers
 * already running have settled.
 */
async function takeSamples(plan: SamplingPlan): Promise<Pick<ReplayOutcome, 'results' | 'samples' | 'notLaunched' | 'unverified' | 'unjudged' | 'treeChanges' | 'spend'>> {
  const { options, state, tree, output, adapter, settings, groups, prompts, replay } = plan;
  const { log } = options;
  let results = plan.results;
  const persist = (): void => {
    writeWhole(join(output, resultsFileName), `${JSON.stringify(results, null, 2)}\n`);
    writeWhole(join(output, summaryFileName), renderSummary(results));
  };
  const run = replay.createRun({ worktree: tree });

  // Each pass is a sample of its own, listed before any of its workers runs, so an interrupted replay shows which sample is unfinished.
  const samples: string[] = [];
  const workersOf = new Map<string, Set<string>>();
  const units: SamplingUnit[] = [];
  for (let pass = 0; pass < options.repeat; pass += 1) {
    const name = nextSampleName(results, adapter.name);
    results = withSample(results, { name, origin: 'replay', runtime: adapter.name, model: settings.model, effort: settings.effort, roleText: options.roleText, rolePromptSha256: plan.rolePromptSha256, version: null, spend: null });
    samples.push(name);
    workersOf.set(name, new Set());
    for (const group of groups) units.push({ sample: name, group });
  }
  persist();

  const budgetUsd = options.budgetUsd ?? null;
  const overBudget = (): boolean => {
    const spent = budgetSpendOf(replay.fold(run.id), adapter).usd;
    return budgetUsd !== null && spent !== null && spent >= budgetUsd;
  };
  const notLaunched: string[] = [];
  const unverified: string[] = [];
  // What a launch the launcher refused threw; a list, since the workers of the pool report into it from their own turns.
  const refusals: unknown[] = [];
  let version: string | null = null;

  /** One attempt of a group in a sample: its verdicts by candidate id, or why it gave none. */
  const attempt = async ({ sample, group }: SamplingUnit): Promise<Map<string, SampledVerdict> | string> => {
    const invocation: InvocationInput = {
      runtime: adapter.name,
      executable: options.executable,
      executableArgs: [...(options.executableArgs ?? [])],
      model: settings.model,
      effort: settings.effort,
      access: 'read-only',
      shell: true,
      prompt: prompts.get(groupKey(group))!,
      outputSchema: verifierOutputSchema,
      timeoutMs: settings.timeoutMs,
      ...(settings.budgetUsd === null ? {} : { budgetUsd: settings.budgetUsd }),
      label: unitLabel(verifierRole, group.phase, group.id),
    };
    const receipt = await runWorker(replay, run.id, invocation, {
      runtimes: plan.runtimes,
      pinned: settings.pinned,
      platform: plan.platform,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.scratchRoot === undefined ? {} : { scratchRoot: options.scratchRoot }),
    });
    workersOf.get(sample)!.add(receipt.workerId);
    version ??= receipt.runtime.version;
    if (receipt.outcome !== 'completed') return `${receipt.outcome}: ${receipt.error ?? 'no reason recorded'}`;
    const answer = receipt.output as VerifierOutput;
    try {
      checkVerdicts(answer, group.candidates.length);
    } catch (error) {
      if (error instanceof StructuralCheckError) return `structural check: ${error.message}`;
      throw error;
    }
    return new Map(answer.verdicts.map((verdict) => {
      const candidate = group.candidates[verdict.index]!;
      return [candidate.id, sampledVerdict(candidate, { verdict: verdict.verdict, unverified: false, evidence: verdict.evidence }, receipt.workerId)];
    }));
  };

  /** A group's pass in a sample: up to `attemptsPerGroup` attempts, then unverified; nothing once the budget is reached. */
  const runUnit = async (unit: SamplingUnit): Promise<void> => {
    const name = `${unit.sample} ${groupKey(unit.group)}`;
    for (let number = 1; number <= attemptsPerGroup; number += 1) {
      if (overBudget()) {
        notLaunched.push(name);
        log(`${name}: not launched, the budget of ${String(budgetUsd)} USD is reached`);
        return;
      }
      const answered = await attempt(unit);
      if (typeof answered !== 'string') {
        results = withVerdicts(results, unit.sample, answered);
        persist();
        log(`${name}: ${[...answered.values()].map((verdict) => verdict.verdict).join(', ')}`);
        return;
      }
      log(`${name}: attempt ${String(number)} of ${String(attemptsPerGroup)} gave no verdicts (${answered})`);
    }
    results = withVerdicts(results, unit.sample, new Map(unit.group.candidates.map((candidate) => [candidate.id, sampledVerdict(candidate, { verdict: 'PLAUSIBLE', unverified: true, evidence: null }, null)])));
    persist();
    unverified.push(name);
    log(`${name}: unverified, every candidate carries PLAUSIBLE`);
  };

  const queue = [...units];
  const worker = async (): Promise<void> => {
    for (let unit = queue.shift(); unit !== undefined && refusals.length === 0; unit = queue.shift()) {
      try {
        await runUnit(unit);
      } catch (error) {
        refusals.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(settings.concurrency, units.length)) }, worker));

  const final = replay.fold(run.id);
  for (const name of samples) results = withSpend(results, name, spendOfWorkers(final, adapter, workersOf.get(name)!), version);
  persist();
  if (refusals.length > 0) throw refusals[0];

  const unjudged = samples.filter((name) => {
    const counts = countsOf(results, name);
    return counts.judged > 0 && counts.unverified === counts.judged;
  });
  for (const name of unjudged) log(`sample ${name} judged nothing: every group it reached went unverified, so it says nothing of the verifier`);
  const treeChanges = treeDifferences(state, tree);
  if (treeChanges.length > 0) log(`the workers left the tree changed: ${treeChanges.join('; ')}`);
  return { results, samples, notLaunched, unverified, unjudged, treeChanges, spend: spendOfWorkers(final, adapter, new Set(samples.flatMap((name) => [...workersOf.get(name)!]))) };
}

/**
 * Replay the verifiers of a recorded run and return what the samples say.
 * In order: read the run and the groups it launched a verifier for; refuse
 * a tree that is not the reviewed commit, unchanged; build every group's
 * prompt; then, unless this is a dry run, hold the output directory and
 * take `repeat` samples (`takeSamples`), added to the results the
 * directory already holds. Nothing is written before the tree and every
 * prompt have passed.
 */
export async function replayVerifier(options: ReplayOptions): Promise<ReplayOutcome> {
  const { source, log } = options;
  const platform = options.platform ?? process.platform;
  if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new ReplayRefusedError(`A replay takes at least one sample, not ${String(options.repeat)}`);
  const state = source.fold(options.runId);
  const scope = state.scope;
  if (scope === null) throw new ReplayRefusedError(`Run ${state.id} captured no scope, so it has nothing to replay`);
  const all = recordedGroups(state);
  const replayable = all.filter(isReplayable);
  const unreplayable = all.filter((group) => !isReplayable(group)).map(groupKey);
  if (replayable.length === 0) throw new ReplayRefusedError(`Run ${state.id} launched no verifier, so it has no verification to replay`);
  const unknown = (options.groups ?? []).filter((key) => !replayable.some((group) => groupKey(group) === key));
  if (unknown.length > 0) throw new ReplayRefusedError(`Run ${state.id} has no replayable group ${unknown.join(', ')}; it has ${replayable.map(groupKey).join(', ')}`);
  const groups = options.groups === undefined ? replayable : replayable.filter((group) => options.groups!.includes(groupKey(group)));

  const tree = locateCheckpoint(options.tree).worktree;
  const differences = treeDifferences(state, tree);
  if (differences.length > 0) throw new ReplayRefusedError(`${tree} is not the tree run ${state.id} reviewed: ${differences.join('; ')}`);

  const runtimes = options.runtimes ?? defaultRuntimes();
  const adapter = runtimes.get(options.runtime);
  const roles = assembleRoles(options.rolesRoot);
  const settings = settingsOf(options, roles, adapter, state, replayable[0]!.launch, platform);
  const roleText = options.roleText === 'current' ? roles.find((role) => role.key === verifierRole)?.prompt ?? null : null;
  if (options.roleText === 'current' && roleText === null) throw new ReplayRefusedError(`The roles directory ${options.rolesRoot} assembles no ${verifierRole} role`);
  const blobs: FrozenBlob[] = collectArtifactReferences(scope).map((reference) => ({ sha256: reference.sha256, path: source.evidence.pathOf(reference) }));
  const prompts = new Map(groups.map((group) => [groupKey(group), replayPrompt(source.evidence.read(group.launch.prompt).toString('utf8'), { scratch: group.launch.scratch, tree, blobs, roleText })]));

  const output = resolve(options.output);
  const sourceVerifiers = new Set(Object.values(state.workers).filter((worker) => parseUnitLabel(worker.launch.label)?.role === verifierRole).map((worker) => worker.launch.workerId));
  /** The results the output directory holds, or the recorded sample alone when it holds none. */
  /** The SHA-256 of the role prompt a composed prompt opens with. */
  const rolePromptHash = (prompt: string): string => sha256Hex(Buffer.from(splitRoleText(prompt).roleText, 'utf8'));
  const startingResults = (): ReplayResults =>
    existingResults(output, state) ??
    recordedResults(state, replayable, {
      spend: spendOfWorkers(state, runtimes.get(replayable[0]!.launch.runtime), sourceVerifiers),
      rolePromptSha256: rolePromptHash(source.evidence.read(replayable[0]!.launch.prompt).toString('utf8')),
    });

  log(`replaying run ${state.id}: ${String(groups.length)} of ${String(replayable.length)} groups, ${String(groups.reduce((sum, group) => sum + group.candidates.length, 0))} candidates, on ${adapter.name} ${settings.model} at effort ${settings.effort}, role prompt ${options.roleText}, in ${tree}`);
  if (unreplayable.length > 0) log(`not replayable, since the run launched no verifier for them: ${unreplayable.join(', ')}`);

  if (options.dryRun === true) {
    const directory = join(output, promptsDirectoryName);
    mkdirSync(directory, { recursive: true });
    for (const group of groups) {
      const path = join(directory, `${group.phase}-${group.id}.md`);
      writeWhole(path, prompts.get(groupKey(group))!);
      log(`dry run: ${groupKey(group)}, ${String(group.candidates.length)} candidates, prompt ${String(Buffer.byteLength(prompts.get(groupKey(group))!, 'utf8'))} bytes at ${path}`);
    }
    return { results: startingResults(), samples: [], unreplayable, notLaunched: [], unverified: [], unjudged: [], treeChanges: [], spend: { workers: 0, seconds: 0, costUsd: adapter.capabilities.costInUsd ? 0 : null } };
  }

  mkdirSync(output, { recursive: true });
  // Held from before the results are read until the last write, so no other replay's samples are read stale or written over.
  const release = holdOutput(output);
  try {
    const results = startingResults();
    const replay = Checkpoint.open(join(output, replayCheckpointDirectoryName), { engine: options.engine });
    try {
      return { unreplayable, ...(await takeSamples({ options, state, tree, output, platform, runtimes, adapter, settings, groups, prompts, rolePromptSha256: rolePromptHash(prompts.get(groupKey(groups[0]!))!), results, replay })) };
    } finally {
      replay.close();
    }
  } finally {
    release();
  }
}
