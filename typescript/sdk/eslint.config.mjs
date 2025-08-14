import { jsRules, typescriptRules } from '@hyperlane-xyz/eslint-config';

export default [
  ...jsRules,
  ...typescriptRules,
  {
    name: 'sdk-rules',
    rules: {
      'no-restricted-imports': ['error', '@hyperlane-xyz/registry'],
      'import/no-nodejs-modules': 'error',
    },
  },
  {
    name: 'sdk-ts-rules',
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/await-thenable': 'off', // FIXME: Recommended rule, fix the violations
      '@typescript-eslint/ban-ts-comment': 'off', // TODO replace with @ts-expect-error, ultimately remove ignore comments
      // TODO: We used to have this enabled, fix the violations
      // '@typescript-eslint/explicit-module-boundary-types': [
      //   'warn',
      //   {
      //     allowArgumentsExplicitlyTypedAsAny: true,
      //   },
      // ],
      '@typescript-eslint/no-base-to-string': 'off', // FIXME: Recommended rule, fix the violations
      '@typescript-eslint/no-duplicate-type-constituents': 'off', // FIXME: Recommended rule, fix the violations
      '@typescript-eslint/no-empty-object-type': 'off', // TODO: Recommended rule, fix the violations
      '@typescript-eslint/no-unnecessary-type-assertion': 'off', // TODO: Recommended rule, fix the violations
      '@typescript-eslint/only-throw-error': 'off', // FIXME: Recommended rule, fix the violations
      '@typescript-eslint/prefer-promise-reject-errors': 'off', // FIXME: Recommended rule, fix the violations
      '@typescript-eslint/restrict-template-expressions': 'off', // FIXME: Recommended rule, fix the violations
      '@typescript-eslint/unbound-method': 'off', // FIXME: Recommended rule, fix the violations
    },
  },
  {
    name: 'sdk-test-rules',
    files: ['**/*.test.ts', '**/*.hardhat-test.ts'],
    rules: {
      'import/no-nodejs-modules': 'off',
    },
  },
];
