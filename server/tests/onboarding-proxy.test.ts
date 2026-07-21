import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

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
import { pool } from '../src/db/client';

const app = await buildApp();

beforeAll(async () => {
  await app.listen({ port: 8788, host: '127.0.0.1' });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('onboarding proxy routes are exempt (no auth, no credits)', () => {
  it('/v1/onboarding/gate needs no auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/onboarding/gate', payload: { messages: [] } });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(200);
  });

  it('/v1/onboarding/tts/stream needs no auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/onboarding/tts/stream', payload: { text: 'hi' } });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(200);
  });

  it('/v1/onboarding/vision needs no auth and is IP-rate-limited (never metered)', async () => {
    // All CAP calls succeed without a JWT (proves no auth + no credit gate)...
    for (let i = 0; i < 12; i += 1) {
      const res = await app.inject({ method: 'POST', url: '/v1/onboarding/vision', payload: {} });
      expect(res.statusCode).toBe(200);
    }
    // ...and the next one is rate-limited (bounds abuse of the expensive vision call).
    const over = await app.inject({ method: 'POST', url: '/v1/onboarding/vision', payload: {} });
    expect(over.statusCode).toBe(429);
  });
});
