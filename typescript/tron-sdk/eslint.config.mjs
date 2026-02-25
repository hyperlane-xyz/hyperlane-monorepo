import { restrictedSdkAndUtilsImportRules } from '@hyperlane-xyz/eslint-config';

import MonorepoDefaults from '../../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
  ...restrictedSdkAndUtilsImportRules,
  {
    files: ['src/**/*.ts'],
  },
  {
    ignores: ['src/tests/**/*.ts', 'src/typechain/**/*.ts', 'scripts/*'],
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'import/no-unresolved': ['error', { ignore: ['\\.*/abi/.*\\.json$'] }],
    },
  },
];
