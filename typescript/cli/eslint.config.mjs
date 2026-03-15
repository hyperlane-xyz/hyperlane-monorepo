import { defaultConfig } from '@hyperlane-xyz/eslint-config';

export default [
  ...defaultConfig,
  {
    files: ['./src/**/*.ts', './cli.ts', './env.ts'],
  },
  {
    rules: {
      'no-console': ['off'],
      'no-restricted-imports': ['off'],
      'import/no-cycle': ['off'], // FIXME: Turn this back on when we resolve the cycles
    },
  },
];
