import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';

// Mock the provider forwarder + streamer so no real upstream call happens.
vi.mock('../src/proxy/forward', () => ({
  forwardJson: vi.fn(async () => ({ status: 200, json: { ok: true } })),
}));
vi.mock('../src/proxy/stream', () => ({
  streamPassthrough: vi.fn(async (_p: string, _path: string, _body: unknown, reply: any) => {
    reply.send({ ok: true });
  }),
}));

import { buildApp } from '../src/app';
import { db, pool } from '../src/db/client';

const app = await buildApp();

// The limiter is durable now, so counts outlive the process. Without this the vision budget below
// would still be spent from the previous run and the suite would fail on its second execution.
beforeAll(async () => {
  await db.execute(sql`DELETE FROM rate_counter`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM rate_counter`);
  await app.close();
  await pool.end();
});

// The models the desktop is built to send; anything else is refused before it reaches a provider.
const GATE_BODY = { model: 'openai/gpt-5.6-luna', messages: [] };
const VISION_BODY = { model: 'claude-opus-4-8' };

describe('onboarding proxy routes are exempt (no auth, no credits)', () => {
  it('/v1/onboarding/gate needs no auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/onboarding/gate', payload: GATE_BODY });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(200);
  });

  it('refuses a model we do not ship, without ever asking for auth', async () => {
    // 400 rather than 401 is the point: the route stays open to anyone mid-onboarding, but what
    // they may spend our provider keys on is fixed. These routes have no meter behind them.
    // Asserted on the gate only — a refused request still consumes a rate-limit slot, and the
    // vision budget below is deliberately tight. `model-guard.test.ts` covers the vision guard.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/gate',
      payload: { model: 'anthropic/most-expensive-thing', max_tokens: 100_000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('bad_request');
  });

  it('/v1/onboarding/tts/stream needs no auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/onboarding/tts/stream', payload: { text: 'hi' } });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(200);
  });

  it('/v1/onboarding/vision needs no auth and is IP-rate-limited (never metered)', async () => {
    // All CAP calls succeed without a JWT (proves no auth + no credit gate)...
    for (let i = 0; i < 12; i += 1) {
      const res = await app.inject({ method: 'POST', url: '/v1/onboarding/vision', payload: VISION_BODY });
      expect(res.statusCode).toBe(200);
    }
    // ...and the next one is rate-limited (bounds abuse of the expensive vision call).
    const over = await app.inject({ method: 'POST', url: '/v1/onboarding/vision', payload: VISION_BODY });
    expect(over.statusCode).toBe(429);
  });
});
