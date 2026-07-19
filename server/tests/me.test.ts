import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildApp } from '../src/app';
import { db, pool } from '../src/db/client';
import { ensureUserRows } from '../src/usage/service';
import { mintCode } from '../src/auth/codes';

const uid = 'test-user-me';
const app = await buildApp();

beforeAll(async () => {
  // JWKS verification does a real HTTP fetch to the server's own /api/auth/jwks, so listen.
  await app.listen({ port: 8787, host: '127.0.0.1' });
  await db.execute(sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES (${uid}, 'Me', 'me@t.dev', true, now(), now()) ON CONFLICT (id) DO NOTHING`);
  await ensureUserRows(uid);
  await db.execute(sql`UPDATE usage_counter SET used_free = 0, plan = 'free', free_limit = 10 WHERE user_id = ${uid}`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM session WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM oauth_code WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM usage_counter WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM subscription WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM "user" WHERE id = ${uid}`);
  await app.close();
  await pool.end();
});

async function freshJwt(): Promise<string> {
  const code = await mintCode(uid);
  const ex = await app.inject({ method: 'POST', url: '/auth/exchange', payload: { code } });
  const sessionToken = ex.json().sessionToken as string;
  const tok = await app.inject({
    method: 'GET',
    url: '/api/auth/token',
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  return tok.json().token as string;
}

describe('/v1/me', () => {
  it('401s without a bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('unauthenticated');
  });

  it('returns plan + usage for a signed-in free user', async () => {
    const jwt = await freshJwt();
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${jwt}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.plan).toBe('free');
    expect(body.usage).toEqual({ used: 0, limit: 10, remaining: 10 });
    expect(body.paywalled).toBe(false);
    expect(body.user.email).toBe('me@t.dev');
  });
});
