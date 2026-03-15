import { defaultConfig } from '@hyperlane-xyz/eslint-config';

export default [
  ...defaultConfig,
  {
    files: ['src/**/*.ts'],
  },
  {
    ignores: ['scripts/*'],
  },
];
