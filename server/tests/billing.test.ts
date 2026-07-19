import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client';
import { ensureUserRows } from '../src/usage/service';
import { applyDodoState, isProNow, recordWebhook } from '../src/billing/service';

const uid = 'test-user-billing';

async function planOf(): Promise<string> {
  const r = await db.execute(sql`SELECT plan FROM usage_counter WHERE user_id = ${uid}`);
  return (r.rows[0] as { plan: string }).plan;
}
async function statusOf(): Promise<string> {
  const r = await db.execute(sql`SELECT status FROM subscription WHERE user_id = ${uid}`);
  return (r.rows[0] as { status: string }).status;
}

beforeAll(async () => {
  await db.execute(sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES (${uid}, 'Bl', 'bl@t.dev', true, now(), now()) ON CONFLICT (id) DO NOTHING`);
  await ensureUserRows(uid);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM subscription WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM usage_counter WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM "user" WHERE id = ${uid}`);
  await pool.end();
});

describe('isProNow', () => {
  it('resolves entitlement with grace windows', () => {
    const future = new Date(Date.now() + 86_400_000);
    const past = new Date(Date.now() - 86_400_000);
    expect(isProNow('active', null)).toBe(true);
    expect(isProNow('cancelled', future)).toBe(true); // paid through the period
    expect(isProNow('cancelled', past)).toBe(false);
    expect(isProNow('on_hold', future)).toBe(true); // dunning grace
    expect(isProNow('expired', future)).toBe(false);
  });
});

describe('applyDodoState', () => {
  it('activate -> pro, cancel(future) -> still pro, expire -> free; ignores stale events', async () => {
    const t1 = new Date(Date.now() - 3000);
    const t2 = new Date(Date.now() - 2000);
    const t3 = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 30 * 86_400_000);

    await applyDodoState(uid, {
      type: 'subscription.active',
      subscriptionId: 'sub_1',
      customerId: 'cus_1',
      currentPeriodEnd: future,
      occurredAt: t1,
    });
    expect(await planOf()).toBe('pro');
    expect(await statusOf()).toBe('active');

    await applyDodoState(uid, { type: 'subscription.cancelled', currentPeriodEnd: future, occurredAt: t2 });
    expect(await planOf()).toBe('pro');
    expect(await statusOf()).toBe('cancelled');

    // A stale event (older than the last applied) must not overwrite newer state.
    await applyDodoState(uid, { type: 'subscription.active', currentPeriodEnd: future, occurredAt: t1 });
    expect(await statusOf()).toBe('cancelled');

    await applyDodoState(uid, { type: 'subscription.expired', currentPeriodEnd: null, occurredAt: t3 });
    expect(await planOf()).toBe('free');
    expect(await statusOf()).toBe('expired');
  });
});

describe('recordWebhook idempotency', () => {
  it('accepts an id once then rejects the duplicate', async () => {
    const id = `wh_test_${Date.now()}`;
    expect(await recordWebhook(id, 'subscription.active', { a: 1 })).toBe(true);
    expect(await recordWebhook(id, 'subscription.active', { a: 1 })).toBe(false);
    await db.execute(sql`DELETE FROM webhook_event WHERE webhook_id = ${id}`);
  });
});
