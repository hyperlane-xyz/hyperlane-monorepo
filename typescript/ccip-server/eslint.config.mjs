import MonorepoDefaults from '../../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
  {
    files: ['./src/**/*.ts'],
  },
  {
    rules: {
      'no-console': ['off'],
      'no-restricted-imports': ['off'],
    },
  },
  {
    ignores: ['**/__mocks__/*', '**/tests/*'],
  },
];
