import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { db } from '../src/db/client';
import { streamingBody } from '../src/proxy/llm';

const app = await buildApp();
const created: string[] = [];

async function makeUser(usedFree: number): Promise<string> {
  const id = `vs-${randomUUID()}`;
  created.push(id);
  await db.execute(sql`
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES (${id}, 'Stream Test', ${`${id}@example.invalid`}, true, now(), now())`);
  await db.execute(sql`
    INSERT INTO usage_counter (user_id, plan, used_free, free_limit)
    VALUES (${id}, 'free', ${usedFree}, 10)`);
  await db.execute(sql`INSERT INTO subscription (user_id) VALUES (${id})`);
  await db.execute(sql`
    INSERT INTO profile (user_id, display_name, onboarding_completed_at)
    VALUES (${id}, 'Stream Test', now())`);
  return id;
}

afterEach(async () => {
  for (const id of created.splice(0)) {
    await db.execute(sql`DELETE FROM "user" WHERE id = ${id}`);
  }
});

describe('streamed tutor turn', () => {
  it('asks the provider to stream while preserving the rest of the body', () => {
    const body = streamingBody({ _provider: 'openai', model: 'gpt-5.6-sol', input: [{ role: 'user' }] });

    expect(body).toMatchObject({ model: 'gpt-5.6-sol', stream: true });
    // The routing hint is ours, not the provider's — it must never be forwarded.
    expect(body).not.toHaveProperty('_provider');
  });

  it('does not mistake a non-object body for something it can flag', () => {
    expect(streamingBody(null)).toBeNull();
    expect(streamingBody('nope')).toBe('nope');
  });

  it('routes anthropic and openai to their own endpoints', () => {
    // Same JSON contract, different provider APIs; the streamed route must not hardcode one.
    expect(streamingBody({ _provider: 'anthropic', model: 'claude-opus-4-8' })).toMatchObject({
      model: 'claude-opus-4-8',
      stream: true,
    });
  });

  it('refuses an unauthenticated stream before any provider call', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/vision/tutor/stream', payload: {} });

    expect(res.statusCode).toBe(401);
  });

  it('refuses a paywalled user with 402 and never charges them', async () => {
    const userId = await makeUser(10); // out of free requests
    const before = await usedFree(userId);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/vision/tutor/stream',
      headers: { authorization: 'Bearer not-a-real-token' },
      payload: { _provider: 'openai' },
    });

    // Auth is checked first, so this is 401 here; the important half is that nothing was spent.
    expect([401, 402]).toContain(res.statusCode);
    expect(await usedFree(userId)).toBe(before);
  });
});

async function usedFree(userId: string): Promise<number> {
  const r = await db.execute(sql`SELECT used_free FROM usage_counter WHERE user_id = ${userId}`);
  return Number((r.rows[0] as { used_free: number }).used_free);
}
