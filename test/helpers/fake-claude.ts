// A stand-in for the Claude Code CLI; see fake-runtime.ts for how tests steer it.
// It prints the stream of --output-format stream-json: the scripted step's
// shell runs, if any, then the result event that is the envelope.
// FAKE_OUTPUT is the structured_output JSON and FAKE_DENIALS the
// permission_denials JSON of the default successful envelope.
// FAKE_CLAUDE_ENV is a file to write every CLAUDE* variable the fake
// received to, as JSON, whatever its spelling. With FAKE_SCRIPT set and a
// review worker's prompt on stdin, the scripted step decides the answer.
// A probe loads only fake-probe.ts, and the help text's flags from the
// adapter; fake-runtime.ts is loaded only when the fake acts as a worker.
// Started as a script it runs in a process of its own; claudeFake runs it
// on any host (fake-host.ts).
import { writeFileSync } from 'node:fs';
import type { ShellRun } from '../../src/runtime/adapter.ts';
import { processHost, type FakeHost } from './fake-host.ts';
import { printHelp, versionOutput } from './fake-probe.ts';

/**
 * The events Claude Code 2.1 prints for each shell run: an `assistant`
 * event with the `Bash` call, then, unless the output is null, a `user`
 * event with its result, whose error text starts with the exit code when
 * the command exited nonzero.
 */
function shellEvents(runs: readonly ShellRun[]): Record<string, unknown>[] {
  return runs.flatMap((run, index) => {
    const id = `toolu_fake_${String(index)}`;
    const call = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: run.command, description: 'a scripted run' } }] } };
    if (run.output === null) return [call];
    const content = run.exitCode === 0 || run.exitCode === null ? run.output : `Exit code ${String(run.exitCode)}\n${run.output}`;
    return [call, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: run.exitCode !== 0 }] } }];
  });
}

/** Act as Claude Code on `host`, and give the exit code. */
export async function claudeFake(host: FakeHost): Promise<number> {
  const argv = host.args;
  const environment = host.environment;
  if (argv[0] === '--version') {
    await host.write('stdout', `${versionOutput(host, '2.1.283 (Claude Code)')}\n`);
    return 0;
  }
  if (argv[0] === '--help') {
    const { claudeFlags } = await import('../../src/runtime/claude.ts');
    await printHelp(host, claudeFlags);
    return 0;
  }
  const { answer, beginScriptedStep, option, record, scriptedStep } = await import('./fake-runtime.ts');
  const stdin = host.readStdin();
  record(host, stdin);
  if (environment.FAKE_CLAUDE_ENV !== undefined) {
    const claude = Object.fromEntries(Object.entries(environment).filter(([name]) => name.toUpperCase().startsWith('CLAUDE')));
    writeFileSync(environment.FAKE_CLAUDE_ENV, JSON.stringify(claude));
  }
  const session = option(argv, '--session-id') ?? option(argv, '--resume') ?? 'no-session';
  // At a limit, Claude Code reports is_error with the limit's words as the result, and no structured output.
  const envelope = (output: unknown, costUsd: number, limit?: string): string =>
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: limit !== undefined,
      session_id: session,
      ...(limit === undefined ? { structured_output: output } : { result: limit }),
      permission_denials: JSON.parse(environment.FAKE_DENIALS ?? '[]') as unknown,
      usage: { input_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 },
      total_cost_usd: costUsd,
    });
  const scripted = scriptedStep(host, stdin);
  if (scripted === null) return answer(host, () => envelope(JSON.parse(environment.FAKE_OUTPUT ?? '{"answer":"ok"}') as unknown, 0.001), session);
  const exit = await beginScriptedStep(host, scripted.step, stdin);
  const result = envelope(scripted.step.malformed === true ? 'not the shape the schema describes' : scripted.step.output, scripted.step.costUsd ?? 0.001, scripted.step.limit);
  await host.write('stdout', [...shellEvents(scripted.step.runs ?? []).map((event) => JSON.stringify(event)), result].map((line) => `${line}\n`).join(''));
  return exit;
}

if (import.meta.main) process.exitCode = await claudeFake(processHost());
