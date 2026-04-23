import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/tests/**/*.e2e-test.ts'],
    globalSetup: ['./src/tests/e2e-test.setup.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false, // e2e tests share a starknet node — run serially
  },
});
