import MonorepoDefaults from '../../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
  {
    files: ['./src/**/*.ts', './test/**/*.ts'],
  },
  {
    rules: {
      'no-restricted-imports': ['off'],
    },
  },
];
