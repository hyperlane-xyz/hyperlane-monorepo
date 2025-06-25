import MonorepoDefaults from '../../eslint.config.mjs';

export default [
  {
    ignores: [
      '**/__mocks__/*',
      '**/tests/*',
      'src/**/*.js',
      'src/generated/**',
    ],
  },
  ...MonorepoDefaults,
  {
    files: ['./src/**/*.ts'],
  },
  {
    rules: {
      'no-console': ['off'],
      'no-restricted-imports': ['off'],
    },
  },
];
