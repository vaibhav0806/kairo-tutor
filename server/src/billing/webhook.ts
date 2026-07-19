import type { FastifyInstance } from 'fastify';
import { Webhook } from 'standardwebhooks';
import { env } from '../config/env';
import { applyDodoState, recordWebhook, userIdByCustomer, type DodoEventType } from './service';

/**
 * Dodo webhook receiver. Registered as its own plugin so its raw-body content-type parser stays
 * encapsulated (HMAC verification needs the exact bytes — the rest of the app parses JSON normally).
 */
export async function dodoWebhookRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/webhooks/dodo', async (req, reply) => {
    const secret = env.DODO_PAYMENTS_WEBHOOK_SECRET;
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
    if (type.startsWith('subscription.')) {
      const data = (payload.data ?? {}) as Record<string, any>;
      const userId = data?.metadata?.user_id ?? (await userIdByCustomer(data?.customer_id));
      if (userId) {
        await applyDodoState(userId, {
          type: type as DodoEventType,
          subscriptionId: data?.subscription_id,
          customerId: data?.customer_id,
          productId: data?.product_id,
          currentPeriodEnd: data?.next_billing_date ? new Date(data.next_billing_date) : null,
          occurredAt: headers['webhook-timestamp']
            ? new Date(Number(headers['webhook-timestamp']) * 1000)
            : new Date(),
        });
      }
    }
    return reply.send({ ok: true });
  });
}
