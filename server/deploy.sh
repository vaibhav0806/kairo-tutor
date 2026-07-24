#!/usr/bin/env bash
# Redeploy the Kairo backend on the Hetzner box. Run from the repo root on the host:
#   ssh era@<box> 'cd ~/kairo && git pull --ff-only && bash server/deploy.sh'
#
# Builds the image, applies forward-only migrations as a release step (never on boot),
# (re)starts the container, and gates success on /readyz. Secrets come from server/.env
# on the box (gitignored) — this script never handles them.
set -euo pipefail
cd "$(dirname "$0")" # -> server/ (compose file + .env live here)

if [ ! -f .env ]; then
  echo "ERROR: server/.env missing on the box — cannot deploy." >&2
  exit 1
fi

echo "==> build image"
docker compose build

echo "==> migrate (forward-only, prod Neon branch)"
docker compose run --rm kairo-server node dist/db/migrate.js

echo "==> (re)start service"
docker compose up -d

echo "==> wait for health"
for _ in $(seq 1 20); do
  s=$(docker inspect -f '{{.State.Health.Status}}' kairo-server 2>/dev/null || echo none)
  echo "health=$s"
  [ "$s" = healthy ] && break
  sleep 2
done

echo "==> readyz gate"
docker exec kairo-server node -e "fetch('http://127.0.0.1:8787/readyz').then(async r=>{console.log('readyz',r.status,await r.text());process.exit(r.ok?0:1)}).catch(e=>{console.error('ERR',e.message);process.exit(1)})"
echo "==> deploy OK"
