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
      'import/no-cycle': ['off'], // FIXME: Turn this back on when we resolve the cycles
    },
  },
];
