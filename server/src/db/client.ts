import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from '../config/env';
import * as schema from './schema';

// Neon POOLED url + a persistent Node process => node-postgres Pool (NOT the serverless HTTP
// driver). rejectUnauthorized:false is the common Neon dev setting; tighten for prod if desired.
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export const db = drizzle(pool, { schema });
