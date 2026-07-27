import { describe, expect, it } from 'vitest';
import { assertStaticEnvironment } from '../src/config/targets';
import { assertDatabaseTarget } from '../src/db/environment';

describe('server environment target guard', () => {
  it('accepts the local dev/test pairing', () => {
    expect(
      assertStaticEnvironment({
        KAIRO_SERVER_TARGET: 'local',
        PUBLIC_BASE_URL: 'http://localhost:8787',
        DODO_ENV: 'test_mode',
      }).neonBranchName,
    ).toBe('dev');
  });

  it('accepts the hosted production/live pairing', () => {
    expect(
      assertStaticEnvironment({
        KAIRO_SERVER_TARGET: 'hosted',
        PUBLIC_BASE_URL: 'https://api.meetkairo.xyz',
        DODO_ENV: 'live_mode',
      }).neonBranchName,
    ).toBe('production');
  });

  it('blocks test-mode billing on the hosted production target', () => {
    expect(() =>
      assertStaticEnvironment({
        KAIRO_SERVER_TARGET: 'hosted',
        PUBLIC_BASE_URL: 'https://api.meetkairo.xyz',
        DODO_ENV: 'test_mode',
      }),
    ).toThrow('requires DODO_ENV=live_mode');
  });

  it('blocks a hosted URL on the local development target', () => {
    expect(() =>
      assertStaticEnvironment({
        KAIRO_SERVER_TARGET: 'local',
        PUBLIC_BASE_URL: 'https://api.meetkairo.xyz',
        DODO_ENV: 'test_mode',
      }),
    ).toThrow('requires PUBLIC_BASE_URL=http://localhost:8787');
  });

  it('accepts the actual local Neon endpoint', async () => {
    const query = async () => ({
      rows: [{ branch_id: 'br-dev', endpoint_id: 'ep-damp-bar-as9g9rwj' }],
    });

    await expect(assertDatabaseTarget({ query } as never)).resolves.toMatchObject({
      target: 'local',
      branch: 'br-dev',
    });
  });

  it('blocks a production Neon endpoint under the local target', async () => {
    const query = async () => ({
      rows: [{ branch_id: 'br-production', endpoint_id: 'ep-summer-wildflower-asm8likt' }],
    });

    await expect(assertDatabaseTarget({ query } as never)).rejects.toThrow(
      'requires Neon branch dev',
    );
  });
});
