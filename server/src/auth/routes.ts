import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { auth } from './better-auth';
import { db } from '../db/client';
import { mintCode, redeemCode } from './codes';
import { env } from '../config/env';

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

function toHeaders(req: FastifyRequest): Headers {
  const h = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') h.set(key, value);
    else if (Array.isArray(value)) h.set(key, value.join(', '));
  }
  return h;
}

/**
 * The three routes the desktop drives for the `kairo://` deep-link handshake.
 * The system browser does Google OAuth; the app only ever sees a one-time code, which it
 * exchanges over HTTPS for a durable session token (stored in the macOS Keychain).
 */
export async function ownedAuthRoutes(app: FastifyInstance) {
  // Opened in the system browser by the desktop app.
  app.get('/auth/start', async (_req, reply) => {
    const result = await auth.api.signInSocial({
      body: { provider: 'google', callbackURL: `${env.PUBLIC_BASE_URL}/auth/callback` },
    });
    const url = (result as { url?: string }).url;
    if (!url) return reply.status(500).send({ error: 'no_auth_url', code: 'provider_error' });
    return reply.redirect(url);
  });

  // Better Auth completes OAuth and redirects the browser here (with the session cookie).
  // We mint a one-time code and hand it to the app via the custom scheme — never a token in the URL.
  app.get('/auth/callback', async (req, reply) => {
    const session = await auth.api.getSession({ headers: toHeaders(req) });
    if (!session?.user) return reply.status(401).send({ error: 'no_session', code: 'unauthenticated' });
    const code = await mintCode(session.user.id);
    return reply.redirect(`kairo://auth-callback?code=${encodeURIComponent(code)}`);
  });

  // The app exchanges the one-time code for a durable session token. We create the session row
  // directly (Better Auth 1.6 exposes no server-side createSession); the bearer plugin validates it.
  app.post<{ Body: { code?: string } }>('/auth/exchange', async (req, reply) => {
    const userId = await redeemCode(req.body?.code ?? '');
    if (!userId) return reply.status(400).send({ error: 'bad_code', code: 'bad_request' });

    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db.execute(sql`
      INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at)
      VALUES (${randomUUID()}, ${token}, ${userId}, ${expiresAt}, ${now}, ${now})`);

    return reply.send({ sessionToken: token, expiresAt: expiresAt.toISOString() });
  });
}
