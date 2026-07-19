import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { FastifyRequest } from 'fastify';
import { env } from '../config/env';
import { AuthError } from './error-handler';

// Cached in-process. Better Auth serves the keys at /api/auth/jwks; the proxy verifies the JWT
// statelessly (no DB) on every request. (Same process => this is effectively a local read.)
const JWKS = createRemoteJWKSet(new URL(`${env.PUBLIC_BASE_URL}/api/auth/jwks`));

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
    const { payload } = await jwtVerify(header.slice(7), JWKS, {
      issuer: env.PUBLIC_BASE_URL,
      audience: env.PUBLIC_BASE_URL,
    });
    req.userId = payload.sub as string;
  } catch {
    throw new AuthError('invalid token');
  }
}
