import { jsRules, typescriptRules } from '@hyperlane-xyz/eslint-config';

export default [
  ...jsRules,
  ...typescriptRules,
  {
    name: 'relayer-rules',
    rules: {
      // Disable restricted imports for Node.js built-ins since relayer is a Node.js-only service
      'no-restricted-imports': 'off',
      'import/no-nodejs-modules': 'off',
    },
  },
  {
    name: 'relayer-ts-rules',
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-base-to-string': 'off', // FIXME: Recommended rule, fix the violations
      '@typescript-eslint/restrict-template-expressions': 'off', // FIXME: Recommended rule, fix the violations
    },
  },
  {
    name: 'relayer-test-rules',
    files: ['**/*.test.ts', '**/*.hardhat-test.ts'],
    rules: {
      'import/no-nodejs-modules': 'off',
    },
  },
];
