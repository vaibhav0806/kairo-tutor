# Kairo Server

Fastify + Neon Postgres + Better Auth (Google-only) + AI proxy. Holds all provider keys; the
desktop app talks only to this service. See [`../AGENTS.md`](../AGENTS.md) (shared rules) and
[`./AGENTS.md`](./AGENTS.md) (backend rules).

## Dev

```bash
cp .env.example .env          # then fill it (see below)
npm run db:migrate -w @kairo/server
npm run server:dev            # from repo root — tsx watch on :8787
```

`.env` must have (see `.env.example`):
- `DATABASE_URL` — the Neon **pooled** connection string (host contains `-pooler`).
- `BETTER_AUTH_SECRET` — `openssl rand -base64 32`.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — a Google **Web** OAuth client whose authorized
  redirect URI is `http://localhost:8787/api/auth/callback/google`.
- Provider keys (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `SARVAM_API_KEY`,
  `ELEVENLABS_API_KEY`) and the **test-mode** `DODO_PAYMENTS_API_KEY`.

## Endpoints

- Auth: `GET /auth/start` → Google; `GET /auth/callback` → `kairo://auth-callback?code=…`;
  `POST /auth/exchange {code}` → `{ sessionToken, expiresAt }`; `POST /api/auth/token` (bearer =
  sessionToken) → short-lived JWT; `GET /api/auth/jwks`.
- `GET /v1/me` (JWT) → `{ plan, status, usage, renews_at, paywalled }`.
- Proxied AI (JWT; only ⭑ metered): `POST /v1/llm/chat`, ⭑`POST /v1/vision/tutor`,
  `POST /v1/vision/point`, `POST /v1/stt` (multipart), `POST /v1/tts`, `POST /v1/tts/stream`.
- Ops: `GET /healthz`, `GET /readyz`.

## Test

```bash
npm run test -w @kairo/server        # vitest against the Neon dev branch
npm run typecheck -w @kairo/server
```

## Deploy (Hetzner)

Live at **`https://api.meetkairo.xyz`**. Runs as a Docker container behind the box's existing
shared **Caddy** (which owns :80/:443 and terminates TLS). The container publishes no host ports;
it joins the `tech-digest-net` docker network so Caddy can `reverse_proxy kairo-server:8787`.
See `Dockerfile` + `docker-compose.yml` here.

First-time setup (done — kept for the record / a fresh box):

1. Clone this repo on the box (public). Compose v2 lives user-local at `~/.docker/cli-plugins/`.
2. `server/.env` on the box holds prod secrets (**keys only**, never committed): prod-branch
   **pooled** `DATABASE_URL`, `PUBLIC_BASE_URL=https://api.meetkairo.xyz`, a fresh
   `BETTER_AUTH_SECRET`, Google client, provider keys, Dodo (test until live keys land).
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
ssh era@<box> 'cd ~/kairo && git pull --ff-only && bash server/deploy.sh'
```

Live keys live **only** in the box `.env`. `deploy.sh` runs migrations as a release step (never
auto-migrate on boot).
