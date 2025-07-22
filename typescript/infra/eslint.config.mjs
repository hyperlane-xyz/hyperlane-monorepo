import { jsRules, typescriptRules } from '@hyperlane-xyz/eslint-config';
import { yamlEslintConfig } from '@hyperlane-xyz/utils/eslint-rules';

export default [
  {
    ignores: ['helm/**/*.yaml'],
  },
  ...jsRules,
  ...yamlEslintConfig,
  ...typescriptRules,
  {
    name: 'infra-rules',
    rules: {
      'no-console': ['off'],
      'no-restricted-imports': ['off'],
    },
  },
];
