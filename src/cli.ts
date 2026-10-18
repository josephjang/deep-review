/**
 * The entry point of the `deep-review` command: of the bundle, which is
 * built from this file, and of `npm run review` during development. It
 * loads the command (`src/command.ts`) and runs it, and passes this file as
 * the script the engine's own commands run with `node`.
 *
 * `guard`, which only the engine starts for each worker and each check
 * (R8 of resumable runs), is dispatched first and loads only the guard,
 * so a guard starts in a fraction of a second. It exits as soon as it is
 * done, since the engine's pipe on its standard input would hold it.
 */
if (process.argv[2] === 'guard') {
  const { runGuard } = await import('./runtime/guard.ts');
  process.exit(await runGuard(process.argv.slice(3)));
}
const { main } = await import('./command.ts');
process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  environment: process.env,
  cwd: process.cwd(),
  engineEntry: import.meta.filename,
});
