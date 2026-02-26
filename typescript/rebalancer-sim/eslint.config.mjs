import MonorepoDefaults from '../../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
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
