import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';

import MonorepoDefaults from '../../eslint.config.mjs';

export default defineConfig(
  ...MonorepoDefaults,
  {
    name: 'widgets',
    plugins: {
      react,
    },
    extends: [
      { name: 'react/recommended', ...react.configs.flat.recommended },
      reactHooks.configs['recommended-latest'],
    ],
    settings: {
      react: {
        version: '18',
        defaultVersion: '18',
      },
    },
  },
  {
    name: 'react',
    files: ['./src/**/*.ts', './src/**/*.tsx'],
    plugins: {
      react,
    },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
    },
  },
  globalIgnores([
    '**/src/stories/*',
    'tailwind.config.js',
    'postcss.config.js',
    '.storybook/*',
  ]),
);
