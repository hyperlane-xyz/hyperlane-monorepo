import { restrictedSdkAndUtilsImportRules } from '@hyperlane-xyz/eslint-config';

import MonorepoDefaults from '../../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
  ...restrictedSdkAndUtilsImportRules,
  {
    files: ['src/**/*.ts'],
  },
  {
    ignores: ['src/generated/**/*.ts', 'src/tests/**/*.ts'],
  },
];
