import type { FastifyInstance } from 'fastify';
import { Webhook } from 'standardwebhooks';
import { dodoWebhookSecret } from '../config/env';
import {
  applyDodoState,
  recordWebhook,
  userFromCheckoutSession,
  userIdByCustomer,
  type DodoEventType,
} from './service';

/**
 * Dodo webhook receiver. Registered as its own plugin so its raw-body content-type parser stays
 * encapsulated (HMAC verification needs the exact bytes — the rest of the app parses JSON normally).
 */
export async function dodoWebhookRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/webhooks/dodo', async (req, reply) => {
    const secret = dodoWebhookSecret;
    if (!secret) return reply.status(503).send({ error: 'webhook_not_configured', code: 'provider_error' });

    const raw = (req.body as Buffer).toString('utf8');
    const headers = {
      'webhook-id': String(req.headers['webhook-id'] ?? ''),
      'webhook-signature': String(req.headers['webhook-signature'] ?? ''),
      'webhook-timestamp': String(req.headers['webhook-timestamp'] ?? ''),
    };

    let payload: { type?: string; data?: Record<string, unknown> };
    try {
      payload = new Webhook(secret).verify(raw, headers) as typeof payload;
    } catch {
      return reply.status(400).send({ error: 'bad_signature', code: 'bad_request' });
    }

    // Idempotency — a re-delivered event is a no-op.
    const fresh = await recordWebhook(headers['webhook-id'], payload.type ?? 'unknown', payload);
    if (!fresh) return reply.send({ ok: true, duplicate: true });

    const type = payload.type ?? '';
    const data = (payload.data ?? {}) as Record<string, any>;
    // Dodo nests the customer id under data.customer.customer_id (NOT data.customer_id); the
    // product id lives in data.product_cart[]. Resolve the user three ways, most-specific first:
    // subscription events carry our metadata.user_id; payment.succeeded carries only the
    // checkout_session_id (mapped at checkout); everything else falls back to the stored customer.
    const customerId = data?.customer?.customer_id ?? data?.customer_id;
    const sessionId = data?.checkout_session_id ?? data?.session_id;
    const userId =
      data?.metadata?.user_id ??
      (await userFromCheckoutSession(sessionId)) ??
      (await userIdByCustomer(customerId));

    // Test mode reliably sends `payment.succeeded` (with checkout_session_id + customer) but often
    // NOT `subscription.active`. Treat a mapped subscription-checkout payment as activation so we
    // always capture the customer id (needed for the billing portal) and grant Pro.
    const billable = type.startsWith('subscription.') || type === 'payment.succeeded';
    if (billable && userId) {
      const evType: DodoEventType = type.startsWith('subscription.')
        ? (type as DodoEventType)
        : 'subscription.active';
      await applyDodoState(userId, {
        type: evType,
        subscriptionId: data?.subscription_id,
        customerId,
        productId: data?.product_id ?? data?.product_cart?.[0]?.product_id,
        currentPeriodEnd: data?.next_billing_date ? new Date(data.next_billing_date) : null,
        occurredAt: headers['webhook-timestamp']
          ? new Date(Number(headers['webhook-timestamp']) * 1000)
          : new Date(),
      });
      req.log.info({ type, mappedFrom: sessionId ? 'session' : 'meta/customer', hasCustomer: Boolean(customerId) }, 'dodo entitlement applied');
    } else {
      req.log.info({ type, hasSession: Boolean(sessionId), hasCustomer: Boolean(customerId) }, 'dodo webhook: no user mapped');
    }
    return reply.send({ ok: true });
  });
}
