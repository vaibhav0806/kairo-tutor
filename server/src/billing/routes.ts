import DodoPayments from 'dodopayments';
import type { Subscription, SubscriptionListResponse } from 'dodopayments/resources/subscriptions';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { env, dodoApiKey, dodoProductId } from '../config/env';
import { requireAuth } from '../plugins/auth-verify';
import { ProviderError } from '../plugins/error-handler';
import {
  applyDodoState,
  customerIdForEmail,
  rememberCheckoutSession,
  type BillingStatus,
  type DodoSubscriptionState,
} from './service';
import { hasManageableSubscription, type SubStatus } from '@kairo/shared';
import { renderBillingReturnPage } from './return-page';

type SubscriptionSnapshot = Pick<
  Subscription,
  | 'status'
  | 'subscription_id'
  | 'customer'
  | 'product_id'
  | 'next_billing_date'
  | 'cancel_at_next_billing_date'
>;

type BillingProvider = Pick<DodoPayments, 'checkoutSessions' | 'customers' | 'subscriptions'>;

type BillingAccount = {
  status: SubStatus;
  plan: 'free' | 'pro';
  dodo_subscription_id: string | null;
  dodo_customer_id: string | null;
  email: string;
};

function dodoClient(): DodoPayments | null {
  if (!dodoApiKey) return null;
  return new DodoPayments({ bearerToken: dodoApiKey, environment: env.DODO_ENV });
}

function providerError(error: unknown, operation: string): ProviderError {
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(`${operation}: ${message}`);
}

function billingReturnUrl(): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/billing/return`;
}

async function readBillingAccount(userId: string): Promise<BillingAccount | undefined> {
  const result = await db.execute(sql`
    SELECT s.status, uc.plan, s.dodo_subscription_id, s.dodo_customer_id, u.email
      FROM "user" u
      JOIN usage_counter uc ON uc.user_id = u.id
      LEFT JOIN subscription s ON s.user_id = u.id
     WHERE u.id = ${userId}`);
  return result.rows[0] as BillingAccount | undefined;
}

export function stateFromDodoSnapshot(
  snapshot: SubscriptionSnapshot | SubscriptionListResponse,
  occurredAt = new Date(),
): DodoSubscriptionState {
  return {
    status: snapshot.status as BillingStatus,
    subscriptionId: snapshot.subscription_id,
    customerId: snapshot.customer.customer_id,
    productId: snapshot.product_id,
    currentPeriodEnd: snapshot.next_billing_date ? new Date(snapshot.next_billing_date) : null,
    cancelAtPeriodEnd: snapshot.cancel_at_next_billing_date,
    occurredAt,
  };
}

/**
 * Recover authoritative state directly from Dodo. This closes the gap if a webhook is delayed,
 * exhausted its retries, or arrived before checkout attribution was committed.
 */
export async function reconcileBillingAccount(
  client: BillingProvider,
  userId: string,
): Promise<{ synced: boolean; status?: BillingStatus }> {
  const account = await readBillingAccount(userId);
  if (!account) return { synced: false };

  let snapshot: Subscription | SubscriptionListResponse | null = null;
  if (account.dodo_subscription_id) {
    snapshot = await client.subscriptions.retrieve(account.dodo_subscription_id);
  } else {
    let customerId = account.dodo_customer_id;
    if (!customerId) {
      const customers = await client.customers.list({ email: account.email, page_size: 20 });
      customerId = customerIdForEmail(customers.items, account.email);
    }
    if (customerId && dodoProductId) {
      const subscriptions = await client.subscriptions.list({
        customer_id: customerId,
        product_id: dodoProductId,
        page_size: 20,
      });
      const candidates = [...subscriptions.items].sort((a, b) => {
        const priority = (status: string) => (status === 'active' ? 3 : status === 'on_hold' ? 2 : status === 'pending' ? 1 : 0);
        return priority(b.status) - priority(a.status) || Date.parse(b.created_at) - Date.parse(a.created_at);
      });
      snapshot = candidates[0] ?? null;
    }
  }

  if (!snapshot || (dodoProductId && snapshot.product_id !== dodoProductId)) return { synced: false };
  const state = stateFromDodoSnapshot(snapshot);
  await applyDodoState(userId, state);
  return { synced: true, status: state.status };
}

export async function billingRoutes(app: FastifyInstance) {
  // Dodo returns here after both checkout and portal actions. The public HTTP page reliably hands
  // control back to the desktop custom scheme and also leaves a clickable fallback.
  app.get<{ Querystring: { status?: string } }>('/billing/return', async (req, reply) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'unknown';
    req.log.info({ checkoutStatus: status }, 'billing browser return received');
    reply
      .header('cache-control', 'no-store')
      .header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      )
      .type('text/html; charset=utf-8');
    return renderBillingReturnPage(status);
  });

  app.post<{ Body: { interval?: 'monthly' } }>(
    '/v1/billing/checkout',
    { preHandler: requireAuth },
    async (req, reply) => {
      const startedAt = performance.now();
      const client = dodoClient();
      const productId = dodoProductId;
      if (!client || !productId) {
        req.log.error({ environment: env.DODO_ENV }, 'checkout requested without complete billing configuration');
        return reply.status(503).send({ error: 'billing_not_configured', code: 'provider_error' });
      }

      // Reconcile first so a missed webhook cannot let an already-subscribed user buy twice.
      try {
        await reconcileBillingAccount(client, req.userId!);
      } catch (error) {
        req.log.warn({ err: error }, 'pre-checkout reconciliation failed; using stored state');
      }
      const account = await readBillingAccount(req.userId!);
      if (account && (account.plan === 'pro' || ['pending', 'active', 'on_hold'].includes(account.status))) {
        req.log.info({ status: account.status }, 'duplicate subscription checkout blocked');
        return reply.status(409).send({ error: 'subscription_exists', code: 'subscription_exists' });
      }

      try {
        const session = await client.checkoutSessions.create({
          product_cart: [{ product_id: productId, quantity: 1 }],
          ...(account?.email ? { customer: { email: account.email } } : {}),
          metadata: {
            user_id: req.userId!,
            backend_url: env.PUBLIC_BASE_URL.replace(/\/$/, ''),
          },
          return_url: billingReturnUrl(),
          feature_flags: { redirect_immediately: true },
        });
        if (!session.session_id || !session.checkout_url) {
          req.log.error(
            { hasSessionId: Boolean(session.session_id), hasCheckoutUrl: Boolean(session.checkout_url) },
            'checkout provider response incomplete',
          );
          return reply.status(502).send({ error: 'checkout_response_incomplete', code: 'provider_error' });
        }

        await rememberCheckoutSession(session.session_id, req.userId!);
        req.log.info({ ms: Math.round(performance.now() - startedAt) }, 'checkout session ready');
        return { checkout_url: session.checkout_url };
      } catch (error) {
        throw providerError(error, 'checkout session creation failed');
      }
    },
  );

  // Called during post-checkout polling and before opening the portal.
  app.post('/v1/billing/sync', { preHandler: requireAuth }, async (req) => {
    const client = dodoClient();
    if (!client) throw new ProviderError('billing reconciliation is not configured');
    try {
      const result = await reconcileBillingAccount(client, req.userId!);
      req.log.info({ synced: result.synced, status: result.status ?? 'unchanged' }, 'billing reconciliation complete');
      return result;
    } catch (error) {
      throw providerError(error, 'billing reconciliation failed');
    }
  });

  app.post('/v1/billing/portal', { preHandler: requireAuth }, async (req, reply) => {
    const client = dodoClient();
    if (!client) return reply.status(503).send({ error: 'billing_not_configured', code: 'provider_error' });

    try {
      await reconcileBillingAccount(client, req.userId!);
    } catch (error) {
      req.log.warn({ err: error }, 'pre-portal reconciliation failed; using stored state');
    }
    const account = await readBillingAccount(req.userId!);
    if (!account || !hasManageableSubscription(account.status)) {
      req.log.info({ status: account?.status ?? 'missing' }, 'billing portal: no managed subscription');
      return reply.status(409).send({ error: 'no_billing_subscription', code: 'no_billing_subscription' });
    }
    if (!account.dodo_customer_id) {
      req.log.warn('billing portal: customer mapping unavailable');
      return reply.status(409).send({ error: 'customer_not_ready', code: 'billing_sync_pending' });
    }

    try {
      const portal = await client.customers.customerPortal.create(account.dodo_customer_id, {
        return_url: billingReturnUrl(),
      });
      if (!portal.link) {
        req.log.error('billing portal: provider returned no link');
        return reply.status(502).send({ error: 'portal_link_missing', code: 'provider_error' });
      }
      req.log.info('billing portal session created');
      return { url: portal.link };
    } catch (error) {
      throw providerError(error, 'customer portal creation failed');
    }
  });
}
