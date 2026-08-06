import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';

const app = await buildApp();

afterAll(async () => {
  await app.close();
  await pool.end();
});

/** The header a browser reads to decide whether the page may see the response. */
function allowOrigin(headers: Record<string, unknown>): string | undefined {
  const value = headers['access-control-allow-origin'];
  return typeof value === 'string' ? value : undefined;
}

describe('CORS is an allowlist, not a mirror', () => {
  it('allows the packaged desktop webview', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'tauri://localhost' },
    });
    expect(allowOrigin(res.headers)).toBe('tauri://localhost');
  });

  it('does not hand an arbitrary website a credentialed grant', async () => {
    // `origin: true` reflected whatever arrived, so any page a signed-in user visited could call
    // this API with their credentials and read the answers.
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://evil.example' },
    });
    expect(allowOrigin(res.headers)).toBeUndefined();
  });

  it('refuses the same origin on a preflight', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'GET',
      },
    });
    expect(allowOrigin(res.headers)).toBeUndefined();
  });

  it('leaves non-browser callers alone', async () => {
    // The Rust proxy, curl and the updater send no Origin. They are not cross-origin requests and
    // CORS was never what stood between them and the API — auth is.
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});
