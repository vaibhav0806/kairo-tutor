import { sql } from 'drizzle-orm';
import { db } from '../db/client';

/** Seed the two per-user rows on signup (called from the Better Auth after-create hook). */
export async function ensureUserRows(userId: string) {
  await db.execute(sql`INSERT INTO usage_counter (user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`);
  await db.execute(sql`INSERT INTO subscription (user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`);
}

/**
 * Atomic reserve: idempotent per `askId`, increments only while under the free limit (or pro).
 * Returns true if the ask is allowed, false if the free limit is reached.
 */
export async function reserve(userId: string, askId: string): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const dup = await tx.execute(
      sql`INSERT INTO usage_event (ask_id, user_id) VALUES (${askId}, ${userId})
          ON CONFLICT (ask_id) DO NOTHING RETURNING ask_id`,
    );
    if (dup.rows.length === 0) return true; // replay of an already-counted ask -> allow

    const upd = await tx.execute(
      sql`UPDATE usage_counter SET used_free = used_free + 1, updated_at = now()
          WHERE user_id = ${userId} AND (plan = 'pro' OR used_free < free_limit)
          RETURNING used_free`,
    );
    return upd.rows.length > 0;
  });
}

/** Compensating refund (failure path). Idempotent per `askId`, never underflows. */
export async function refund(userId: string, askId: string) {
  const r = await db.execute(
    sql`UPDATE usage_event SET counted = false WHERE ask_id = ${askId} AND counted = true RETURNING ask_id`,
  );
  if (r.rows.length === 0) return;
  await db.execute(
    sql`UPDATE usage_counter SET used_free = GREATEST(used_free - 1, 0) WHERE user_id = ${userId} AND plan <> 'pro'`,
  );
}

export interface MeRow {
  email: string;
  plan: 'free' | 'pro';
  used_free: number;
  free_limit: number;
  status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
  onboarding_completed_at: string | null;
  display_name: string | null;
}

export async function readMe(userId: string): Promise<MeRow | undefined> {
  const r = await db.execute(sql`
    SELECT u.email, uc.plan, uc.used_free, uc.free_limit,
           s.status, s.current_period_end, s.cancel_at_period_end,
           p.onboarding_completed_at, p.display_name
    FROM usage_counter uc
    JOIN "user" u ON u.id = uc.user_id
    LEFT JOIN subscription s ON s.user_id = uc.user_id
    LEFT JOIN profile p ON p.user_id = uc.user_id
    WHERE uc.user_id = ${userId}`);
  return r.rows[0] as unknown as MeRow | undefined;
}
