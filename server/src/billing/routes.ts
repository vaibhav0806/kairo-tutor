import DodoPayments from 'dodopayments';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { env, dodoApiKey, dodoProductId } from '../config/env';
import { requireAuth } from '../plugins/auth-verify';
import { customerIdForEmail, rememberCheckoutSession, rememberDodoCustomer } from './service';
import { hasManageableSubscription, type SubStatus } from '@kairo/shared';

function dodoClient(): DodoPayments | null {
  if (!dodoApiKey) return null;
  return new DodoPayments({ bearerToken: dodoApiKey, environment: env.DODO_ENV });
}

export async function billingRoutes(app: FastifyInstance) {
  // Start a checkout for the Pro subscription (monthly or yearly). Opened in the system browser.
  app.post<{ Body: { interval?: 'monthly' | 'yearly' } }>(
    '/v1/billing/checkout',
    { preHandler: requireAuth },
    async (req, reply) => {
      const client = dodoClient();
      // Single Pro product — interval kept in the body for future plans, but both map to it.
      const productId = dodoProductId;
      if (!client || !productId) {
        return reply.status(503).send({ error: 'billing_not_configured', code: 'provider_error' });
      }

      const u = await db.execute(sql`SELECT email FROM "user" WHERE id = ${req.userId!}`);
      const email = (u.rows[0] as { email: string } | undefined)?.email;

      // metadata.user_id lets the webhook map the payment back to our user.
      const session = (await client.checkoutSessions.create({
        product_cart: [{ product_id: productId, quantity: 1 }],
        ...(email ? { customer: { email } } : {}),
        metadata: { user_id: req.userId! },
        return_url: 'kairo://billing-done',
      } as never)) as { checkout_url?: string; url?: string; session_id?: string; id?: string };

      // Persist session_id → user so the reliable `payment.succeeded` webhook (which carries only
      // the checkout_session_id, not our metadata) can still be attributed and capture the customer.
      const sessionId = session.session_id ?? session.id;
      if (sessionId) {
        await rememberCheckoutSession(sessionId, req.userId!);
        req.log.info({ sessionId }, 'checkout session stored');
      } else {
        req.log.warn({ keys: Object.keys(session) }, 'checkout: no session_id in response');
      }

      return { checkout_url: session.checkout_url ?? session.url };
    },
  );

  // Self-serve subscription management (cancel, update card, invoices).
  app.post('/v1/billing/portal', { preHandler: requireAuth }, async (req, reply) => {
    const client = dodoClient();
    if (!client) return reply.status(503).send({ error: 'billing_not_configured', code: 'provider_error' });

    const s = await db.execute(sql`
      SELECT s.status, s.dodo_customer_id, u.email
        FROM subscription s
        JOIN "user" u ON u.id = s.user_id
       WHERE s.user_id = ${req.userId!}`);
    const account = s.rows[0] as {
      status: SubStatus;
      dodo_customer_id: string | null;
      email: string;
    } | undefined;
    if (!account || !hasManageableSubscription(account.status)) {
      req.log.info({ status: account?.status ?? 'missing' }, 'billing portal: no managed subscription');
      return reply.status(409).send({
        error: 'no_billing_subscription',
        code: 'no_billing_subscription',
      });
    }
    let customerId = account?.dodo_customer_id ?? null;

    // Early test-mode checkouts could grant Pro from payment.succeeded without persisting the nested
    // customer id. Recover once from Dodo's exact-email filter, then store the mapping permanently.
    if (!customerId && account?.email) {
      const customers = await client.customers.list({ email: account.email, page_size: 20 });
      customerId = customerIdForEmail(customers.items, account.email);
      if (customerId) {
        await rememberDodoCustomer(req.userId!, customerId);
        req.log.info('billing portal: recovered missing customer mapping');
      }
    }
    if (!customerId) {
      req.log.warn('billing portal: customer mapping unavailable');
      return reply.status(409).send({ error: 'customer_not_ready', code: 'billing_sync_pending' });
    }

    const portal = await client.customers.customerPortal.create(customerId, {
      return_url: 'kairo://billing-done',
    });
    if (!portal.link) {
      req.log.error('billing portal: provider returned no link');
      return reply.status(502).send({ error: 'portal_link_missing', code: 'provider_error' });
    }
    req.log.info('billing portal session created');
    return { url: portal.link };
  });
}
