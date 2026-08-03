import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/client';
import { saveDisplayName } from '../src/onboarding/service';
import { readMe } from '../src/usage/service';

const created: string[] = [];

async function makeUser(accountName: string): Promise<string> {
  const id = `name-${randomUUID()}`;
  created.push(id);
  await db.execute(sql`
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES (${id}, ${accountName}, ${`${id}@example.invalid`}, true, now(), now())`);
  await db.execute(sql`INSERT INTO usage_counter (user_id) VALUES (${id})`);
  return id;
}

afterEach(async () => {
  for (const id of created.splice(0)) {
    await db.execute(sql`DELETE FROM "user" WHERE id = ${id}`);
  }
});

describe('renaming yourself', () => {
  it('survives the next /v1/me read', async () => {
    const userId = await makeUser('Prasad Sankar');

    await saveDisplayName(userId, 'Prasad');

    // This is the exact path that used to clobber the rename: the desktop caches whatever
    // /v1/me returns, so if display_name were unchanged the old name would come straight back.
    const me = await readMe(userId);
    expect(me?.display_name).toBe('Prasad');
    expect(me?.name).toBe('Prasad Sankar');
  });

  it('creates the profile row when one does not exist yet', async () => {
    const userId = await makeUser('Prasad Sankar');

    await expect(saveDisplayName(userId, 'Prasad')).resolves.toBe('Prasad');
  });

  it('replaces an earlier override rather than stacking', async () => {
    const userId = await makeUser('Prasad Sankar');

    await saveDisplayName(userId, 'Prasad');
    await saveDisplayName(userId, 'PJ');

    expect((await readMe(userId))?.display_name).toBe('PJ');
  });

  it('clears back to the account name on an empty value', async () => {
    const userId = await makeUser('Prasad Sankar');
    await saveDisplayName(userId, 'Prasad');

    await expect(saveDisplayName(userId, '   ')).resolves.toBeNull();
    expect((await readMe(userId))?.display_name).toBeNull();
  });

  it('does not mark onboarding complete as a side effect of a rename', async () => {
    const userId = await makeUser('Prasad Sankar');

    await saveDisplayName(userId, 'Prasad');

    // saveProfile owns that stamp; a rename must not fabricate a finished onboarding.
    expect((await readMe(userId))?.onboarding_completed_at).toBeFalsy();
  });
});
