import {
  defaultConfig,
  restrictedSdkAndUtilsImportRules,
} from '@hyperlane-xyz/eslint-config';

export default [
  ...defaultConfig,
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
