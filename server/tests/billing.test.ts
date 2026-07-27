import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client';
import { ensureUserRows } from '../src/usage/service';
import {
  applyDodoState,
  applyWebhookState,
  customerIdForEmail,
  isProNow,
  recordWebhook,
} from '../src/billing/service';

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
    expect(isProNow('active', future)).toBe(true); // includes scheduled cancellation
    expect(isProNow('cancelled', future)).toBe(false); // provider says fully ended
    expect(isProNow('cancelled', past)).toBe(false);
    expect(isProNow('on_hold', future)).toBe(true); // dunning grace
    expect(isProNow('on_hold', new Date(Date.now() - 4 * 86_400_000))).toBe(false);
    expect(isProNow('expired', future)).toBe(false);
  });
});

describe('applyDodoState', () => {
  it('activate -> pro, scheduled cancel -> pro, final cancel -> free; ignores stale events', async () => {
    const t1 = new Date(Date.now() - 3000);
    const t2 = new Date(Date.now() - 2000);
    const t3 = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 30 * 86_400_000);

    await applyDodoState(uid, {
      status: 'active',
      subscriptionId: 'sub_1',
      customerId: 'cus_1',
      currentPeriodEnd: future,
      occurredAt: t1,
    });
    expect(await planOf()).toBe('pro');
    expect(await statusOf()).toBe('active');

    await applyDodoState(uid, {
      status: 'active',
      currentPeriodEnd: future,
      cancelAtPeriodEnd: true,
      occurredAt: t2,
    });
    expect(await planOf()).toBe('pro');
    expect(await statusOf()).toBe('active');

    // A stale event (older than the last applied) must not overwrite newer state.
    await applyDodoState(uid, { status: 'on_hold', currentPeriodEnd: future, occurredAt: t1 });
    expect(await statusOf()).toBe('active');

    await applyDodoState(uid, { status: 'cancelled', currentPeriodEnd: future, occurredAt: t3 });
    expect(await planOf()).toBe('free');
    expect(await statusOf()).toBe('cancelled');
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

describe('transactional webhook idempotency', () => {
  it('rolls back the webhook id when entitlement application fails', async () => {
    const id = `wh_rollback_${Date.now()}`;
    await expect(
      applyWebhookState(id, 'subscription.active', { safe: true }, 'missing-user', {
        status: 'active',
        occurredAt: new Date(),
      }),
    ).rejects.toBeTruthy();

    expect(await recordWebhook(id, 'subscription.active', { retry: true })).toBe(true);
    await db.execute(sql`DELETE FROM webhook_event WHERE webhook_id = ${id}`);
  });
});

describe('customerIdForEmail', () => {
  it('recovers only an exact case-insensitive customer match', () => {
    const customers = [
      { customer_id: 'cus_wrong', email: 'someone@example.com' },
      { customer_id: 'cus_right', email: ' Founder@Example.com ' },
    ];
    expect(customerIdForEmail(customers, 'founder@example.com')).toBe('cus_right');
    expect(customerIdForEmail(customers, 'founder+other@example.com')).toBeNull();
  });
});
