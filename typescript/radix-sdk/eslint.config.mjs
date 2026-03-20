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
    ignores: ['src/tests/**/*.ts'],
  },
];
