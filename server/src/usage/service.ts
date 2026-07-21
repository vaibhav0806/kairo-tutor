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

// Cap on onboarding "tutorial" vision turns (separate from the 10 free). The onboarding demo
// makes ~2 vision calls; this leaves headroom for retries but bounds the tutorial so it can't
// be looped for unlimited free vision.
export const ONBOARDING_VISION_CAP = 6;

/** True while the user is still in onboarding (no profile row yet, or completed_at unset). */
export async function isOnboarding(userId: string): Promise<boolean> {
  const r = await db.execute(
    sql`SELECT onboarding_completed_at FROM profile WHERE user_id = ${userId}`,
  );
  const row = r.rows[0] as { onboarding_completed_at?: unknown } | undefined;
  return !row || row.onboarding_completed_at == null;
}

/**
 * Fast paywall check (no reserve): true when the user is out of their CURRENT budget and not
 * pro — the tutorial cap while onboarding, else the 10-free limit. A missing counter row reads
 * as NOT paywalled so a setup hiccup never blocks a legit user; the atomic reserves on the
 * vision route are the real ceilings regardless.
 */
export async function isPaywalled(userId: string): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT uc.plan, uc.used_free, uc.free_limit, uc.onboarding_used,
           (p.onboarding_completed_at IS NULL) AS onboarding
    FROM usage_counter uc
    LEFT JOIN profile p ON p.user_id = uc.user_id
    WHERE uc.user_id = ${userId}`);
  const row = r.rows[0] as
    | { plan: string; used_free: number; free_limit: number; onboarding_used: number; onboarding: boolean }
    | undefined;
  if (!row || row.plan === 'pro') return false;
  return row.onboarding
    ? Number(row.onboarding_used) >= ONBOARDING_VISION_CAP
    : Number(row.used_free) >= Number(row.free_limit);
}

/**
 * Atomic reserve for a tutorial (onboarding) vision turn: capped + NOT billed against the 10
 * free. Returns true if under the tutorial cap, false if the tutorial budget is spent.
 */
export async function reserveOnboarding(userId: string): Promise<boolean> {
  const r = await db.execute(
    sql`UPDATE usage_counter SET onboarding_used = onboarding_used + 1, updated_at = now()
        WHERE user_id = ${userId} AND onboarding_used < ${ONBOARDING_VISION_CAP}
        RETURNING onboarding_used`,
  );
  return r.rows.length > 0;
}

/** Compensating refund for a failed tutorial turn (never underflows). */
export async function refundOnboarding(userId: string) {
  await db.execute(
    sql`UPDATE usage_counter SET onboarding_used = GREATEST(onboarding_used - 1, 0) WHERE user_id = ${userId}`,
  );
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
  name: string | null;
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
    SELECT u.email, u.name, uc.plan, uc.used_free, uc.free_limit,
           s.status, s.current_period_end, s.cancel_at_period_end,
           p.onboarding_completed_at, p.display_name
    FROM usage_counter uc
    JOIN "user" u ON u.id = uc.user_id
    LEFT JOIN subscription s ON s.user_id = uc.user_id
    LEFT JOIN profile p ON p.user_id = uc.user_id
    WHERE uc.user_id = ${userId}`);
  return r.rows[0] as unknown as MeRow | undefined;
}
