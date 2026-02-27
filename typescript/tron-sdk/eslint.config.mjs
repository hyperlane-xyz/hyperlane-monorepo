import { restrictedSdkAndUtilsImportRules } from '@hyperlane-xyz/eslint-config';

import MonorepoDefaults from '../../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
  ...restrictedSdkAndUtilsImportRules,
  {
    files: ['src/**/*.ts'],
  },
  {
    ignores: [
      'src/**/*.test.ts',
      'src/**/*.integration.test.ts',
      'src/**/*.e2e-test.ts',
      'src/tests/**',
      'src/typechain/**',
      'src/abi/**',
      'scripts/*',
    ],
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'import/no-unresolved': ['error', { ignore: ['\\.*/abi/.*\\.json$'] }],
    },
  },
];
