import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { localPostgresConnection } from '../src/db/connection';

const defaultDatabaseUrl = 'postgresql://postgres:postgres@127.0.0.1:5432/kairo_test';
const databaseUrl = process.env.KAIRO_TEST_DATABASE_URL?.trim() || defaultDatabaseUrl;
const databaseConfig = localPostgresConnection(databaseUrl, 'kairo_test');

// Tests never inherit server/.env. These deterministic values keep imports hermetic and ensure a
// test run cannot contact Neon, OAuth, billing, or AI providers by accident.
Object.assign(process.env, {
  NODE_ENV: 'test',
  KAIRO_SERVER_TARGET: 'local',
  KAIRO_DATABASE_TARGET: 'local-postgres',
  PORT: '8787',
  PUBLIC_BASE_URL: 'http://localhost:8787',
  DATABASE_URL: databaseUrl,
  BETTER_AUTH_SECRET: 'kairo-test-secret-not-for-production',
  GOOGLE_CLIENT_ID: 'kairo-test-client',
  GOOGLE_CLIENT_SECRET: 'kairo-test-client-secret',
  KAIRO_STT_PROVIDER: 'sarvam',
  KAIRO_TTS_PROVIDER: 'sarvam',
  KAIRO_TTS_PROVIDERS_ENABLED: 'sarvam',
  KAIRO_RELEASES_DIR: '/tmp/kairo-test-releases',
  KAIRO_RELEASE_DMG_NAME: 'Kairo-Tutor-test.dmg',
  DODO_ENV: 'test_mode',
  DODO_TEST_WEBHOOK_SECRET: `whsec_${Buffer.from('kairo-test-webhook-secret').toString('base64')}`,
  DODO_KAIRO_TEST_PRODUCT_ID: 'pdt_kairo_test',
});

for (const key of [
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'SARVAM_API_KEY',
  'ELEVENLABS_API_KEY',
  'DODO_KAIRO_TEST_KEY',
  'DODO_KAIRO_LIVE_KEY',
  'DODO_LIVE_WEBHOOK_SECRET',
  'DODO_KAIRO_LIVE_PRODUCT_ID',
]) {
  // dotenv does not overwrite existing variables. Empty values therefore keep a contributor's
  // server/.env secrets out of the test process while still behaving as unconfigured providers.
  process.env[key] = '';
}

export async function setup() {
  const pool = new Pool(databaseConfig);
  try {
    const connected = await pool.query<{ database: string }>('SELECT current_database() AS database');
    if (connected.rows[0]?.database !== databaseConfig.database) {
      throw new Error(`connected to unexpected database ${connected.rows[0]?.database ?? 'unknown'}`);
    }
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
  } catch (error) {
    throw new Error(
      'Could not prepare the local kairo_test database. Start Postgres as described in README.md, then retry.',
      { cause: error },
    );
  } finally {
    await pool.end();
  }
}
