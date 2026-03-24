import { restrictedSdkAndUtilsImportRules } from '@hyperlane-xyz/eslint-config';

import MonorepoDefaults from '../../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
  ...restrictedSdkAndUtilsImportRules.map((rule) => ({
    ...rule,
    files: ['src/**/*.ts'],
  })),
];
