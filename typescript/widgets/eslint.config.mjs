import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

import { defaultConfig } from '@hyperlane-xyz/eslint-config';

export default [
  ...defaultConfig,
  {
    files: ['./src/**/*.ts', './src/**/*.tsx'],
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    settings: {
      react: {
        version: '18',
        defaultVersion: '18',
      },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
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
