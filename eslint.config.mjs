import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
import jest from 'eslint-plugin-jest';
import globals from 'globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default [
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/cli-bundle',
      '**/coverage',
      '**/*.cjs',
      '**/*.cts',
      '**/*.mjs',
      'jest.config.js',
    ],
  },
  ...compat.extends(
    'eslint:recommended',
    'plugin:import/recommended',
    'plugin:import/typescript',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ),
  {
    plugins: {
      import: importPlugin,
      '@typescript-eslint': typescriptEslint,
      jest,
    },

    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },

      parser: tsParser,
      ecmaVersion: 12,
      sourceType: 'module',

      parserOptions: {
        project: './tsconfig.json',
      },
    },

    settings: {
      'import/resolver': {
        typescript: true,
        node: true,
      },
    },

    rules: {
      'guard-for-in': ['error'],
      'import/no-cycle': ['error'],
      'import/no-self-import': ['error'],
      'import/no-named-as-default-member': ['off'],
      'no-console': ['error'],
      'no-eval': ['error'],
      'no-extra-boolean-cast': ['error'],
      'no-ex-assign': ['error'],
      'no-constant-condition': ['off'],
      'no-return-await': ['error'],

      'no-restricted-imports': [
        'error',
        {
          name: 'console',
          message: 'Please use a logger and/or the utils package assert',
        },
      ],

      '@typescript-eslint/ban-ts-comment': ['off'],
      '@typescript-eslint/explicit-module-boundary-types': ['off'],
      '@typescript-eslint/no-explicit-any': ['off'],
      '@typescript-eslint/no-floating-promises': ['error'],
      '@typescript-eslint/no-non-null-assertion': ['off'],
      '@typescript-eslint/no-require-imports': ['warn'],
      '@typescript-eslint/no-unused-expressions': ['off'],
      '@typescript-eslint/no-empty-object-type': ['off'],
      '@typescript-eslint/no-duplicate-enum-values': ['off'],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      'jest/no-disabled-tests': 'warn',
      'jest/no-focused-tests': 'error',
      'jest/no-identical-title': 'error',
      'jest/prefer-to-have-length': 'warn',
      'jest/valid-expect': 'error',
    },
  },

  {
    files: ['**/*.ts', '**/*.js', '**/*.mjs'],
    ignores: ['**/aws/**/*', '**/test/**/*', '**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'fs',
              message:
                'Avoid Node.js built-in modules in cross-platform code. Use environment-agnostic alternatives.',
            },
            {
              name: 'path',
              message:
                'Avoid Node.js built-in modules in cross-platform code. Use environment-agnostic alternatives.',
            },
            {
              name: 'child_process',
              message:
                'Avoid Node.js built-in modules in cross-platform code. Use environment-agnostic alternatives.',
            },
            {
              name: 'os',
              message:
                'Avoid Node.js built-in modules in cross-platform code. Use environment-agnostic alternatives.',
            },
            {
              name: 'process',
              message:
                'Avoid Node.js built-in modules in cross-platform code. Use environment-agnostic alternatives.',
            },
            {
              name: 'http',
              message:
                'Avoid Node.js built-in modules in cross-platform code. Use environment-agnostic alternatives.',
            },
            {
              name: 'https',
              message:
                'Avoid Node.js built-in modules in cross-platform code. Use environment-agnostic alternatives.',
            },
            {
              name: 'net',
              message:
                'Avoid Node.js built-in modules in cross-platform code. Use environment-agnostic alternatives.',
            },
            {
              name: 'dgram',
              message:
                'Avoid Node.js built-in modules in cross-platform code. Use environment-agnostic alternatives.',
            },
            {
              name: 'dns',
              message:
                'Avoid Node.js built-in modules in cross-platform code. Use environment-agnostic alternatives.',
            },
            {
              name: 'crypto',
              message:
                'Avoid Node.js built-in modules in cross-platform code. Use environment-agnostic alternatives.',
            },
            {
              name: 'tls',
              message:
                'Avoid Node.js built-in modules in cross-platform code. Use environment-agnostic alternatives.',
            },
            {
              name: 'cluster',
              message:
                'Avoid Node.js built-in modules in cross-platform code. Use environment-agnostic alternatives.',
            },
            {
              name: 'stream',
              message:
                'Avoid Node.js built-in modules in cross-platform code. Use environment-agnostic alternatives.',
            },
            {
              name: 'vm',
              message:
                'Avoid Node.js built-in modules in cross-platform code. Use environment-agnostic alternatives.',
            },
            {
              name: 'readline',
              message:
                'Avoid Node.js built-in modules in cross-platform code. Use environment-agnostic alternatives.',
            },
          ],
        },
      ],
    },
  },
];
