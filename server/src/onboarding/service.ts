import { sql } from 'drizzle-orm';
import { db } from '../db/client';

/** Save onboarding answers + mark the flow complete (waitlisted for now). */
export async function saveProfile(userId: string, displayName: string, source: string) {
  await db.execute(sql`
    INSERT INTO profile (user_id, display_name, source, waitlisted, onboarding_completed_at)
    VALUES (${userId}, ${displayName}, ${source}, true, now())
    ON CONFLICT (user_id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      source = EXCLUDED.source,
      onboarding_completed_at = now()`);
}
