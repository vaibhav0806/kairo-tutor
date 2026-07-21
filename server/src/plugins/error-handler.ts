import type { FastifyInstance } from 'fastify';
import type { ErrorEnvelope } from '@kairo/shared';

export class QuotaExceededError extends Error {
  code = 'quota_exceeded' as const;
}
export class AuthError extends Error {
  code = 'unauthenticated' as const;
}
export class ProviderError extends Error {
  code = 'provider_error' as const;
}

/** Maps our typed errors to a uniform `{ error, code }` body the desktop branches on. */
export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof QuotaExceededError) {
      return reply
        .status(402)
        .send({ error: 'free_limit_reached', code: 'quota_exceeded', message: err.message } satisfies ErrorEnvelope);
    }
    if (err instanceof AuthError) {
      return reply.status(401).send({ error: 'unauthenticated', code: 'unauthenticated' } satisfies ErrorEnvelope);
    }
    if (err instanceof ProviderError) {
      // ALWAYS store the real provider error (OpenAI/Sarvam/etc. message) — never swallow it.
      req.log.warn({ err: err.message, url: req.url }, 'provider error');
      return reply
        .status(502)
        .send({ error: 'provider_error', code: 'provider_error', message: err.message } satisfies ErrorEnvelope);
    }
    // Unknown/unhandled: log the full error (stack) AND surface its message to our trusted desktop
    // client, so the failure shows up in the Kairo log too instead of an opaque "internal".
    req.log.error({ err }, 'unhandled error');
    const message = err instanceof Error ? err.message : String(err);
    return reply
      .status(500)
      .send({ error: 'internal', code: 'provider_error', message } satisfies ErrorEnvelope);
  });
}
