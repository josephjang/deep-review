import tseslint from 'typescript-eslint';

export default tseslint.config(
  // dist/ is build output and skill/ holds prompts; neither is code.
  { ignores: ['node_modules/**', 'dist/**', 'skill/**'] },
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
);
