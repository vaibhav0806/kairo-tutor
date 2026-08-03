import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/client';
import { claimReconcileSlot, RECONCILE_COOLDOWN_MS } from '../src/billing/entitlement';
import { hasLapsedProRecord, isPaywalled, refund, reserve } from '../src/usage/service';
import { RENEWAL_GRACE_MS } from '../src/billing/service';

const created: string[] = [];

async function makeUser(plan: 'free' | 'pro', usedFree: number): Promise<string> {
  const id = `ent-${randomUUID()}`;
  created.push(id);
  await db.execute(sql`
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES (${id}, 'Entitlement Test', ${`${id}@example.invalid`}, true, now(), now())`);
  await db.execute(sql`
    INSERT INTO usage_counter (user_id, plan, used_free, free_limit)
    VALUES (${id}, ${plan}, ${usedFree}, 10)`);
  await db.execute(sql`INSERT INTO subscription (user_id) VALUES (${id})`);
  // Out of onboarding, so the 10-free limit is the budget that applies.
  await db.execute(sql`
    INSERT INTO profile (user_id, display_name, onboarding_completed_at)
    VALUES (${id}, 'Entitlement Test', now())`);
  return id;
}

async function usedFree(userId: string): Promise<number> {
  const r = await db.execute(sql`SELECT used_free FROM usage_counter WHERE user_id = ${userId}`);
  return Number((r.rows[0] as { used_free: number }).used_free);
}

afterEach(async () => {
  for (const id of created.splice(0)) {
    await db.execute(sql`DELETE FROM "user" WHERE id = ${id}`);
  }
});

describe('lapse detection tracks the entitlement boundary', () => {
  const future = (ms: number) => new Date(Date.now() + ms);

  it('does not call a renewing subscription lapsed while its grace window is open', () => {
    // The period end has passed but `isProNow` still entitles this user, so treating the record as
    // lapsed would send every credit-gated request off to the provider for a working subscription.
    const inGrace = {
      status: 'active',
      currentPeriodEnd: future(-60_000),
      cancelAtPeriodEnd: false,
    };
    expect(hasLapsedProRecord(inGrace)).toBe(false);
  });

  it('calls it lapsed once the grace window has closed', () => {
    expect(
      hasLapsedProRecord({
        status: 'active',
        currentPeriodEnd: future(-RENEWAL_GRACE_MS - 60_000),
        cancelAtPeriodEnd: false,
      }),
    ).toBe(true);
  });

  it('gives a cancelled subscription no grace past its promised end date', () => {
    expect(
      hasLapsedProRecord({
        status: 'active',
        currentPeriodEnd: future(-60_000),
        cancelAtPeriodEnd: true,
      }),
    ).toBe(true);
  });
});

describe('refund mirrors what reserve charged', () => {
  it('neither charges nor credits a subscriber whose cached plan still reads free', async () => {
    // The webhook that would have flipped `usage_counter.plan` to 'pro' never landed, so the cache
    // and the subscription disagree. Entitlement comes from the subscription in both directions.
    const userId = await makeUser('free', 2);
    await db.execute(sql`
      UPDATE subscription
         SET status = 'active', current_period_end = now() + interval '30 days',
             cancel_at_period_end = false
       WHERE user_id = ${userId}`);

    const askId = randomUUID();
    expect(await reserve(userId, askId)).toBe(true);
    expect(await usedFree(userId)).toBe(2); // a Pro turn does not spend a free credit

    await refund(userId, askId);
    // Before the fix this handed back a credit that was never spent: the user's free balance grew
    // by one on every failed Pro turn, purely because the cache said 'free'.
    expect(await usedFree(userId)).toBe(2);
  });

  it('still refunds a genuinely free user', async () => {
    const userId = await makeUser('free', 0);
    const askId = randomUUID();

    expect(await reserve(userId, askId)).toBe(true);
    expect(await usedFree(userId)).toBe(1);

    await refund(userId, askId);
    expect(await usedFree(userId)).toBe(0);
  });
});

describe('paywall entitlement recovery', () => {
  it('claims the slot once, then refuses until the cooldown expires', async () => {
    const userId = await makeUser('free', 10);

    expect(await claimReconcileSlot(userId)).toBe(true);
    // The population that repeatedly hits the paywall is exactly the one that must not become
    // provider load, so the second attempt inside the window must not call out.
    expect(await claimReconcileSlot(userId)).toBe(false);
    expect(await claimReconcileSlot(userId)).toBe(false);
  });

  it('serialises concurrent blocked requests into a single provider call', async () => {
    const userId = await makeUser('free', 10);

    const claims = await Promise.all(
      Array.from({ length: 8 }, () => claimReconcileSlot(userId)),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('allows another attempt once the window has passed', async () => {
    const userId = await makeUser('free', 10);
    expect(await claimReconcileSlot(userId)).toBe(true);

    // Age the marker rather than sleeping through a real ten-minute window.
    await db.execute(sql`
      UPDATE subscription SET last_reconcile_at = now() - interval '11 minutes'
       WHERE user_id = ${userId}`);

    expect(await claimReconcileSlot(userId)).toBe(true);
  });

  it('treats a zero cooldown as always claimable', async () => {
    const userId = await makeUser('free', 10);

    expect(await claimReconcileSlot(userId, 0)).toBe(true);
    expect(await claimReconcileSlot(userId, 0)).toBe(true);
  });

  it('only reaches the recovery path for a user who is actually out of budget', async () => {
    // Entitlement comes from the SUBSCRIPTION, so a Pro user needs a live subscription — setting
    // usage_counter.plan alone grants nothing, which is the loophole that used to exist.
    const pro = await makeUser('pro', 999);
    await db.execute(sql`
      UPDATE subscription SET status = 'active', current_period_end = now() + interval '30 days'
       WHERE user_id = ${pro}`);
    const fresh = await makeUser('free', 0);
    const spent = await makeUser('free', 10);

    expect(await isPaywalled(pro)).toBe(false);
    expect(await isPaywalled(fresh)).toBe(false);
    expect(await isPaywalled(spent)).toBe(true);
  });

  it('a stale plan column alone never grants Pro', async () => {
    const stale = await makeUser('pro', 10); // cached plan says pro, no subscription backs it
    expect(await isPaywalled(stale)).toBe(true);
  });

  it('keeps the cooldown long enough to bound a blocked user’s retries', () => {
    expect(RECONCILE_COOLDOWN_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });
});
