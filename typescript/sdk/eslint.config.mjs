import eslintConfig, { typescriptRules } from '@hyperlane-xyz/eslint-config';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    name: 'sdk',
    files: ['src/**/*.ts'],
    extends: [...eslintConfig, typescriptRules],
  },
]);
