import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/client';
import { isProNow, RENEWAL_GRACE_MS } from '../src/billing/service';
import { isEntitledToPro, isPaywalled, reserve } from '../src/usage/service';

const DAY = 24 * 3600 * 1000;
const future = () => new Date(Date.now() + 30 * DAY);
const past = (days = 1) => new Date(Date.now() - days * DAY);
const created: string[] = [];

async function makeUser(usedFree = 0): Promise<string> {
  const id = `ent-${randomUUID()}`;
  created.push(id);
  await db.execute(sql`
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES (${id}, 'Lifecycle', ${`${id}@example.invalid`}, true, now(), now())`);
  await db.execute(sql`
    INSERT INTO usage_counter (user_id, plan, used_free, free_limit)
    VALUES (${id}, 'free', ${usedFree}, 10)`);
  await db.execute(sql`INSERT INTO subscription (user_id) VALUES (${id})`);
  await db.execute(sql`
    INSERT INTO profile (user_id, display_name, onboarding_completed_at)
    VALUES (${id}, 'Lifecycle', now())`);
  return id;
}

async function setSubscription(
  userId: string,
  status: string,
  periodEnd: Date | null,
  cancelAtPeriodEnd = false,
) {
  await db.execute(sql`
    UPDATE subscription SET status = ${status}, current_period_end = ${periodEnd},
                            cancel_at_period_end = ${cancelAtPeriodEnd}
     WHERE user_id = ${userId}`);
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

describe('isProNow · entitlement expires with time, not with messages', () => {
  it('keeps a renewing subscription through a late renewal webhook', () => {
    // The webhook can lag the renewal; cutting a paying customer off for that is unacceptable.
    expect(isProNow({ status: 'active', currentPeriodEnd: past(1) })).toBe(true);
    expect(isProNow({ status: 'active', currentPeriodEnd: past(2) })).toBe(true);
  });

  it('eventually drops a renewing subscription that never renewed', () => {
    expect(isProNow({ status: 'active', currentPeriodEnd: past(4) })).toBe(false);
  });

  it('ends a CANCELLED subscription exactly at the period end, with no grace', () => {
    // The end date is the promise made to the user. Grace here would grant time nobody agreed to.
    const ending = { status: 'active', currentPeriodEnd: past(0.001), cancelAtPeriodEnd: true };
    expect(isProNow(ending)).toBe(false);
    expect(isProNow({ ...ending, currentPeriodEnd: future() })).toBe(true);
  });

  it('gives dunning a grace window and then stops', () => {
    expect(isProNow({ status: 'on_hold', currentPeriodEnd: past(1) })).toBe(true);
    expect(isProNow({ status: 'on_hold', currentPeriodEnd: past(4) })).toBe(false);
  });

  it('never entitles a status that was never paid for', () => {
    for (const status of ['pending', 'failed', 'cancelled', 'expired', 'none']) {
      expect(isProNow({ status, currentPeriodEnd: future() })).toBe(false);
    }
  });

  it('trusts an active status that has no period recorded yet', () => {
    expect(isProNow({ status: 'active', currentPeriodEnd: null })).toBe(true);
  });

  it('keeps the grace window long enough to survive a delayed webhook', () => {
    expect(RENEWAL_GRACE_MS).toBeGreaterThanOrEqual(DAY);
  });
});

describe('the cancellation the user actually reported', () => {
  it('serves Pro until the period ends, then falls back to free turns WITHOUT a webhook', async () => {
    const userId = await makeUser(5);
    await setSubscription(userId, 'active', future(), true); // cancelled, period still running

    expect(await isEntitledToPro(userId)).toBe(true);
    expect(await isPaywalled(userId)).toBe(false);

    // Time passes. NOTHING else happens — no webhook, no sync, no restart.
    await setSubscription(userId, 'active', past(1), true);

    // This is the whole fix: entitlement lapses because the date passed.
    expect(await isEntitledToPro(userId)).toBe(false);
    // 5 of 10 used, so they are NOT paywalled — they have their remaining 5 turns back.
    expect(await isPaywalled(userId)).toBe(false);
    expect(await usedFree(userId)).toBe(5);
  });

  it('leaves the free counter untouched while Pro, so cancelling restores what was left', async () => {
    const userId = await makeUser(5);
    await setSubscription(userId, 'active', future());

    for (let i = 0; i < 9; i++) {
      await expect(reserve(userId, randomUUID())).resolves.toBe(true);
    }

    // Pro is unmetered: nine Pro turns must not have spent nine free credits.
    expect(await usedFree(userId)).toBe(5);

    await setSubscription(userId, 'active', past(1), true);
    expect(await isPaywalled(userId)).toBe(false); // 5 of 10 remain
  });

  it('paywalls a lapsed subscriber who had already spent their free turns', async () => {
    const userId = await makeUser(10);
    await setSubscription(userId, 'active', past(1), true);

    expect(await isPaywalled(userId)).toBe(true);
  });

  it('still meters a free user normally', async () => {
    const userId = await makeUser(9);

    await expect(reserve(userId, randomUUID())).resolves.toBe(true);
    expect(await usedFree(userId)).toBe(10);
    await expect(reserve(userId, randomUUID())).resolves.toBe(false);
    expect(await isPaywalled(userId)).toBe(true);
  });

  it('counts a replayed ask once, however it is billed', async () => {
    const userId = await makeUser(0);
    const askId = randomUUID();

    await reserve(userId, askId);
    await reserve(userId, askId);

    expect(await usedFree(userId)).toBe(1);
  });

  it('ignores a stale plan column entirely', async () => {
    // The loophole this closes: `plan` is a cache written by webhooks. If it were the authority,
    // a webhook that never arrived would serve Pro forever.
    const userId = await makeUser(10);
    await db.execute(sql`UPDATE usage_counter SET plan = 'pro' WHERE user_id = ${userId}`);
    await setSubscription(userId, 'cancelled', past(30));

    expect(await isEntitledToPro(userId)).toBe(false);
    expect(await isPaywalled(userId)).toBe(true);
  });
});
