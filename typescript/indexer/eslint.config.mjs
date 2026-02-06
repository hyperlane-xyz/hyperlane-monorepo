import hyperlaneConfig from '@hyperlane-xyz/eslint-config';

export default [
  ...hyperlaneConfig,
  {
    ignores: ['.ponder/**', 'dist/**', 'node_modules/**'],
  },
];
