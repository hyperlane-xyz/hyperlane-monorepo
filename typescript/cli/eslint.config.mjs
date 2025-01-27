import MonorepoDefaults from '../../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
  {
    files: ['./src/**/*.ts', './cli.ts', './env.ts'],
  },
  {
    rules: {
      'no-console': ['off'],
      'no-restricted-imports': ['off'],
    },
  },
  {
    ignores: ['./src/tests/**/*.ts'],
    rules: {
      'import/no-cycle': ['off'],
    },
  },
];
