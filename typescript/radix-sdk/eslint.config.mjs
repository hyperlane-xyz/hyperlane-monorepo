import MonorepoDefaults from '../../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
  {
    files: ['src/**/*.ts'],
  },
  {
    ignores: ['src/tests/**/*.ts'],
  },
];
