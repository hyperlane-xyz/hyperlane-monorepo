import MonorepoDefaults from '../../eslint.config.mjs';

export default [
  ...MonorepoDefaults,
  {
    files: ['./src/**/*.ts'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': [
        'warn',
        {
          allowArgumentsExplicitlyTypedAsAny: true,
        },
      ],
    },
  },
  {
    ignores: ['./src/ism/metadata/**/*.ts'],
    rules: {
      'import/no-cycle': ['off'],
    },
  },
  {
    ignores: ['src/**/*.js'],
  },
];
