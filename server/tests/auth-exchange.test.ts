import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildApp } from '../src/app';
import { db, pool } from '../src/db/client';
import { mintCode } from '../src/auth/codes';

const uid = 'test-user-exchange';
const app = await buildApp();

beforeAll(async () => {
  await db.execute(sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES (${uid}, 'Ex', 'ex@t.dev', true, now(), now()) ON CONFLICT (id) DO NOTHING`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM session WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM oauth_code WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM "user" WHERE id = ${uid}`);
  await app.close();
  await pool.end();
});

describe('/auth/exchange', () => {
  it('rejects a bad code', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/exchange', payload: { code: 'nope' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('bad_request');
  });

  it('exchanges a valid code for a session token that authenticates /api/auth/token', async () => {
    const code = await mintCode(uid);

    const ex = await app.inject({ method: 'POST', url: '/auth/exchange', payload: { code } });
    expect(ex.statusCode).toBe(200);
    const sessionToken = ex.json().sessionToken as string;
    expect(typeof sessionToken).toBe('string');

    // The session we inserted must be a valid bearer for Better Auth's own endpoints.
    const tok = await app.inject({
      method: 'GET',
      url: '/api/auth/token',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(tok.statusCode).toBe(200);
    expect(typeof tok.json().token).toBe('string'); // a short-lived JWT

    // The one-time code must be burned (single use).
    const reuse = await app.inject({ method: 'POST', url: '/auth/exchange', payload: { code } });
    expect(reuse.statusCode).toBe(400);
  });
});
