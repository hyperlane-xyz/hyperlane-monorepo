import { defaultConfig } from '@hyperlane-xyz/eslint-config';

export default [
  ...defaultConfig,
  {
    files: ['./src/**/*.ts'],
  },
  {
    ignores: ['**/src/types/*'],
  },
  {
    ignores: ['./src/scripts'],
    rules: {
      'no-console': ['off'],
    },
  },
];
