import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client';
import {
  ACCOUNT_LIMITS,
  BURST_WINDOW_MS,
  DAILY_WINDOW_MS,
  chargeAccount,
} from '../src/plugins/account-limits';
import { RateLimitedError, QuotaExceededError } from '../src/plugins/error-handler';

/** Minimal stand-in for the parts of FastifyRequest that `chargeAccount` touches. */
function fakeReq(userId: string | undefined) {
  return { userId, log: { warn: () => {}, error: () => {} } } as never;
}

/**
 * Seed a bucket directly instead of walking to the limit.
 *
 * The loop version issued hundreds of sequential statements, which slowed the suite enough to time
 * out an unrelated test. Testing a boundary does not require walking to it.
 */
async function seed(prefix: string, route: string, userId: string, windowMs: number, hits: number) {
  const start = Math.floor(Date.now() / windowMs) * windowMs;
  const bucket = `rl:${prefix}:${route}:${userId}:${start}`;
  await db.execute(sql`
    INSERT INTO rate_counter (bucket, hits, expires_at)
    VALUES (${bucket}, ${hits}, ${new Date(start + windowMs).toISOString()})
    ON CONFLICT (bucket) DO UPDATE SET hits = ${hits}`);
}

beforeEach(async () => {
  await db.execute(sql`DELETE FROM rate_counter`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM rate_counter`);
  await pool.end();
});

describe('every account is rate limited, including Pro', () => {
  it('refuses a burst with 429 and a Retry-After the client can use', async () => {
    // A subscription buys unlimited questions, not unlimited request rate. A retry loop or a
    // stolen token looks exactly like a very fast user, and must not be able to run all night.
    const userId = `acct-${randomUUID()}`;
    await seed('acct', 'vision', userId, BURST_WINDOW_MS, ACCOUNT_LIMITS.vision.burst);

    const error = await chargeAccount(fakeReq(userId), 'vision').catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(error.limit).toBe(ACCOUNT_LIMITS.vision.burst);
  });

  it('never answers an abuse limit with "buy more"', async () => {
    // 402 drives the desktop's upgrade prompt. Showing that to someone who already pays, because
    // they tripped an anti-abuse limit, would be actively misleading.
    const userId = `acct-${randomUUID()}`;
    await seed('acct', 'stt', userId, BURST_WINDOW_MS, ACCOUNT_LIMITS.stt.burst);

    const error = await chargeAccount(fakeReq(userId), 'stt').catch((e) => e);
    expect(error).not.toBeInstanceOf(QuotaExceededError);
    expect(error).toBeInstanceOf(RateLimitedError);
  });

  it('refuses once the daily allowance is gone, with a longer Retry-After', async () => {
    const userId = `acct-${randomUUID()}`;
    await seed('acctd', 'voice-preview', userId, DAILY_WINDOW_MS, ACCOUNT_LIMITS['voice-preview'].daily);

    const error = await chargeAccount(fakeReq(userId), 'voice-preview').catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.retryAfterSeconds).toBeGreaterThan(60);
  });

  it('lets an ordinary working pace straight through', async () => {
    const userId = `acct-${randomUUID()}`;
    for (let i = 0; i < 10; i += 1) {
      await expect(chargeAccount(fakeReq(userId), 'llm-chat')).resolves.toBeUndefined();
    }
  });

  it('keeps each route and each account on its own allowance', async () => {
    const a = `acct-${randomUUID()}`;
    const b = `acct-${randomUUID()}`;
    await seed('acct', 'vision', a, BURST_WINDOW_MS, ACCOUNT_LIMITS.vision.burst);

    // A different route for the same user is untouched...
    await expect(chargeAccount(fakeReq(a), 'stt')).resolves.toBeUndefined();
    // ...and another account is unaffected, which is exactly what a global ceiling got wrong.
    await expect(chargeAccount(fakeReq(b), 'vision')).resolves.toBeUndefined();
  });

  it('records usage against the user, not their address', async () => {
    const userId = `acct-${randomUUID()}`;
    await chargeAccount(fakeReq(userId), 'tts');
    await chargeAccount(fakeReq(userId), 'tts');

    const r = await db.execute(
      sql`SELECT hits FROM rate_counter WHERE bucket LIKE ${`rl:acct:tts:${userId}:%`}`,
    );
    expect(Number((r.rows[0] as { hits: number }).hits)).toBe(2);
  });

  it('does nothing when there is no user to charge', async () => {
    await expect(chargeAccount(fakeReq(undefined), 'stt')).resolves.toBeUndefined();
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM rate_counter`);
    expect(Number((r.rows[0] as { n: number }).n)).toBe(0);
  });
});
