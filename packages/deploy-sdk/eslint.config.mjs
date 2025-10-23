import { jsRules, typescriptRules } from '@hyperlane-xyz/eslint-config';

export default [{ ignores: ['dist/**'] }, ...jsRules, ...typescriptRules];
