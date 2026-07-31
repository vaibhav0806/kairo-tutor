import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/setup.ts'],
    setupFiles: ['./tests/setup.ts'],
    // Integration tests share one local Postgres database and seed/clean the same rows.
    fileParallelism: false,
  },
});
