import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier/flat';
import { globalIgnores } from 'eslint/config';
import ts from 'typescript-eslint';

const basicRules = [
  globalIgnores(['**/dist']),
  { name: 'js/recommended', ...js.configs.recommended },
  prettierConfig,
];
export default basicRules;

export const typescriptRules = [
  ts.configs.recommendedTypeChecked,
  {
    name: 'hyperlane-ts-rules',
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
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
  },
];
