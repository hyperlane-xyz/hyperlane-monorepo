import { defaultConfig } from '@hyperlane-xyz/eslint-config';

export default [
  ...defaultConfig,
  {
    name: 'sdk-rules',
    rules: {
      'no-restricted-imports': ['error', '@hyperlane-xyz/registry'],
      'import/no-nodejs-modules': 'error',
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
