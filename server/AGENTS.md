# Kairo Server — agent rules

Node + Fastify + Neon Postgres + Better Auth + Dodo. A narrow service that:
authenticates (Better Auth, **Google-only**), **proxies all AI provider calls** holding the
real keys, **meters usage** (10 free requests, lifetime), and handles **Dodo** billing.
Secrets never reach the browser or the desktop bundle.

> Root rules (secret hygiene, commit discipline, and Dodo environment controls) live in `../AGENTS.md`.
> This file is the backend-specific layer.

## Run / dev

- `npm run server:dev` (from repo root) → `tsx watch`, port **8787**.
- `npm run db:generate` / `npm run db:migrate` (Drizzle Kit against the configured guarded database target).
- Env from `server/.env` (gitignored). Copy `server/.env.example`; runtime policy is enforced in
  `src/config/`.
- Google OAuth redirect URI (dev): `http://localhost:8787/api/auth/callback/google`.

## Fastify conventions

- `buildApp()` in `src/app.ts` returns the instance (unit-testable via `app.inject`);
  `src/index.ts` only calls `listen`. Keep files small and one-responsibility.
- Validate route inputs with **zod**. Uniform error shape `{ error, code }` via
  `plugins/error-handler.ts` (throw `QuotaExceededError` → 402, `AuthError` → 401).
- Structured **pino** logs. **NEVER log secrets/tokens/auth headers/PII/raw media** — metadata
  only (same discipline as the desktop `klog`).

## Postgres + migrations

- **Drizzle** ORM with a `pg` (node-postgres) pool. Contributors use literal-loopback PostgreSQL;
  maintainers and hosted deployments use pooled Neon.
- `KAIRO_DATABASE_TARGET=local-postgres` is allowed only with the local server target and rejects
  DNS/remote hosts and connection-string overrides. `neon` mode keeps the exact dev/production
  endpoint verification in `src/config/targets.ts`. Do not bypass either guard.
- Migrations are **forward-only**, checked into `server/drizzle/`, reviewed in-PR, dry-run on a
  Neon branch first. **Never** auto-apply on boot; run `src/db/migrate.ts` as a deploy step.
  Never hand-edit an already-applied migration.

## Better Auth

- Google-only social provider; **JWT (15m) + JWKS + bearer** plugins. Proxy verifies the JWT via
  JWKS with `jose` (no DB on the hot path). Don't roll your own auth.
- The verification key set is read **in-process** (`src/auth/jwks.ts` → `auth.api.getJwks()`),
  cached, and reloaded on an unknown `kid`. **Never** verify against
  `PUBLIC_BASE_URL/api/auth/jwks` over HTTP — in prod that makes the container fetch its own public
  hostname through Cloudflare + Caddy, which hangs and 401s every authenticated request.
- The desktop is Rust (no TS client): we own `/auth/start|callback|exchange` and hand the app a
  session over a **`kairo://` one-time code** — the JWT never rides in the URL.

## Dodo environment safety

- Local development is always test mode; **live keys only exist in the Hetzner env**. Never commit
  or print any Dodo key.
- Verify webhook signatures over the **raw** body (Standard Webhooks HMAC).
- Local end-to-end testing uses `npm run billing:test:listen` from the repo root. It applies
  migrations, verifies `DODO_ENV=test_mode`, and runs Dodo's signed CLI relay to
  `http://localhost:8787/webhooks/dodo`. Never bypass signature checks for local testing.
- Never point test-mode Dodo at the hosted API. Test checkouts, webhook relays, account resets, and
  simulated lifecycle events belong only to the local server using local PostgreSQL or the Neon
  `dev` branch.
- A Hetzner live cutover requires explicit user approval in the current request and the preflight
  in root `AGENTS.md`. Change only the environment selector after preflight; never copy live values
  into a command, repo file, local env, test, or log. Do not generate a live checkout as an agent.

## Verify gate (before "done")

- Start the loopback PostgreSQL 17 `kairo_test` database documented in `README.md`, then run
  `npm run typecheck -w @kairo/server` + `npm run test -w @kairo/server` + a migration dry-run.
  The test harness applies its own migrations, injects fake credentials, and refuses remote DBs.

## Deploying backend changes

Changes under `server/` are NOT live until deployed to the prod box (Hetzner). After ANY
backend change, **OFFER to deploy — but ASK the user and get explicit confirmation BEFORE
deploying. Never auto-deploy.** The deploy runs `server/deploy.sh` on the box (build →
forward-only migrate → restart → `/readyz` gate). CI (typecheck + build + isolated PostgreSQL tests) runs automatically on
push via `.github/workflows/server-ci.yml`; the deploy itself is manual + confirmed. (Box host +
SSH details live in the agent's local memory, not this public repo.)
