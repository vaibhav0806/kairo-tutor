import { pgTable, text, integer, boolean, timestamp, jsonb, uuid, pgEnum } from 'drizzle-orm/pg-core';

export const planT = pgEnum('plan_t', ['free', 'pro']);
export const subStatusT = pgEnum('sub_status_t', [
  'none',
  'pending',
  'active',
  'on_hold',
  'cancelled',
  'failed',
  'expired',
]);

// `user_id` references the Better Auth `user` table (added in the auth schema). The FK is applied
// in a follow-up migration once that table exists — kept out of the Drizzle model here so this
// file stands alone.

/** Hot-path counter. "used N of limit" + a denormalized plan for the O(1) metering gate. */
export const usageCounter = pgTable('usage_counter', {
  userId: text('user_id').primaryKey(),
  plan: planT('plan').notNull().default('free'),
  usedFree: integer('used_free').notNull().default(0),
  freeLimit: integer('free_limit').notNull().default(10),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Idempotency + refund ledger. One row per ask attempt (keyed by the client-minted ask id). */
export const usageEvent = pgTable('usage_event', {
  askId: uuid('ask_id').primaryKey(),
  userId: text('user_id').notNull(),
  counted: boolean('counted').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Billing source of truth (one row per user, upserted by the Dodo webhook sync). */
export const subscription = pgTable('subscription', {
  userId: text('user_id').primaryKey(),
  status: subStatusT('status').notNull().default('none'),
  dodoSubscriptionId: text('dodo_subscription_id').unique(),
  dodoCustomerId: text('dodo_customer_id'),
  dodoProductId: text('dodo_product_id'),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  lastEventAt: timestamp('last_event_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Webhook idempotency store (dedupe on the Dodo `webhook-id` header). */
export const webhookEvent = pgTable('webhook_event', {
  webhookId: text('webhook_id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb('payload').notNull(),
});

/** One-time codes for the desktop `kairo://` deep-link handshake. */
export const oauthCode = pgTable('oauth_code', {
  code: text('code').primaryKey(),
  userId: text('user_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  used: boolean('used').notNull().default(false),
});
