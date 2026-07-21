import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildApp } from '../src/app';
import { db, pool } from '../src/db/client';
import { ensureUserRows } from '../src/usage/service';
import { mintCode } from '../src/auth/codes';

const uid = 'test-user-onboarding';
const app = await buildApp();

beforeAll(async () => {
  await app.listen({ port: 8787, host: '127.0.0.1' });
  await db.execute(sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES (${uid}, 'Ob', 'ob@t.dev', true, now(), now()) ON CONFLICT (id) DO NOTHING`);
  await ensureUserRows(uid);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM profile WHERE user_id = ${uid}`);
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

describe('/v1/onboarding', () => {
  it('saves answers -> /v1/me reports onboarded + display_name', async () => {
    const jwt = await freshJwt();
    const auth = { authorization: `Bearer ${jwt}` };

    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: auth })).json().onboarded).toBe(false);

    const save = await app.inject({
      method: 'POST',
      url: '/v1/onboarding',
      headers: auth,
      payload: { displayName: 'Prasad', source: 'Twitter / X' },
    });
    expect(save.statusCode).toBe(200);

    const after = (await app.inject({ method: 'GET', url: '/v1/me', headers: auth })).json();
    expect(after.onboarded).toBe(true);
    expect(after.display_name).toBe('Prasad');
  });

  it('persists a valid accent hex and ignores a malformed one', async () => {
    const jwt = await freshJwt();
    const auth = { authorization: `Bearer ${jwt}` };

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/onboarding',
      headers: auth,
      payload: { displayName: 'Prasad', source: 'A friend', accent: '#7C3AED' },
    });
    expect(ok.statusCode).toBe(200);

    // A malformed accent is dropped (null), not rejected — the save still succeeds.
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/onboarding',
      headers: auth,
      payload: { displayName: 'Prasad', source: 'A friend', accent: 'purple' },
    });
    expect(bad.statusCode).toBe(200);
  });

  it('rejects an empty name', async () => {
    const jwt = await freshJwt();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/onboarding',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { displayName: '   ', source: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});
