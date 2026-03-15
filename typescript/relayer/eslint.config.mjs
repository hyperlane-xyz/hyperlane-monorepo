import { defaultConfig } from '@hyperlane-xyz/eslint-config';

export default [
  ...defaultConfig,
  {
    name: 'relayer-rules',
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    // Browser-safe code should not use Node.js built-in modules
    name: 'relayer-browser-safe',
    files: ['src/**/*.ts'],
    ignores: ['src/fs/**', '**/*.test.ts', '**/*.hardhat-test.ts'],
    rules: {
      'import/no-nodejs-modules': 'error',
    },
  },
  {
    // Node.js specific code (fs/) can use Node.js modules
    name: 'relayer-nodejs-rules',
    files: ['src/fs/**/*.ts'],
    rules: {
      'import/no-nodejs-modules': 'off',
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
