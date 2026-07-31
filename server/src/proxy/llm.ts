import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../plugins/auth-verify';
import { requireCredits } from '../plugins/require-credits';
import { forwardJson } from './forward';
import { streamPassthrough } from './stream';
import { reserve, refund, isOnboarding, reserveOnboarding, refundOnboarding } from '../usage/service';
import { QuotaExceededError } from '../plugins/error-handler';

/** Drop the `_provider` routing hint before forwarding the body to the provider. */
function stripMeta(body: unknown): unknown {
  if (body && typeof body === 'object') {
    const clone = { ...(body as Record<string, unknown>) };
    delete clone._provider;
    return clone;
  }
  return body;
}

/** The same body, asking the provider to stream. Both OpenAI Responses and Anthropic use `stream`. */
export function streamingBody(body: unknown): unknown {
  const stripped = stripMeta(body);
  return stripped && typeof stripped === 'object' ? { ...(stripped as object), stream: true } : stripped;
}

function providerFor(body: unknown): { provider: 'anthropic' | 'openai'; path: string } {
  const provider = (body as { _provider?: string })?._provider === 'anthropic' ? 'anthropic' : 'openai';
  return { provider, path: provider === 'anthropic' ? '/v1/messages' : '/v1/responses' };
}

export async function llmRoutes(app: FastifyInstance) {
  // Gate / text / ack — authed + credit-gated but UNMETERED (they keep keys server-side; a
  // paywalled user is refused here so we never spend on their gate/ack calls).
  app.post('/v1/llm/chat', { preHandler: [requireAuth, requireCredits] }, async (req) => {
    const { json } = await forwardJson('openrouter', '/chat/completions', req.body);
    return json;
  });

  // The answer + box turn — authed AND METERED. One ask = one unit (this route fires once per ask).
  app.post('/v1/vision/tutor', { preHandler: [requireAuth, requireCredits] }, async (req) => {
    // Mint the ask_id server-side (ignore any client header): the client must NOT control it, or
    // a modified client could reuse one id to get unlimited "already-counted" free asks.
    const askId = randomUUID();
    const provider = (req.body as { _provider?: string })?._provider === 'anthropic' ? 'anthropic' : 'openai';
    const path = provider === 'anthropic' ? '/v1/messages' : '/v1/responses';

    // Onboarding "tutorial" turns draw a SEPARATE capped budget — NOT billed against the 10
    // free, but bounded. Server-decided by onboarding state (profile.onboarding_completed_at),
    // so a modified client can't fake "this is a tutorial" to dodge metering.
    if (await isOnboarding(req.userId!)) {
      if (!(await reserveOnboarding(req.userId!))) throw new QuotaExceededError('tutorial limit reached');
      try {
        const { json } = await forwardJson(provider, path, stripMeta(req.body));
        return json;
      } catch (e) {
        await refundOnboarding(req.userId!);
        throw e;
      }
    }

    const allowed = await reserve(req.userId!, askId);
    if (!allowed) throw new QuotaExceededError('free limit reached');
    try {
      const { json } = await forwardJson(provider, path, stripMeta(req.body));
      return json;
    } catch (e) {
      await refund(req.userId!, askId); // don't burn a free credit on our/provider failure
      throw e;
    }
  });

  /**
   * The same answer + box turn, streamed. Kept as a SEPARATE route rather than a flag on the
   * buffered one: that route stays byte-for-byte the fallback, so a client whose stream dies
   * mid-response — or any build that predates this — keeps working untouched.
   *
   * Metering is identical to the buffered route, with one extra case that only exists here. Once
   * a byte is on the wire the reply is hijacked and no error envelope can follow, so a stream that
   * dies halfway is refunded on the outcome rather than on a thrown error. The user must not be
   * charged for an answer they never heard.
   */
  app.post('/v1/vision/tutor/stream', { preHandler: [requireAuth, requireCredits] }, async (req, reply) => {
    const askId = randomUUID();
    const { provider, path } = providerFor(req.body);
    const body = streamingBody(req.body);

    if (await isOnboarding(req.userId!)) {
      if (!(await reserveOnboarding(req.userId!))) throw new QuotaExceededError('tutorial limit reached');
      const outcome = await streamPassthrough(provider, path, body, reply).catch(() => null);
      if (!outcome?.completed) {
        await refundOnboarding(req.userId!);
        req.log.warn({ started: outcome?.started ?? false }, 'streamed tutorial turn did not complete');
      }
      return reply;
    }

    const allowed = await reserve(req.userId!, askId);
    if (!allowed) throw new QuotaExceededError('free limit reached');
    const outcome = await streamPassthrough(provider, path, body, reply).catch(() => null);
    if (!outcome?.completed) {
      await refund(req.userId!, askId);
      req.log.warn({ started: outcome?.started ?? false }, 'streamed tutor turn did not complete');
    }
    return reply;
  });

  // Computer-use pointing — authed + credit-gated, UNMETERED (part of the same ask).
  app.post('/v1/vision/point', { preHandler: [requireAuth, requireCredits] }, async (req) => {
    const { json } = await forwardJson('openai', '/v1/responses', stripMeta(req.body));
    return json;
  });
}
