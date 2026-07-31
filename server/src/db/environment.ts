import type { Pool } from 'pg';
import { env } from '../config/env';
import { SERVER_TARGETS } from '../config/targets';
import { localPostgresConnection } from './connection';

type DatabaseEnvironment = Pick<
  typeof env,
  'KAIRO_SERVER_TARGET' | 'KAIRO_DATABASE_TARGET' | 'DATABASE_URL'
>;

export type VerifiedDatabaseTarget =
  | {
      kind: 'neon';
      target: keyof typeof SERVER_TARGETS;
      branch: string;
      endpoint: string;
    }
  | {
      kind: 'local-postgres';
      target: 'local';
      database: string;
      address: string;
    };

/** Verify the connected local database or Neon's authoritative endpoint before startup/migration. */
export async function assertDatabaseTarget(
  pool: Pick<Pool, 'query'>,
  environment: DatabaseEnvironment = env,
): Promise<VerifiedDatabaseTarget> {
  if (environment.KAIRO_DATABASE_TARGET === 'local-postgres') {
    if (environment.KAIRO_SERVER_TARGET !== 'local') {
      throw new Error('local Postgres is only allowed with KAIRO_SERVER_TARGET=local');
    }
    const configured = localPostgresConnection(environment.DATABASE_URL);
    const result = await pool.query<{ database: string; address: string | null }>(`
      SELECT current_database() AS database, inet_server_addr()::text AS address
    `);
    const database = result.rows[0]?.database ?? 'unknown';
    if (database !== configured.database) {
      throw new Error(
        `local Postgres expected database ${configured.database}; connected database was ${database}`,
      );
    }
    return {
      kind: 'local-postgres',
      target: 'local',
      database,
      address: result.rows[0]?.address ?? 'local-socket',
    };
  }

  const expected = SERVER_TARGETS[environment.KAIRO_SERVER_TARGET];
  const result = await pool.query<{
    branch_id: string | null;
    endpoint_id: string | null;
  }>(`
    SELECT
      current_setting('neon.branch_id', true) AS branch_id,
      current_setting('neon.endpoint_id', true) AS endpoint_id
  `);
  const branch = result.rows[0]?.branch_id ?? 'unknown';
  const endpoint = result.rows[0]?.endpoint_id ?? 'unknown';

  if (endpoint !== expected.neonEndpointId) {
    throw new Error(
      `KAIRO_SERVER_TARGET=${environment.KAIRO_SERVER_TARGET} requires Neon branch ${expected.neonBranchName}; connected endpoint was ${endpoint}`,
    );
  }

  return { kind: 'neon', target: environment.KAIRO_SERVER_TARGET, branch, endpoint };
}
