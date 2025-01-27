import MonorepoDefaults from '../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
  {
    ignores: [
      '**/test/**/*',
      '**/dist/**/*',
      '**/typechain/**/*',
      '.solcover.js',
    ],
  },
];
