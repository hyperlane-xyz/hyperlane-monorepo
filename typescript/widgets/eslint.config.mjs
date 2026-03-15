import react from 'eslint-plugin-react';

import { defaultConfig } from '@hyperlane-xyz/eslint-config';

export default [
  ...defaultConfig,
  {
    files: ['./src/**/*.ts', './src/**/*.tsx'],
    plugins: {
      react,
    },
    settings: {
      react: {
        version: '18',
        defaultVersion: '18',
      },
    },
    rules: {
      // Only rules oxlint's react plugin doesn't cover
      'react/no-deprecated': 'error',
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
