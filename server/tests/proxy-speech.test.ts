import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';

const app = await buildApp();
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('proxy/speech', () => {
  it('401s /v1/tts/stream without auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/tts/stream', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('401s /v1/stt without auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/stt' });
    expect(res.statusCode).toBe(401);
  });
});
