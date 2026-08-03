import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client';
import {
  ACCOUNT_DAILY_LIMITS,
  ACCOUNT_WINDOW_MS,
  chargeAccount,
} from '../src/plugins/account-limits';
import { QuotaExceededError } from '../src/plugins/error-handler';

/** Minimal stand-in for the parts of FastifyRequest that `chargeAccount` touches. */
function fakeReq(userId: string | undefined) {
  return { userId, log: { error: () => {} } } as never;
}

beforeEach(async () => {
  await db.execute(sql`DELETE FROM rate_counter`);
});

/**
 * Seed a bucket to `hits` directly instead of calling `chargeAccount` in a loop.
 *
 * The loop version issued hundreds of sequential statements, which slowed the whole suite enough
 * to time out an unrelated test. Testing the boundary does not require walking to it.
 */
async function seedBucket(userId: string, route: string, hits: number): Promise<void> {
  const windowStart = Math.floor(Date.now() / ACCOUNT_WINDOW_MS) * ACCOUNT_WINDOW_MS;
  const bucket = `rl:acct:${route}:${userId}:${windowStart}`;
  const expiresAt = new Date(windowStart + ACCOUNT_WINDOW_MS).toISOString();
  await db.execute(sql`
    INSERT INTO rate_counter (bucket, hits, expires_at)
    VALUES (${bucket}, ${hits}, ${expiresAt})
    ON CONFLICT (bucket) DO UPDATE SET hits = ${hits}`);
}

afterAll(async () => {
  await db.execute(sql`DELETE FROM rate_counter`);
  await pool.end();
});

describe('unmetered routes are still bounded per account', () => {
  it('records every call against the user, not their address', async () => {
    // The identity is the whole point: one office shares an address, and one attacker rents
    // thousands, so an address was never a caller.
    const userId = `acct-${randomUUID()}`;
    await chargeAccount(fakeReq(userId), 'voice-preview');
    await chargeAccount(fakeReq(userId), 'voice-preview');

    const r = await db.execute(
      sql`SELECT hits FROM rate_counter WHERE bucket LIKE ${`rl:acct:voice-preview:${userId}:%`}`,
    );
    expect(Number((r.rows[0] as { hits: number }).hits)).toBe(2);
  });

  it('refuses with a 402-shaped error once the daily allowance is gone', async () => {
    const userId = `acct-${randomUUID()}`;
    // One short of the allowance: the next call is the last one that may pass.
    await seedBucket(userId, 'voice-preview', ACCOUNT_DAILY_LIMITS['voice-preview'] - 1);

    await expect(chargeAccount(fakeReq(userId), 'voice-preview')).resolves.toBeUndefined();
    await expect(chargeAccount(fakeReq(userId), 'voice-preview')).rejects.toThrow(
      QuotaExceededError,
    );
  });

  it('keeps each route and each account on its own allowance', async () => {
    const a = `acct-${randomUUID()}`;
    const b = `acct-${randomUUID()}`;
    await seedBucket(a, 'voice-preview', ACCOUNT_DAILY_LIMITS['voice-preview']);

    // A different route for the same user is untouched...
    await expect(chargeAccount(fakeReq(a), 'stt')).resolves.toBeUndefined();
    // ...and another user is unaffected, which is what a global ceiling got wrong.
    await expect(chargeAccount(fakeReq(b), 'voice-preview')).resolves.toBeUndefined();
  });

  it('does nothing when there is no user to charge', async () => {
    await expect(chargeAccount(fakeReq(undefined), 'stt')).resolves.toBeUndefined();
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM rate_counter`);
    expect(Number((r.rows[0] as { n: number }).n)).toBe(0);
  });
});
