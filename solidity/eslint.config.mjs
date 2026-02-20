import MonorepoDefaults from '../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
  {
    ignores: [
      '**/lib/**/*',
      '**/test/**/*',
      '**/dist/**/*',
      '**/dependencies/**/*',
      '**/multicollateral/**/*',
      '.solcover.js',
      'generate-artifact-exports.mjs',
      'generate-contract-factories.mjs',
    ],
  },
];
