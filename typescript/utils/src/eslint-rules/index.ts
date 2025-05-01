import noRestrictedImportsFromExports from './no-restricted-imports-from-exports.js';

export const importRestrictionsPlugin = {
  name: '@hyperlane/import-restrictions',
  rules: {
    'no-restricted-imports-from-exports': noRestrictedImportsFromExports,
  },
};
