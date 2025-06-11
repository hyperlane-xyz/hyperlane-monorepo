import MonorepoDefaults from '../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
  {
    ignores: [
      '**/test/**/*',
      '**/dist/**/*',
      '**/lib/**/*',
      '**/typechain/**/*',
      '.solcover.js',
      'generate-artifact-exports.mjs',
    ],
  },
];
