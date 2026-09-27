// A stand-in for the Claude Code CLI; see fake-runtime.ts for how tests steer it.
// FAKE_OUTPUT is the structured_output JSON and FAKE_DENIALS the
// permission_denials JSON of the default successful envelope.
// FAKE_CLAUDE_ENV is a file to write every CLAUDE* variable the fake
// received to, as JSON, whatever its spelling.
import { writeFileSync } from 'node:fs';
import { claudeFlags } from '../../src/runtime/claude.ts';
import { answer, environment, option, printHelp, readStdin, record } from './fake-runtime.ts';

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
  await answer(
    () =>
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: session,
        structured_output: JSON.parse(environment.FAKE_OUTPUT ?? '{"answer":"ok"}') as unknown,
        permission_denials: JSON.parse(environment.FAKE_DENIALS ?? '[]') as unknown,
        usage: { input_tokens: 7, output_tokens: 2 },
        total_cost_usd: 0.001,
      }),
    session,
  );
}
