import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/e2e/**/*.e2e-test.ts', 'src/e2e/harness/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false, // each file spins up anvil; shared container cost
  },
});
