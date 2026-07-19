import { defineConfig } from 'tsup';

// Bundle the server into one self-contained file for prod `node dist/index.js`.
// noExternal inlines the source-only @kairo/shared package so it needs no build of its own.
export default defineConfig({
  // index = the server; db/migrate = the deploy-time migration runner.
  entry: ['src/index.ts', 'src/db/migrate.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  sourcemap: true,
  noExternal: ['@kairo/shared'],
});
