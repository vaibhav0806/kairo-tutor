import { jwtVerify } from 'jose';
import type { FastifyRequest } from 'fastify';
import { env } from '../config/env';
import { jwks } from '../auth/jwks';
import { AuthError } from './error-handler';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
}

/** preHandler: require a valid Better Auth JWT, set `req.userId`. Throws AuthError -> 401. */
export async function requireAuth(req: FastifyRequest): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new AuthError('missing bearer token');
  try {
    // Keys come from `jwks` (in-process, no HTTP); issuer/audience stay pinned to PUBLIC_BASE_URL
    // because that is what the issued tokens carry.
    const { payload } = await jwtVerify(header.slice(7), jwks, {
      issuer: env.PUBLIC_BASE_URL,
      audience: env.PUBLIC_BASE_URL,
    });
    req.userId = payload.sub as string;
  } catch (err) {
    // Log the jose error code only (e.g. ERR_JWT_EXPIRED) — never the token or its claims. Without
    // this, an infrastructure-level verification failure looks identical to a bad token.
    req.log.warn({ reason: (err as { code?: string })?.code ?? 'unknown' }, 'jwt verification failed');
    throw new AuthError('invalid token');
  }
}
