import { sql } from 'drizzle-orm';
import { db } from '../db/client';

/**
 * Closed-alpha access control.
 *
 * The gate sits at session-issue time (OAuth callback + code exchange), not on the request hot
 * path: an uninvited person can complete Google sign-in, but never receives a session token, so
 * they can make no authenticated call. That keeps the per-request cost at zero and means the
 * "you're not in yet" message lands in the browser where they can actually read it.
 *
 * Note this is not retroactive — sessions issued before an email is removed stay valid until they
 * expire. Revoking someone immediately means deleting their session rows too.
 */

/** Google returns whatever casing the user typed; invites are matched case-insensitively. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function isInvited(email: string | null | undefined): Promise<boolean> {
  const normalized = normalizeEmail(email ?? '');
  if (!normalized) return false;
  const rows = await db.execute(
    sql`SELECT 1 FROM access_invite WHERE email = ${normalized} LIMIT 1`,
  );
  return rows.rows.length > 0;
}

/** Stamp first use, so the invite list doubles as "who actually showed up". */
export async function markRedeemed(email: string): Promise<void> {
  await db.execute(
    sql`UPDATE access_invite SET redeemed_at = now()
        WHERE email = ${normalizeEmail(email)} AND redeemed_at IS NULL`,
  );
}

/** Add invites. Returns how many rows were new (re-inviting someone is a no-op, not an error). */
export async function addInvites(emails: string[], note?: string): Promise<number> {
  const normalized = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  if (normalized.length === 0) return 0;

  let added = 0;
  for (const email of normalized) {
    const result = await db.execute(
      sql`INSERT INTO access_invite (email, note) VALUES (${email}, ${note ?? null})
          ON CONFLICT (email) DO NOTHING RETURNING email`,
    );
    added += result.rows.length;
  }
  return added;
}

export async function removeInvite(email: string): Promise<boolean> {
  const result = await db.execute(
    sql`DELETE FROM access_invite WHERE email = ${normalizeEmail(email)} RETURNING email`,
  );
  return result.rows.length > 0;
}

export async function listInvites(): Promise<
  Array<{ email: string; note: string | null; invited_at: string; redeemed_at: string | null }>
> {
  const rows = await db.execute(
    sql`SELECT email, note, invited_at, redeemed_at FROM access_invite ORDER BY invited_at DESC`,
  );
  return rows.rows as Array<{
    email: string;
    note: string | null;
    invited_at: string;
    redeemed_at: string | null;
  }>;
}
