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
  // The brand mark, inlined — this page is served from the API host, so it can't reach the
  // desktop bundle's /brand/kairo-mark.svg. Kept in sync with public/brand/kairo-mark.svg.
  const mark = `<svg class="glyph" viewBox="0 0 1024 1024" role="img" aria-label="Kairo"><g transform="translate(0,1024) scale(0.1,-0.1)"><path fill="#5c26f1" d="M3542 9389 c-88 -44 -122 -139 -122 -343 0 -165 14 -233 72 -356 60 -127 118 -207 213 -299 48 -46 85 -84 83 -86 -2 -2 -50 2 -108 7 -58 5 -156 8 -218 6 l-114 -3 -29 -33 c-61 -68 -26 -160 112 -302 49 -49 85 -90 81 -90 -14 0 -253 -140 -337 -198 -383 -261 -722 -651 -963 -1107 -71 -136 -83 -162 -159 -345 -69 -166 -160 -472 -188 -633 -75 -416 -82 -781 -25 -1167 11 -74 22 -151 25 -170 8 -52 68 -261 110 -379 65 -187 224 -482 344 -640 31 -40 65 -85 75 -100 35 -46 258 -265 346 -338 82 -68 173 -130 330 -225 295 -178 694 -310 1170 -387 100 -16 248 -29 580 -51 339 -22 390 -30 471 -70 87 -44 136 -126 159 -262 20 -121 39 -344 45 -528 10 -337 19 -373 96 -429 36 -27 51 -31 103 -31 52 0 70 5 117 34 92 55 378 271 485 365 22 20 60 53 85 75 112 98 345 317 449 424 318 324 476 504 655 747 49 66 118 161 155 210 36 50 104 151 149 225 46 74 94 151 106 170 52 81 206 385 225 445 7 22 16 45 20 50 27 35 143 383 189 570 33 133 32 125 61 355 37 285 43 666 15 895 -6 49 -30 227 -40 293 -15 98 -36 186 -99 402 -148 507 -407 976 -780 1414 -220 260 -526 514 -841 700 -125 74 -447 236 -468 236 -5 0 -70 23 -145 51 -165 62 -582 168 -799 204 -268 44 -418 74 -519 105 -53 17 -107 32 -120 34 -31 6 -160 65 -260 119 -128 69 -334 219 -489 355 -116 102 -209 127 -303 81z"/><path fill="#fefefe" d="M4752 7145 c-239 -25 -527 -89 -717 -160 -284 -106 -560 -289 -749 -496 -456 -498 -663 -1295 -521 -2005 31 -154 71 -268 145 -419 144 -291 360 -485 700 -630 205 -87 522 -152 920 -187 196 -17 943 -17 1155 0 377 31 748 104 956 188 468 189 752 553 848 1084 103 565 -5 1203 -280 1665 -318 534 -854 854 -1590 951 -172 22 -687 28 -867 9z m1815 -2237 c-2 -29 -3 -6 -3 52 0 58 1 81 3 53 2 -29 2 -77 0 -105z"/><path fill="#0f0e1a" d="M4022 5665 c-78 -22 -111 -42 -170 -103 -118 -123 -171 -313 -172 -612 0 -292 58 -489 180 -611 69 -69 119 -92 216 -97 96 -5 138 6 211 55 100 67 177 202 208 366 9 45 18 145 22 222 13 321 -49 557 -184 691 -83 83 -206 118 -311 89z M6082 5670 c-101 -21 -206 -108 -262 -220 -130 -259 -133 -725 -6 -985 45 -92 110 -159 192 -197 60 -28 72 -30 152 -26 105 5 169 35 239 112 123 137 169 328 160 662 -5 212 -21 293 -82 422 -79 167 -241 263 -393 232z"/></g></svg>`;
  // Styled to match meetkairo.xyz and the desktop app: cool canvas + dot field, Bricolage display,
  // Geist body, near-square edges, and the site's hard violet offset shadow. It's a normal browser
  // page (not the CSP-restricted artifact), so a Google Fonts link is fine, with system fallbacks
  // if it's blocked.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Signed in — Kairo</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Geist:wght@400..700&display=swap" rel="stylesheet" />
<style>
  /* Tokens copied from the website (kairo/src/styles.css). */
  :root{--canvas:#f5f7fb;--canvas-raised:#fbfcfe;--ink:#0b0d12;--ink-strong:#08090c;
    --ink-muted:#626a78;--hairline:rgb(11 13 18 / 10%);--kairo:#665cff;--verify:#b8f34a;
    --body:"Geist",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    --display:"Bricolage Grotesque",var(--body)}
  *{box-sizing:border-box}
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;padding:24px;position:relative;
    background:var(--canvas);font-family:var(--body);color:var(--ink);
    font-synthesis:none;-webkit-font-smoothing:antialiased}
  /* The site's hero dot field. */
  body::before{content:"";position:fixed;inset:0;opacity:.5;pointer-events:none;
    background-image:radial-gradient(circle,rgb(11 13 18 / 17%) .7px,transparent .8px);
    background-size:23px 23px;
    -webkit-mask-image:linear-gradient(to bottom,transparent 2%,#000 18%,#000 86%,transparent 100%);
    mask-image:linear-gradient(to bottom,transparent 2%,#000 18%,#000 86%,transparent 100%)}
  .card{position:relative;max-width:440px;width:100%;text-align:center;padding:40px 40px 34px;
    background:var(--canvas-raised);border:1px solid var(--hairline);border-radius:14px;
    box-shadow:7px 7px 0 rgb(102 92 255 / 19%)}
  /* The lockup: the brand mark beside the site's lowercase wordmark. */
  .mark{display:inline-flex;align-items:center;gap:9px;
    font-family:var(--display);font-size:21px;font-weight:740;letter-spacing:-.065em;
    line-height:1;color:var(--ink-strong)}
  .glyph{width:26px;height:26px;display:block}
  .check{width:52px;height:52px;margin:22px auto 20px;border-radius:999px;display:grid;place-items:center;
    background:var(--verify);border:1px solid color-mix(in srgb,var(--verify) 70%,var(--ink))}
  h1{font-family:var(--display);font-weight:670;font-size:38px;line-height:.95;letter-spacing:-.055em;
    margin:0 0 10px;color:var(--ink-strong)}
  p{color:var(--ink-muted);font-size:15.5px;margin:0 0 26px;line-height:1.62}
  a.btn{display:inline-block;text-decoration:none;color:#fff;font-weight:680;font-size:14.5px;
    padding:14px 22px;border:1px solid var(--ink-strong);border-radius:3px;background:var(--ink-strong);
    box-shadow:7px 7px 0 rgb(102 92 255 / 19%);
    transition:transform 180ms cubic-bezier(.2,.8,.2,1),box-shadow 180ms cubic-bezier(.2,.8,.2,1)}
  a.btn:hover{transform:translate(3px,3px);box-shadow:4px 4px 0 rgb(102 92 255 / 26%)}
  @media (prefers-reduced-motion:no-preference){
    .check{animation:pop .5s cubic-bezier(.22,1,.36,1) both}
    @keyframes pop{from{transform:scale(.7);opacity:0}to{transform:scale(1);opacity:1}}
  }
  @media (prefers-reduced-motion:reduce){a.btn{transition:none}}
</style></head><body>
  <div class="card">
    <div class="mark">${mark}<span>kairo</span></div>
    <div class="check" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" width="25" height="25"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="#0b0d12" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <h1>You're all set</h1>
    <p>You're signed in. Head back to Kairo — this tab will close itself.</p>
    <a class="btn" href="${safe}">Return to Kairo →</a>
  </div>
  <script>setTimeout(function(){location.href="${safe}"},250);</script>
</body></html>`;
}
