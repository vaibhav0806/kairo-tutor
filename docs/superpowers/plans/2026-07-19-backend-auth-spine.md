# Backend + Auth Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `server/` backend — a Fastify monolith on Neon Postgres with self-hosted Better Auth (Google-only) and key-injecting AI proxy endpoints — fully curl-testable, with **zero changes to the desktop app**.

**Architecture:** New top-level `server/` workspace (npm workspaces) + `packages/shared` for TS DTOs. Fastify 5 mounts Better Auth on `/api/auth/*` (Google social + JWT/JWKS + bearer plugins); three app-owned routes (`/auth/start|callback|exchange`) implement the desktop `kairo://` deep-link handshake via one-time codes. A JWKS `preHandler` authenticates every proxy call with no DB hit; the answer-turn route atomically meters (10 free lifetime). Provider keys live only in `server/.env`.

**Tech Stack:** Node 20 + TypeScript (ESM), Fastify 5, Better Auth (+ `@dodopayments/better-auth` wired but dormant until Plan 3), Drizzle ORM + `pg` (Neon pooled), `jose`, `undici`, `zod`, `pino`, `vitest`.

**Scope boundary:** This plan is server-only + repo scaffolding. It does NOT modify `src/` or `src-tauri/` (that is Plan 2, "Desktop cutover"). Billing enforcement wiring to Dodo webhooks is stubbed here and completed in Plan 3.

**Prerequisites already satisfied:** `.env` has `NEON_CONNECTION_STRING`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DODO_KAIRO_TEST_KEY`, and the provider keys. Backend dev port = **8787** (matches the Google OAuth redirect URI `http://localhost:8787/api/auth/callback/google`).

> **Version note:** Better Auth's exact handler-mount signature and the `@better-auth/cli generate` output evolve. Where a step says "per Better Auth docs (current version)", verify against the installed version's docs; the code shown targets Better Auth 1.6.x.

---

## File structure (locked before tasks)

```
kairo-tutor/
├── package.json                    # MODIFY: add "workspaces"; add server:*/db:* delegating scripts
├── AGENTS.md                       # NEW: canonical shared + desktop rules (from current CLAUDE.md)
├── CLAUDE.md                       # MODIFY: becomes one-line "@AGENTS.md" stub (+ Claude-only notes)
├── packages/shared/
│   ├── package.json                # NEW: @kairo/shared, exports ./src/index.ts
│   ├── tsconfig.json               # NEW
│   └── src/index.ts                # NEW: shared DTOs (MeResponse, error envelope, ask id header name)
└── server/
    ├── package.json                # NEW: @kairo/server
    ├── tsconfig.json               # NEW
    ├── .env.example                # NEW: key names only
    ├── .gitignore                  # NEW: dist/, .env
    ├── drizzle.config.ts           # NEW
    ├── drizzle/                    # NEW: generated SQL migrations (committed)
    ├── AGENTS.md                   # NEW: backend rules
    ├── CLAUDE.md                   # NEW: "@AGENTS.md" stub
    ├── src/
    │   ├── index.ts                # NEW: listen(8787) + graceful shutdown
    │   ├── app.ts                  # NEW: buildApp() -> Fastify instance (test entrypoint)
    │   ├── config/env.ts           # NEW: zod-parsed process.env
    │   ├── config/providers.ts     # NEW: capability -> {baseUrl,keyEnv,authHeader,timeoutMs}
    │   ├── db/client.ts            # NEW: pg Pool + drizzle singleton
    │   ├── db/migrate.ts           # NEW: programmatic migrator (deploy step)
    │   ├── db/schema/auth.ts       # NEW: Better Auth CLI output
    │   ├── db/schema/app.ts        # NEW: usage_counter, usage_event, subscription, webhook_event, oauth_code
    │   ├── db/schema/index.ts      # NEW: barrel
    │   ├── auth/better-auth.ts     # NEW: betterAuth() config
    │   ├── auth/routes.ts          # NEW: catch-all + /auth/start|callback|exchange
    │   ├── auth/codes.ts           # NEW: one-time code mint/verify/burn
    │   ├── plugins/auth-verify.ts  # NEW: JWKS verify -> request.userId
    │   ├── plugins/error-handler.ts# NEW: uniform {error,code}; QuotaExceeded->402
    │   ├── plugins/raw-body.ts     # NEW: preserve raw Buffer for /api/auth/*
    │   ├── usage/routes.ts         # NEW: GET /v1/me
    │   ├── usage/service.ts        # NEW: ensureCounter, reserve, refund, readMe
    │   ├── proxy/forward.ts        # NEW: undici key-injecting forward
    │   ├── proxy/stream.ts         # NEW: hijack + pipeline passthrough
    │   ├── proxy/llm.ts            # NEW: /v1/llm/chat, /v1/vision/tutor (metered), /v1/vision/point
    │   ├── proxy/speech.ts         # NEW: /v1/stt, /v1/tts, /v1/tts/stream
    │   ├── health/routes.ts        # NEW: /healthz, /readyz
    │   └── lib/http.ts             # NEW: shared keep-alive undici Agent
    └── tests/                      # NEW: vitest
```

---

## Task 1: Monorepo workspaces + shared package (no behavior change)

**Files:**
- Modify: `package.json` (add `workspaces`)
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`

- [ ] **Step 1: Snapshot baseline**

Run: `git status && git stash list`
Expected: note the pre-existing `M src-tauri/src/constants.rs` (leave it staged/unstaged as-is; do not commit it in this plan).

- [ ] **Step 2: Add the workspaces field to root `package.json`**

Add this top-level key (do not touch existing scripts/deps):

```jsonc
"workspaces": ["packages/*", "server"],
```

- [ ] **Step 3: Create `packages/shared/package.json`**

```json
{
  "name": "@kairo/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

- [ ] **Step 4: Create `packages/shared/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "declaration": true,
    "composite": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Create `packages/shared/src/index.ts` with the first real DTOs**

```ts
// Shared contracts between the desktop app and the Fastify server.
export const ASK_ID_HEADER = 'x-kairo-ask-id';

export type Plan = 'free' | 'pro';

export interface MeResponse {
  user: { id: string; email: string };
  plan: Plan;
  status: 'none' | 'pending' | 'active' | 'on_hold' | 'cancelled' | 'failed' | 'expired';
  usage: { used: number; limit: number; remaining: number | null }; // remaining null => unlimited (pro)
  renews_at: string | null;
  cancel_at_period_end: boolean;
  paywalled: boolean;
}

// Typed error the desktop branches on (401/402/5xx bodies all use this envelope).
export type ErrorCode = 'quota_exceeded' | 'unauthenticated' | 'offline' | 'provider_error' | 'bad_request';
export interface ErrorEnvelope {
  error: string;
  code: ErrorCode;
  message?: string;
}
```

- [ ] **Step 6: Install + verify the desktop build is untouched**

Run: `npm install`
Then run: `npm run typecheck`
Expected: PASS (workspaces added no new TS to the desktop build).

- [ ] **Step 7: Verify the packaged app still builds/signs/launches**

Run: `npm run app`
Expected: app quits, rebuilds, signs, verifies, launches; **no TCC re-prompt** (identity/paths unchanged).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json packages/shared
git commit -m "chore(monorepo): add npm workspaces + @kairo/shared DTO package

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Agent rules — AGENTS.md canonical + CLAUDE.md stub

**Files:**
- Create: `AGENTS.md` (root)
- Modify: `CLAUDE.md` (root) → stub
- Create: `server/AGENTS.md`, `server/CLAUDE.md` (stub)

- [ ] **Step 1: Create root `AGENTS.md`**

Copy the ENTIRE current `CLAUDE.md` content into `AGENTS.md`, then prepend these shared/monorepo sections above the existing desktop body:

```markdown
# Kairo Tutor — monorepo agent rules

Two packages: **root = the desktop app** (Tauri: `src-tauri/` Rust + `src/` React), and
**`server/` = the Fastify backend** (auth + AI proxy + billing). Working in `server/`? read
`server/AGENTS.md`. This file's build/log/panel rules are the DESKTOP rules.

## Open-source secret hygiene
`.env` holds ONLY API keys and is gitignored. NEVER commit secrets/tokens. NEVER paste a live
key into code, logs, tests, or committed config. Provider keys live in `server/.env` (dev) / the
Hetzner env (prod) — never in the desktop bundle.

## Dodo — TEST MODE ONLY
The agent operates Dodo in test mode only. Live keys live only on the Hetzner prod env, never in
the repo or a dev machine.

## Commit discipline
Work on `main`. Commit each change as you go (revertible history). No unrelated refactors. End
commit messages with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

## How to run things
Desktop → `npm run app`. Server → `npm run server:dev` (see `server/AGENTS.md`).

---

<!-- BELOW: DESKTOP-SPECIFIC RULES (the former CLAUDE.md body) -->
```

- [ ] **Step 2: Replace root `CLAUDE.md` with a stub**

```markdown
@AGENTS.md

<!-- Claude Code only. Shared + desktop rules live in AGENTS.md (imported above).
     Backend rules load from server/AGENTS.md when you work in server/. -->
```

- [ ] **Step 3: Create `server/AGENTS.md`**

```markdown
# Kairo Server (Node + Fastify + Neon Postgres + Better Auth + Dodo)

Narrow service: authenticate (Better Auth, Google-only), proxy all AI provider calls holding the
real keys, meter usage (10 free lifetime), handle Dodo (Plan 3). Secrets never reach the browser.

## Run / dev
- `npm run server:dev` (tsx watch, port 8787). `npm run db:generate` / `npm run db:migrate`.
- Env from `server/.env` (gitignored) — KEYS ONLY. Mirror non-secret config in `config/`.

## Fastify conventions
- `buildApp()` in `app.ts` returns the instance (unit-testable); `index.ts` only calls `listen`.
- Validate route inputs with zod. Uniform error shape `{error,code}` via `plugins/error-handler.ts`.
- Structured pino logs with a request id. NEVER log secrets/tokens/auth headers/PII/raw media.

## Neon + migrations
- Drizzle. Migrations are forward-only, checked into `server/drizzle/`, reviewed in-PR, dry-run on a
  Neon branch. NEVER auto-apply on boot; run `db/migrate.ts` as a deploy step. Never hand-edit an
  applied migration.

## Better Auth
- Google-only social provider; JWT (15m) + JWKS + bearer plugins. Don't roll your own auth.

## Dodo — TEST MODE ONLY
- Test keys in dev; live keys only on Hetzner. Verify webhook signatures over the RAW body.

## Verify gate
- `npm run typecheck -w @kairo/server` + `npm run test -w @kairo/server` + a migration dry-run.
```

- [ ] **Step 4: Create `server/CLAUDE.md` stub**

```markdown
@AGENTS.md
```

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md CLAUDE.md server/AGENTS.md server/CLAUDE.md
git commit -m "docs(rules): split rules into root AGENTS.md (shared+desktop) + server/AGENTS.md; CLAUDE.md stubs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Server skeleton (Fastify boots, `/healthz` green)

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/.gitignore`, `server/.env.example`
- Create: `server/src/{index.ts,app.ts}`, `server/src/config/env.ts`, `server/src/health/routes.ts`, `server/src/plugins/error-handler.ts`
- Test: `server/tests/health.test.ts`

- [ ] **Step 1: Create `server/package.json`**

```json
{
  "name": "@kairo/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "@kairo/shared": "*",
    "better-auth": "^1.6.0",
    "drizzle-orm": "^0.36.0",
    "pg": "^8.13.0",
    "jose": "^5.9.0",
    "undici": "^7.0.0",
    "fastify": "^5.1.0",
    "@fastify/multipart": "^9.0.0",
    "zod": "^3.23.0",
    "pino": "^9.5.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "@types/pg": "^8.11.0",
    "drizzle-kit": "^0.28.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `server/.gitignore` and `server/.env.example`**

`server/.gitignore`:
```
node_modules/
dist/
.env
```

`server/.env.example` (names only):
```
PORT=8787
PUBLIC_BASE_URL=http://localhost:8787
DATABASE_URL=
BETTER_AUTH_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
OPENROUTER_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
SARVAM_API_KEY=
ELEVENLABS_API_KEY=
DODO_PAYMENTS_API_KEY=
DODO_PAYMENTS_WEBHOOK_SECRET=
DODO_ENV=test_mode
```

- [ ] **Step 4: Create `server/.env` for dev by importing from the repo-root `.env`**

The root `.env` already holds the keys (with the project's own names). Create `server/.env` referencing them. Map the existing names → the server's expected names:

```
PORT=8787
PUBLIC_BASE_URL=http://localhost:8787
DATABASE_URL=<paste NEON_CONNECTION_STRING value — MUST be the pooled -pooler host>
BETTER_AUTH_SECRET=<generate: `openssl rand -base64 32`>
GOOGLE_CLIENT_ID=<from root .env>
GOOGLE_CLIENT_SECRET=<from root .env>
OPENROUTER_API_KEY=<from root .env>
ANTHROPIC_API_KEY=<from root .env>
OPENAI_API_KEY=<from root .env>
SARVAM_API_KEY=<from root .env>
ELEVENLABS_API_KEY=<from root .env>
DODO_PAYMENTS_API_KEY=<root .env DODO_KAIRO_TEST_KEY>
DODO_ENV=test_mode
```

(`server/.env` is gitignored via Step 3.)

- [ ] **Step 5: Create `server/src/config/env.ts`**

```ts
import 'dotenv/config';
import { z } from 'zod';

const Env = z.object({
  PORT: z.coerce.number().default(8787),
  PUBLIC_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(16),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  OPENROUTER_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  SARVAM_API_KEY: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  DODO_PAYMENTS_API_KEY: z.string().optional(),
  DODO_PAYMENTS_WEBHOOK_SECRET: z.string().optional(),
  DODO_ENV: z.enum(['test_mode', 'live_mode']).default('test_mode'),
});

export const env = Env.parse(process.env);
export type AppEnv = typeof env;
```

- [ ] **Step 6: Create `server/src/plugins/error-handler.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { ErrorEnvelope } from '@kairo/shared';

export class QuotaExceededError extends Error { code = 'quota_exceeded' as const; }
export class AuthError extends Error { code = 'unauthenticated' as const; }
export class ProviderError extends Error { code = 'provider_error' as const; }

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof QuotaExceededError) {
      const body: ErrorEnvelope = { error: 'free_limit_reached', code: 'quota_exceeded', message: err.message };
      return reply.status(402).send(body);
    }
    if (err instanceof AuthError) {
      return reply.status(401).send({ error: 'unauthenticated', code: 'unauthenticated' } satisfies ErrorEnvelope);
    }
    if (err instanceof ProviderError) {
      return reply.status(502).send({ error: 'provider_error', code: 'provider_error', message: err.message } satisfies ErrorEnvelope);
    }
    reply.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal', code: 'provider_error' } satisfies ErrorEnvelope);
  });
}
```

- [ ] **Step 7: Create `server/src/health/routes.ts`**

```ts
import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async () => {
    // DB probe is added in Task 4; for now liveness only.
    return { ok: true };
  });
}
```

- [ ] **Step 8: Create `server/src/app.ts`**

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandler } from './plugins/error-handler.js';
import { healthRoutes } from './health/routes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: 'info' } });
  registerErrorHandler(app);
  await app.register(healthRoutes);
  return app;
}
```

- [ ] **Step 9: Create `server/src/index.ts`**

```ts
import { env } from './config/env.js';
import { buildApp } from './app.js';

const app = await buildApp();
await app.listen({ port: env.PORT, host: '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => { await app.close(); process.exit(0); });
}
```

- [ ] **Step 10: Write the failing test `server/tests/health.test.ts`**

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';

const app = await buildApp();
afterAll(() => app.close());

describe('health', () => {
  it('GET /healthz returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 11: Install workspace deps + run the test**

Run: `npm install`
Run: `npm run test -w @kairo/server`
Expected: PASS.

- [ ] **Step 12: Smoke the dev server**

Run: `npm run server:dev` (separate terminal), then `curl -s localhost:8787/healthz`
Expected: `{"ok":true}`. Ctrl-C.

- [ ] **Step 13: Commit**

```bash
git add server package.json package-lock.json
git commit -m "feat(server): Fastify skeleton with health routes + zod env + error envelope

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> Add root delegating scripts now too: in root `package.json` scripts add
> `"server:dev": "npm run dev -w @kairo/server"`, `"server:build": "npm run build -w @kairo/server"`,
> `"server:start": "npm run start -w @kairo/server"`, `"db:generate": "npm run db:generate -w @kairo/server"`,
> `"db:migrate": "npm run db:migrate -w @kairo/server"`. Include them in this commit.

---

## Task 4: Database — Drizzle + Neon + app schema + migration

**Files:**
- Create: `server/drizzle.config.ts`, `server/src/db/client.ts`, `server/src/db/migrate.ts`, `server/src/db/schema/app.ts`, `server/src/db/schema/index.ts`
- Modify: `server/src/health/routes.ts` (real `/readyz`), `server/src/app.ts` (nothing yet)
- Test: `server/tests/db.test.ts`

- [ ] **Step 1: Create `server/src/db/client.ts`**

```ts
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from '../config/env.js';
import * as schema from './schema/index.js';

// Neon POOLED url + persistent Node process => node-postgres Pool (NOT the serverless HTTP driver).
export const pool = new Pool({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
export const db = drizzle(pool, { schema });
```

- [ ] **Step 2: Create `server/src/db/schema/app.ts`**

```ts
import { pgTable, text, integer, boolean, timestamp, jsonb, uuid, pgEnum } from 'drizzle-orm/pg-core';

export const planT = pgEnum('plan_t', ['free', 'pro']);
export const subStatusT = pgEnum('sub_status_t', ['none','pending','active','on_hold','cancelled','failed','expired']);

// NOTE: references "user"(id) — the Better Auth user table (Task 5) — added as a raw FK in the
// generated SQL. Better Auth ids are text.
export const usageCounter = pgTable('usage_counter', {
  userId: text('user_id').primaryKey(),
  plan: planT('plan').notNull().default('free'),
  usedFree: integer('used_free').notNull().default(0),
  freeLimit: integer('free_limit').notNull().default(10),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const usageEvent = pgTable('usage_event', {
  askId: uuid('ask_id').primaryKey(),
  userId: text('user_id').notNull(),
  counted: boolean('counted').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const subscription = pgTable('subscription', {
  userId: text('user_id').primaryKey(),
  status: subStatusT('status').notNull().default('none'),
  dodoSubscriptionId: text('dodo_subscription_id').unique(),
  dodoCustomerId: text('dodo_customer_id'),
  dodoProductId: text('dodo_product_id'),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  lastEventAt: timestamp('last_event_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const webhookEvent = pgTable('webhook_event', {
  webhookId: text('webhook_id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb('payload').notNull(),
});

export const oauthCode = pgTable('oauth_code', {
  code: text('code').primaryKey(),
  userId: text('user_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  used: boolean('used').notNull().default(false),
});
```

- [ ] **Step 3: Create `server/src/db/schema/index.ts`**

```ts
export * from './app.js';
// export * from './auth.js';  // uncommented after Task 5 generates it
```

- [ ] **Step 4: Create `server/drizzle.config.ts`**

```ts
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema/*.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

- [ ] **Step 5: Create `server/src/db/migrate.ts` (deploy step)**

```ts
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './client.js';

await migrate(db, { migrationsFolder: './drizzle' });
await pool.end();
console.log('migrations applied');
```

- [ ] **Step 6: Generate + apply the migration against a Neon dev branch**

Run: `npm run db:generate -w @kairo/server`
Expected: a new SQL file under `server/drizzle/`. Open it and **add the FKs** to `"user"(id)` for `usage_counter.user_id`, `usage_event.user_id`, `subscription.user_id`, `oauth_code.user_id` (Drizzle won't emit them since the `user` table isn't in this schema yet — they're added after Task 5, so for now leave the columns FK-less and add a follow-up migration in Task 5).
Run: `npm run db:migrate -w @kairo/server`
Expected: tables created on Neon.

- [ ] **Step 7: Real `/readyz` in `server/src/health/routes.ts`**

Replace the `/readyz` handler:

```ts
import { pool } from '../db/client.js';
// ...
  app.get('/readyz', async (_req, reply) => {
    try { await pool.query('SELECT 1'); return { ok: true }; }
    catch (e) { reply.log.error({ e }, 'db not ready'); return reply.status(503).send({ ok: false }); }
  });
```

- [ ] **Step 8: Write test `server/tests/db.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { pool } from '../src/db/client.js';

describe('db', () => {
  it('connects and sees usage_counter', async () => {
    const r = await pool.query("SELECT to_regclass('public.usage_counter') AS t");
    expect(r.rows[0].t).toBe('usage_counter');
  });
});
```

- [ ] **Step 9: Run test**

Run: `npm run test -w @kairo/server`
Expected: PASS (requires `server/.env` DATABASE_URL pointing at the migrated Neon branch).

- [ ] **Step 10: Commit**

```bash
git add server/drizzle.config.ts server/src/db server/drizzle server/src/health server/tests/db.test.ts
git commit -m "feat(server): Drizzle + Neon client, app schema (usage/subscription/webhook/oauth), migrations

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Better Auth (Google-only) + JWT/JWKS + seed hook

**Files:**
- Create: `server/src/auth/better-auth.ts`, `server/src/db/schema/auth.ts` (generated), `server/src/plugins/raw-body.ts`
- Modify: `server/src/db/schema/index.ts`, `server/src/app.ts`
- Test: `server/tests/auth-jwks.test.ts`

- [ ] **Step 1: Create `server/src/auth/better-auth.ts`**

```ts
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { jwt, bearer } from 'better-auth/plugins';
import { db } from '../db/client.js';
import { env } from '../config/env.js';
import { ensureUserRows } from '../usage/service.js';

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  baseURL: env.PUBLIC_BASE_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: ['kairo://'],
  socialProviders: {
    google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
  },
  plugins: [
    jwt({
      jwt: {
        issuer: env.PUBLIC_BASE_URL,
        audience: env.PUBLIC_BASE_URL,
        expirationTime: '15m',
        definePayload: ({ user }) => ({ sub: user.id, email: user.email }),
      },
    }),
    bearer(),
  ],
  databaseHooks: {
    user: {
      create: {
        after: async (user) => { await ensureUserRows(user.id); },
      },
    },
  },
});
```

- [ ] **Step 2: Generate the Better Auth schema**

Run: `npx @better-auth/cli generate --config server/src/auth/better-auth.ts --output server/src/db/schema/auth.ts`
Expected: `auth.ts` with `user`, `session`, `account`, `verification`, `jwks` Drizzle tables.
(If the CLI needs the app to import cleanly, temporarily stub `ensureUserRows` — Task 6 fills it.)

- [ ] **Step 3: Un-comment the auth barrel export**

In `server/src/db/schema/index.ts`:
```ts
export * from './app.js';
export * from './auth.js';
```

- [ ] **Step 4: Generate + apply the auth migration (and add the deferred FKs)**

Run: `npm run db:generate -w @kairo/server`
Open the new SQL: it creates the `user`/`session`/`account`/`verification`/`jwks` tables. **Append** the deferred foreign keys from Task 4:
```sql
ALTER TABLE usage_counter   ADD CONSTRAINT usage_counter_user_fk   FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
ALTER TABLE usage_event     ADD CONSTRAINT usage_event_user_fk     FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
ALTER TABLE subscription    ADD CONSTRAINT subscription_user_fk    FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
ALTER TABLE oauth_code      ADD CONSTRAINT oauth_code_user_fk      FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
```
Run: `npm run db:migrate -w @kairo/server`

- [ ] **Step 5: Create `server/src/plugins/raw-body.ts`** (needed by the auth handler + future webhook)

```ts
import fp from 'fastify-plugin';
// Preserve the exact raw body for /api/auth/* (Better Auth builds a Web Request; webhook HMAC
// in Plan 3 needs untouched bytes). We add a content-type parser that keeps the Buffer.
export default fp(async (app) => {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body); // hand raw Buffer to routes that need it; JSON routes parse explicitly
  });
});
```
> If this global parser conflicts with normal JSON routes, scope it: only register for the auth
> prefix via an encapsulated child instance. Prefer scoping — see Better Auth Fastify docs.

- [ ] **Step 6: Mount Better Auth in `app.ts`**

```ts
import { Readable } from 'node:stream';
import { auth } from './auth/better-auth.js';

// inside buildApp(), after error handler:
app.route({
  method: ['GET', 'POST'],
  url: '/api/auth/*',
  handler: async (req, reply) => {
    const url = new URL(req.url, env.PUBLIC_BASE_URL);
    const res = await auth.handler(new Request(url, {
      method: req.method,
      headers: req.headers as any,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : (req.body as Buffer),
    }));
    reply.status(res.status);
    res.headers.forEach((v, k) => reply.header(k, v));
    reply.send(res.body ? Readable.fromWeb(res.body as any) : null);
  },
});
```
(Import `env` at the top of `app.ts`.)

- [ ] **Step 7: Write test `server/tests/auth-jwks.test.ts`**

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';

const app = await buildApp();
afterAll(() => app.close());

describe('better-auth', () => {
  it('exposes a JWKS with at least one key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/jwks' });
    expect(res.statusCode).toBe(200);
    expect(res.json().keys.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 8: Run test**

Run: `npm run test -w @kairo/server`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/auth server/src/db server/drizzle server/src/plugins/raw-body.ts server/src/app.ts server/tests/auth-jwks.test.ts
git commit -m "feat(server): Better Auth (Google-only) + JWT/JWKS + bearer, mounted on /api/auth/*, seed hook

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Usage service + owned auth routes (`/auth/start|callback|exchange`)

**Files:**
- Create: `server/src/usage/service.ts`, `server/src/auth/codes.ts`, `server/src/auth/routes.ts`
- Modify: `server/src/app.ts`
- Test: `server/tests/codes.test.ts`, `server/tests/usage.test.ts`

- [ ] **Step 1: Create `server/src/usage/service.ts`**

```ts
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

// Seed the two per-user rows on signup (called from the Better Auth after-create hook).
export async function ensureUserRows(userId: string) {
  await db.execute(sql`INSERT INTO usage_counter (user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`);
  await db.execute(sql`INSERT INTO subscription (user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`);
}

// Atomic reserve: idempotent per askId, increments only while under the free limit (or pro).
// Returns true if allowed, false if the free limit is hit.
export async function reserve(userId: string, askId: string): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const dup = await tx.execute(
      sql`INSERT INTO usage_event (ask_id, user_id) VALUES (${askId}, ${userId})
          ON CONFLICT (ask_id) DO NOTHING RETURNING ask_id`);
    if (dup.rows.length === 0) return true; // replay of an already-counted ask -> allow
    const upd = await tx.execute(
      sql`UPDATE usage_counter SET used_free = used_free + 1, updated_at = now()
          WHERE user_id = ${userId} AND (plan = 'pro' OR used_free < free_limit)
          RETURNING used_free`);
    return upd.rows.length > 0;
  });
}

// Compensating refund (failure path), idempotent, never underflows.
export async function refund(userId: string, askId: string) {
  const r = await db.execute(
    sql`UPDATE usage_event SET counted = false WHERE ask_id = ${askId} AND counted = true RETURNING ask_id`);
  if (r.rows.length === 0) return;
  await db.execute(
    sql`UPDATE usage_counter SET used_free = GREATEST(used_free - 1, 0) WHERE user_id = ${userId} AND plan <> 'pro'`);
}

export async function readMe(userId: string) {
  const r = await db.execute(sql`
    SELECT u.email, uc.plan, uc.used_free, uc.free_limit, s.status, s.current_period_end, s.cancel_at_period_end
    FROM usage_counter uc
    JOIN "user" u ON u.id = uc.user_id
    LEFT JOIN subscription s ON s.user_id = uc.user_id
    WHERE uc.user_id = ${userId}`);
  return r.rows[0] as {
    email: string; plan: 'free'|'pro'; used_free: number; free_limit: number;
    status: string | null; current_period_end: string | null; cancel_at_period_end: boolean | null;
  } | undefined;
}
```

- [ ] **Step 2: Create `server/src/auth/codes.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

const TTL_MS = 60_000;

export async function mintCode(userId: string): Promise<string> {
  const code = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + TTL_MS);
  await db.execute(sql`INSERT INTO oauth_code (code, user_id, expires_at) VALUES (${code}, ${userId}, ${expires})`);
  return code;
}

// Validate + burn in one shot. Returns userId or null.
export async function redeemCode(code: string): Promise<string | null> {
  const r = await db.execute(sql`
    UPDATE oauth_code SET used = true
    WHERE code = ${code} AND used = false AND expires_at > now()
    RETURNING user_id`);
  return r.rows.length ? (r.rows[0] as any).user_id as string : null;
}
```

- [ ] **Step 3: Create `server/src/auth/routes.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { auth } from './better-auth.js';
import { mintCode, redeemCode } from './codes.js';
import { env } from '../config/env.js';

export async function ownedAuthRoutes(app: FastifyInstance) {
  // Desktop opens this in the system browser.
  app.get('/auth/start', async (_req, reply) => {
    const { url } = await auth.api.signInSocial({
      body: { provider: 'google', callbackURL: `${env.PUBLIC_BASE_URL}/auth/callback` },
    });
    return reply.redirect(url!);
  });

  // Better Auth returns here with a live session (cookie on this response). Mint a one-time code
  // and hand it to the desktop over the custom scheme. The JWT/session never rides in the URL.
  app.get('/auth/callback', async (req, reply) => {
    const session = await auth.api.getSession({ headers: req.headers as any });
    if (!session?.user) return reply.status(401).send({ error: 'no_session', code: 'unauthenticated' });
    const code = await mintCode(session.user.id);
    return reply.redirect(`kairo://auth-callback?code=${encodeURIComponent(code)}`);
  });

  // Desktop exchanges the one-time code over HTTPS for a durable session token.
  app.post<{ Body: { code: string } }>('/auth/exchange', async (req, reply) => {
    const userId = await redeemCode(req.body?.code ?? '');
    if (!userId) return reply.status(400).send({ error: 'bad_code', code: 'bad_request' });
    // Issue a Better Auth session token for this user (server-side). See Better Auth admin/session API.
    const token = await auth.api.signInAsUser?.({ body: { userId } }).catch(() => null);
    // Fallback: if signInAsUser isn't available in this version, create a session via the DB/session API.
    return reply.send({ sessionToken: token?.token ?? null, userId });
  });
}
```
> **Version check:** the exact server-side "create a session for a known user" call differs across
> Better Auth versions (`auth.api.signInAsUser`, an admin plugin, or a direct `createSession`).
> Confirm the current API and adjust `/auth/exchange` to return a real `sessionToken`. This is the
> one spot to verify against installed docs.

- [ ] **Step 4: Register owned routes in `app.ts`**

```ts
import { ownedAuthRoutes } from './auth/routes.js';
// inside buildApp():
await app.register(ownedAuthRoutes);
```

- [ ] **Step 5: Write `server/tests/codes.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { mintCode, redeemCode } from '../src/auth/codes.js';

const uid = 'test-user-codes';
describe('one-time codes', () => {
  it('mints, redeems once, then rejects reuse', async () => {
    await db.execute(sql`INSERT INTO "user"(id,email,"emailVerified","createdAt","updatedAt")
      VALUES(${uid},'c@t.dev',true,now(),now()) ON CONFLICT DO NOTHING`);
    const code = await mintCode(uid);
    expect(await redeemCode(code)).toBe(uid);
    expect(await redeemCode(code)).toBeNull(); // burned
    expect(await redeemCode('nope')).toBeNull();
  });
});
```

- [ ] **Step 6: Write `server/tests/usage.test.ts`**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { ensureUserRows, reserve, refund } from '../src/usage/service.js';

const uid = 'test-user-usage';
beforeAll(async () => {
  await db.execute(sql`INSERT INTO "user"(id,email,"emailVerified","createdAt","updatedAt")
    VALUES(${uid},'u@t.dev',true,now(),now()) ON CONFLICT DO NOTHING`);
  await db.execute(sql`DELETE FROM usage_event WHERE user_id=${uid}`);
  await ensureUserRows(uid);
  await db.execute(sql`UPDATE usage_counter SET used_free=0, plan='free', free_limit=3 WHERE user_id=${uid}`);
});

describe('metering', () => {
  it('allows up to the limit, then blocks; idempotent per askId; refund frees a slot', async () => {
    const a = randomUUID(), b = randomUUID(), c = randomUUID(), d = randomUUID();
    expect(await reserve(uid, a)).toBe(true);
    expect(await reserve(uid, a)).toBe(true);   // replay -> still allowed, not double counted
    expect(await reserve(uid, b)).toBe(true);
    expect(await reserve(uid, c)).toBe(true);
    expect(await reserve(uid, d)).toBe(false);  // limit (3) reached
    await refund(uid, c);
    const e = randomUUID();
    expect(await reserve(uid, e)).toBe(true);   // slot freed
  });
});
```

- [ ] **Step 7: Run tests**

Run: `npm run test -w @kairo/server`
Expected: PASS (both files).

- [ ] **Step 8: Commit**

```bash
git add server/src/usage server/src/auth server/src/app.ts server/tests/codes.test.ts server/tests/usage.test.ts
git commit -m "feat(server): usage metering service + one-time-code deep-link auth routes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: JWT verify plugin + `GET /v1/me`

**Files:**
- Create: `server/src/plugins/auth-verify.ts`, `server/src/usage/routes.ts`
- Modify: `server/src/app.ts`
- Test: `server/tests/me.test.ts`

- [ ] **Step 1: Create `server/src/plugins/auth-verify.ts`**

```ts
import fp from 'fastify-plugin';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../config/env.js';
import { AuthError } from './error-handler.js';

const JWKS = createRemoteJWKSet(new URL(`${env.PUBLIC_BASE_URL}/api/auth/jwks`));

declare module 'fastify' {
  interface FastifyRequest { userId: string; }
}

export default fp(async (app) => {
  app.decorateRequest('userId', '');
  app.decorate('requireAuth', async function (req: any) {
    const h = req.headers.authorization as string | undefined;
    if (!h?.startsWith('Bearer ')) throw new AuthError('missing bearer');
    try {
      const { payload } = await jwtVerify(h.slice(7), JWKS, {
        issuer: env.PUBLIC_BASE_URL, audience: env.PUBLIC_BASE_URL,
      });
      req.userId = payload.sub as string;
    } catch { throw new AuthError('invalid token'); }
  });
});

declare module 'fastify' {
  interface FastifyInstance { requireAuth: (req: any) => Promise<void>; }
}
```

- [ ] **Step 2: Create `server/src/usage/routes.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { MeResponse } from '@kairo/shared';
import { readMe } from './service.js';

export async function usageRoutes(app: FastifyInstance) {
  app.get('/v1/me', { preHandler: app.requireAuth }, async (req, reply): Promise<MeResponse> => {
    const row = await readMe(req.userId);
    if (!row) return reply.status(404).send({ error: 'no_user', code: 'bad_request' }) as any;
    const isPro = row.plan === 'pro';
    const remaining = isPro ? null : Math.max(row.free_limit - row.used_free, 0);
    return {
      user: { id: req.userId, email: row.email },
      plan: row.plan,
      status: (row.status ?? 'none') as MeResponse['status'],
      usage: { used: row.used_free, limit: row.free_limit, remaining },
      renews_at: row.current_period_end,
      cancel_at_period_end: row.cancel_at_period_end ?? false,
      paywalled: !isPro && remaining === 0,
    };
  });
}
```

- [ ] **Step 3: Register in `app.ts`**

```ts
import authVerify from './plugins/auth-verify.js';
import { usageRoutes } from './usage/routes.js';
// inside buildApp(): register the plugin BEFORE routes that use requireAuth
await app.register(authVerify);
await app.register(usageRoutes);
```

- [ ] **Step 4: Write `server/tests/me.test.ts`**

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';

const app = await buildApp();
afterAll(() => app.close());

describe('/v1/me', () => {
  it('401s without a bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('unauthenticated');
  });
});
```
> A positive-path `/v1/me` test needs a real signed JWT; add it in Plan 2 integration once the
> desktop can mint one, or mint one in-test via `auth.api` if convenient.

- [ ] **Step 5: Run test**

Run: `npm run test -w @kairo/server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/plugins/auth-verify.ts server/src/usage/routes.ts server/src/app.ts server/tests/me.test.ts
git commit -m "feat(server): JWKS bearer verify plugin + GET /v1/me

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: AI proxy — forward helper + LLM/vision routes (meter the tutor turn)

**Files:**
- Create: `server/src/config/providers.ts`, `server/src/lib/http.ts`, `server/src/proxy/forward.ts`, `server/src/proxy/llm.ts`
- Modify: `server/src/app.ts`
- Test: `server/tests/proxy-llm.test.ts`

- [ ] **Step 1: Create `server/src/config/providers.ts`** (server mirror of `constants.rs`)

```ts
import { env } from './env.js';

type Provider = { baseUrl: string; key?: string; authHeader: (k: string) => Record<string, string>; timeoutMs: number };

export const providers: Record<string, Provider> = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', key: env.OPENROUTER_API_KEY,
    authHeader: (k) => ({ authorization: `Bearer ${k}`, 'x-openrouter-title': 'Kairo Tutor', 'http-referer': 'https://kairo.tutor' }), timeoutMs: 45_000 },
  anthropic: { baseUrl: 'https://api.anthropic.com', key: env.ANTHROPIC_API_KEY,
    authHeader: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }), timeoutMs: 15_000 },
  openai: { baseUrl: 'https://api.openai.com', key: env.OPENAI_API_KEY,
    authHeader: (k) => ({ authorization: `Bearer ${k}` }), timeoutMs: 15_000 },
  sarvam: { baseUrl: 'https://api.sarvam.ai', key: env.SARVAM_API_KEY,
    authHeader: (k) => ({ 'api-subscription-key': k }), timeoutMs: 45_000 },
  elevenlabs: { baseUrl: 'https://api.elevenlabs.io', key: env.ELEVENLABS_API_KEY,
    authHeader: (k) => ({ 'xi-api-key': k }), timeoutMs: 45_000 },
};
```

- [ ] **Step 2: Create `server/src/lib/http.ts`**

```ts
import { Agent } from 'undici';
// Keep-alive pool to provider hosts (mirrors reqwest warm pool so the first ask skips cold TLS).
export const agent = new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000, connections: 32 });
```

- [ ] **Step 3: Create `server/src/proxy/forward.ts`**

```ts
import { request } from 'undici';
import type { FastifyReply } from 'fastify';
import { agent } from '../lib/http.js';
import { providers } from '../config/providers.js';
import { ProviderError } from '../plugins/error-handler.js';

// Forward a JSON request to `${provider}${path}` injecting the real key. Returns parsed JSON.
export async function forwardJson(providerId: string, path: string, body: unknown, extraHeaders: Record<string,string> = {}) {
  const p = providers[providerId];
  if (!p?.key) throw new ProviderError(`no key for ${providerId}`);
  const res = await request(`${p.baseUrl}${path}`, {
    method: 'POST', dispatcher: agent, headersTimeout: p.timeoutMs, bodyTimeout: p.timeoutMs,
    headers: { 'content-type': 'application/json', ...p.authHeader(p.key), ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await res.body.text();
  if (res.statusCode >= 400) throw new ProviderError(`${providerId} ${res.statusCode}: ${text.slice(0,200)}`);
  return { status: res.statusCode, json: JSON.parse(text) };
}
```

- [ ] **Step 4: Create `server/src/proxy/llm.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { ASK_ID_HEADER } from '@kairo/shared';
import { forwardJson } from './forward.js';
import { reserve, refund } from '../usage/service.js';
import { QuotaExceededError } from '../plugins/error-handler.js';

export async function llmRoutes(app: FastifyInstance) {
  // Gate/text/ack — JWT-gated, UNMETERED.
  app.post('/v1/llm/chat', { preHandler: app.requireAuth }, async (req) => {
    const { json } = await forwardJson('openrouter', '/chat/completions', req.body);
    return json;
  });

  // The answer+box turn — JWT-gated AND METERED (one ask = one unit).
  app.post('/v1/vision/tutor', { preHandler: app.requireAuth }, async (req, reply) => {
    const askId = (req.headers[ASK_ID_HEADER] as string) || crypto.randomUUID();
    const provider = (req.body as any)?._provider === 'anthropic' ? 'anthropic' : 'openai';
    const path = provider === 'anthropic' ? '/v1/messages' : '/v1/responses';
    const allowed = await reserve(req.userId, askId);
    if (!allowed) throw new QuotaExceededError('free limit reached');
    try {
      const { json } = await forwardJson(provider, path, stripMeta(req.body));
      return json;
    } catch (e) {
      await refund(req.userId, askId); // don't burn a credit on our/provider failure
      throw e;
    }
  });

  // Computer-use pointing — UNMETERED (part of the same ask).
  app.post('/v1/vision/point', { preHandler: app.requireAuth }, async (req) => {
    const { json } = await forwardJson('openai', '/v1/responses', stripMeta(req.body));
    return json;
  });
}

function stripMeta(body: unknown) {
  const b = { ...(body as any) }; delete b._provider; return b;
}
```
> The desktop sends the provider-shaped body it already builds. `_provider` is an optional hint the
> Rust side adds so the backend knows anthropic-vs-openai for the tutor turn (Plan 2 wires it). If
> absent, defaults to the configured default (openai).

- [ ] **Step 5: Register + raise bodyLimit in `app.ts`**

```ts
import { llmRoutes } from './proxy/llm.js';
// bump Fastify bodyLimit (screenshots ~80KB base64; be safe on hi-DPI):
// in buildApp(): const app = Fastify({ logger:{level:'info'}, bodyLimit: 16*1024*1024 });
await app.register(llmRoutes);
```

- [ ] **Step 6: Write `server/tests/proxy-llm.test.ts`** (mock upstream via a stubbed `forwardJson`)

```ts
import { describe, it, expect, vi, afterAll } from 'vitest';
vi.mock('../src/proxy/forward.js', () => ({ forwardJson: vi.fn(async () => ({ status: 200, json: { ok: true } })) }));
import { buildApp } from '../src/app.js';

const app = await buildApp();
afterAll(() => app.close());

describe('proxy/llm', () => {
  it('401s /v1/vision/tutor without auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/vision/tutor', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});
```
> Metered-path 402 behavior is covered by the unit test in Task 6 (`reserve`); a full authed
> integration test lands in Plan 2.

- [ ] **Step 7: Run test**

Run: `npm run test -w @kairo/server`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/config/providers.ts server/src/lib/http.ts server/src/proxy server/src/app.ts server/tests/proxy-llm.test.ts
git commit -m "feat(server): AI proxy LLM/vision routes with key injection; meter the tutor turn

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Speech proxy — STT (multipart) + TTS + streaming TTS passthrough

**Files:**
- Create: `server/src/proxy/stream.ts`, `server/src/proxy/speech.ts`
- Modify: `server/src/app.ts`
- Test: `server/tests/proxy-speech.test.ts`

- [ ] **Step 1: Create `server/src/proxy/stream.ts`**

```ts
import { request } from 'undici';
import { pipeline } from 'node:stream/promises';
import type { FastifyReply } from 'fastify';
import { agent } from '../lib/http.js';
import { providers } from '../config/providers.js';

// Stream an upstream chunked body straight to the client. Never awaits the whole body.
// If the client disconnects (barge-in), pipeline rejects -> we abort the upstream request.
export async function streamPassthrough(providerId: string, path: string, body: unknown, reply: FastifyReply) {
  const p = providers[providerId];
  const ac = new AbortController();
  const up = await request(`${p.baseUrl}${path}`, {
    method: 'POST', dispatcher: agent, signal: ac.signal, bodyTimeout: p.timeoutMs,
    headers: { 'content-type': 'application/json', ...p.authHeader(p.key!) },
    body: JSON.stringify(body),
  });
  reply.header('content-type', 'application/octet-stream');
  reply.hijack();
  reply.raw.on('close', () => { if (!reply.raw.writableEnded) ac.abort(); }); // client gone -> stop paying upstream
  try { await pipeline(up.body, reply.raw); }
  catch { ac.abort(); if (!reply.raw.writableEnded) reply.raw.end(); }
}
```

- [ ] **Step 2: Create `server/src/proxy/speech.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { request } from 'undici';
import { agent } from '../lib/http.js';
import { providers } from '../config/providers.js';
import { forwardJson } from './forward.js';
import { streamPassthrough } from './stream.js';

export async function speechRoutes(app: FastifyInstance) {
  await app.register(multipart, { limits: { fileSize: 16 * 1024 * 1024 } });

  // STT — forward multipart (WAV up to ~3MB) to Sarvam/ElevenLabs.
  app.post('/v1/stt', { preHandler: app.requireAuth }, async (req, reply) => {
    const p = providers.sarvam;
    const parts: Buffer[] = [];
    const mp = await req.file();               // one WAV field
    for await (const chunk of mp!.file) parts.push(chunk as Buffer);
    const form = new FormData();
    form.append('file', new Blob([Buffer.concat(parts)]), mp!.filename);
    // include any text fields Sarvam needs (model, language) — copied from mp.fields as needed
    const res = await request(`${p.baseUrl}/speech-to-text`, {
      method: 'POST', dispatcher: agent, headers: { ...p.authHeader(p.key!) }, body: form as any,
    });
    reply.status(res.statusCode); return res.body.text().then(JSON.parse);
  });

  // TTS buffered.
  app.post('/v1/tts', { preHandler: app.requireAuth }, async (req) => {
    const { json } = await forwardJson('sarvam', '/text-to-speech', req.body);
    return json;
  });

  // TTS streaming (linear16 PCM) — pipe straight through.
  app.post('/v1/tts/stream', { preHandler: app.requireAuth }, async (req, reply) => {
    await streamPassthrough('sarvam', '/text-to-speech/stream', req.body, reply);
  });
}
```

- [ ] **Step 3: Register in `app.ts`**

```ts
import { speechRoutes } from './proxy/speech.js';
await app.register(speechRoutes);
```

- [ ] **Step 4: Write `server/tests/proxy-speech.test.ts`**

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';

const app = await buildApp();
afterAll(() => app.close());

describe('proxy/speech', () => {
  it('401s /v1/tts/stream without auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/tts/stream', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});
```
> Streaming/disconnect behavior is verified manually in Step 5 (inject can't model a mid-stream
> client abort); a live curl test is the real check.

- [ ] **Step 5: Manual streaming smoke (optional, needs a real Sarvam key + a valid JWT)**

Run the dev server, then `curl -N` the stream endpoint with a Bearer token and observe chunks arrive incrementally (first bytes fast, not one big blob at the end).

- [ ] **Step 6: Run test + commit**

Run: `npm run test -w @kairo/server`
Expected: PASS.

```bash
git add server/src/proxy/stream.ts server/src/proxy/speech.ts server/src/app.ts server/tests/proxy-speech.test.ts
git commit -m "feat(server): speech proxy — STT multipart + buffered TTS + streaming TTS passthrough

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: End-to-end auth smoke + typecheck gate + README

**Files:**
- Create: `server/README.md`
- Modify: none (verification task)

- [ ] **Step 1: Full server typecheck**

Run: `npm run typecheck -w @kairo/server`
Expected: PASS (fix any type errors surfaced across tasks).

- [ ] **Step 2: Full server test run**

Run: `npm run test -w @kairo/server`
Expected: all suites PASS.

- [ ] **Step 3: Manual Google sign-in smoke (real browser)**

Start the dev server. In a browser open `http://localhost:8787/auth/start`. Complete Google
consent. Expected: browser is redirected to `kairo://auth-callback?code=…` (the OS will warn no app
handles `kairo://` yet — that's Plan 2). Copy the `code`, then:
`curl -s -X POST localhost:8787/auth/exchange -H 'content-type: application/json' -d '{"code":"<code>"}'`
Expected: a `{ sessionToken, userId }` JSON (confirms the whole Google→session→code→exchange chain).

- [ ] **Step 4: Verify a user row + seeded counter exist**

`curl` is fine, or check Neon: `SELECT id,email FROM "user";` and `SELECT * FROM usage_counter;`
Expected: your Google user + a `usage_counter` row (`used_free=0, free_limit=10`) from the seed hook.

- [ ] **Step 5: Write `server/README.md`** (short run/deploy notes)

```markdown
# Kairo Server
Fastify + Neon + Better Auth (Google-only) + AI proxy. See ../AGENTS.md and ./AGENTS.md.

## Dev
- `cp .env.example .env` and fill (DATABASE_URL = Neon POOLED url; test-mode Dodo key).
- `npm run db:migrate -w @kairo/server` then `npm run server:dev`.
- Google OAuth redirect URI: `http://localhost:8787/api/auth/callback/google`.

## Deploy (Hetzner, later)
- Build `npm run build -w @kairo/server`; run `node dist/db/migrate.js` as a release step; `node dist/index.js`.
- Live keys only in the box env. Add prod redirect URI `https://api.<domain>/api/auth/callback/google`.
```

- [ ] **Step 6: Final commit**

```bash
git add server/README.md
git commit -m "docs(server): run/deploy notes; Plan 1 (backend + auth spine) complete

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review checklist (done during authoring)

- **Spec coverage:** monorepo (§4) ✓; backend module tree (§5.1) ✓; Drizzle (§5, Task4) ✓; Better Auth Google-only + JWT/JWKS (§5.2, Task5/7) ✓; owned deep-link routes (§5.2, Task6) ✓; metering DDL + atomic reserve/refund (§6, Task4/6) ✓; proxy passthrough + streaming (§5.3, Task8/9) ✓; `/me` + 402 (§6.5, Task7/8) ✓; agent rules (§9, Task2) ✓. Deferred by design to later plans: native repoint + deep-link + Keychain + frontend (Plan 2); Dodo webhook enforcement (Plan 3); CI hooks (Plan 4).
- **Types consistent:** `usage_counter(used_free, free_limit, plan)`, `reserve/refund(userId, askId)`, `MeResponse`, `ASK_ID_HEADER`, `sessionToken` used consistently across tasks.
- **Version-sensitive spots flagged:** Better Auth handler mount (Task5 S6), `@better-auth/cli generate` output (Task5 S2), `/auth/exchange` session-creation call (Task6 S3) — each carries a "verify against installed version" note.

## Open items to confirm while executing
1. `NEON_CONNECTION_STRING` is the **pooled** endpoint (host contains `-pooler`). If it's the direct one, swap it.
2. The exact Better Auth server API to mint a session for a known user in `/auth/exchange` (version-dependent).
3. Whether the global raw-body parser (Task5 S5) needs to be scoped to `/api/auth/*` to avoid clashing with JSON proxy routes — prefer scoping.
