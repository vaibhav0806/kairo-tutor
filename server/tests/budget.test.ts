import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client';
import { clientBucket, consume, withinDailyBudget } from '../src/lib/budget';

beforeEach(async () => {
  await db.execute(sql`DELETE FROM rate_counter`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM rate_counter`);
  await pool.end();
});

describe('durable rate limiting', () => {
  it('allows up to the limit and refuses after', async () => {
    const key = `t-${Math.random().toString(36).slice(2)}`;
    for (let i = 0; i < 3; i += 1) expect(await consume(key, 3, 60_000)).toBe(true);
    expect(await consume(key, 3, 60_000)).toBe(false);
  });

  it('survives a restart, because the count is not in this process', async () => {
    // The whole point of moving off the in-memory Map: a deploy used to hand every caller a fresh
    // allowance, which on an unauthenticated route means a deploy was a free refill.
    const key = `t-${Math.random().toString(36).slice(2)}`;
    for (let i = 0; i < 3; i += 1) await consume(key, 3, 60_000);

    const row = await db.execute(sql`SELECT hits FROM rate_counter WHERE bucket LIKE ${`rl:${key}:%`}`);
    expect(Number((row.rows[0] as { hits: number }).hits)).toBe(3);
  });

  it('starts a fresh allowance in the next window', async () => {
    const key = `t-${Math.random().toString(36).slice(2)}`;
    const now = 1_800_000_000_000;
    for (let i = 0; i < 3; i += 1) expect(await consume(key, 3, 60_000, now)).toBe(true);
    expect(await consume(key, 3, 60_000, now)).toBe(false);
    expect(await consume(key, 3, 60_000, now + 60_000)).toBe(true);
  });

  it('counts concurrent callers exactly once each', async () => {
    // Read-then-write would let eight simultaneous requests all see "under the limit". The upsert
    // increments and reports position in one statement, so exactly three can win.
    const key = `t-${Math.random().toString(36).slice(2)}`;
    const results = await Promise.all(Array.from({ length: 8 }, () => consume(key, 3, 60_000)));
    expect(results.filter(Boolean)).toHaveLength(3);
  });
});

describe('client bucketing', () => {
  it('leaves IPv4 alone', () => {
    expect(clientBucket('203.0.113.9')).toBe('203.0.113.9');
  });

  it('groups an IPv6 customer by /64 rather than by address', () => {
    // A single subscriber is routinely handed a /64. Limiting per address there would be limiting
    // per attacker-chosen value.
    const a = clientBucket('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd');
    const b = clientBucket('2001:db8:1234:5678:1111:2222:3333:4444');
    expect(a).toBe(b);
    expect(clientBucket('2001:db8:1234:9999::1')).not.toBe(a);
  });
});

describe('daily ceiling', () => {
  it('refuses everyone once the day is spent, regardless of who is calling', async () => {
    const route = `t-${Math.random().toString(36).slice(2)}`;
    for (let i = 0; i < 2; i += 1) expect(await withinDailyBudget(route, 2)).toBe(true);
    expect(await withinDailyBudget(route, 2)).toBe(false);
  });

  it('is a separate allowance per day', async () => {
    const route = `t-${Math.random().toString(36).slice(2)}`;
    const day1 = Date.parse('2026-08-03T10:00:00Z');
    const day2 = Date.parse('2026-08-04T10:00:00Z');
    expect(await withinDailyBudget(route, 1, day1)).toBe(true);
    expect(await withinDailyBudget(route, 1, day1)).toBe(false);
    expect(await withinDailyBudget(route, 1, day2)).toBe(true);
  });
});
