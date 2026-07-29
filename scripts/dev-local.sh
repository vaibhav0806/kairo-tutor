#!/usr/bin/env bash
#
# The whole local stack in one terminal:
#
#   npm run local              # server (watch) + packaged .app pointed at it
#   npm run local -- --check   # …after typecheck + tests + cargo check
#   npm run local -- --reset   # …from a TRUE first run (TCC grants + markers wiped)
#
# The app half is exactly `npm run app:local` — the same packaged, signed bundle,
# never a dev server (see AGENTS.md). The only thing this adds is starting the
# Fastify server first, waiting until it actually answers, and tearing it down
# again when you Ctrl-C.
#
# Ctrl-C stops the server. The .app keeps running (it is a normal macOS app) —
# quit it from the tray, or run this again, which quits it before rebuilding.

set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-8787}"
HEALTH="http://localhost:${PORT}/healthz"
LOG="$HOME/Library/Logs/Kairo/kairo-latest.log"
CHECK=""
RESET=""

for arg in "$@"; do
  case "$arg" in
    --check) CHECK="--check" ;;
    --reset) RESET="1" ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# --- optional: a genuine first run -------------------------------------------
# Full reset per AGENTS.md — the TCC grants AND the on-disk markers. A
# markers-only wipe makes Act 2/3 behave like a returning user (permissions
# already granted → primers never fire), which is not a first run and hides bugs.
if [[ -n "$RESET" ]]; then
  echo "▸ Resetting to a true first run (TCC grants + markers)…"
  osascript -e 'tell application "Kairo Tutor" to quit' 2>/dev/null || true
  sleep 1
  tccutil reset ScreenCapture com.kairo.tutor || true
  tccutil reset Accessibility com.kairo.tutor || true
  tccutil reset Microphone com.kairo.tutor || true
  # Input Monitoring is keyed to the EXECUTABLE, not the bundle id, so a
  # bundle-scoped reset does not clear it. Resetting it for all apps is the only
  # reliable way — you may have to re-grant Input Monitoring elsewhere once.
  tccutil reset ListenEvent || true
  CFG="$HOME/Library/Application Support/com.kairo.tutor"
  rm -f "$CFG/onboarded" "$CFG/onboarding_step" "$CFG/user_name" "$CFG/accent" \
        "$CFG/screen_recording_granted" "$CFG/session.token"
  echo "  ✓ signed out, unonboarded, no grants"
fi

# --- 1. server ---------------------------------------------------------------
if curl -fsS --max-time 1 "$HEALTH" >/dev/null 2>&1; then
  echo "▸ A server is already answering on :${PORT} — reusing it."
  SERVER_PID=""
else
  echo "▸ Starting the local server (npm run server:dev)…"
  # Own process group so Ctrl-C can take the whole watch tree down, not just tsx.
  npm run server:dev &
  SERVER_PID=$!

  cleanup() {
    if [[ -n "${SERVER_PID}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
      echo ""
      echo "▸ Stopping the local server…"
      kill "$SERVER_PID" 2>/dev/null || true
      wait "$SERVER_PID" 2>/dev/null || true
    fi
  }
  trap cleanup EXIT INT TERM

  echo "▸ Waiting for ${HEALTH}…"
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 1 "$HEALTH" >/dev/null 2>&1; then
      echo "  ✓ server is up on :${PORT}"
      break
    fi
    # If it died on startup (bad env, port taken, Neon unreachable) say so now
    # rather than building a .app that has nothing to talk to.
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "✗ The server exited during startup — see its output above." >&2
      exit 1
    fi
    sleep 0.5
  done

  if ! curl -fsS --max-time 1 "$HEALTH" >/dev/null 2>&1; then
    echo "✗ The server never answered on ${HEALTH} (waited 30s)." >&2
    exit 1
  fi
fi

# --- 2. the packaged app, pointed at that server ------------------------------
echo "▸ Building + launching the app against http://localhost:${PORT}…"
KAIRO_BACKEND_TARGET=local bash scripts/rebuild-run.sh ${CHECK}

echo ""
echo "✓ Local stack is up."
echo "  Server : http://localhost:${PORT}  (this terminal — Ctrl-C stops it)"
echo "  App    : running, every request → http://localhost:${PORT}"
echo "  Logs   : tail -F ${LOG}"
echo ""

# Hold the terminal on the server so its output keeps streaming here.
if [[ -n "${SERVER_PID}" ]]; then
  wait "$SERVER_PID"
fi
