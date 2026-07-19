import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';

const TTL_MS = 60_000; // one-time codes are short-lived

export async function mintCode(userId: string): Promise<string> {
  const code = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TTL_MS);
  await db.execute(sql`INSERT INTO oauth_code (code, user_id, expires_at) VALUES (${code}, ${userId}, ${expiresAt})`);
  return code;
}

/** Validate + burn in one atomic statement. Returns the userId, or null if invalid/expired/used. */
export async function redeemCode(code: string): Promise<string | null> {
  const r = await db.execute(sql`
    UPDATE oauth_code SET used = true
    WHERE code = ${code} AND used = false AND expires_at > now()
    RETURNING user_id`);
  return r.rows.length ? (r.rows[0] as { user_id: string }).user_id : null;
}
