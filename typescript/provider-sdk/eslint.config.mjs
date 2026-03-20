import {
  defaultConfig,
  restrictedSdkAndUtilsImportRules,
} from '@hyperlane-xyz/eslint-config';

export default [
  { ignores: ['dist/**'] },
  ...defaultConfig,
  ...restrictedSdkAndUtilsImportRules,
];
