import MonorepoDefaults from '../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
  {
    ignores: [
      '**/lib/**/*',
      '**/test/**/*',
      '**/dist/**/*',
      '**/lib/**/*',
      '**/typechain/**/*',
      '**/dependencies/**/*',
      '.solcover.js',
      'generate-artifact-exports.mjs',
      '**/.tronbox-build/**/*',
      'tronbox-config.js',
    ],
  },
];
