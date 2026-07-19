# Kairo Tutor — Auth + Billing + Onboarding: Design & Plan

**Date:** 2026-07-19
**Status:** Draft for review (design phase — no code yet)
**Scope:** Add Google-only auth, usage metering + paid billing, and a first-run onboarding
flow to the Kairo Tutor macOS app, plus the backend spine that makes metering possible,
a monorepo restructure, a focused frontend refactor, and agent-rules files for Claude
Code + Codex.

> Source research: six parallel deep-dive agents (2026-07-19) covering Rust/native,
> frontend, monorepo, Fastify backend, billing/metering, and agent-rules. This doc is the
> reconciled synthesis + the phased build plan.

---

## 1. Why this shape (the one load-bearing fact)

A free tier (10 requests) + paid tiers on a **distributed DMG** forces a backend that holds
the real provider keys and proxies every AI call. Shipping keys in the app = they get
extracted; a client-side counter = trivially reset. So the whole feature hangs on one new
thing: **desktop app → our backend (auth + proxy + meter) → AI providers**, with Dodo bolted
onto the backend for money.

Everything the user asked for (Google sign-in, 10-free-then-paid, in-app onboarding) is a
consequence of that spine.

---

## 2. Locked decisions

| Area | Decision | One-line why |
|---|---|---|
| Auth | **Self-hosted Better Auth**, Google-only | MIT, runs in our monolith → nothing for OSS contributors to sign up for; its JWT+JWKS plugin *is* our stateless per-request proxy-verify; Dodo ships an official Better Auth adapter. Beats WorkOS (proprietary SaaS) and Neon Auth (Beta; doesn't support our desktop+separate-backend shape). |
| DB | **Neon Postgres** (Postgres only, not Neon Auth) | Already chosen; Better Auth + our tables share one DB. |
| Backend | **Node + Fastify** monolith on **Hetzner**, same repo | Modern/fast; always-on fits streaming TTS + large payloads better than serverless. |
| ORM | **Drizzle** (+ `pg` node-postgres pooled driver) | Better Auth CLI first-classes Drizzle; one migration history for auth + app tables. |
| Payments | **Dodo Payments** (Merchant of Record) via `@dodopayments/better-auth` | MoR handles global tax/VAT/GST + chargebacks; the plugin mounts checkout/portal/webhooks for us. |
| Repo | **Monorepo, fully open source.** Desktop stays at root; add `server/` + `packages/shared/`; **npm workspaces** | Least disruption to the signed Tauri build; lowest ceremony. |
| Agent rules | **`AGENTS.md` canonical + `CLAUDE.md` = `@AGENTS.md` stub** | Codex reads AGENTS.md natively, Claude Code reads CLAUDE.md; import (not symlink) is OSS/Windows-safe. |
| Free tier | **10 lifetime requests**, no reset | Each ask is premium-model COGS; a monthly reset bleeds money + kills conversion. |
| Paid tier | **One "Kairo Pro" plan**, monthly + yearly Dodo products, unlimited (soft fair-use) | Keep it simple; Teams/seats is a future add. |
| Client secrets | **Zero.** Client holds only `KAIRO_BACKEND_URL` + Keychain tokens | Fresh clone runs keyless — an OSS win. |

---

## 3. Architecture: the spine + three flows

```
Tauri desktop app  ──►  Fastify monolith (Hetzner, same repo, server/)  ──►  Neon Postgres
   (existing)             ├─ Better Auth   (Google-only, JWT/JWKS)             (Better Auth tables
   holds only:            ├─ AI proxy      (holds ALL provider keys)            + our billing/usage)
   • KAIRO_BACKEND_URL    ├─ usage meter   (10 free, atomic gate)
   • Keychain tokens      └─ Dodo          (checkout + portal + webhooks, MoR)
                                 │
                          providers: OpenRouter / Anthropic / OpenAI / Sarvam / ElevenLabs
                          keys live ONLY on Hetzner — never in the DMG
```

**Flow A — Sign-in (once):**
1. App opens the **system browser** at `GET {backend}/auth/start`.
2. Backend → Google consent → `GET {backend}/auth/callback` (Better Auth creates the user/session).
3. Backend mints a **one-time code** (≤60 s TTL) and 302s to **`kairo://auth-callback?code=…`**.
4. macOS routes the deep link to the running app → Rust `POST {backend}/auth/exchange {code}` over HTTPS → `{ sessionToken, expiresAt }`.
5. Rust stores `sessionToken` (+ refresh) in the **macOS Keychain**; emits `auth:changed`.

**Flow B — Every AI ask:**
1. Rust fetches a short-lived **15-min JWT** from `POST {backend}/api/auth/token` (bearer = sessionToken), cached in-process, re-fetched on 401.
2. Each provider call now targets the backend with `Authorization: Bearer <jwt>`.
3. Fastify verifies the JWT via **JWKS (no DB hit)**; on the **metered** call it atomically reserves one unit; then injects the real provider key and forwards/streams.
4. Over the free limit → **`402 {code:"quota_exceeded"}`** → app shows paywall.

**Flow C — Upgrade:**
1. Paywall → app opens the Dodo **checkout URL** in the browser (`POST /api/auth/dodopayments/checkout`).
2. User pays (Dodo = MoR, handles tax) → Dodo **webhook** → backend verifies + flips the user to Pro in Neon.
3. App re-polls `GET /v1/me` (or catches a `kairo://billing-done` deep link) → paywall lifts.

---

## 4. Monorepo layout

Keep the desktop app at repo root (moving `src/`/`src-tauri/` would churn every hardcoded
build/sign path + `tauri.conf.json` `frontendDist: "../dist"` for zero benefit; TCC is
identity-keyed so nothing about grants changes either way). Add two siblings.

```
kairo-tutor/                 # repo root = DESKTOP package + workspace root
├── package.json             # desktop scripts UNCHANGED + new "workspaces": ["server","packages/*"]
├── AGENTS.md                # canonical shared + desktop rules (was CLAUDE.md content)
├── CLAUDE.md                # stub: "@AGENTS.md" (+ Claude-only notes)
├── src/                     # desktop React frontend — stays
├── src-tauri/               # desktop Rust/native — stays
├── scripts/  tests/  docs/  # unchanged paths
├── server/                  # NEW Fastify backend (own package.json + .env + AGENTS.md/CLAUDE.md stub)
└── packages/
    └── shared/              # NEW TS-only DTOs shared desktop-frontend ↔ server (no build step)
```

- **Tooling:** npm workspaces (keeps `npm run app` / `npm run tauri:build` verbatim; Tauri auto-detects npm from the lockfile). pnpm only later if we want hard phantom-dep isolation.
- **Shared types:** `packages/shared` exports `./src/index.ts` directly (Vite + tsc consume TS source; wired via tsconfig project references). Rust stays hand-mirrored — **no Rust↔TS codegen** yet (same pattern as today's `constants.rs` ↔ `env.ts`).
- **Root scripts add:** `server:dev|build|start`, `db:generate|migrate`, `typecheck:all`, `test:all` (delegating via `-w @kairo/server`). Desktop scripts untouched.

---

## 5. Backend design (`server/`)

### 5.1 Module tree (domain-first, thin files)

```
server/src/
  index.ts                 # listen(); graceful shutdown
  app.ts                   # buildApp(): plugins → routes → error handler (unit-testable)
  config/env.ts            # zod-parsed secrets + PORT + DATABASE_URL (fail-fast)
  config/providers.ts      # capability→{provider,baseUrl,model,effort,timeoutMs,keyEnv,authHeader}  (server mirror of constants.rs)
  db/client.ts             # pg.Pool (Neon POOLED url, ssl) + drizzle singleton
  db/migrate.ts            # programmatic migrator (deploy step)
  db/schema/{auth,billing,usage,index}.ts
  plugins/logger.ts        # pino, structured, NO secrets/media (same discipline as klog)
  plugins/raw-body.ts      # preserve raw Buffer for /api/auth/* (webhook HMAC needs exact bytes)
  plugins/auth-verify.ts   # request.userId via cached JWKS (jose) — NO DB on hot path
  plugins/metering.ts      # reply.reserve()/refund()
  plugins/error-handler.ts # uniform {error,code}; QuotaExceeded→402
  auth/better-auth.ts      # betterAuth(): google-only, jwt(), bearer(), dodopayments()
  auth/routes.ts           # catch-all /api/auth/*  +  our /auth/start, /auth/callback, /auth/exchange
  auth/service.ts          # one-time code mint/verify; google url builder
  usage/routes.ts          # GET /v1/me
  usage/service.ts         # atomic reserve/refund/ensureCounter
  billing/service.ts       # entitlementSync(event) → flip plan, upsert subscription (idempotent + ordered)
  billing/webhook.ts       # dormant self-hosted fallback (if not using the plugin's route)
  proxy/guard.ts           # composed preHandlers: verifyJwt (all) + meter (tutor route only)
  proxy/llm.ts             # POST /v1/llm/chat, /v1/vision/tutor⭑, /v1/vision/point
  proxy/speech.ts          # POST /v1/stt (multipart), /v1/tts (json), /v1/tts/stream (PCM)
  proxy/forward.ts         # undici request: inject key+headers, per-provider timeout, pass body through
  proxy/stream.ts          # pipe upstream chunked body → reply (backpressure-safe)
  health/routes.ts         # /healthz, /readyz
  lib/http.ts              # shared keep-alive undici Agent (mirror reqwest warm pool)
  lib/errors.ts            # QuotaExceededError, ProviderError, AuthError
```

### 5.2 Auth wiring (Google-only, JWT/JWKS)

- `betterAuth()` with `drizzleAdapter(db,{provider:'pg'})`, `socialProviders.google`, `trustedOrigins:['kairo://']`, and plugins `jwt({ expirationTime:'15m', definePayload:({user})=>({sub:user.id,email:user.email}) })`, `bearer()`, `dodopayments(...)`.
- Mount Better Auth on a catch-all `['GET','POST'] /api/auth/*` → `auth.handler` (official Fastify pattern; `fastify-better-auth` is an optional convenience). This exposes `/api/auth/{jwks,token,callback/google,sign-in/social,sign-out,dodopayments/*}` for free.
- **We own three routes** for the desktop deep-link flow: `/auth/start` (→ Google), `/auth/callback` (→ mint one-time code → `kairo://auth-callback?code=…`), `/auth/exchange` (`{code}`→`{sessionToken,expiresAt}`).
- **Two tokens:** long-lived **sessionToken** (Keychain; used on Better Auth + billing endpoints via `bearer()`), short-lived **JWT** (proxy hot path; JWKS-verified, zero DB). Never put the JWT in the deep-link URL — only the one-time code.

### 5.3 AI proxy (the hard part)

**Shape = authenticated, key-injecting passthrough, grouped by capability.** The desktop sends
the same provider-shaped body it builds today *minus the key*; the backend injects the real
key + attribution headers, meters (on the one metered route), forwards, and streams/returns.
This keeps all the sophisticated Rust post-processing (grounding, box→display-point mapping)
untouched and makes the desktop change tiny.

- Per-provider timeouts mirrored from `constants.rs` (OpenRouter 45s, gate 12s, grounding 15s, TTS 45s), applied as undici `headersTimeout`/`bodyTimeout`.
- **Streaming TTS:** `reply.hijack()` + `pipeline(upstream.body, reply.raw)` — never `await` the whole body (first bytes ~200–400 ms). Must **propagate the client's mid-stream disconnect upstream** (barge-in) so we stop paying Sarvam.
- **Large payloads:** raise `bodyLimit` to 16 MB on proxy routes (base64 screenshots ~80 KB, high-DPI safe); STT stays multipart via `@fastify/multipart`.
- Keep a warm keep-alive `undici.Agent` to provider hosts (mirror `shared_http_client` pool tuning) so the first ask after a lull skips the cold TLS handshake.

### 5.4 Dodo wiring

- Use `@dodopayments/better-auth` as a subplugin: `checkout({products:[{productId,slug:'pro'}], successUrl:'kairo://billing-done', authenticatedUsersOnly:true})`, `portal()`, `webhooks({ webhookKey, onPayload: entitlementSync })`, `createCustomerOnSignUp:true`.
- The plugin handles route mounting + Standard-Webhooks HMAC verification; **our `entitlementSync` owns the state machine** (§6.4) writing our `subscription` + `usage_counter` tables with idempotency + ordering + reconciliation.
- **Raw-body gotcha:** the webhook HMAC is over exact raw bytes → `plugins/raw-body.ts` must preserve the untouched Buffer for `/api/auth/*` before the handler runs.

### 5.5 Endpoint surface (what the desktop calls)

- **Auth:** `GET /auth/start`, `GET /auth/callback`, `POST /auth/exchange`, `POST /api/auth/token`, `GET /api/auth/jwks`, `POST /api/auth/sign-out`.
- **Me/usage:** `GET /v1/me` → `{ plan, status, usage:{used,limit,remaining}, renews_at, cancel_at_period_end, paywalled }`.
- **Proxied AI** (all JWT-gated; only ⭑ metered): `POST /v1/llm/chat`, ⭑`POST /v1/vision/tutor`, `POST /v1/vision/point`, `POST /v1/stt` (multipart), `POST /v1/tts` (json), `POST /v1/tts/stream` (PCM).
- **Billing** (sessionToken): `POST /api/auth/dodopayments/checkout`, `GET/POST /api/auth/dodopayments/customer/portal`, `POST /api/auth/dodopayments/webhooks` (called by Dodo).
- **Health:** `GET /healthz`, `GET /readyz`.

---

## 6. Data model + metering

### 6.1 What counts as "1 request"

**1 metered unit = one whole top-level user ask** (STT + gate + vision + TTS + grounding
fan-out). Follow-along `ack`/`follow` continuation turns within a guided session are **free**.

Implementation: **meter exactly one endpoint — ⭑`/v1/vision/tutor`** (the answer+box turn).
It fires exactly once per ask and is the expensive unit, and it is NOT reused by gate/ack/
follow — so no ambiguity and no need to thread an idempotency id through all 12 call sites.
The desktop mints an **`ask_id`** per ask and sends it (`X-Kairo-Ask-Id`) **only on the tutor
turn**, for retry idempotency + refunds. Gate/STT/TTS/point stay JWT-gated but unmetered
(they exist only to keep keys server-side).

### 6.2 Schema (Drizzle → Neon)

Better Auth owns `user`/`session`/`account`/`verification`/`jwks` (generated by its CLI; do not modify). Our tables:

```sql
CREATE TYPE plan_t       AS ENUM ('free','pro');
CREATE TYPE sub_status_t AS ENUM ('none','pending','active','on_hold','cancelled','failed','expired');

-- Hot-path counter. "used N of 10" + denormalized plan live HERE (O(1) gate, no join).
CREATE TABLE usage_counter (
  user_id    text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  plan       plan_t  NOT NULL DEFAULT 'free',      -- kept in sync by entitlementSync
  used_free  integer NOT NULL DEFAULT 0 CHECK (used_free >= 0),
  free_limit integer NOT NULL DEFAULT 10,          -- per-user; bump for comps/referrals
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotency + refund ledger. One row per ask attempt.
CREATE TABLE usage_event (
  ask_id     uuid PRIMARY KEY,                      -- client-minted; idempotency key
  user_id    text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  counted    boolean NOT NULL DEFAULT true,         -- false once refunded
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON usage_event (user_id, created_at);

-- Billing source of truth (one row per user, upserted).
CREATE TABLE subscription (
  user_id              text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  status               sub_status_t NOT NULL DEFAULT 'none',
  dodo_subscription_id text UNIQUE,
  dodo_customer_id     text,
  dodo_product_id      text,
  current_period_end   timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  last_event_at        timestamptz,                 -- out-of-order webhook guard
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON subscription (dodo_customer_id);
CREATE INDEX ON subscription (status, current_period_end);   -- reconciliation sweep

-- Webhook idempotency.
CREATE TABLE webhook_event (
  webhook_id  text PRIMARY KEY,                      -- from `webhook-id` header
  type        text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload     jsonb NOT NULL
);

-- One-time deep-link auth codes.
CREATE TABLE oauth_code (
  code       text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used       boolean NOT NULL DEFAULT false
);
```

Seed `usage_counter` + `subscription` eagerly in a Better Auth after-signup hook.

### 6.3 Atomic enforcement (reserve-before, refund-on-failure)

```sql
-- Reserve (inside one txn on the metered route):
INSERT INTO usage_event (ask_id, user_id) VALUES ($ask_id,$uid)
  ON CONFLICT (ask_id) DO NOTHING RETURNING ask_id;   -- no row = replay → ALLOW, proceed
UPDATE usage_counter
   SET used_free = used_free + 1, updated_at = now()
 WHERE user_id = $uid AND (plan = 'pro' OR used_free < free_limit)
RETURNING used_free, plan;                            -- no row = limit hit → 402
```
Single conditional `UPDATE … WHERE … RETURNING` = race-free under concurrency (row lock), no
`SELECT`-then-`UPDATE`. **Pro users skip the block** (entitlement checked first).

**Reserve before** the provider fan-out (must decide before spending). **Refund only** on an
all-provider / our-side failure or empty-STT (a known failure mode) — keyed by `ask_id` so a
retried failure can't double-refund:
```sql
UPDATE usage_event SET counted=false WHERE ask_id=$ask_id AND counted=true RETURNING ask_id;
UPDATE usage_counter SET used_free=GREATEST(used_free-1,0) WHERE user_id=$uid AND plan<>'pro';
```

### 6.4 Dodo entitlement sync + reconciliation

- **Products in Dodo = paid only** (Pro monthly + Pro yearly). Free is 100% our Neon state.
- One `applyDodoState(event)` mapper, called by **both** the webhook and reconciliation:
  - `active`/`renewed` → `plan=pro`, `status=active`, extend `current_period_end`.
  - `plan_changed` → update product/period.
  - `on_hold` → keep `pro` during dunning grace, then free.
  - `cancelled` → `status=cancelled`, keep Pro **until** `current_period_end`.
  - `expired`/`failed`/`refund`/`dispute` → `plan=free`.
- **Entitlement resolver** (the only thing the hot path + `/me` consult): `isPro = active OR (cancelled AND now<current_period_end) OR (on_hold AND now<current_period_end+3d)`. Sync flips `usage_counter.plan` accordingly.
- **Idempotency:** dedupe on `webhook_event.webhook_id`. **Ordering:** apply only if event timestamp ≥ `subscription.last_event_at`. Verify HMAC over `${timestamp}.${rawBody}`, reject >5 min old.
- **Reconciliation (missed webhook):** (a) on-read self-heal in `/v1/me` when the row looks stale → `GET /subscriptions/{id}`; (b) periodic cron sweep over `status IN (active,on_hold,cancelled) AND current_period_end < now()+grace`.

### 6.5 App contracts

- `GET /v1/me` → `{ user:{id,email}, plan, status, usage:{used,limit,remaining|null}, renews_at|null, cancel_at_period_end, paywalled }` (remaining=null, renews_at set for Pro).
- `402 Payment Required` on the metered route when free is exhausted → `{ error:"free_limit_reached", plan:"free", usage:{...}, checkout:{monthly_url,yearly_url} }`. Emitted **before** any provider call, so an exhausted user never triggers paid COGS.

---

## 7. Native / desktop changes (Rust)

All 12 provider call sites live in Rust; the frontend never calls a provider directly. So the
proxy migration is **~95% a Rust change**.

- **Re-point (mechanical, per site):** base URL → backend route (request path stays byte-identical, so provider bodies + all parsers are unchanged); **drop** the provider auth header + `provider_env_optional("*_API_KEY")` reads; **attach** `Authorization: Bearer <jwt>`. Centralize in one helper `backend_request(client, path)` in `tutor.rs`; add `X-Kairo-Ask-Id` **only** on the tutor turn.
- **Secrets after:** client keeps only a new committed `KAIRO_BACKEND_URL` constant + Keychain tokens. Delete all six `*_API_KEY` reads + `.env.example` entries; replace the six provider base-URL constants with `KAIRO_BACKEND_URL`; `prewarm_http_connections` warms one host. Keep model-name constants (backend whitelists).
- **Deep link:** `tauri-plugin-deep-link` v2 → `plugins.deep-link.desktop.schemes=["kairo"]` (injects `CFBundleURLTypes`). **No entitlement needed** (custom scheme ≠ universal link) → `Entitlements.plist` unchanged, TCC + stable signing untouched. Register `on_open_url` in `lib.rs` setup; the handler must **not** foreground/`set_activation_policy(Regular)` (preserve the Accessory/NSPanel design); parse code → exchange → Keychain → `app.emit("auth:changed")`. Redact the code in logs.
- **Keychain:** `keyring` v3 (one API, Windows-ready for the planned platform), service `com.kairo.tutor`, items `session`+`refresh`, `kSecAttrAccessibleAfterFirstUnlock`. Reading the app's own items = no TCC prompt, persists across rebuilds via the stable cert. New commands: `start_google_auth()`, `get_auth_status()`, `sign_out()` (keep the token setter internal to the deep-link handler; the frontend never sees the raw token).
- **Typed errors:** replace flat provider error strings with `{code: "quota_exceeded"|"unauthenticated"|"offline"}` so the notch can branch to paywall / sign-in / offline distinctly.
- **Token refresh:** proactive (background/on-focus) + refresh-once-on-401-then-retry; never read the token in the cpal audio callback or the CGEventTap runloop.

---

## 8. Frontend changes + refactor

### 8.1 Auth + onboarding + paywall

- **Auth state truth = Rust/Keychain** (the 4 WebViews share no JS state). New `src/core/auth.ts` = bridge wrappers (`startGoogleAuth/getAuthState/signOut`) + a `useAuth()` hook that reads initial state and subscribes to the `auth:changed` Tauri event. Reusable by `App.tsx` and `NotchApp.tsx`.
- **Screens render in the main window** (`App.tsx`, label `main`), internal step state — **not** a new WebView. Onboarding = **(1) Sign in with Google → (2) Grant permissions (existing FEATURE.md §6.2 UI verbatim) → (3) Ready / show shortcuts.** Sign-in first, so a metering identity exists before any tutor turn.
- **Paywall:** soft "N free left / Upgrade" in the main-window account area (+ optional compact notch state); hard paywall when the metered turn returns `402` → notch shows "Out of free tutors — open Kairo to upgrade" and focuses the main window, which opens the Dodo checkout in the browser; returns via `kairo://billing-done`.
- The one request-flow touch: `core/runtimePlanner.ts` + `core/tutorErrors.ts` gain a typed `quota_exceeded`/`auth_required` branch instead of the generic "AI unavailable".

### 8.2 Focused refactor (behavior-preserving; do the ★ moves)

- ★ **Split `notch/NotchApp.tsx` (2498 lines)** into a thin view + hooks (`useTutorLoop`, `useVoiceCapture`, `useStepPlayback`, `useGateTurn`, `useAnnotationToolbar`). Biggest single win; also what makes the notch paywall reaction tractable.
- ★ **Extract a `tutor/` feature** (the app-wide runtime that isn't notch UI): move `notch/notchTutor.ts`→`tutor/askTutor.ts`, plus `followAlong.ts`, `pointerWatch.ts`, and `core/{orchestrator,runtimePlanner,tutorErrors,mockTutor}.ts`.
- ★ **Fix the `server/providers/` lie:** move the still-used parser `tutorPlanner.ts`→`tutor/tutorResponse.ts`; relocate the dead-at-runtime Node adapters to `providers-node/` (test-only) or delete.
- ★ **Extract `speech/`** (voiceRecorder, streamingTts, audioPlayback) and **`gesture/`** out of `notch/`.
- ★ **Split `App.tsx` (720)** into `main/MainWindow.tsx` + onboarding steps; add the `auth/` feature folder.
- (opt) slice `native/nativeBridge.ts` (631) into domain files re-exported from one index — do it opportunistically when adding the auth bridge methods.

---

## 9. Agent rules (Claude Code + Codex)

- **Single source of truth:** `AGENTS.md` canonical at each level; each `CLAUDE.md` is a one-line `@AGENTS.md` import stub (import, not symlink — safe across OSes for OSS contributors). Codex reads AGENTS.md natively; both tools nest per-directory.
- **Layout (reconciled with the root-stays repo):** root `AGENTS.md` = shared/monorepo rules **+** the existing desktop rules (root *is* the desktop package); `server/AGENTS.md` = backend rules (loaded on demand when working in `server/`). Convert today's `CLAUDE.md` → root `AGENTS.md`; add the shared sections; make `CLAUDE.md` the stub; add `server/AGENTS.md` + `server/CLAUDE.md` stub.
- **Root `AGENTS.md` sections:** what Kairo is; monorepo map + "which package → which rules"; **open-source secret hygiene** (`.env` = keys only, gitignored; never commit secrets/tokens); commit discipline (main branch, commit-as-you-go, Co-Authored-By); **Dodo test-mode-only**; how to run things (desktop `npm run app`; server scripts); mandatory logging; enforcement pointers. Keep the desktop deep-rules (klog, `.app` build, `constants.rs`, panels/TCC, native-capability checklist, test gate) here since desktop = root.
- **`server/AGENTS.md`:** Fastify conventions + schema validation + request-id logging (never log secrets/tokens/PII/auth headers); Neon migrations (forward-only, checked in, reviewed in-PR, dry-run on a Neon branch, never agent-applied to prod); Better Auth patterns; **Dodo test-mode-only, live keys only on Hetzner, verify webhook signatures**; request-metering rules; test/verify gate.
- **Enforcement (files are guidance, not a wall):** back the mandatory rules with CI (gitleaks/trufflehog secret scan; a live-Dodo-key-prefix check; a `console.*`/`println!` log-lint; migration dry-run on a Neon branch), a pre-commit hook (lefthook/husky) running the same scans, branch protection on `server/drizzle/**`, and Claude Code `PreToolUse` hooks blocking writes to `.env`. CI + git hooks are the cross-tool wall since Codex lacks Claude's hook model.

---

## 10. Two decisions to confirm (my recommendation in bold)

1. **Metering point:** **meter only the `/v1/vision/tutor` answer turn** (= clean "10 free asks", no idempotency threading across all calls) vs meter every provider call (burns 10 in ~2 asks — rejected) vs a single semantic `POST /v1/ask` (backend owns the fan-out).
2. **Proxy API shape:** **passthrough-first** (key-injecting per-capability proxy; tiny Rust change; grounding/orchestration stays in Rust) vs a fully-semantic `/v1/ask` now (would relocate the whole notch orchestration brain — step playback, barge-in, follow-along — into the backend = large rewrite + latency risk).

Both recommendations favor the smallest correct change; the semantic API remains a clean
*later* evolution once we want grounding server-side.

---

## 11. Phased build plan (each phase = a shippable checkpoint)

**Phase 0 — Monorepo scaffold (no behavior change).**
Commit baseline → add `"workspaces"` to root `package.json`, `npm install`, verify `npm run app`
still builds/signs/launches + no TCC re-prompt → create `packages/shared` with the first DTO →
scaffold empty `server/` (Fastify boot + `/healthz`). Convert `CLAUDE.md`→root `AGENTS.md` +
stub; add `server/AGENTS.md`.

**Phase 1 — Backend + Auth spine (subsystem #1).**
Neon project + Drizzle schema (Better Auth CLI generate → drizzle-kit) → Better Auth Google-only
+ jwt/bearer → our `/auth/start|callback|exchange` + `oauth_code` → `GET /v1/me` (stub plan/usage)
→ the AI proxy routes (passthrough, JWT-gated) with streaming TTS + multipart STT → deploy to
Hetzner (Docker/systemd + migrate-on-release). **Native:** deep-link plugin + Keychain + repoint
the 12 call sites at the proxy + typed errors. **Frontend:** `core/auth.ts` + `useAuth` +
sign-in step. Checkpoint: sign in with Google, ask a question end-to-end through the proxy, keys
gone from the client.

**Phase 2 — Billing (subsystem #2).**
`usage_counter`/`usage_event`/`subscription`/`webhook_event` + atomic reserve/refund → meter the
tutor turn → `402` contract → Dodo products (test mode) + `@dodopayments/better-auth` (checkout/
portal/webhooks) + `entitlementSync` + reconciliation → frontend paywall (soft indicator + hard
402 handling + checkout open + `kairo://billing-done`). Checkpoint (test mode): burn 10, hit
paywall, pay, get unlocked, cancel via portal.

**Phase 3 — Onboarding (subsystem #3).**
3-step main-window flow absorbing the existing permission UI; account area (plan/usage/manage);
polish. Checkpoint: fresh install → guided to signed-in + permissioned + first successful ask.

**Phase 4 — Hardening.**
CI (secret scan, log-lint, migration dry-run) + pre-commit hooks + branch protection; cron
reconciliation; go-live (Dodo KYC done, live keys on Hetzner only, flip env).

Each phase can spin its own implementation plan (superpowers:writing-plans) when we start it.

---

## 12. Risks

1. **Streaming through the proxy** — if Fastify buffers Sarvam PCM, the streaming-TTS win dies; must stream-pipe + propagate barge-in disconnect upstream. (Rust side unchanged.)
2. **Extra hop latency** — gate runs every ask; keep the mirrored timeouts; warm one backend host.
3. **Metering granularity** — meter the tutor turn only; follow-along continuations must route to unmetered endpoints.
4. **Better Auth desktop deep-link** — under-documented industry-wide, but we own the callback redirect so we control it; fallback is roll-your-own `@fastify/oauth2` (same self-hosted shape).
5. **Instruction files are guidance** — real enforcement is CI + git hooks.
6. **Deep-link token leakage** — one-time code in the URL, never the JWT; redact in logs.

---

## 13. One-time manual prerequisites (only you can do these)

- **Google Cloud:** create an OAuth 2.0 client (Web), set the authorized redirect URI to `{backend}/api/auth/callback/google`, copy client ID/secret → Hetzner env.
- **Neon:** create the project, grab the pooled connection string → Hetzner env (+ a dev branch).
- **Hetzner:** provision the box, point `api.<domain>` DNS at it, TLS (Caddy/nginx), run the service + migrate-on-release.
- **Dodo:** create the account, complete KYC/business (MoR payouts), create the two **Pro** products (monthly/yearly), generate **test** then **live** API keys + the webhook signing secret (webhook URL = `{backend}/api/auth/dodopayments/webhooks`). Live key lives only on Hetzner; the local `.env` keeps only the **test** key (and remove the live key currently sitting in local `.env`).

---

*End of design. Next: your review of this doc → then a per-phase implementation plan.*
