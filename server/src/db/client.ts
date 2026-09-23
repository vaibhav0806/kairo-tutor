import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from '../config/env';
import { hostedPostgresConnection, localPostgresConnection } from './connection';
import * as schema from './schema';

// Local and hosted Postgres URLs are parsed before they reach `pg`, preventing connection-string
// overrides from escaping their respective environment guards.
export const pool = new Pool(
  env.KAIRO_DATABASE_TARGET === 'local-postgres'
    ? localPostgresConnection(env.DATABASE_URL)
    : env.KAIRO_DATABASE_TARGET === 'hosted-postgres'
      ? hostedPostgresConnection(env.DATABASE_URL)
      : { connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } },
);

export const db = drizzle(pool, { schema });
