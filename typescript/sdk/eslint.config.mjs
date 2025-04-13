import { defineConfig, globalIgnores } from 'eslint/config';

import MonorepoDefaults from '../../eslint.config.mjs';

export default defineConfig(
  ...MonorepoDefaults,
  globalIgnores(['src/**/*.js']),
  {
    files: ['./src/**/*.ts'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': [
        'warn',
        {
          allowArgumentsExplicitlyTypedAsAny: true,
        },
      ],
    },
  },
  {
    ignores: ['./src/ism/metadata/**/*.ts'],
    rules: {
      'import/no-cycle': ['off'],
    },
  },
);
