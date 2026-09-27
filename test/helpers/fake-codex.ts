// A stand-in for the Codex CLI; see fake-runtime.ts for how tests steer it.
// FAKE_OUTPUT is the final message of the default successful turn, written
// to --output-last-message unless FAKE_FINAL says otherwise; FAKE_FINAL set
// to an empty string writes no final message file. A fresh thread is
// FAKE_THREAD or freshThread from fake-runtime.ts; a continuation reports
// the id it resumes. FAKE_COMMAND_OUTPUT, a byte count, adds a command to the
// default turn whose aggregated_output is that many bytes long, all on the
// one line of its item.completed event. With FAKE_SCRIPT set and a review
// worker's prompt on stdin, the scripted step decides the final message.
import { writeFileSync } from 'node:fs';
import { answer, beginScriptedStep, environment, freshThread, option, printHelp, readStdin, record, scriptedStep, versionOutput } from './fake-runtime.ts';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write(`${versionOutput('codex-cli 0.147.0')}\n`);
} else if (argv[0] === '--help') {
  printHelp(['--ask-for-approval', '--config', '--model', '--sandbox']);
} else if (argv.at(-1) === '--help') {
  printHelp(['--ignore-user-config', '--strict-config', '--ignore-rules', '--skip-git-repo-check', '--config', '--model', '--json', '--output-schema', '--output-last-message']);
} else {
  const stdin = readStdin();
  record(argv, stdin);
  const resumed = argv.includes('resume') ? argv.at(-2) : undefined;
  const thread = resumed ?? environment.FAKE_THREAD ?? freshThread;
  const finalFile = option(argv, '--output-last-message');
  const stream = (output: string, commandOutput: Record<string, unknown>[] = []): string =>
    [
      { type: 'thread.started', thread_id: thread },
      { type: 'turn.started' },
      ...commandOutput,
      { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: output } },
      { type: 'turn.completed', usage: { input_tokens: 11, cached_input_tokens: 0, output_tokens: 4 } },
    ]
      .map((event) => `${JSON.stringify(event)}\n`)
      .join('');
  const scripted = scriptedStep(stdin);
  if (scripted === null) {
    const output = environment.FAKE_OUTPUT ?? '{"answer":"ok"}';
    const final = environment.FAKE_FINAL ?? output;
    const commandOutput = environment.FAKE_COMMAND_OUTPUT === undefined ? [] : [
      { type: 'item.started', item: { id: 'item_c', type: 'command_execution', command: 'cat big', aggregated_output: '', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'item_c', type: 'command_execution', command: 'cat big', aggregated_output: 'x'.repeat(Number(environment.FAKE_COMMAND_OUTPUT)), exit_code: 0, status: 'completed' } },
    ];
    if (final !== '' && finalFile !== undefined && environment.FAKE_HANG === undefined) writeFileSync(finalFile, final);
    await answer(() => stream(output, commandOutput), thread);
  } else {
    const exit = await beginScriptedStep(scripted.step);
    const output = scripted.step.malformed === true ? '"not the shape the schema describes"' : JSON.stringify(scripted.step.output);
    if (finalFile !== undefined) writeFileSync(finalFile, output);
    process.stdout.write(stream(output));
    process.exitCode = exit;
  }
}
