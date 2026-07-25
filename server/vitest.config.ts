import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Tests share one Neon DB (they seed/clean the same rows) — run files sequentially.
    fileParallelism: false,
  },
});
