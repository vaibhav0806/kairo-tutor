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
      return reply
        .status(502)
        .send({ error: 'provider_error', code: 'provider_error', message: err.message } satisfies ErrorEnvelope);
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal', code: 'provider_error' } satisfies ErrorEnvelope);
  });
}
