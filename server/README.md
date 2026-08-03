# Kairo Server

Fastify + Postgres + Better Auth (Google-only) + AI proxy. Holds all provider keys; the
desktop app talks only to this service. See [`../AGENTS.md`](../AGENTS.md) (shared rules) and
[`./AGENTS.md`](./AGENTS.md) (backend rules).

## Dev

```bash
cp .env.example .env          # then fill it (see below)
npm run db:migrate -w @kairo/server
npm run server:dev            # from repo root — tsx watch on :8787
```

The environment pairing is deliberate and guarded:

| Server target | Database target | Base URL | Dodo |
| --- | --- | --- | --- |
| `local` (contributor) | literal-loopback PostgreSQL | `http://localhost:8787` | test mode |
| `local` (maintainer) | guarded Neon `dev` | `http://localhost:8787` | test mode |
| `hosted` | guarded Neon `production` | `https://api.meetkairo.xyz` | live mode |

Contributor mode parses the local URL into explicit connection fields and rejects DNS names,
remote hosts, query overrides, and hosted mode. Neon modes read runtime endpoint metadata and
refuse any endpoint other than Kairo's mapped development or production branch.

`.env` must have (see `.env.example`):
- `KAIRO_DATABASE_TARGET=local-postgres` and the local `kairo_local` URL from `.env.example`.
- `BETTER_AUTH_SECRET` — `openssl rand -base64 32`.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — a Google **Web** OAuth client whose authorized
  redirect URI is `http://localhost:8787/api/auth/callback/google`.
- Provider keys (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `SARVAM_API_KEY`,
  `ELEVENLABS_API_KEY`) and, when testing billing, the `DODO_KAIRO_TEST_*` values.

Start the contributor database before migrating:

```bash
# Port 5433, so it runs alongside the test database on 5432 (see Test below).
# Re-runnable: starts the existing container, or creates it the first time.
docker start kairo-local-db 2>/dev/null || docker run --name kairo-local-db \
  -e POSTGRES_DB=kairo_local -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5433:5432 -d postgres:17-alpine
```

If you created `kairo-local-db` under the earlier instructions it is still bound to 5432, and
`docker start` keeps that old mapping. Recreate it once, then run the command above:

```bash
docker rm -f kairo-local-db
```

Kairo maintainers can set `KAIRO_DATABASE_TARGET=neon` with the pooled guarded `dev` URL instead.

## Endpoints

- Auth: `GET /auth/start` → Google; `GET /auth/callback` → correlated
  `kairo://auth-callback?code=…&state=…`;
  `POST /auth/exchange {code}` → `{ sessionToken, expiresAt }`; `POST /api/auth/token` (bearer =
  sessionToken) → short-lived JWT; `GET /api/auth/jwks`.
- `GET /v1/me` (JWT) → `{ plan, status, usage, renews_at, paywalled }`.
- Proxied AI (JWT; only ⭑ metered): `POST /v1/llm/chat`, ⭑`POST /v1/vision/tutor`,
  `POST /v1/vision/point`, `POST /v1/stt` (multipart), `POST /v1/tts`, `POST /v1/tts/stream`.
- Ops: `GET /healthz`, `GET /readyz`.

## Test

```bash
# Re-runnable: starts the existing container, or creates it the first time.
docker start kairo-test-db 2>/dev/null || docker run --name kairo-test-db \
  -e POSTGRES_DB=kairo_test \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 127.0.0.1:5432:5432 \
  -d postgres:17-alpine
npm run test -w @kairo/server
npm run typecheck -w @kairo/server
```

Tests use only this loopback `kairo_test` database, run migrations automatically, and replace
auth/provider settings with deterministic fake values. They refuse remote database hosts and do
not use the Neon URL or provider credentials from `server/.env`. See the root README for a custom
loopback port configuration.

## Deploy (Hetzner)

Live at **`https://api.meetkairo.xyz`**. Runs as a Docker container behind the box's existing
shared **Caddy** (which owns :80/:443 and terminates TLS). The container publishes no host ports;
it joins the `tech-digest-net` docker network so Caddy can `reverse_proxy kairo-server:8787`.
See `Dockerfile` + `docker-compose.yml` here.

First-time setup (done — kept for the record / a fresh box):

1. Clone this repo on the box (public). Compose v2 lives user-local at `~/.docker/cli-plugins/`.
2. `server/.env` on the box holds production secrets and runtime configuration (never committed):
   the prod-branch **pooled** `DATABASE_URL`, `PUBLIC_BASE_URL=https://api.meetkairo.xyz`, a fresh
   `BETTER_AUTH_SECRET`, Google client, provider keys, live-mode Dodo credentials, and an absolute
   `KAIRO_RELEASE_DIR` host path for the private download volume.
3. Add the prod redirect URI `https://api.meetkairo.xyz/api/auth/callback/google` to the Google
   web client.
4. Add a vhost to the box's shared Caddyfile, then graceful `caddy reload`:
   ```
   api.meetkairo.xyz {
       encode zstd gzip
       reverse_proxy kairo-server:8787
   }
   ```

Redeploy (build → forward-only migrate → restart → `/readyz` gate):

```bash
ssh -i "$KAIRO_RELEASE_SSH_KEY" "$KAIRO_RELEASE_HOST" \
  'cd /path/to/kairo && git pull --ff-only && bash server/deploy.sh'
```

Live keys live **only** in the box `.env`. `deploy.sh` runs migrations as a release step (never
auto-migrate on boot).
