import { defaultConfig } from '@hyperlane-xyz/eslint-config';

export default [
  ...defaultConfig,
  {
    ignores: [
      '**/lib/**/*',
      '**/test/**/*',
      '**/dist/**/*',
      '**/lib/**/*',
      '**/typechain/**/*',
      '**/multicollateral/**/*',
      '**/dependencies/**/*',
      '.solcover.js',
      'generate-artifact-exports.mjs',
    ],
  },
];
