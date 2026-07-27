import { sql } from 'drizzle-orm';
import { db } from '../db/client';

export type BillingStatus = 'pending' | 'active' | 'on_hold' | 'cancelled' | 'expired' | 'failed';

export interface DodoSubscriptionState {
  status: BillingStatus;
  subscriptionId?: string | null;
  customerId?: string | null;
  productId?: string | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  occurredAt: Date;
}

type SqlExecutor = Pick<typeof db, 'execute'>;

/**
 * Dodo keeps a scheduled cancellation `active` until the paid period ends. A fully `cancelled`
 * subscription has already ended and must be Free. On-hold gets Kairo's three-day dunning grace.
 */
export function isProNow(status: string, currentPeriodEnd: Date | null, now = Date.now()): boolean {
  if (status === 'active') return true;
  if (status !== 'on_hold' || !currentPeriodEnd) return false;
  return now < currentPeriodEnd.getTime() + 3 * 24 * 3600 * 1000;
}

async function applyDodoStateWith(
  executor: SqlExecutor,
  userId: string,
  state: DodoSubscriptionState,
): Promise<'applied' | 'stale'> {
  const cur = await executor.execute(sql`SELECT last_event_at FROM subscription WHERE user_id = ${userId}`);
  const last = (cur.rows[0] as { last_event_at: string | null } | undefined)?.last_event_at;
  if (last && new Date(last).getTime() > state.occurredAt.getTime()) return 'stale';

  await executor.execute(sql`
    INSERT INTO subscription (user_id, status, dodo_subscription_id, dodo_customer_id, dodo_product_id,
                              current_period_end, cancel_at_period_end, last_event_at, updated_at)
    VALUES (${userId}, ${state.status}, ${state.subscriptionId ?? null}, ${state.customerId ?? null},
            ${state.productId ?? null}, ${state.currentPeriodEnd ?? null},
            ${state.cancelAtPeriodEnd ?? false}, ${state.occurredAt}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      status = EXCLUDED.status,
      dodo_subscription_id = COALESCE(EXCLUDED.dodo_subscription_id, subscription.dodo_subscription_id),
      dodo_customer_id = COALESCE(EXCLUDED.dodo_customer_id, subscription.dodo_customer_id),
      dodo_product_id = COALESCE(EXCLUDED.dodo_product_id, subscription.dodo_product_id),
      current_period_end = COALESCE(EXCLUDED.current_period_end, subscription.current_period_end),
      cancel_at_period_end = EXCLUDED.cancel_at_period_end,
      last_event_at = EXCLUDED.last_event_at,
      updated_at = now()`);

  const pro = isProNow(state.status, state.currentPeriodEnd ?? null);
  await executor.execute(
    sql`UPDATE usage_counter SET plan = ${pro ? 'pro' : 'free'}, updated_at = now() WHERE user_id = ${userId}`,
  );
  return 'applied';
}

/** Apply a provider snapshot outside a webhook (for explicit reconciliation). */
export async function applyDodoState(userId: string, state: DodoSubscriptionState): Promise<void> {
  await db.transaction(async (tx) => {
    await applyDodoStateWith(tx, userId, state);
  });
}

/**
 * Record a webhook and apply its entitlement in one transaction. If applying state fails, the
 * idempotency row rolls back too, so Dodo's retry can safely process the event again.
 */
export async function applyWebhookState(
  webhookId: string,
  type: string,
  payload: unknown,
  userId: string,
  state: DodoSubscriptionState,
): Promise<'applied' | 'stale' | 'duplicate'> {
  return db.transaction(async (tx) => {
    const inserted = await tx.execute(sql`
      INSERT INTO webhook_event (webhook_id, type, payload)
      VALUES (${webhookId}, ${type}, ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (webhook_id) DO NOTHING RETURNING webhook_id`);
    if (inserted.rows.length === 0) return 'duplicate';
    return applyDodoStateWith(tx, userId, state);
  });
}

/** Record a verified webhook that intentionally requires no entitlement update. */
export async function recordWebhook(webhookId: string, type: string, payload: unknown): Promise<boolean> {
  const r = await db.execute(sql`
    INSERT INTO webhook_event (webhook_id, type, payload)
    VALUES (${webhookId}, ${type}, ${JSON.stringify(payload)}::jsonb)
    ON CONFLICT (webhook_id) DO NOTHING RETURNING webhook_id`);
  return r.rows.length > 0;
}

export async function userIdByCustomer(customerId?: string | null): Promise<string | null> {
  if (!customerId) return null;
  const r = await db.execute(sql`SELECT user_id FROM subscription WHERE dodo_customer_id = ${customerId} LIMIT 1`);
  return r.rows.length ? (r.rows[0] as { user_id: string }).user_id : null;
}

/**
 * Resolve webhook attribution in one database round-trip, in trust order. Metadata is accepted
 * only when that user exists in this database; this prevents another Kairo backend's user id from
 * ever reaching the subscription foreign key.
 */
export async function resolveWebhookUser(
  metadataUserId?: string | null,
  sessionId?: string | null,
  customerId?: string | null,
): Promise<{
  userId: string | null;
  metadataUserExists: boolean;
  source: 'metadata' | 'session' | 'customer' | null;
}> {
  const r = await db.execute(sql`
    WITH candidates AS (
      SELECT 1 AS priority, id AS user_id, true AS metadata_user
        FROM "user" WHERE id = ${metadataUserId ?? null}
      UNION ALL
      SELECT 2, c.user_id, false
        FROM checkout_session_map c
        JOIN "user" u ON u.id = c.user_id
       WHERE c.session_id = ${sessionId ?? null}
      UNION ALL
      SELECT 3, s.user_id, false
        FROM subscription s
        JOIN "user" u ON u.id = s.user_id
       WHERE s.dodo_customer_id = ${customerId ?? null}
    )
    SELECT user_id, metadata_user, priority FROM candidates ORDER BY priority LIMIT 1`);
  const row = r.rows[0] as { user_id: string; metadata_user: boolean; priority: number } | undefined;
  return {
    userId: row?.user_id ?? null,
    metadataUserExists: row?.metadata_user ?? false,
    source: row?.priority === 1 ? 'metadata' : row?.priority === 2 ? 'session' : row?.priority === 3 ? 'customer' : null,
  };
}

/** Recover a legacy/missed-webhook customer mapping without trusting a fuzzy email match. */
export function customerIdForEmail(
  customers: Array<{ customer_id: string; email: string }>,
  email: string,
): string | null {
  const wanted = email.trim().toLowerCase();
  return customers.find((customer) => customer.email.trim().toLowerCase() === wanted)?.customer_id ?? null;
}

export async function rememberDodoCustomer(userId: string, customerId: string): Promise<void> {
  await db.execute(sql`
    UPDATE subscription
       SET dodo_customer_id = ${customerId}, updated_at = now()
     WHERE user_id = ${userId}`);
}

/** Store checkout-session attribution before the desktop opens Dodo's hosted page. */
export async function rememberCheckoutSession(sessionId: string, userId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO checkout_session_map (session_id, user_id) VALUES (${sessionId}, ${userId})
    ON CONFLICT (session_id) DO NOTHING`);
}

export async function userFromCheckoutSession(sessionId?: string | null): Promise<string | null> {
  if (!sessionId) return null;
  const r = await db.execute(sql`SELECT user_id FROM checkout_session_map WHERE session_id = ${sessionId} LIMIT 1`);
  return r.rows.length ? (r.rows[0] as { user_id: string }).user_id : null;
}
