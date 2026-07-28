import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { env } from '../config/env';
import { normalizeEmail } from '../access/service';

/**
 * Email-gated download links.
 *
 * The DMG is NOT served from a public URL. A visitor gives an email, and only if that email is on
 * the invite list do they get a short-lived token that the download route accepts. Everyone else is
 * recorded as a request so there is one list to invite from later.
 *
 * The token is a plain HMAC rather than a DB row: it is single-purpose, expires in minutes, and
 * carries nothing secret, so a table would be state with no benefit.
 */

const TOKEN_TTL_MS = 15 * 60 * 1000;

function sign(payload: string): string {
  return createHmac('sha256', env.BETTER_AUTH_SECRET).update(payload).digest('base64url');
}

/** `<expiry>.<email-b64>.<hmac>` — self-contained and verifiable without a lookup. */
export function issueDownloadToken(email: string, now = Date.now()): string {
  const payload = `${now + TOKEN_TTL_MS}.${Buffer.from(normalizeEmail(email)).toString('base64url')}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyDownloadToken(token: string, now = Date.now()): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [expiry, encodedEmail, signature] = parts;

  const expected = sign(`${expiry}.${encodedEmail}`);
  const provided = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) return null;
  if (!Number.isFinite(Number(expiry)) || Number(expiry) < now) return null;

  return Buffer.from(encodedEmail, 'base64url').toString();
}

/**
 * Record who asked. Invited requests are logged too, so the list doubles as "who actually tried to
 * download", which is the number that matters during an alpha.
 */
export async function recordDownloadRequest(email: string, invited: boolean): Promise<void> {
  await db.execute(
    sql`INSERT INTO download_request (email, invited, requested_at)
        VALUES (${normalizeEmail(email)}, ${invited}, now())
        ON CONFLICT (email) DO UPDATE
          SET invited = EXCLUDED.invited,
              requested_at = now(),
              request_count = download_request.request_count + 1`,
  );
}

/** Loose shape check only — the invite list is the real gate, this just rejects obvious junk. */
export function looksLikeEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  return normalized.length >= 3 && normalized.length <= 254 && /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(normalized);
}
