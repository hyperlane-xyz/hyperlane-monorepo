import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    setupFiles: ['../../vitest.setup.ts'],
    testTimeout: 180000,
    hookTimeout: 180000,
  },
});
