import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import importPlugin from 'eslint-plugin-import';
import jest from 'eslint-plugin-jest';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/dist',
    '**/coverage',
    '**/*.cjs',
    '**/*.cts',
    '**/*.mjs',
    'jest.config.js',
  ]),
  eslintConfigPrettier,
  {
    name: 'monorepo',
    extends: [
      'js/recommended',
      ts.configs.recommended,
      importPlugin.flatConfigs.recommended,
      importPlugin.flatConfigs.typescript,
    ],
    plugins: {
      js,
      jest,
    },

    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },

      parser: ts.parser,
      ecmaVersion: 18,
      sourceType: 'module',

      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
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
    name: 'no-node-imports',
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
);
