import MonorepoDefaults from '../../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
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
