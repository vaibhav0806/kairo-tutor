import { sql } from 'drizzle-orm';
import { db } from '../db/client';

/** Save onboarding answers + mark the flow complete (waitlisted for now). */
export async function saveProfile(
  userId: string,
  displayName: string,
  source: string,
  accent: string | null,
) {
  await db.execute(sql`
    INSERT INTO profile (user_id, display_name, source, accent, waitlisted, onboarding_completed_at)
    VALUES (${userId}, ${displayName}, ${source}, ${accent}, true, now())
    ON CONFLICT (user_id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      source = EXCLUDED.source,
      accent = COALESCE(EXCLUDED.accent, profile.accent),
      onboarding_completed_at = now()`);
}

/**
 * Rename an existing user. Kept separate from `saveProfile` so a rename cannot re-stamp
 * `onboarding_completed_at` or clear the onboarding answers.
 *
 * This has to reach the database: `display_name` is what `/v1/me` returns and what the desktop
 * caches, so a rename that only touched the local file was silently reverted by the next sync.
 * An empty name clears the override and falls back to the Google account name.
 */
export async function saveDisplayName(userId: string, displayName: string): Promise<string | null> {
  const next = displayName.trim() || null;
  await db.execute(sql`
    INSERT INTO profile (user_id, display_name)
    VALUES (${userId}, ${next})
    ON CONFLICT (user_id) DO UPDATE SET display_name = ${next}`);
  return next;
}
