import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.hardhat-test.ts'],
    setupFiles: ['../../vitest.setup.ts'],
    testTimeout: 100000,
  },
});
