import { defineConfig } from 'eslint/config';

import MonorepoDefaults from '../../eslint.config.mjs';

export default defineConfig(
  ...MonorepoDefaults,
  {
    files: ['./src/**/*.ts', './cli.ts', './env.ts'],
    rules: {
      'no-console': ['off'],
      'no-restricted-imports': ['off'],
    },
  },
  {
    ignores: ['./src/tests/**/*.ts'],
    rules: {
      'import/no-cycle': ['off'],
    },
  },
);
