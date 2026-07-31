# Kairo Server contributor instructions

These rules supplement [`../AGENTS.md`](../AGENTS.md) for files under `server/`.

The server is a Fastify service using PostgreSQL and Drizzle, Better Auth with Google,
provider proxies, usage metering, and Dodo billing. Secrets stay server-side.

## Local development

Use the literal-loopback PostgreSQL setup in [`README.md`](./README.md), then:

```bash
cp server/.env.example server/.env
npm run db:migrate
npm run server:dev
```

Those commands run from the repository root. From `server/`, use `npm run db:migrate`
and `npm run dev` instead. Local development and billing tests use Dodo test mode.

The contributor database target is `KAIRO_DATABASE_TARGET=local-postgres` with a
literal `127.0.0.1` or `[::1]` URL. Keep the local/hosted and database-target guards
in `src/config/` intact; never make a remote database acceptable to contributor tests.

## Service conventions

- `buildApp()` in `src/app.ts` constructs the testable Fastify instance.
  `src/index.ts` only starts the listener.
- Keep route handlers small and validate request input with Zod.
- Use the shared `{ error, code }` response shape through
  `src/plugins/error-handler.ts`.
- Use structured Pino logging. Never log secrets, tokens, auth headers, email
  addresses, raw media, transcripts, prompts, answers, or provider response bodies.
- Provider errors exposed to clients or logs must contain safe status/class metadata,
  not upstream payloads.

## Database and migrations

- Access PostgreSQL through Drizzle and the configured `pg` pool.
- Keep migrations forward-only and commit generated files under `drizzle/`.
- Never edit an already-applied migration or auto-apply migrations during server
  startup.
- Preserve the loopback parser in `src/db/connection.ts` and the environment mappings
  in `src/config/targets.ts`.
- Tests may use only a loopback database named `kairo_test`; the harness supplies fake
  auth and provider values and must not load secrets from `server/.env`.

## Authentication and billing

- Keep Google OAuth callbacks correlated with the locally initiated, short-lived,
  single-use state flow.
- Better Auth and JWKS remain the authentication source of truth. Do not implement a
  parallel token verifier or put session tokens in callback URLs.
- Verify Dodo webhooks against the raw request body. Never bypass signature
  verification, use live billing credentials locally, or simulate live transactions.
- Local signed webhook testing uses `npm run billing:test:listen` from the repository
  root after test-mode configuration is present.

## Verification

Start the PostgreSQL 17 `kairo_test` database documented in the root README, then run:

```bash
npm run typecheck -w @kairo/server
npm run test -w @kairo/server
npm run build -w @kairo/server
```

Add focused `app.inject()` tests for route behavior and regression tests for changes
to configuration guards, authentication, billing, or provider error handling.
