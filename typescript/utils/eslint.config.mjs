import MonorepoDefaults from '../../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
  { files: ['./src/**/*.ts'] },
  {
    // Allow Node.js built-in modules in fs and anvil submodules (not for browser use)
    files: ['./src/fs/**/*.ts', './src/anvil/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
];
