import {
  defaultConfig,
  restrictedSdkAndUtilsImportRules,
} from '@hyperlane-xyz/eslint-config';

export default [...defaultConfig, ...restrictedSdkAndUtilsImportRules];
