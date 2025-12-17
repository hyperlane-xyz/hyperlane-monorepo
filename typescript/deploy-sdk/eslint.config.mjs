import { jsRules, typescriptRules } from '@hyperlane-xyz/eslint-config';

export default [
  { ignores: ['dist/**'] },
  ...jsRules,
  ...typescriptRules,
  {
    name: 'deploy-sdk-overrides',
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@hyperlane-xyz/sdk',
              message:
                'Imports from @hyperlane-xyz/sdk are not allowed in this package',
            },
            // Remove the @hyperlane-xyz/utils/fs restriction for deploy-sdk
            {
              name: '@hyperlane-xyz/utils',
              importNames: [
                'ProtocolType',
                'ProtocolTypeValue',
                'ProtocolSmallestUnit',
              ],
              message:
                'Use the export from the `@hyperlane-xyz/protocol-sdk` package',
            },
          ],
        },
      ],
    },
  },
];
