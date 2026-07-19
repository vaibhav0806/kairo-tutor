import DodoPayments from 'dodopayments';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { env } from '../config/env';
import { requireAuth } from '../plugins/auth-verify';

function dodoClient(): DodoPayments | null {
  if (!env.DODO_PAYMENTS_API_KEY) return null;
  return new DodoPayments({ bearerToken: env.DODO_PAYMENTS_API_KEY, environment: env.DODO_ENV });
}

export async function billingRoutes(app: FastifyInstance) {
  // Start a checkout for the Pro subscription (monthly or yearly). Opened in the system browser.
  app.post<{ Body: { interval?: 'monthly' | 'yearly' } }>(
    '/v1/billing/checkout',
    { preHandler: requireAuth },
    async (req, reply) => {
      const client = dodoClient();
      const productId =
        req.body?.interval === 'yearly' ? env.DODO_PRO_YEARLY_PRODUCT_ID : env.DODO_PRO_MONTHLY_PRODUCT_ID;
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
      } as never)) as { checkout_url?: string; url?: string };

      return { checkout_url: session.checkout_url ?? session.url };
    },
  );

  // Self-serve subscription management (cancel, update card, invoices).
  app.post('/v1/billing/portal', { preHandler: requireAuth }, async (req, reply) => {
    const client = dodoClient();
    if (!client) return reply.status(503).send({ error: 'billing_not_configured', code: 'provider_error' });

    const s = await db.execute(sql`SELECT dodo_customer_id FROM subscription WHERE user_id = ${req.userId!}`);
    const customerId = (s.rows[0] as { dodo_customer_id: string | null } | undefined)?.dodo_customer_id;
    if (!customerId) return reply.status(400).send({ error: 'no_customer', code: 'bad_request' });

    const portal = (await client.customers.customerPortal.create(customerId)) as { link?: string; url?: string };
    return { url: portal.link ?? portal.url };
  });
}
