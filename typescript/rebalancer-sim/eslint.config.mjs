import { defaultConfig } from '@hyperlane-xyz/eslint-config';

export default [
  ...defaultConfig,
  {
    files: ['./src/**/*.ts', './test/**/*.ts'],
    rules: {
      // Disable restricted imports for Node.js built-ins since simulation harness is Node.js-only
      'no-restricted-imports': ['off'],
      // Allow console statements for simulation output
      'no-console': ['off'],
    },
  },
];
