import { describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { assertStaticEnvironment } from '../src/config/targets';
import { localPostgresConnection } from '../src/db/connection';
import { assertDatabaseTarget } from '../src/db/environment';

describe('server environment target guard', () => {
  it('uses isolated test credentials instead of values from server/.env', () => {
    const databaseUrl = new URL(env.DATABASE_URL);
    expect(['127.0.0.1', '[::1]']).toContain(databaseUrl.hostname);
    expect(databaseUrl.pathname).toBe('/kairo_test');
    expect(env.KAIRO_DATABASE_TARGET).toBe('local-postgres');
    expect(env.OPENROUTER_API_KEY).toBe('');
    expect(env.ANTHROPIC_API_KEY).toBe('');
    expect(env.OPENAI_API_KEY).toBe('');
    expect(env.SARVAM_API_KEY).toBe('');
    expect(env.ELEVENLABS_API_KEY).toBe('');
    expect(env.DODO_KAIRO_LIVE_KEY).toBe('');
  });

  it('accepts the local dev/test pairing', () => {
    expect(
      assertStaticEnvironment({
        KAIRO_SERVER_TARGET: 'local',
        KAIRO_DATABASE_TARGET: 'neon',
        PUBLIC_BASE_URL: 'http://localhost:8787',
        DODO_ENV: 'test_mode',
      }).neonBranchName,
    ).toBe('dev');
  });

  it('accepts the hosted production/live pairing', () => {
    expect(
      assertStaticEnvironment({
        KAIRO_SERVER_TARGET: 'hosted',
        KAIRO_DATABASE_TARGET: 'neon',
        PUBLIC_BASE_URL: 'https://api.meetkairo.xyz',
        DODO_ENV: 'live_mode',
      }).neonBranchName,
    ).toBe('production');
  });

  it('blocks test-mode billing on the hosted production target', () => {
    expect(() =>
      assertStaticEnvironment({
        KAIRO_SERVER_TARGET: 'hosted',
        KAIRO_DATABASE_TARGET: 'neon',
        PUBLIC_BASE_URL: 'https://api.meetkairo.xyz',
        DODO_ENV: 'test_mode',
      }),
    ).toThrow('requires DODO_ENV=live_mode');
  });

  it('blocks a hosted URL on the local development target', () => {
    expect(() =>
      assertStaticEnvironment({
        KAIRO_SERVER_TARGET: 'local',
        KAIRO_DATABASE_TARGET: 'neon',
        PUBLIC_BASE_URL: 'https://api.meetkairo.xyz',
        DODO_ENV: 'test_mode',
      }),
    ).toThrow('requires PUBLIC_BASE_URL=http://localhost:8787');
  });

  it('blocks local Postgres on the hosted target', () => {
    expect(() =>
      assertStaticEnvironment({
        KAIRO_SERVER_TARGET: 'hosted',
        KAIRO_DATABASE_TARGET: 'local-postgres',
        PUBLIC_BASE_URL: 'https://api.meetkairo.xyz',
        DODO_ENV: 'live_mode',
      }),
    ).toThrow('cannot use KAIRO_DATABASE_TARGET=local-postgres');
  });

  it('passes only parsed loopback fields to Postgres', () => {
    expect(
      localPostgresConnection('postgresql://user:password@127.0.0.1:5433/kairo_local'),
    ).toMatchObject({
      host: '127.0.0.1',
      port: 5433,
      database: 'kairo_local',
      user: 'user',
      password: 'password',
      ssl: false,
    });
    expect(localPostgresConnection('postgresql://user:password@[::1]/kairo_local')).toMatchObject({
      host: '::1',
      database: 'kairo_local',
    });
  });

  it.each([
    'postgresql://postgres:postgres@127.0.0.1:5432/kairo_test?host=remote.example',
    'postgresql://postgres:postgres@127.0.0.1:5432/kairo_test?hostaddr=203.0.113.1',
    'postgresql://postgres:postgres@127.0.0.1:5432/kairo_test?service=production',
    'postgresql://postgres:postgres@127.0.0.1:5432/kairo_test?sslmode=require',
    'postgresql://postgres:postgres@127.0.0.1:5432/kairo_test#remote',
  ])('rejects connection overrides in a loopback URL: %s', (url) => {
    expect(() => localPostgresConnection(url, 'kairo_test')).toThrow(
      'must not contain query parameters or a fragment',
    );
  });

  it('rejects remote hosts and the wrong test database', () => {
    expect(() =>
      localPostgresConnection('postgresql://postgres:postgres@db.example/kairo_test'),
    ).toThrow('must use literal 127.0.0.1 or ::1');
    expect(() =>
      localPostgresConnection('postgresql://postgres:postgres@localhost/kairo_test'),
    ).toThrow('must use literal 127.0.0.1 or ::1');
    expect(() =>
      localPostgresConnection('postgresql://postgres:postgres@127.0.0.1/not_the_test_db', 'kairo_test'),
    ).toThrow('must use the kairo_test database');
    expect(() =>
      localPostgresConnection('postgresql://postgres:postgres@127.0.0.1/kairo%2Ftest'),
    ).toThrow('must name exactly one database');
    expect(() =>
      localPostgresConnection('postgresql://postgres:postgres@127.0.0.1:0/kairo_test'),
    ).toThrow('must use a valid TCP port');
  });

  it('accepts stock local Postgres for the local server target', async () => {
    const query = async () => ({
      rows: [{ database: 'kairo_local', address: '127.0.0.1' }],
    });

    await expect(
      assertDatabaseTarget({ query } as never, {
        KAIRO_SERVER_TARGET: 'local',
        KAIRO_DATABASE_TARGET: 'local-postgres',
        DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/kairo_local',
      }),
    ).resolves.toMatchObject({
      kind: 'local-postgres',
      target: 'local',
      database: 'kairo_local',
    });
  });

  it('blocks local Postgres for hosted and mismatched databases', async () => {
    const query = async () => ({ rows: [{ database: 'other', address: '127.0.0.1' }] });

    await expect(
      assertDatabaseTarget({ query } as never, {
        KAIRO_SERVER_TARGET: 'hosted',
        KAIRO_DATABASE_TARGET: 'local-postgres',
        DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/kairo_local',
      }),
    ).rejects.toThrow('only allowed with KAIRO_SERVER_TARGET=local');
    await expect(
      assertDatabaseTarget({ query } as never, {
        KAIRO_SERVER_TARGET: 'local',
        KAIRO_DATABASE_TARGET: 'local-postgres',
        DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/kairo_local',
      }),
    ).rejects.toThrow('connected database was other');
  });

  it('accepts the actual local Neon endpoint', async () => {
    const query = async () => ({
      rows: [{ branch_id: 'br-dev', endpoint_id: 'ep-damp-bar-as9g9rwj' }],
    });

    await expect(
      assertDatabaseTarget({ query } as never, {
        KAIRO_SERVER_TARGET: 'local',
        KAIRO_DATABASE_TARGET: 'neon',
        DATABASE_URL: 'postgresql://unused',
      }),
    ).resolves.toMatchObject({ kind: 'neon', target: 'local', branch: 'br-dev' });
  });

  it('blocks a production Neon endpoint under the local target', async () => {
    const query = async () => ({
      rows: [{ branch_id: 'br-production', endpoint_id: 'ep-summer-wildflower-asm8likt' }],
    });

    await expect(
      assertDatabaseTarget({ query } as never, {
        KAIRO_SERVER_TARGET: 'local',
        KAIRO_DATABASE_TARGET: 'neon',
        DATABASE_URL: 'postgresql://unused',
      }),
    ).rejects.toThrow('requires Neon branch dev');
  });

  it('blocks the Neon dev endpoint under the hosted target', async () => {
    const query = async () => ({
      rows: [{ branch_id: 'br-dev', endpoint_id: 'ep-damp-bar-as9g9rwj' }],
    });

    await expect(
      assertDatabaseTarget({ query } as never, {
        KAIRO_SERVER_TARGET: 'hosted',
        KAIRO_DATABASE_TARGET: 'neon',
        DATABASE_URL: 'postgresql://unused',
      }),
    ).rejects.toThrow('requires Neon branch production');
  });

  it('accepts the production Neon endpoint under the hosted target', async () => {
    const query = async () => ({
      rows: [{ branch_id: 'br-production', endpoint_id: 'ep-summer-wildflower-asm8likt' }],
    });

    await expect(
      assertDatabaseTarget({ query } as never, {
        KAIRO_SERVER_TARGET: 'hosted',
        KAIRO_DATABASE_TARGET: 'neon',
        DATABASE_URL: 'postgresql://unused',
      }),
    ).resolves.toMatchObject({ kind: 'neon', target: 'hosted', branch: 'br-production' });
  });
});
