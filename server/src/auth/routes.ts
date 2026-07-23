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
  // "Editorial Light" to match Kairo's onboarding front door (warm-white card, Instrument Serif
  // display, violet accent). It's a normal browser page (not the CSP-restricted artifact), so a
  // Google Fonts link is fine, with a Georgia fallback if it's blocked.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Signed in — Kairo</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&display=swap" rel="stylesheet" />
<style>
  :root{--accent:#7c3aed}
  *{box-sizing:border-box}
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;padding:24px;
    background:radial-gradient(120% 90% at 50% -10%,#fdfcf9,#f7f4ef 55%,#f1ece3);
    font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#1a1622;-webkit-font-smoothing:antialiased}
  .card{max-width:440px;width:100%;text-align:center;padding:44px 40px 34px;
    background:radial-gradient(120% 90% at 50% -10%,color-mix(in srgb,var(--accent) 8%,#fdfbf7),#faf7f2 55%,#f4efe7);
    border:1px solid rgba(20,16,28,.06);border-radius:28px;
    box-shadow:0 1px 0 rgba(255,255,255,.7) inset,0 40px 90px -32px rgba(30,20,45,.35),0 0 60px -24px color-mix(in srgb,var(--accent) 45%,transparent)}
  /* LOGO SLOT — drop the real Kairo logo (an <img>/inline SVG) in place of this wordmark once ready. */
  .mark{font-family:'Instrument Serif',Georgia,serif;font-size:22px;letter-spacing:.01em;
    color:color-mix(in srgb,var(--accent) 70%,#1a1622)}
  .check{width:54px;height:54px;margin:20px auto 22px;border-radius:999px;display:grid;place-items:center;
    background:linear-gradient(180deg,color-mix(in srgb,var(--accent) 84%,#fff 16%),var(--accent));
    box-shadow:0 12px 28px -8px color-mix(in srgb,var(--accent) 60%,transparent)}
  h1{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:34px;line-height:1.05;margin:0 0 8px}
  p{color:#6b6478;font-size:15.5px;margin:0 0 24px;line-height:1.5}
  a.btn{display:inline-block;text-decoration:none;color:#fff;font-weight:600;font-size:14.5px;padding:12px 26px;border-radius:14px;
    background:linear-gradient(180deg,color-mix(in srgb,var(--accent) 84%,#fff 16%),var(--accent));
    box-shadow:0 1px 0 rgba(255,255,255,.25) inset,0 12px 28px -8px color-mix(in srgb,var(--accent) 65%,transparent)}
  @media (prefers-reduced-motion:no-preference){
    .check{animation:pop .5s cubic-bezier(.22,1,.36,1) both}
    @keyframes pop{from{transform:scale(.7);opacity:0}to{transform:scale(1);opacity:1}}
  }
</style></head><body>
  <div class="card">
    <div class="mark">Kairo</div>
    <div class="check" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" width="26" height="26"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <h1>You're all set</h1>
    <p>You're signed in. Head back to Kairo — this tab will close itself.</p>
    <a class="btn" href="${safe}">Return to Kairo →</a>
  </div>
  <script>setTimeout(function(){location.href="${safe}"},250);</script>
</body></html>`;
}
