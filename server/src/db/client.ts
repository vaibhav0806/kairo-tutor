import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from '../config/env';
import { localPostgresConnection } from './connection';
import * as schema from './schema';

// Local Postgres receives only parsed fields, never the raw URL. This prevents libpq-style query
// parameters from overriding a validated loopback host. Maintainer and hosted targets stay on Neon.
export const pool = new Pool(
  env.KAIRO_DATABASE_TARGET === 'local-postgres'
    ? localPostgresConnection(env.DATABASE_URL)
    : { connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } },
);

export const db = drizzle(pool, { schema });
