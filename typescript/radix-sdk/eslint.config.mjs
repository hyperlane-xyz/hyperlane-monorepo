import { restrictedSdkAndUtilsImportRules } from '@hyperlane-xyz/eslint-config';

import MonorepoDefaults from '../../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
  ...restrictedSdkAndUtilsImportRules,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
        },
      ],
    },
  },
  {
    ignores: ['src/tests/**/*.ts'],
  },
];
