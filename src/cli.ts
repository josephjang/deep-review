/**
 * The entry point of the `deep-review` command: of the bundle, which is
 * built from this file, and of `npm run review` during development. It
 * loads the command (`src/command.ts`) and runs it, and passes this file as
 * the script the engine's own commands run with `node`.
 */
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
