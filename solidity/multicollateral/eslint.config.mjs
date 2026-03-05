export default [
  {
    ignores: [
      '**/dist/**/*',
      '**/generated/**/*',
      '**/artifacts/**/*',
      '**/cache/**/*',
      '**/forge-cache/**/*',
      '**/out/**/*',
      '**/test/**/*',
    ],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
    },
  },
];
