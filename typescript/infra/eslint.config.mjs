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
  {
    name: 'infra-ts-rules',
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/await-thenable': 'off', // FIXME: Recommended rule, fix the violations
      '@typescript-eslint/ban-ts-comment': 'off', // TODO replace with @ts-expect-error, ultimately remove ignore comments
      '@typescript-eslint/no-base-to-string': 'off', // FIXME: Recommended rule, fix the violations
      '@typescript-eslint/no-empty-object-type': 'off', // TODO: Recommended rule, fix the violations
      '@typescript-eslint/no-unnecessary-type-assertion': 'off', // TODO: Recommended rule, fix the violations
      '@typescript-eslint/noonly-throw-error': 'off', // FIXME: Recommended rule, fix the violations
      '@typescript-eslint/only-throw-error': 'off', // FIXME: Recommended rule, fix the violations
      '@typescript-eslint/prefer-promise-reject-errors': 'off', // FIXME: Recommended rule, fix the violations
      '@typescript-eslint/restrict-template-expressions': 'off', // FIXME: Recommended rule, fix the violations
      '@typescript-eslint/unbound-method': 'off', // FIXME: Recommended rule, fix the violations
    },
  },
];
