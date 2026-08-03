import { sql } from 'drizzle-orm';
import { db } from '../db/client';

/**
 * How long to wait before asking Dodo again for the same user on the paywall path.
 *
 * The population that lands here repeatedly is exactly the one that must NOT cost us provider
 * calls: someone genuinely out of free requests who keeps trying. One lookup per user per window
 * is enough to heal a missed webhook quickly without turning a blocked user into API load.
 */
export const RECONCILE_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Claim the right to reconcile this user now, atomically.
 *
 * The UPDATE is the lock: only the statement that actually moves `last_reconcile_at` returns a
 * row, so concurrent blocked requests produce exactly one Dodo call between them rather than one
 * each. `now()` is the database clock, so this holds across processes too.
 */
export async function claimReconcileSlot(
  userId: string,
  cooldownMs = RECONCILE_COOLDOWN_MS,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE subscription
       SET last_reconcile_at = now()
     WHERE user_id = ${userId}
       AND (last_reconcile_at IS NULL
            OR last_reconcile_at < now() - ${`${Math.floor(cooldownMs / 1000)} seconds`}::interval)
    RETURNING user_id`);
  return result.rows.length > 0;
}
