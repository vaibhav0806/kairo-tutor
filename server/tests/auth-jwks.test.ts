import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';

const app = await buildApp();
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('better-auth', () => {
  it('exposes a JWKS with at least one key (generates a keypair in the db on first call)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/jwks' });
    expect(res.statusCode).toBe(200);
    expect(res.json().keys.length).toBeGreaterThan(0);
  });
});
