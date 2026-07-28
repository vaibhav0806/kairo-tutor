import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { auth } from './better-auth';
import { db } from '../db/client';
import { mintCode, redeemCode } from './codes';
import { isInvited, markRedeemed } from '../access/service';
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
    const page = () =>
      reply
        .header('cache-control', 'no-store')
        .header(
          'content-security-policy',
          "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        )
        .type('text/html; charset=utf-8');
    if (!session?.user) {
      req.log.warn('auth callback opened without a valid session');
      return page().status(401).send(callbackPage(null));
    }

    // Closed alpha: no invite, no session. The Better Auth user row stays — when they are invited
    // later, the next sign-in just works with no re-signup.
    if (!(await isInvited(session.user.email))) {
      req.log.info('sign-in refused: email not on the alpha invite list');
      return page().status(403).send(callbackPage(null, 'waitlist'));
    }
    await markRedeemed(session.user.email);

    const code = await mintCode(session.user.id);
    const deepLink = `kairo://auth-callback?code=${encodeURIComponent(code)}`;
    req.log.info('auth callback ready for desktop handoff');
    return page().send(callbackPage(deepLink));
  });

  // The app exchanges the one-time code for a durable session token. We create the session row
  // directly (Better Auth 1.6 exposes no server-side createSession); the bearer plugin validates it.
  app.post<{ Body: { code?: string } }>('/auth/exchange', async (req, reply) => {
    const userId = await redeemCode(req.body?.code ?? '');
    if (!userId) return reply.status(400).send({ error: 'bad_code', code: 'bad_request' });

    // Re-check the invite here as well: the callback already gated this, but a code minted before
    // an email was removed must not still buy a 30-day session.
    const owner = await db.execute(sql`SELECT email FROM "user" WHERE id = ${userId}`);
    const email = (owner.rows[0] as { email?: string } | undefined)?.email;
    if (!(await isInvited(email))) {
      req.log.info('exchange refused: email not on the alpha invite list');
      return reply.status(403).send({ error: 'not_invited', code: 'unauthenticated' });
    }

    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db.execute(sql`
      INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at)
      VALUES (${randomUUID()}, ${token}, ${userId}, ${expiresAt}, ${now}, ${now})`);

    return reply.send({ sessionToken: token, expiresAt: expiresAt.toISOString() });
  });
}

/**
 * Browser page shown after Google OAuth. Three outcomes:
 *   - success   → fires the kairo:// deep link so the app receives its one-time code
 *   - 'error'   → the session was missing/expired; offer another try
 *   - 'waitlist'→ signed in fine, but the email is not on the closed-alpha list. This is the ONE
 *                 place that person learns why the app never opened, so it says so plainly and
 *                 does not imply they did anything wrong.
 */
export function callbackPage(deepLink: string | null, state: 'error' | 'waitlist' = 'error'): string {
  const safe = deepLink?.replace(/"/g, '&quot;') ?? '';
  const success = Boolean(deepLink);
  const waitlist = !success && state === 'waitlist';
  // The brand mark, inlined — this page is served from the API host, so it can't reach the
  // desktop bundle's /brand/kairo-mark.svg. Kept in sync with public/brand/kairo-mark.svg.
  const mark = `<svg class="glyph" viewBox="0 0 1024 1024" role="img" aria-label="Kairo"><g transform="translate(0,1024) scale(0.1,-0.1)"><path fill="#5c26f1" d="M3542 9389 c-88 -44 -122 -139 -122 -343 0 -165 14 -233 72 -356 60 -127 118 -207 213 -299 48 -46 85 -84 83 -86 -2 -2 -50 2 -108 7 -58 5 -156 8 -218 6 l-114 -3 -29 -33 c-61 -68 -26 -160 112 -302 49 -49 85 -90 81 -90 -14 0 -253 -140 -337 -198 -383 -261 -722 -651 -963 -1107 -71 -136 -83 -162 -159 -345 -69 -166 -160 -472 -188 -633 -75 -416 -82 -781 -25 -1167 11 -74 22 -151 25 -170 8 -52 68 -261 110 -379 65 -187 224 -482 344 -640 31 -40 65 -85 75 -100 35 -46 258 -265 346 -338 82 -68 173 -130 330 -225 295 -178 694 -310 1170 -387 100 -16 248 -29 580 -51 339 -22 390 -30 471 -70 87 -44 136 -126 159 -262 20 -121 39 -344 45 -528 10 -337 19 -373 96 -429 36 -27 51 -31 103 -31 52 0 70 5 117 34 92 55 378 271 485 365 22 20 60 53 85 75 112 98 345 317 449 424 318 324 476 504 655 747 49 66 118 161 155 210 36 50 104 151 149 225 46 74 94 151 106 170 52 81 206 385 225 445 7 22 16 45 20 50 27 35 143 383 189 570 33 133 32 125 61 355 37 285 43 666 15 895 -6 49 -30 227 -40 293 -15 98 -36 186 -99 402 -148 507 -407 976 -780 1414 -220 260 -526 514 -841 700 -125 74 -447 236 -468 236 -5 0 -70 23 -145 51 -165 62 -582 168 -799 204 -268 44 -418 74 -519 105 -53 17 -107 32 -120 34 -31 6 -160 65 -260 119 -128 69 -334 219 -489 355 -116 102 -209 127 -303 81z"/><path fill="#fefefe" d="M4752 7145 c-239 -25 -527 -89 -717 -160 -284 -106 -560 -289 -749 -496 -456 -498 -663 -1295 -521 -2005 31 -154 71 -268 145 -419 144 -291 360 -485 700 -630 205 -87 522 -152 920 -187 196 -17 943 -17 1155 0 377 31 748 104 956 188 468 189 752 553 848 1084 103 565 -5 1203 -280 1665 -318 534 -854 854 -1590 951 -172 22 -687 28 -867 9z m1815 -2237 c-2 -29 -3 -6 -3 52 0 58 1 81 3 53 2 -29 2 -77 0 -105z"/><path fill="#0f0e1a" d="M4022 5665 c-78 -22 -111 -42 -170 -103 -118 -123 -171 -313 -172 -612 0 -292 58 -489 180 -611 69 -69 119 -92 216 -97 96 -5 138 6 211 55 100 67 177 202 208 366 9 45 18 145 22 222 13 321 -49 557 -184 691 -83 83 -206 118 -311 89z M6082 5670 c-101 -21 -206 -108 -262 -220 -130 -259 -133 -725 -6 -985 45 -92 110 -159 192 -197 60 -28 72 -30 152 -26 105 5 169 35 239 112 123 137 169 328 160 662 -5 212 -21 293 -82 422 -79 167 -241 263 -393 232z"/></g></svg>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${success ? 'Signed in' : waitlist ? 'You’re on the waitlist' : 'Sign-in needs attention'} · Kairo</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Geist:wght@400..700&family=Geist+Mono:wght@500..700&display=swap" rel="stylesheet">
  <style>
    :root{--canvas:#f5f7fb;--paper:#fbfcfe;--ink:#0b0d12;--muted:#626a78;--line:rgb(11 13 18 / 11%);
      --accent:#665cff;--verify:#b8f34a;--rose:#ff796f;--body:"Geist","Avenir Next",sans-serif;
      --display:"Bricolage Grotesque",var(--body);--mono:"Geist Mono",ui-monospace,monospace}
    *{box-sizing:border-box}
    html,body{width:100%;min-height:100%;margin:0}
    body{min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:28px;
      background:radial-gradient(circle at 84% 16%,rgb(184 243 74 / 16%),transparent 25rem),var(--canvas);
      color:var(--ink);font-family:var(--body);font-synthesis:none;-webkit-font-smoothing:antialiased}
    body::before{content:"";position:fixed;inset:0;opacity:.58;pointer-events:none;
      background-image:radial-gradient(circle,rgb(11 13 18 / 18%) .7px,transparent .8px);background-size:23px 23px;
      -webkit-mask-image:linear-gradient(to bottom,transparent 2%,#000 18%,#000 86%,transparent 100%);
      mask-image:linear-gradient(to bottom,transparent 2%,#000 18%,#000 86%,transparent 100%)}
    .shell{position:relative;width:min(100%,620px);margin:auto;transform:translate(-5px,-5px)}
    .spark{position:absolute;z-index:2;border:1px solid var(--ink);transform:rotate(8deg)}
    .spark.one{width:28px;height:28px;right:-11px;top:45px;background:var(--verify)}
    .spark.two{width:15px;height:15px;left:-7px;bottom:63px;background:var(--accent);transform:rotate(-12deg)}
    main{position:relative;overflow:hidden;padding:34px 38px 36px;border:1px solid var(--ink);border-radius:18px;
      background:rgb(251 252 254 / 96%);box-shadow:10px 10px 0 rgb(102 92 255 / 17%)}
    header{display:flex;align-items:center;justify-content:space-between;padding-bottom:26px;border-bottom:1px solid var(--line)}
    .brand{display:inline-flex;align-items:center;gap:9px;font-family:var(--display);font-size:21px;font-weight:740;
      letter-spacing:-.065em;line-height:1;color:var(--ink)}
    .glyph{width:27px;height:27px;display:block}
    .state{display:inline-flex;align-items:center;gap:8px;font:650 11px/1 var(--mono);letter-spacing:.1em;
      text-transform:uppercase;color:var(--muted)}
    .dot{width:8px;height:8px;border-radius:50%;background:${success ? 'var(--verify)' : waitlist ? 'var(--accent)' : 'var(--rose)'};
      box-shadow:0 0 0 4px ${success ? 'rgb(184 243 74 / 18%)' : waitlist ? 'rgb(102 92 255 / 18%)' : 'rgb(255 121 111 / 15%)'}}
    .content{padding:52px 0 44px;max-width:510px}
    .kicker{margin:0 0 13px;font:650 11px/1.2 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
    h1{max-width:500px;margin:0;font-family:var(--display);font-size:clamp(38px,7vw,57px);font-weight:700;
      line-height:.96;letter-spacing:-.06em;color:var(--ink)}
    .copy{max-width:455px;margin:19px 0 0;color:var(--muted);font-size:16px;line-height:1.55}
    footer{display:flex;align-items:center;justify-content:space-between;gap:20px}
    .actions{display:flex;align-items:center;gap:15px}
    a.btn{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 19px;border:1px solid var(--ink);
      border-radius:5px;background:var(--ink);box-shadow:5px 5px 0 rgb(102 92 255 / 20%);color:white;text-decoration:none;
      font-weight:680;transition:transform .18s cubic-bezier(.2,.8,.2,1),box-shadow .18s cubic-bezier(.2,.8,.2,1)}
    a.btn:hover{transform:translate(2px,2px);box-shadow:3px 3px 0 rgb(102 92 255 / 27%)}
    a.text{color:var(--muted);font-size:13px;text-underline-offset:3px}
    .hint{margin:0;font:500 11px/1.45 var(--mono);color:var(--muted);text-align:right}
    @media(max-width:560px){body{padding:20px}.shell{transform:translate(-3px,-3px)}main{padding:26px 24px 28px}
      .content{padding:42px 0 38px}footer{align-items:flex-start;flex-direction:column}.hint{text-align:left}.actions{align-items:flex-start;flex-direction:column}}
    @media(prefers-reduced-motion:no-preference){main{animation:arrive .52s cubic-bezier(.2,.8,.2,1) both}.dot{animation:pulse 1.8s ease-in-out infinite}
      @keyframes arrive{from{opacity:0;transform:translateY(12px) scale(.985)}to{opacity:1;transform:none}}@keyframes pulse{50%{transform:scale(.72)}}}
  </style>
</head>
<body>
  <div class="shell">
    <i class="spark one" aria-hidden="true"></i><i class="spark two" aria-hidden="true"></i>
    <main>
      <header><div class="brand">${mark}<span>kairo</span></div>
        <div class="state"><span class="dot"></span>${success ? 'Secure sign-in complete' : waitlist ? 'Invite required' : 'Sign-in interrupted'}</div></header>
      <section class="content">
        <div class="kicker">${success ? 'Welcome back' : waitlist ? 'Closed alpha' : 'One more try'}</div>
        <h1>${success ? 'You’re in. Kairo is ready.' : waitlist ? 'You’re on the list.' : 'That sign-in didn’t finish.'}</h1>
        <p class="copy">${success
          ? 'Your account is connected securely. Return to the app and pick up exactly where you left off.'
          : waitlist
            ? 'Kairo is in a small closed alpha right now. Your email is on the waitlist — we’ll send an invite as soon as a spot opens, and this same sign-in will just work.'
            : 'The browser session is missing or expired. Start sign-in again and Kairo will bring you straight back.'}</p>
      </section>
      <footer>
        <div class="actions">${success
          ? `<a class="btn" href="${safe}">Return to Kairo&nbsp; →</a>`
          : waitlist
            ? '<a class="btn" href="https://meetkairo.xyz">Back to meetkairo.xyz&nbsp; →</a>'
            : '<a class="btn" href="/auth/start">Try sign-in again&nbsp; →</a><a class="text" href="https://meetkairo.xyz">Visit meetkairo.xyz</a>'}</div>
        <p class="hint">${success ? 'This tab can be closed<br>after Kairo opens.' : waitlist ? 'You can close this tab.<br>We’ll email you.' : 'No account changes<br>were made.'}</p>
      </footer>
    </main>
  </div>
  ${success ? `<script>window.setTimeout(function(){location.href="${safe}"},450)</script>` : ''}
</body>
</html>`;
}
