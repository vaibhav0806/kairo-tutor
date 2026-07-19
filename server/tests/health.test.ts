import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../src/app';

const app = await buildApp();
afterAll(() => app.close());

describe('health', () => {
  it('GET /healthz returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
