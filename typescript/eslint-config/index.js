import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier/flat';
import importPlugin from 'eslint-plugin-import';
import { globalIgnores } from 'eslint/config';
import ts from 'typescript-eslint';

const basicRules = [
  globalIgnores(['**/dist']),
  { name: 'js/recommended', ...js.configs.recommended },
  prettierConfig,
  importPlugin.flatConfigs.recommended,
  {
    rules: {
      'import/namespace': 'off',
    },
  },
];
export default basicRules;

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
      'import/namespace': 'off',
    },
    settings: {
      'import/resolver': 'typescript',
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
    '@typescript-eslint/no-unsafe-argument': 'off',
    '@typescript-eslint/no-unsafe-assignment': 'off',
    '@typescript-eslint/no-misused-promises': 'off',
    '@typescript-eslint/no-unused-expressions': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
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
