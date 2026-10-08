/**
 * Preloaded into every test process by `npm test` (`node --import
 * ./test/setup.ts --test`; node --test passes the flag on to the process it
 * starts for each test file). Importing the git helper deletes the variables
 * that name a repository from `process.env` before any test runs, so neither
 * a test nor the engine code it runs can act on the repository a
 * `git rebase --exec` or a git hook that started the suite was working on.
 */
import './helpers/git.ts';
