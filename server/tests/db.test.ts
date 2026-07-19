import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../src/db/client';

afterAll(() => pool.end());

describe('db', () => {
  it('connects and sees the migrated usage_counter table', async () => {
    const r = await pool.query("SELECT to_regclass('public.usage_counter') AS t");
    expect(r.rows[0].t).toBe('usage_counter');
  });
});
