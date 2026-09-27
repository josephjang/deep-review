// A stand-in for the Codex CLI; see fake-runtime.ts for how tests steer it.
// FAKE_OUTPUT is the final message of the default successful turn, written
// to --output-last-message unless FAKE_FINAL says otherwise; FAKE_FINAL set
// to an empty string writes no final message file. A fresh thread is
// FAKE_THREAD or freshThread from fake-runtime.ts; a continuation reports
// the id it resumes. FAKE_COMMAND_OUTPUT, a byte count, adds a command to the
// default turn whose aggregated_output is that many bytes long, all on the
// one line of its item.completed event.
import { writeFileSync } from 'node:fs';
import { answer, environment, freshThread, option, printHelp, readStdin, record } from './fake-runtime.ts';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write(`${environment.FAKE_VERSION ?? 'codex-cli 0.147.0'}\n`);
} else if (argv[0] === '--help') {
  printHelp(['--ask-for-approval', '--config', '--model', '--sandbox']);
} else if (argv.at(-1) === '--help') {
  printHelp(['--ignore-user-config', '--strict-config', '--ignore-rules', '--skip-git-repo-check', '--config', '--model', '--json', '--output-schema', '--output-last-message']);
} else {
  const stdin = readStdin();
  record(argv, stdin);
  const resumed = argv.includes('resume') ? argv.at(-2) : undefined;
  const thread = resumed ?? environment.FAKE_THREAD ?? freshThread;
  const output = environment.FAKE_OUTPUT ?? '{"answer":"ok"}';
  const final = environment.FAKE_FINAL ?? output;
  const commandOutput = environment.FAKE_COMMAND_OUTPUT === undefined ? [] : [
    { type: 'item.started', item: { id: 'item_c', type: 'command_execution', command: 'cat big', aggregated_output: '', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_c', type: 'command_execution', command: 'cat big', aggregated_output: 'x'.repeat(Number(environment.FAKE_COMMAND_OUTPUT)), exit_code: 0, status: 'completed' } },
  ];
  const finalFile = option(argv, '--output-last-message');
  if (final !== '' && finalFile !== undefined && environment.FAKE_HANG === undefined) writeFileSync(finalFile, final);
  await answer(
    () =>
      [
        { type: 'thread.started', thread_id: thread },
        { type: 'turn.started' },
        ...commandOutput,
        { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: output } },
        { type: 'turn.completed', usage: { input_tokens: 11, cached_input_tokens: 0, output_tokens: 4 } },
      ]
        .map((event) => `${JSON.stringify(event)}\n`)
        .join(''),
    thread,
  );
}
