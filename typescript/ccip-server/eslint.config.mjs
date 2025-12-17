import MonorepoDefaults from '../../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
  {
    files: ['./src/**/*.ts'],
  },
  {
    rules: {
      'no-console': ['off'],
      'no-restricted-imports': ['off'],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
        },
      ],
    },
  },
  {
    ignores: [
      '**/__mocks__/*',
      '**/tests/*',
      'src/**/*.js',
      'src/generated/**',
    ],
  },
];
