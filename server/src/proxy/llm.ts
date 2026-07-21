import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../plugins/auth-verify';
import { requireCredits } from '../plugins/require-credits';
import { forwardJson } from './forward';
import { reserve, refund } from '../usage/service';
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

  // Computer-use pointing — authed + credit-gated, UNMETERED (part of the same ask).
  app.post('/v1/vision/point', { preHandler: [requireAuth, requireCredits] }, async (req) => {
    const { json } = await forwardJson('openai', '/v1/responses', stripMeta(req.body));
    return json;
  });
}
