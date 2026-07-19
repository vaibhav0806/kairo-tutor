import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client';
import { ensureUserRows, reserve, refund } from '../src/usage/service';

const uid = 'test-user-metering';

beforeAll(async () => {
  await db.execute(sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES (${uid}, 'Mt', 'mt@t.dev', true, now(), now()) ON CONFLICT (id) DO NOTHING`);
  await db.execute(sql`DELETE FROM usage_event WHERE user_id = ${uid}`);
  await ensureUserRows(uid);
  await db.execute(sql`UPDATE usage_counter SET used_free = 0, plan = 'free', free_limit = 3 WHERE user_id = ${uid}`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM usage_event WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM usage_counter WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM subscription WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM "user" WHERE id = ${uid}`);
  await pool.end();
});

describe('metering (atomic reserve/refund)', () => {
  it('allows up to the limit, blocks after, is idempotent per askId, and refund frees a slot', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();
    const d = randomUUID();

    expect(await reserve(uid, a)).toBe(true);
    expect(await reserve(uid, a)).toBe(true); // replay of the same ask -> allowed, not double-counted
    expect(await reserve(uid, b)).toBe(true);
    expect(await reserve(uid, c)).toBe(true);
    expect(await reserve(uid, d)).toBe(false); // free_limit (3) reached

    await refund(uid, c);
    expect(await reserve(uid, randomUUID())).toBe(true); // slot freed by the refund
  });
});
