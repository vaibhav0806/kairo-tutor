#!/usr/bin/env node
// Simulate a Dodo webhook against the LOCAL backend (test mode) — no Dodo, no tunnel.
// Signs a subscription event with DODO_TEST_WEBHOOK_SECRET (the same secret the local server
// verifies with) and POSTs it to the local /webhooks/dodo, flipping a user's plan. Use this to
// test the paywall→upgrade→Pro loop locally after paying with a Dodo test card (which never
// reaches localhost). Requires the local server running: `npm run server:dev`.
//
//   node server/scripts/simulate-webhook.mjs                          # latest user → Pro (subscription.active)
//   node server/scripts/simulate-webhook.mjs --event subscription.cancelled
//   node server/scripts/simulate-webhook.mjs --user <user_id>
import { config } from 'dotenv';
import { Webhook } from 'standardwebhooks';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, '..', '.env') }); // always load server/.env

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const event = opt('--event') ?? 'subscription.active';
const url = process.env.SIM_URL ?? 'http://localhost:8787/webhooks/dodo';
const secret = process.env.DODO_TEST_WEBHOOK_SECRET;
if (!secret) { console.error('Set DODO_TEST_WEBHOOK_SECRET in server/.env first.'); process.exit(1); }

let userId = opt('--user');
if (!userId) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query('SELECT id, email FROM "user" ORDER BY created_at DESC LIMIT 1');
  await pool.end();
  if (!r.rows.length) { console.error('No users in the local DB — sign in first.'); process.exit(1); }
  userId = r.rows[0].id;
  console.log('using latest user:', userId, `(${r.rows[0].email})`);
}

const payload = {
  type: event,
  data: {
    metadata: { user_id: userId },
    subscription_id: 'sub_sim_' + Date.now(),
    customer_id: 'cus_sim_' + userId.slice(0, 8),
    product_id: process.env.DODO_KAIRO_PRODUCT_ID ?? 'pdt_sim',
    next_billing_date: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
  },
};
const body = JSON.stringify(payload);
const msgId = 'msg_sim_' + Date.now();
const ts = new Date();
const signature = new Webhook(secret).sign(msgId, ts, body);

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'webhook-id': msgId,
    'webhook-timestamp': String(Math.floor(ts.getTime() / 1000)),
    'webhook-signature': signature,
  },
  body,
});
console.log(`→ ${event} | HTTP ${res.status} | ${await res.text()}`);
