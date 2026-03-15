import {
  jestRules,
  jsRules,
  typescriptRules,
} from '@hyperlane-xyz/eslint-config';

export default [
  ...jsRules,
  ...typescriptRules,
  ...jestRules,
  {
    name: 'sdk-rules',
    rules: {
      'no-restricted-imports': ['error', '@hyperlane-xyz/registry'],
      'import/no-nodejs-modules': 'error',
    },
  },
  {
    name: 'sdk-ts-rules',
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off', // TODO replace with @ts-expect-error, ultimately remove ignore comments
      '@typescript-eslint/no-empty-object-type': 'off', // TODO: Recommended rule, fix the violations
    },
  },
  {
    name: 'sdk-test-rules',
    files: ['**/*.test.ts', '**/*.hardhat-test.ts'],
    rules: {
      'import/no-nodejs-modules': 'off',
    },
  },
];
