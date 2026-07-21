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
