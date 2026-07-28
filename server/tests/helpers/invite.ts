import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client';

/**
 * Test fixtures that exchange a code for a session must also be on the closed-alpha invite list —
 * `/auth/exchange` refuses anyone who is not, which is the whole point of the gate.
 */
export async function inviteTestEmail(email: string): Promise<void> {
  await db.execute(
    sql`INSERT INTO access_invite (email, note) VALUES (${email.toLowerCase()}, 'test fixture')
        ON CONFLICT (email) DO NOTHING`,
  );
}

export async function revokeTestEmail(email: string): Promise<void> {
  await db.execute(sql`DELETE FROM access_invite WHERE email = ${email.toLowerCase()}`);
}
