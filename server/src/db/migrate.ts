import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './client';

// Programmatic migrator for the deploy step (systemd ExecStartPre / CI). Dev uses `db:migrate`.
await migrate(db, { migrationsFolder: './drizzle' });
await pool.end();
console.log('migrations applied');
