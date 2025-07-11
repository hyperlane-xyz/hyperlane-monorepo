import eslintPluginYml from 'eslint-plugin-yml';
import yamlParser from 'yaml-eslint-parser';

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

export const yamlEslintConfig = [
  ...eslintPluginYml.configs['flat/standard'],
  {
    languageOptions: {
      parser: yamlParser,
    },
    plugins: {
      hyperlane: sortYamlArraysPlugin,
    },
    rules: {
      'yml/sort-keys': ['error'],
      'yml/flow-mapping-curly-spacing': ['error', 'always'],
      'yml/sort-sequence-values': [
        'error',
        {
          pathPattern: '.*',
          order: {
            type: 'asc',
            caseSensitive: true,
            natural: false,
          },
          minValues: 2,
        },
      ],
      'hyperlane/sort-yaml-arrays': [
        'error',
        {
          arrays: [
            { path: 'tokens', sortKey: 'chainName' },
            { path: 'tokens[].connections', sortKey: 'token' },
            { path: '*.interchainSecurityModule.modules', sortKey: 'type' },
            {
              path: '*.interchainSecurityModule.modules[].domains.*.modules',
              sortKey: 'type',
            },
          ],
        },
      ],
    },
  },
];
