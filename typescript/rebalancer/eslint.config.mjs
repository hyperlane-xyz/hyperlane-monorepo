import { defaultConfig } from '@hyperlane-xyz/eslint-config';

export default [
  ...defaultConfig,
  {
    files: ['./src/**/*.ts'],
  },
  {
    rules: {
      // Disable restricted imports for Node.js built-ins since rebalancer is a Node.js-only service
      'no-restricted-imports': ['off'],
    },
  },
];
