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
  // Opened in the system browser by the desktop app. We must forward Better Auth's Set-Cookie
  // (the OAuth `state`) to the browser, or the Google callback fails with `state_mismatch`.
  app.get('/auth/start', async (_req, reply) => {
    const res = await auth.api.signInSocial({
      body: { provider: 'google', callbackURL: `${env.PUBLIC_BASE_URL}/auth/callback` },
      asResponse: true,
    });
    const cookies = res.headers.getSetCookie?.() ?? [];
    if (cookies.length) reply.header('set-cookie', cookies);

    const location = res.headers.get('location');
    if (location) return reply.redirect(location);
    const data = (await res.json().catch(() => ({}))) as { url?: string };
    if (data.url) return reply.redirect(data.url);
    return reply.status(500).send({ error: 'no_auth_url', code: 'provider_error' });
  });

  // Better Auth completes OAuth and redirects the browser here (with the session cookie). We mint a
  // one-time code and serve a small success page that fires the kairo:// deep link (so the app gets
  // the code) AND leaves the browser on a clean "you can close this" screen — not a spinning tab.
  app.get('/auth/callback', async (req, reply) => {
    const session = await auth.api.getSession({ headers: toHeaders(req) });
    if (!session?.user) return reply.status(401).send({ error: 'no_session', code: 'unauthenticated' });
    const code = await mintCode(session.user.id);
    const deepLink = `kairo://auth-callback?code=${encodeURIComponent(code)}`;
    reply.type('text/html').send(callbackPage(deepLink));
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

/** Browser success page shown after Google OAuth: fires the kairo:// deep link, then rests. */
function callbackPage(deepLink: string): string {
  const safe = deepLink.replace(/"/g, '&quot;');
  return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Signed in — Kairo</title><style>
  :root{color-scheme:dark}
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;background:radial-gradient(130% 90% at 50% -10%,#271b40,#150f21 44%,#0b0810);
    font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#efeaf7}
  .card{text-align:center;padding:40px 44px}
  .orb{width:72px;height:72px;margin:0 auto 26px;border-radius:999px;
    background:radial-gradient(circle at 40% 34%,#fff,#cbb6ff 42%,#7c3aed 100%);
    box-shadow:0 0 40px rgba(163,124,255,.7);animation:b 3s ease-in-out infinite}
  @keyframes b{0%,100%{transform:scale(.94);opacity:.9}50%{transform:scale(1.04);opacity:1}}
  h1{font-size:24px;font-weight:600;margin:0 0 8px}
  p{color:rgba(226,219,242,.65);font-size:15px;margin:0 0 22px;line-height:1.5}
  a{display:inline-block;color:#c9b6ff;font-weight:600;text-decoration:none;font-size:14px}
</style></head><body><div class="card">
  <div class="orb"></div>
  <h1>You're signed in</h1>
  <p>You can close this tab and head back to Kairo.</p>
  <a href="${safe}">Didn't open? Return to Kairo →</a>
</div>
<script>setTimeout(function(){location.href="${safe}"},250);</script>
</body></html>`;
}
