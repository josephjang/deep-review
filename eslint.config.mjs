import tseslint from 'typescript-eslint';

export default tseslint.config(
  // dist/ is build output; skill/ and roles/ hold prompts; none of them is code.
  { ignores: ['node_modules/**', 'dist/**', 'skill/**', 'roles/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      // A subprocess supervisor is full of promises; a dropped one is a
      // silent hang or a lost error. Both rules need type information.
      // node:test's describe/it return promises that the runner itself awaits.
      '@typescript-eslint/no-floating-promises': ['error', {
        allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['describe', 'it', 'test', 'before', 'after', 'beforeEach', 'afterEach'] }],
      }],
      '@typescript-eslint/no-misused-promises': 'error',
      // Type-only imports must stay erasable for Node's type stripping.
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // A test's git must run through test/helpers/git.ts, which keeps the
    // variables that name another repository, such as the GIT_DIR of a
    // `git rebase --exec`, out of its environment. Any other spawn of git
    // under test/ would inherit them. The rule flags a spawn whose first
    // argument is the literal string git; one that names git any other way,
    // through a variable, a template literal or a shell, passes it.
    files: ['test/**/*.ts', 'test/**/*.mjs'],
    ignores: ['test/helpers/git.ts'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "CallExpression:matches([callee.name=/^(spawn|spawnSync|exec|execSync|execFile|execFileSync)$/], [callee.property.name=/^(spawn|spawnSync|exec|execSync|execFile|execFileSync)$/])[arguments.0.value=/^git(\\.exe)?(\\s|$)/i]",
        message: 'Run git in tests through git() from test/helpers/git.ts, which keeps GIT_DIR and the other repository variables out of its environment.',
      }],
    },
  },
);
