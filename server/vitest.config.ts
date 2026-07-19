import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Tests share one Neon DB and some listen on port 8787 (for JWKS) — run files sequentially.
    fileParallelism: false,
  },
});
