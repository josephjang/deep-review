// A stand-in for the Claude Code CLI; see fake-runtime.ts for how tests steer it.
// FAKE_OUTPUT is the structured_output JSON and FAKE_DENIALS the
// permission_denials JSON of the default successful envelope.
// FAKE_CLAUDE_ENV is a file to write every CLAUDE* variable the fake
// received to, as JSON, whatever its spelling. With FAKE_SCRIPT set and a
// review worker's prompt on stdin, the scripted step decides the answer.
import { writeFileSync } from 'node:fs';
import { claudeFlags } from '../../src/runtime/claude.ts';
import { answer, beginScriptedStep, environment, option, printHelp, readStdin, record, scriptedStep } from './fake-runtime.ts';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write(`${environment.FAKE_VERSION ?? '2.1.283 (Claude Code)'}\n`);
} else if (argv[0] === '--help') {
  printHelp(claudeFlags);
} else {
  const stdin = readStdin();
  record(argv, stdin);
  if (environment.FAKE_CLAUDE_ENV !== undefined) {
    const claude = Object.fromEntries(Object.entries(environment).filter(([name]) => name.toUpperCase().startsWith('CLAUDE')));
    writeFileSync(environment.FAKE_CLAUDE_ENV, JSON.stringify(claude));
  }
  const session = option(argv, '--session-id') ?? option(argv, '--resume') ?? 'no-session';
  const envelope = (output: unknown, costUsd: number): string =>
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: session,
      structured_output: output,
      permission_denials: JSON.parse(environment.FAKE_DENIALS ?? '[]') as unknown,
      usage: { input_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 },
      total_cost_usd: costUsd,
    });
  const scripted = scriptedStep(stdin);
  if (scripted === null) {
    await answer(() => envelope(JSON.parse(environment.FAKE_OUTPUT ?? '{"answer":"ok"}') as unknown, 0.001), session);
  } else {
    const exit = await beginScriptedStep(scripted.step);
    process.stdout.write(envelope(scripted.step.malformed === true ? 'not the shape the schema describes' : scripted.step.output, scripted.step.costUsd ?? 0.001));
    process.exitCode = exit;
  }
}
