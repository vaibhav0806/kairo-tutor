import { sql } from 'drizzle-orm';
import { db } from '../db/client';

export type DodoEventType =
  | 'subscription.active'
  | 'subscription.renewed'
  | 'subscription.plan_changed'
  | 'subscription.on_hold'
  | 'subscription.cancelled'
  | 'subscription.expired'
  | 'subscription.failed';

export interface DodoLifecycle {
  type: DodoEventType;
  subscriptionId?: string;
  customerId?: string;
  productId?: string;
  currentPeriodEnd?: Date | null;
  occurredAt: Date;
}

type SubStatus = 'active' | 'on_hold' | 'cancelled' | 'expired' | 'failed';

function statusFor(type: DodoEventType): SubStatus {
  switch (type) {
    case 'subscription.active':
    case 'subscription.renewed':
    case 'subscription.plan_changed':
      return 'active';
    case 'subscription.on_hold':
      return 'on_hold';
    case 'subscription.cancelled':
      return 'cancelled';
    case 'subscription.expired':
      return 'expired';
    case 'subscription.failed':
      return 'failed';
  }
}

/**
 * The single entitlement resolver. Cancelled users keep Pro until the period ends; on_hold gets a
 * 3-day dunning grace. Both the webhook sync and reconciliation agree via this function.
 */
export function isProNow(status: string, currentPeriodEnd: Date | null): boolean {
  if (status === 'active') return true;
  if (!currentPeriodEnd) return false;
  const now = Date.now();
  if (status === 'cancelled') return now < currentPeriodEnd.getTime();
  if (status === 'on_hold') return now < currentPeriodEnd.getTime() + 3 * 24 * 3600 * 1000;
  return false;
}

/**
 * Apply a Dodo lifecycle event: upsert the subscription row and set the denormalized
 * `usage_counter.plan` the metering hot path reads. Out-of-order events are ignored.
 */
export async function applyDodoState(userId: string, ev: DodoLifecycle): Promise<void> {
  const status = statusFor(ev.type);
  await db.transaction(async (tx) => {
    const cur = await tx.execute(sql`SELECT last_event_at FROM subscription WHERE user_id = ${userId}`);
    const last = (cur.rows[0] as { last_event_at: string | null } | undefined)?.last_event_at;
    if (last && new Date(last).getTime() > ev.occurredAt.getTime()) return; // stale event, skip

    await tx.execute(sql`
      INSERT INTO subscription (user_id, status, dodo_subscription_id, dodo_customer_id, dodo_product_id,
                                current_period_end, cancel_at_period_end, last_event_at, updated_at)
      VALUES (${userId}, ${status}, ${ev.subscriptionId ?? null}, ${ev.customerId ?? null},
              ${ev.productId ?? null}, ${ev.currentPeriodEnd ?? null}, ${status === 'cancelled'},
              ${ev.occurredAt}, now())
      ON CONFLICT (user_id) DO UPDATE SET
        status = EXCLUDED.status,
        dodo_subscription_id = COALESCE(EXCLUDED.dodo_subscription_id, subscription.dodo_subscription_id),
        dodo_customer_id = COALESCE(EXCLUDED.dodo_customer_id, subscription.dodo_customer_id),
        dodo_product_id = COALESCE(EXCLUDED.dodo_product_id, subscription.dodo_product_id),
        current_period_end = EXCLUDED.current_period_end,
        cancel_at_period_end = EXCLUDED.cancel_at_period_end,
        last_event_at = EXCLUDED.last_event_at,
        updated_at = now()`);

    const pro = isProNow(status, ev.currentPeriodEnd ?? null);
    await tx.execute(
      sql`UPDATE usage_counter SET plan = ${pro ? 'pro' : 'free'}, updated_at = now() WHERE user_id = ${userId}`,
    );
  });
}

/** Idempotency: record a webhook id. Returns false if it was already processed. */
export async function recordWebhook(webhookId: string, type: string, payload: unknown): Promise<boolean> {
  const r = await db.execute(sql`
    INSERT INTO webhook_event (webhook_id, type, payload)
    VALUES (${webhookId}, ${type}, ${JSON.stringify(payload)}::jsonb)
    ON CONFLICT (webhook_id) DO NOTHING RETURNING webhook_id`);
  return r.rows.length > 0;
}

export async function userIdByCustomer(customerId?: string): Promise<string | null> {
  if (!customerId) return null;
  const r = await db.execute(sql`SELECT user_id FROM subscription WHERE dodo_customer_id = ${customerId} LIMIT 1`);
  return r.rows.length ? (r.rows[0] as { user_id: string }).user_id : null;
}
