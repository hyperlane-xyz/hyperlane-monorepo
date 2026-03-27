import { defaultConfig } from '@hyperlane-xyz/eslint-config';

export default [
  ...defaultConfig,
  {
    files: ['./src/**/*.ts'],
  },
  {
    rules: {
      'no-console': ['off'],
      'no-restricted-imports': ['off'],
    },
  },
  {
    ignores: [
      '**/__mocks__/*',
      '**/tests/*',
      'src/**/*.js',
      'src/generated/**',
      'bundle/**',
      'prisma/config.ts',
    ],
  },
];
