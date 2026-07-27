import type { FastifyInstance } from 'fastify';
import { Webhook } from 'standardwebhooks';
import { dodoProductId, dodoWebhookSecret } from '../config/env';
import {
  applyWebhookState,
  recordWebhook,
  resolveWebhookUser,
  type BillingStatus,
  type DodoSubscriptionState,
} from './service';
import { env } from '../config/env';

const SUBSCRIPTION_EVENTS = new Set([
  'subscription.active',
  'subscription.updated',
  'subscription.renewed',
  'subscription.plan_changed',
  'subscription.update_payment_method',
  'subscription.on_hold',
  'subscription.cancelled',
  'subscription.expired',
  'subscription.failed',
]);

function fallbackStatus(type: string): BillingStatus | null {
  if (type === 'subscription.active' || type === 'subscription.renewed' || type === 'subscription.plan_changed') {
    return 'active';
  }
  if (type === 'subscription.on_hold') return 'on_hold';
  if (type === 'subscription.cancelled') return 'cancelled';
  if (type === 'subscription.expired') return 'expired';
  if (type === 'subscription.failed') return 'failed';
  return null;
}

function billingStatus(value: unknown, type: string): BillingStatus | null {
  if (['pending', 'active', 'on_hold', 'cancelled', 'expired', 'failed'].includes(String(value))) {
    return value as BillingStatus;
  }
  return fallbackStatus(type);
}

function eventTime(payloadTimestamp: unknown, headerTimestamp: string): Date {
  const payloadDate = typeof payloadTimestamp === 'string' ? new Date(payloadTimestamp) : null;
  if (payloadDate && Number.isFinite(payloadDate.getTime())) return payloadDate;
  const headerDate = new Date(Number(headerTimestamp) * 1000);
  return Number.isFinite(headerDate.getTime()) ? headerDate : new Date();
}

function stateFromSubscription(
  type: string,
  data: Record<string, any>,
  occurredAt: Date,
): DodoSubscriptionState | null {
  const status = billingStatus(data.status, type);
  if (!status) return null;
  return {
    status,
    subscriptionId: data.subscription_id,
    customerId: data.customer?.customer_id ?? data.customer_id,
    productId: data.product_id,
    currentPeriodEnd: data.next_billing_date ? new Date(data.next_billing_date) : null,
    cancelAtPeriodEnd: Boolean(data.cancel_at_next_billing_date),
    occurredAt,
  };
}

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

    let payload: { timestamp?: string; type?: string; data?: Record<string, unknown> };
    try {
      payload = new Webhook(secret).verify(raw, headers) as typeof payload;
    } catch {
      req.log.warn('dodo webhook signature rejected');
      return reply.status(400).send({ error: 'bad_signature', code: 'bad_request' });
    }

    const type = payload.type ?? 'unknown';
    const data = (payload.data ?? {}) as Record<string, any>;
    const customerId = data.customer?.customer_id ?? data.customer_id;
    const sessionId = data.checkout_session_id ?? data.session_id;
    const metadataUserId = typeof data.metadata?.user_id === 'string' ? data.metadata.user_id : null;
    const metadataBackend = typeof data.metadata?.backend_url === 'string'
      ? data.metadata.backend_url.replace(/\/$/, '')
      : null;
    const currentBackend = env.PUBLIC_BASE_URL.replace(/\/$/, '');
    if (metadataBackend && metadataBackend !== currentBackend) {
      const fresh = await recordWebhook(headers['webhook-id'], type, payload);
      req.log.info({ type, duplicate: !fresh }, 'ignored webhook routed to another Kairo backend');
      return reply.send({ ok: true, ignored: true, duplicate: !fresh });
    }
    const resolvedUser = await resolveWebhookUser(metadataUserId, sessionId, customerId);
    const occurredAt = eventTime(payload.timestamp, headers['webhook-timestamp']);

    let state: DodoSubscriptionState | null = null;
    let userId: string | null = null;
    if (SUBSCRIPTION_EVENTS.has(type)) {
      state = stateFromSubscription(type, data, occurredAt);
      userId = resolvedUser.userId;
    } else if (
      type === 'payment.succeeded'
      && data.subscription_id
      && resolvedUser.userId
      && resolvedUser.source === 'session'
    ) {
      // Test mode may deliver payment.succeeded before subscription.active. Only a mapped checkout
      // with a real subscription id may take this fallback path; unrelated customer payments cannot.
      state = {
        status: 'active',
        subscriptionId: data.subscription_id,
        customerId,
        productId: dodoProductId,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        occurredAt,
      };
      userId = resolvedUser.userId;
    }

    const eventProductId = state?.productId;
    if (state && dodoProductId && eventProductId && eventProductId !== dodoProductId) {
      const fresh = await recordWebhook(headers['webhook-id'], type, payload);
      req.log.warn({ type, duplicate: !fresh }, 'ignored webhook for another product');
      return reply.send({ ok: true, ignored: true });
    }

    if (state && !userId) {
      if (metadataUserId && !resolvedUser.metadataUserExists) {
        const fresh = await recordWebhook(headers['webhook-id'], type, payload);
        req.log.warn(
          { type, duplicate: !fresh },
          'ignored billable webhook carrying a user from another Kairo database',
        );
        return reply.send({ ok: true, ignored: true, duplicate: !fresh });
      }
      // Do not record this event yet: a retry may arrive after checkout/customer attribution commits.
      req.log.warn(
        { type, hasSession: Boolean(sessionId), hasCustomer: Boolean(customerId) },
        'billable webhook has no user mapping; requesting retry',
      );
      return reply.status(503).send({ error: 'billing_user_not_ready', code: 'provider_error' });
    }

    if (state && userId) {
      const result = await applyWebhookState(headers['webhook-id'], type, payload, userId, state);
      req.log.info(
        {
          type,
          result,
          status: state.status,
          scheduledCancel: state.cancelAtPeriodEnd ?? false,
          hasCustomer: Boolean(state.customerId),
        },
        'dodo entitlement processed',
      );
      return reply.send({ ok: true, duplicate: result === 'duplicate' });
    }

    const fresh = await recordWebhook(headers['webhook-id'], type, payload);
    req.log.info({ type, duplicate: !fresh }, 'dodo webhook acknowledged without entitlement change');
    return reply.send({ ok: true, duplicate: !fresh });
  });
}
