import type { PoolConfig } from 'pg';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

export type LocalPostgresConnection = PoolConfig & {
  database: string;
  host: string;
  port: number;
  ssl: false;
};

/** Parse a loopback Postgres URL into fields so libpq-style query overrides never reach `pg`. */
export function localPostgresConnection(
  value: string,
  expectedDatabase?: string,
): LocalPostgresConnection {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('local Postgres URL must use the postgres protocol');
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('local Postgres URL must use literal 127.0.0.1 or ::1');
  }
  if (url.search || url.hash) {
    throw new Error('local Postgres URL must not contain query parameters or a fragment');
  }
  if (url.port === '0') {
    throw new Error('local Postgres URL must use a valid TCP port');
  }

  const database = decodeURIComponent(url.pathname.slice(1));
  if (!database || database.includes('/')) {
    throw new Error('local Postgres URL must name exactly one database');
  }
  if (expectedDatabase && database !== expectedDatabase) {
    throw new Error(`local Postgres URL must use the ${expectedDatabase} database`);
  }

  return {
    host: url.hostname === '[::1]' ? '::1' : url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: false,
  };
}
