import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Mock the provider forwarder so no real upstream call happens.
vi.mock('../src/proxy/forward', () => ({
  forwardJson: vi.fn(async () => ({ status: 200, json: { ok: true } })),
}));

import { sql } from 'drizzle-orm';
import { buildApp } from '../src/app';
import { db, pool } from '../src/db/client';
import { ensureUserRows, ONBOARDING_VISION_CAP } from '../src/usage/service';
import { mintCode } from '../src/auth/codes';

const uid = 'test-user-proxy';
const app = await buildApp();

beforeAll(async () => {
  await app.listen({ port: 8787, host: '127.0.0.1' });
  await db.execute(sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES (${uid}, 'Px', 'px@t.dev', true, now(), now()) ON CONFLICT (id) DO NOTHING`);
  await db.execute(sql`DELETE FROM usage_event WHERE user_id = ${uid}`);
  await ensureUserRows(uid);
  await db.execute(sql`UPDATE usage_counter SET used_free = 0, onboarding_used = 0, plan = 'free', free_limit = 1 WHERE user_id = ${uid}`);
  // Mark onboarding complete so /v1/vision/tutor exercises the METERED path (not the tutorial budget).
  await db.execute(sql`INSERT INTO profile (user_id, onboarding_completed_at, waitlisted)
    VALUES (${uid}, now(), false) ON CONFLICT (user_id) DO UPDATE SET onboarding_completed_at = now()`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM usage_event WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM session WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM oauth_code WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM profile WHERE user_id = ${uid}`);
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

describe('proxy /v1/vision/tutor metering', () => {
  it('401s without auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/vision/tutor', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('allows the first ask, then 402s at the free limit', async () => {
    const jwt = await freshJwt();
    const headers = { authorization: `Bearer ${jwt}` };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/vision/tutor',
      headers: { ...headers, 'x-kairo-ask-id': randomAskId() },
      payload: {},
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/vision/tutor',
      headers: { ...headers, 'x-kairo-ask-id': randomAskId() },
      payload: {},
    });
    expect(second.statusCode).toBe(402);
    expect(second.json().code).toBe('quota_exceeded');
  });
});

describe('proxy /v1/vision/tutor tutorial budget (onboarding)', () => {
  it('does not bill used_free during onboarding, and caps the tutorial', async () => {
    // Look like a user still in onboarding (no completed profile), with the 10-free limit at 1.
    await db.execute(sql`DELETE FROM profile WHERE user_id = ${uid}`);
    await db.execute(sql`UPDATE usage_counter SET used_free = 0, onboarding_used = 0, free_limit = 1 WHERE user_id = ${uid}`);
    const headers = { authorization: `Bearer ${await freshJwt()}` };

    // free_limit is 1, yet tutorial turns draw the SEPARATE capped budget: CAP turns all allowed.
    for (let i = 0; i < ONBOARDING_VISION_CAP; i += 1) {
      const res = await app.inject({ method: 'POST', url: '/v1/vision/tutor', headers, payload: {} });
      expect(res.statusCode).toBe(200);
    }
    const row = await db.execute(sql`SELECT used_free, onboarding_used FROM usage_counter WHERE user_id = ${uid}`);
    expect(Number(row.rows[0].used_free)).toBe(0); // tutorial NOT billed against the 10 free
    expect(Number(row.rows[0].onboarding_used)).toBe(ONBOARDING_VISION_CAP);

    // Over the tutorial cap → 402 (can't loop the tutorial for unlimited free vision).
    const over = await app.inject({ method: 'POST', url: '/v1/vision/tutor', headers, payload: {} });
    expect(over.statusCode).toBe(402);
  });
});

function randomAskId(): string {
  return crypto.randomUUID();
}
