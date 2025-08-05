import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

import MonorepoDefaults, { compat } from '../../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
  ...compat.extends(
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ),
  {
    settings: {
      react: {
        version: '18',
        defaultVersion: '18',
      },
    },
  },
  {
    files: ['./src/**/*.ts', './src/**/*.tsx'],
    plugins: {
      react,
      'react-hooks': reactHooks,
    },

    rules: {
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    ignores: [
      '**/src/stories/*',
      'tailwind.config.js',
      'postcss.config.js',
      '.storybook/*',
    ],
  },
];
