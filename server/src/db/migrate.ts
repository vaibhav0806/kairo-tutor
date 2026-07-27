import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pino from 'pino';
import { db, pool } from './client';
import { assertDatabaseTarget } from './environment';

// Programmatic migrator for the deploy step (systemd ExecStartPre / CI). Dev uses `db:migrate`.
const log = pino({ name: 'kairo-migrate' });

try {
  const databaseTarget = await assertDatabaseTarget(pool);
  log.info(databaseTarget, 'migration environment verified');
  await migrate(db, { migrationsFolder: './drizzle' });
  log.info(databaseTarget, 'migrations applied');
} catch (error) {
  log.error({ err: error }, 'migration failed');
  throw error;
} finally {
  await pool.end();
}
