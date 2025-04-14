import { defineConfig, globalIgnores } from 'eslint/config';

import MonorepoDefaults from '../../eslint.config.mjs';

export default defineConfig(
  ...MonorepoDefaults,
  {
    files: ['./src/**/*.ts'],
    rules: {
      'no-console': ['off'],
      'no-restricted-imports': ['off'],
    },
  },
  globalIgnores(['**/__mocks__/*', '**/tests/*']),
);
