# syntax=docker/dockerfile:1
# Kairo backend image — Fastify auth + AI proxy + billing.
# Build context is the REPO ROOT (needs the npm workspace + @kairo/shared source).
# Multi-stage: build the tsup bundle with full deps, then ship pruned prod deps + dist + SQL.

# ---- builder: install workspaces, build the self-contained bundle ----
FROM node:22-slim AS builder
WORKDIR /app

# Manifests first so the `npm ci` layer caches until deps change.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
RUN npm ci

# Sources, then build only the server workspace (tsup inlines @kairo/shared).
COPY packages/shared packages/shared
COPY server server
RUN npm run build -w @kairo/server \
 && npm prune --omit=dev

# ---- runtime: node + pruned prod deps + built dist + migration SQL ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
# The pruned workspace tree: hoisted root node_modules + built server/dist +
# server/drizzle (the migrator reads ./drizzle at runtime).
COPY --from=builder /app /app
WORKDIR /app/server
EXPOSE 8787
CMD ["node", "dist/index.js"]
