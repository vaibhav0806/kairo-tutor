import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Webhook } from 'standardwebhooks';
import { sql } from 'drizzle-orm';
import { buildApp } from '../src/app';
import { db, pool } from '../src/db/client';
import { dodoProductId, dodoWebhookSecret } from '../src/config/env';
import { ensureUserRows } from '../src/usage/service';

const uid = 'test-user-billing-webhook';
const webhookIds: string[] = [];
const app = await buildApp();

async function sendSigned(type: string, data: Record<string, unknown>, occurredAt: Date, id: string) {
  if (!dodoWebhookSecret) throw new Error('test webhook secret is required');
  const payload = JSON.stringify({ business_id: 'biz_test', type, timestamp: occurredAt.toISOString(), data });
  const deliveredAt = new Date();
  const signature = new Webhook(dodoWebhookSecret).sign(id, deliveredAt, payload);
  webhookIds.push(id);
  return app.inject({
    method: 'POST',
    url: '/webhooks/dodo',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(Math.floor(deliveredAt.getTime() / 1000)),
      'webhook-signature': signature,
    },
    payload,
  });
}

async function billingState() {
  const result = await db.execute(sql`
    SELECT uc.plan, s.status, s.cancel_at_period_end
      FROM usage_counter uc JOIN subscription s ON s.user_id = uc.user_id
     WHERE uc.user_id = ${uid}`);
  return result.rows[0] as { plan: string; status: string; cancel_at_period_end: boolean };
}

beforeAll(async () => {
  await db.execute(sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES (${uid}, 'Webhook', 'billing-webhook@t.dev', true, now(), now()) ON CONFLICT (id) DO NOTHING`);
  await ensureUserRows(uid);
});

afterAll(async () => {
  if (webhookIds.length) {
    await db.execute(sql`DELETE FROM webhook_event WHERE webhook_id IN (${sql.join(webhookIds.map((id) => sql`${id}`), sql`, `)})`);
  }
  await db.execute(sql`DELETE FROM checkout_session_map WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM subscription WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM usage_counter WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM "user" WHERE id = ${uid}`);
  await app.close();
  await pool.end();
});

describe('signed Dodo subscription lifecycle', () => {
  it('activates, schedules cancellation, deduplicates, then revokes on final cancellation', async () => {
    const base = Date.now() - 10_000;
    const common = {
      metadata: { user_id: uid },
      subscription_id: 'sub_webhook_test',
      customer: { customer_id: 'cus_webhook_test' },
      product_id: dodoProductId,
      next_billing_date: new Date(base + 86_400_000).toISOString(),
    };

    const active = await sendSigned(
      'subscription.active',
      { ...common, status: 'active', cancel_at_next_billing_date: false },
      new Date(base),
      `wh_active_${Date.now()}`,
    );
    expect(active.statusCode).toBe(200);
    expect(await billingState()).toMatchObject({ plan: 'pro', status: 'active', cancel_at_period_end: false });

    const updatedId = `wh_updated_${Date.now()}`;
    const updated = await sendSigned(
      'subscription.updated',
      { ...common, status: 'active', cancel_at_next_billing_date: true },
      new Date(base + 1000),
      updatedId,
    );
    expect(updated.statusCode).toBe(200);
    expect(await billingState()).toMatchObject({ plan: 'pro', status: 'active', cancel_at_period_end: true });

    const duplicate = await sendSigned(
      'subscription.updated',
      { ...common, status: 'active', cancel_at_next_billing_date: true },
      new Date(base + 1000),
      updatedId,
    );
    expect(duplicate.json().duplicate).toBe(true);

    const cancelled = await sendSigned(
      'subscription.cancelled',
      { ...common, status: 'cancelled', cancel_at_next_billing_date: false },
      new Date(base + 2000),
      `wh_cancelled_${Date.now()}`,
    );
    expect(cancelled.statusCode).toBe(200);
    expect(await billingState()).toMatchObject({ plan: 'free', status: 'cancelled', cancel_at_period_end: false });
  });

  it('rejects unsigned payloads, retries an unmapped event, and ignores foreign user metadata', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/webhooks/dodo',
      headers: {
        'content-type': 'application/json',
        'webhook-id': 'wh_bad',
        'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
        'webhook-signature': 'v1,bad',
      },
      payload: JSON.stringify({ type: 'subscription.active', data: {} }),
    });
    expect(bad.statusCode).toBe(400);

    const unmappedId = `wh_unmapped_${Date.now()}`;
    const unmapped = await sendSigned(
      'subscription.active',
      { status: 'active', subscription_id: 'sub_unknown', customer: { customer_id: 'cus_unknown' } },
      new Date(),
      unmappedId,
    );
    expect(unmapped.statusCode).toBe(503);
    const stored = await db.execute(sql`SELECT webhook_id FROM webhook_event WHERE webhook_id = ${unmappedId}`);
    expect(stored.rows).toHaveLength(0);

    const foreignId = `wh_foreign_${Date.now()}`;
    const foreign = await sendSigned(
      'subscription.active',
      {
        status: 'active',
        subscription_id: 'sub_foreign',
        metadata: { user_id: 'user-from-another-kairo-database' },
        customer: { customer_id: 'cus_foreign' },
      },
      new Date(),
      foreignId,
    );
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json()).toMatchObject({ ok: true, ignored: true });
  });

  it('serves a public HTTPS-to-deep-link return bridge', async () => {
    const response = await app.inject({ method: 'GET', url: '/billing/return?status=failed&email=not-rendered@example.com' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('kairo://billing-done?status=failed');
    expect(response.body).toContain('That payment didn’t go through.');
    expect(response.body).not.toContain('not-rendered@example.com');
    expect(response.body).toContain('history.replaceState(null,"","/billing/return")');
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
