import { env } from './config/env';
import { buildApp } from './app';
import { pool } from './db/client';
import { assertDatabaseTarget } from './db/environment';

const databaseTarget = await assertDatabaseTarget(pool);
const app = await buildApp();
app.log.info(databaseTarget, 'server environment verified');
await app.listen({ port: env.PORT, host: '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
