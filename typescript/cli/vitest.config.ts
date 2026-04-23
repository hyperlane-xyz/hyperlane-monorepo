import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.e2e-test.ts'],
    setupFiles: ['./src/tests/test-setup.ts'],
    testTimeout: 30000,
    // Some tests instantiate ethers providers whose async network detection
    // rejects after the test completes; mocha silently tolerated these.
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
