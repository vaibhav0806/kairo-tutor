import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ASK_ID_HEADER } from '@kairo/shared';
import { requireAuth } from '../plugins/auth-verify';
import { forwardJson } from './forward';
import { reserve, refund } from '../usage/service';
import { QuotaExceededError } from '../plugins/error-handler';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  // Gate / text / ack — authed but UNMETERED (they exist only to keep keys server-side).
  app.post('/v1/llm/chat', { preHandler: requireAuth }, async (req) => {
    const { json } = await forwardJson('openrouter', '/chat/completions', req.body);
    return json;
  });

  // The answer + box turn — authed AND METERED. One ask = one unit (this route fires once per ask).
  app.post('/v1/vision/tutor', { preHandler: requireAuth }, async (req) => {
    // usage_event.ask_id is a uuid column — only trust a well-formed UUID from the client;
    // otherwise mint one so a malformed header can never crash the reserve INSERT.
    const rawAskId = req.headers[ASK_ID_HEADER];
    const askId =
      typeof rawAskId === 'string' && UUID_RE.test(rawAskId) ? rawAskId : randomUUID();
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

  // Computer-use pointing — authed, UNMETERED (part of the same ask).
  app.post('/v1/vision/point', { preHandler: requireAuth }, async (req) => {
    const { json } = await forwardJson('openai', '/v1/responses', stripMeta(req.body));
    return json;
  });
}
