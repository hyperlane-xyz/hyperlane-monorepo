import { defineConfig, globalIgnores } from 'eslint/config';

import MonorepoDefaults from '../../eslint.config.mjs';

export default defineConfig(
  ...MonorepoDefaults,
  globalIgnores(['src/types/**/*.ts']),
  {
    ignores: ['./src/scripts'],
    rules: {
      'no-console': ['off'],
    },
  },
);
