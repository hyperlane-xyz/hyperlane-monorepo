import noRestrictedImportsFromExports from './no-restricted-imports-from-exports.js';
import sortYamlArrays from './sort-yaml-arrays.js';

export const importRestrictionsPlugin = {
  name: '@hyperlane/import-restrictions',
  rules: {
    'no-restricted-imports-from-exports': noRestrictedImportsFromExports,
  },
};

export const sortYamlArraysPlugin = {
  name: '@hyperlane/sort-yaml-arrays',
  rules: {
    'sort-yaml-arrays': sortYamlArrays,
  },
};
