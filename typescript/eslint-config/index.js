import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier/flat';
import importPlugin from 'eslint-plugin-import';
import { globalIgnores } from 'eslint/config';
import ts from 'typescript-eslint';

export const jsRules = [
  globalIgnores(['**/dist/']),
  { name: 'js/recommended', ...js.configs.recommended },
  prettierConfig,
  importPlugin.flatConfigs.recommended,
  {
    name: 'hyperlane-js-rules',
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'guard-for-in': 'error',
      'no-console': 'error',
      'no-eval': 'error',
      'import/namespace': 'off', // This is very slow, should be in the full-check config
      'import/no-cycle': 'off', // This is very slow, should be in the full-check config
    },
    settings: {
      'import/resolver': 'typescript', // This is the only resolver that works, even for JavaScript files
    },
  },
];

export const typescriptRules = ts.config({
  name: 'hyperlane-ts-rules',
  files: ['**/*.ts'],
  extends: [
    ts.configs.recommendedTypeChecked,
    importPlugin.flatConfigs.typescript,
  ],
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    '@typescript-eslint/require-await': 'off', // Recommended rule, but we have many violations
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-misused-promises': 'off', // Recommended rule, but we have many violations
    '@typescript-eslint/no-unsafe-argument': 'off', // Recommended rule, but we have many violations
    '@typescript-eslint/no-unsafe-assignment': 'off', // Recommended rule, but we have many violations
    '@typescript-eslint/no-unsafe-call': 'off', // Recommended rule, but we have many violations
    '@typescript-eslint/no-unsafe-enum-comparison': 'off', // Recommended rule, but we have many violations
    '@typescript-eslint/no-unsafe-member-access': 'off', // Recommended rule, but we have many violations
    '@typescript-eslint/no-unsafe-return': 'off', // Recommended rule, but we have many violations
    '@typescript-eslint/no-unused-expressions': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
  },
  settings: {
    'import/resolver': 'typescript',
  },
});

export const restrictedSdkAndUtilsImportRules = [
  {
    name: 'import-restriction-rules',
    rules: {
      // The monorepo default already includes this but needs to be set here too
      // as eslint will override the config with the latest definition in the flattened config
      'import/no-nodejs-modules': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@hyperlane-xyz/sdk',
              message:
                'Imports from @hyperlane-xyz/sdk are not allowed in this package',
            },
            {
              name: '@hyperlane-xyz/utils/fs',
              message:
                'The @hyperlane-xyz/utils/fs submodule requires Node.js and cannot be used in browser packages',
            },
            {
              name: '@hyperlane-xyz/utils',
              // These have been duplicated to reduce the changes
              // while work is completed on the multivm packages
              importNames: [
                'ProtocolType',
                'ProtocolTypeValue',
                'ProtocolSmallestUnit',
              ],
              message:
                'Use the export from the `@hyperlane-xyz/protocol-sdk` package',
            },
          ],
        },
      ],
    },
  },
];

export default jsRules;
