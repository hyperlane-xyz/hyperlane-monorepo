import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/services/CallCommitmentsService.test.ts'],
    setupFiles: ['../../vitest.setup.ts'],
  },
});
