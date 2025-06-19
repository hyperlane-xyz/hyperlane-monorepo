import MonorepoDefaults from '../../eslint.config.mjs';

export default [
  {
    ignores: ['src/generated/**', '**/__mocks__/*', '**/tests/*'],
  },
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
  {
    ignores: ['src/**/*.js'],
  },
];
