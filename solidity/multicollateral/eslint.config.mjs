export default [
  {
    ignores: [
      '**/dist/**/*',
      '**/typechain/**/*',
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
