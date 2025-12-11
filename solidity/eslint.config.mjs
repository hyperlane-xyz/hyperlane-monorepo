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
      '**/named-args-converter/**/*',
      '.solcover.js',
      'generate-artifact-exports.mjs',
    ],
  },
];
