import MonorepoDefaults from '../../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
  { files: ['./src/**/*.ts'] },
  {
    // Allow Node.js built-in modules in the fs submodule (not for browser use)
    files: ['./src/fs/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
];
