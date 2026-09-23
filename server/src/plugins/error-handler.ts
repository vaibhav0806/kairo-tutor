import type { FastifyInstance } from 'fastify';
import type { ErrorEnvelope } from '@kairo/shared';
import { requestPath } from '../logging';
import { env } from '../config/env';

type ProviderErrorMetadata = {
  provider?: string;
  errorClass?: string;
  status?: number;
  /**
   * Truncated upstream body, captured only so an operator can answer "why did the provider say no".
   * Never reaches a client response, and only reaches the log when KAIRO_LOG_PROVIDER_BODIES is on.
   */
  bodySnippet?: string;
};

export const PROVIDER_BODY_SNIPPET_CHARS = 500;

export class QuotaExceededError extends Error {
  code = 'quota_exceeded' as const;
}
export class AuthError extends Error {
  code = 'unauthenticated' as const;
}
/**
 * Too many requests, too fast. Distinct from `QuotaExceededError` on purpose: 402 means "you are
 * out of the allowance you can buy more of", and telling a paying subscriber that would put an
 * upgrade prompt in front of someone who already upgraded. This is 429 — slow down, come back.
 */
export class RateLimitedError extends Error {
  code = 'bad_request' as const;

  constructor(
    message: string,
    readonly retryAfterSeconds: number,
    readonly limit: number,
    readonly resetAt: number,
  ) {
    super(message);
  }
}

/**
 * A request we refuse to forward. The message is ours, never the caller's input echoed back, so it
 * is safe to return — a rejected payload must not become a way to get our server to repeat text.
 */
export class BadRequestError extends Error {
  code = 'bad_request' as const;
}
export class ProviderError extends Error {
  code = 'provider_error' as const;

  constructor(
    message: string,
    readonly metadata: ProviderErrorMetadata = {},
  ) {
    super(message);
  }
}

export const SAFE_PROVIDER_ERROR_MESSAGE = 'The provider request failed. Please try again.';

/**
 * Log fields for a provider failure. Class and status alone cannot distinguish an exhausted quota
 * from a rotated key from a retired model id — all three arrive as `http 400`. The body is what
 * separates them, so it is retained behind an operator flag that is off by default.
 */
export function providerErrorLogFields(error: ProviderError, url?: string) {
  const bodyChars = error.metadata.bodySnippet?.length;
  return {
    provider: error.metadata.provider ?? 'unknown',
    errorClass: error.metadata.errorClass ?? 'provider',
    status: error.metadata.status,
    path: requestPath(url),
    // Always safe: a length tells you the upstream said something without repeating it.
    bodyChars,
    body: env.KAIRO_LOG_PROVIDER_BODIES ? error.metadata.bodySnippet : undefined,
  };
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
    if (err instanceof RateLimitedError) {
      // `Retry-After` is the one every client already understands (RFC 9110). The RateLimit-*
      // trio is the IETF draft shape, so a well-behaved client can back off before being refused.
      reply.header('Retry-After', String(err.retryAfterSeconds));
      reply.header('RateLimit-Limit', String(err.limit));
      reply.header('RateLimit-Remaining', '0');
      reply.header('RateLimit-Reset', String(err.retryAfterSeconds));
      return reply
        .status(429)
        .send({ error: 'rate_limited', code: 'bad_request', message: err.message } satisfies ErrorEnvelope);
    }
    if (err instanceof BadRequestError) {
      // Logged at info: on the unauthenticated routes this fires for every probe, and a stranger
      // must not be able to fill the disk by being refused loudly.
      req.log.info({ path: requestPath(req.url) }, 'request refused before forwarding');
      return reply
        .status(400)
        .send({ error: 'bad_request', code: 'bad_request', message: err.message } satisfies ErrorEnvelope);
    }
    if (err instanceof ProviderError) {
      req.log.warn(providerErrorLogFields(err, req.url), 'provider error');
      return reply
        .status(502)
        .send({
          error: 'provider_error',
          code: 'provider_error',
          message: SAFE_PROVIDER_ERROR_MESSAGE,
        } satisfies ErrorEnvelope);
    }
    const errorClass = err instanceof Error ? err.name : typeof err;
    req.log.error({ errorClass, path: requestPath(req.url) }, 'unhandled error');
    return reply
      .status(500)
      .send({
        error: 'internal',
        code: 'provider_error',
        message: 'The server could not complete the request. Please try again.',
      } satisfies ErrorEnvelope);
  });
}
