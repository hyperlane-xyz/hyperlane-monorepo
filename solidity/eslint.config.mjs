import MonorepoDefaults from '../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
  {
    ignores: [
      '**/lib/**/*',
      '**/test/**/*',
      '**/dist/**/*',
      '**/artifacts/**/*',
      '**/artifacts-tron/**/*',
      '**/lib/**/*',
      '**/dependencies/**/*',
      'core-utils/generated/**/*',
      'core-utils/typechain/**/*',
      '.solcover.js',
      'generate-artifact-exports.mjs',
    ],
  },
];
