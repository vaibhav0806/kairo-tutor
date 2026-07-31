import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/client';
import { claimReconcileSlot, RECONCILE_COOLDOWN_MS } from '../src/billing/entitlement';
import { isPaywalled } from '../src/usage/service';

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

afterEach(async () => {
  for (const id of created.splice(0)) {
    await db.execute(sql`DELETE FROM "user" WHERE id = ${id}`);
  }
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
    const pro = await makeUser('pro', 999);
    const fresh = await makeUser('free', 0);
    const spent = await makeUser('free', 10);

    expect(await isPaywalled(pro)).toBe(false);
    expect(await isPaywalled(fresh)).toBe(false);
    expect(await isPaywalled(spent)).toBe(true);
  });

  it('keeps the cooldown long enough to bound a blocked user’s retries', () => {
    expect(RECONCILE_COOLDOWN_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });
});
