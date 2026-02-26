import {
  jestRules,
  jsRules,
  typescriptRules,
} from '@hyperlane-xyz/eslint-config';

export default [...jsRules, ...typescriptRules, ...jestRules];
