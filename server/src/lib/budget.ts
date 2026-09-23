import { sql } from 'drizzle-orm';
import { db } from '../db/client';

/**
 * Durable fixed-window counters, and the daily ceiling built on top of them.
 *
 * Two things are true about the unauthenticated onboarding routes: someone will eventually point a
 * script at them, and no per-caller limit can stop that on its own — IPs are cheap. So there are
 * two layers here with different jobs:
 *
 *   `consume()`  bounds any single caller, and is the one that keeps ordinary abuse boring.
 *   `withinDailyBudget()` bounds EVERYONE, together, per day. It is the answer to "what is the
 *                worst case", and the worst case needs to be a number we chose rather than a
 *                number an attacker chose.
 *
 * Both are one atomic statement: the upsert increments and returns the new count in the same
 * round trip, so concurrent requests cannot each read "under the limit" and then all proceed.
 */

/** Sweep expired rows roughly this often, from whichever request notices. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let lastSweep = 0;

/**
 * Bucket a client for rate-limiting purposes.
 *
 * IPv6 is bucketed by /64 because a single customer is routinely handed one — limiting per address
 * there would be limiting per attacker-chosen value, which is not a limit at all.
 */
export function clientBucket(ip: string): string {
  if (!ip.includes(':')) return ip;
  const hextets = ip.split('%')[0].split(':');
  // Only expand when we can do it unambiguously; a compressed address still yields a stable key.
  return hextets.slice(0, 4).join(':') + '::/64';
}

/** Floor `now` to the start of its window, so every caller in a window shares one row. */
function windowStart(windowMs: number, now: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

/**
 * Count one hit against `key` and report whether it is within `max` for this window.
 *
 * Returns true when the request may proceed. A database failure returns true: this limiter exists
 * to bound cost, and taking the product down when Postgres hiccups would be a worse outcome than
 * the spending it prevents. The daily ceiling below is the backstop that must not be optional.
 */
export async function consume(
  key: string,
  max: number,
  windowMs: number,
  now = Date.now(),
): Promise<boolean> {
  return (await consumeDetailed(key, max, windowMs, now)).allowed;
}

/** What a caller needs to tell the client how much is left and when it resets. */
export type ConsumeResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix epoch ms at which this window ends and the allowance returns. */
  resetAt: number;
};

/**
 * Count one hit and report the window state, so the response can carry standard rate-limit headers.
 *
 * Fixed windows, not a sliding log. The known trade is that a caller timing requests either side of
 * a boundary can briefly reach twice the limit; for burst control that is acceptable, and it costs
 * one row and one statement instead of retaining every request. If the boundary case ever matters,
 * this is the function to change.
 */
export async function consumeDetailed(
  key: string,
  max: number,
  windowMs: number,
  now = Date.now(),
): Promise<ConsumeResult> {
  const start = windowStart(windowMs, now);
  const bucket = `rl:${key}:${start}`;
  const resetAt = start + windowMs;
  try {
    const hits = await increment(bucket, new Date(resetAt));
    void sweepOccasionally(now);
    return { allowed: hits <= max, limit: max, remaining: Math.max(0, max - hits), resetAt };
  } catch {
    // Fail open: this bounds cost, and must not become a dependency that can take the product down.
    return { allowed: true, limit: max, remaining: max, resetAt };
  }
}

/**
 * Count one call against today's ceiling for `route`.
 *
 * Unlike `consume`, a failure here returns FALSE. This is the only thing standing between a bad
 * day and an unbounded provider bill, so if it cannot be evaluated the answer is no.
 */
export async function withinDailyBudget(
  route: string,
  max: number,
  now = Date.now(),
): Promise<boolean> {
  const day = new Date(now).toISOString().slice(0, 10);
  const bucket = `budget:${route}:${day}`;
  // Expire a day after the window closes, so a row survives long enough to be inspected.
  const expiresAt = new Date(windowStart(86_400_000, now) + 2 * 86_400_000);
  const hits = await increment(bucket, expiresAt);
  return hits <= max;
}

/** Atomic increment-and-read. The RETURNING value is this caller's position in the window. */
async function increment(bucket: string, expiresAt: Date): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO rate_counter (bucket, hits, expires_at)
         VALUES (${bucket}, 1, ${expiresAt.toISOString()})
    ON CONFLICT (bucket)
      DO UPDATE SET hits = rate_counter.hits + 1
      RETURNING hits`);
  return Number((result.rows[0] as { hits: number }).hits);
}

/** Delete closed windows. Cheap, indexed by primary key, and no scheduler to own. */
async function sweepOccasionally(now: number): Promise<void> {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  try {
    await db.execute(sql`DELETE FROM rate_counter WHERE expires_at < now()`);
  } catch {
    // A failed sweep costs disk, not correctness.
  }
}

/** Test seam: forget when the last sweep ran. */
export function resetSweepClock(): void {
  lastSweep = 0;
}
