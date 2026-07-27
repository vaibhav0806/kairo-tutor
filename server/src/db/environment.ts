import type { Pool } from 'pg';
import { env } from '../config/env';
import { SERVER_TARGETS } from '../config/targets';

export type VerifiedDatabaseTarget = {
  target: keyof typeof SERVER_TARGETS;
  branch: string;
  endpoint: string;
};

/**
 * Ask Neon which endpoint the connection actually reached. Labels in an env file can drift;
 * Neon's runtime setting is authoritative and prevents test/prod cross-contamination.
 */
export async function assertDatabaseTarget(pool: Pick<Pool, 'query'>): Promise<VerifiedDatabaseTarget> {
  const expected = SERVER_TARGETS[env.KAIRO_SERVER_TARGET];
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
      `KAIRO_SERVER_TARGET=${env.KAIRO_SERVER_TARGET} requires Neon branch ${expected.neonBranchName}; connected endpoint was ${endpoint}`,
    );
  }

  return { target: env.KAIRO_SERVER_TARGET, branch, endpoint };
}
