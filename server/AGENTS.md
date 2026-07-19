# Kairo Server — agent rules

Node + Fastify + Neon Postgres + Better Auth + Dodo. A narrow service that:
authenticates (Better Auth, **Google-only**), **proxies all AI provider calls** holding the
real keys, **meters usage** (10 free requests, lifetime), and handles **Dodo** billing.
Secrets never reach the browser or the desktop bundle.

> Root rules (secret hygiene, commit discipline, Dodo test-mode) live in `../AGENTS.md`.
> This file is the backend-specific layer.

## Run / dev

- `npm run server:dev` (from repo root) → `tsx watch`, port **8787**.
- `npm run db:generate` / `npm run db:migrate` (Drizzle Kit against Neon).
- Env from `server/.env` (gitignored) — **keys only**. Non-secret config lives in `src/config/`.
- Google OAuth redirect URI (dev): `http://localhost:8787/api/auth/callback/google`.

## Fastify conventions

- `buildApp()` in `src/app.ts` returns the instance (unit-testable via `app.inject`);
  `src/index.ts` only calls `listen`. Keep files small and one-responsibility.
- Validate route inputs with **zod**. Uniform error shape `{ error, code }` via
  `plugins/error-handler.ts` (throw `QuotaExceededError` → 402, `AuthError` → 401).
- Structured **pino** logs. **NEVER log secrets/tokens/auth headers/PII/raw media** — metadata
  only (same discipline as the desktop `klog`).

## Neon + migrations

- **Drizzle** ORM, `pg` (node-postgres) `Pool` on the **pooled** Neon URL.
- Migrations are **forward-only**, checked into `server/drizzle/`, reviewed in-PR, dry-run on a
  Neon branch first. **Never** auto-apply on boot; run `src/db/migrate.ts` as a deploy step.
  Never hand-edit an already-applied migration.

## Better Auth

- Google-only social provider; **JWT (15m) + JWKS + bearer** plugins. Proxy verifies the JWT via
  JWKS with `jose` (no DB on the hot path). Don't roll your own auth.
- The desktop is Rust (no TS client): we own `/auth/start|callback|exchange` and hand the app a
  session over a **`kairo://` one-time code** — the JWT never rides in the URL.

## Dodo — TEST MODE ONLY

- Test keys in dev; **live keys only on the Hetzner prod env**. Never commit any Dodo key.
- Verify webhook signatures over the **raw** body (Standard Webhooks HMAC).

## Verify gate (before "done")

- `npm run typecheck -w @kairo/server` + `npm run test -w @kairo/server` + a migration dry-run.
