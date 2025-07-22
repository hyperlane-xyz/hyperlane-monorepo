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

export default jsRules;
