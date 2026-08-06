#!/usr/bin/env bash
#
# The whole local stack in one terminal:
#
#   npm run local              # server (watch) + packaged .app pointed at it
#   npm run local -- --check   # …after typecheck + tests + cargo check
#   npm run local -- --reset   # …with app-scoped TCC grants + markers wiped
#   npm run local -- --reset-input-monitoring
#                              # …and clear Input Monitoring too (GLOBAL: other
#                              #   apps must be re-granted). Required for a TRUE
#                              #   first run — see the reset block below.
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
RESET_INPUT_MONITORING=""

for arg in "$@"; do
  case "$arg" in
    --check) CHECK="--check" ;;
    --reset) RESET="1" ;;
    --reset-input-monitoring) RESET="1"; RESET_INPUT_MONITORING="1" ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# --- optional: reset app state and app-scoped permissions --------------------
if [[ -n "$RESET" ]]; then
  echo "▸ Resetting app state and app-scoped TCC grants…"
  osascript -e 'tell application "Kairo Tutor" to quit' 2>/dev/null || true
  sleep 1
  tccutil reset ScreenCapture com.kairo.tutor || true
  tccutil reset Accessibility com.kairo.tutor || true
  tccutil reset Microphone com.kairo.tutor || true
  CFG="$HOME/Library/Application Support/com.kairo.tutor"
  rm -f "$CFG/onboarded" "$CFG/onboarding_step" "$CFG/user_name" "$CFG/accent" \
        "$CFG/screen_recording_granted" "$CFG/session.token" "$CFG/pending-auth.state"
  echo "  ✓ signed out, unonboarded, app-scoped grants reset"
  # Input Monitoring is keyed to the EXECUTABLE, not the bundle id, so no bundle-scoped reset can
  # clear it — only a global one can. That also clears OTHER apps' grants, which is why it is not
  # part of --reset. Without it this is NOT a true first run: the grant survives, so Act 2's
  # mic/keystroke primer never fires and onboarding behaves like a returning user's.
  if [[ -n "$RESET_INPUT_MONITORING" ]]; then
    echo "  ▸ Resetting Input Monitoring for ALL apps (global; re-grant others once)…"
    tccutil reset ListenEvent || true
    echo "  ✓ Input Monitoring cleared — this is a true first run"
  else
    echo "  ! Input Monitoring left intact, so this is NOT a true first run."
    echo "    Use --reset-input-monitoring to clear it (global: affects other apps too)."
  fi
fi

# --- 1. server ---------------------------------------------------------------
if curl -fsS --max-time 1 "$HEALTH" >/dev/null 2>&1; then
  echo "▸ A server is already answering on :${PORT} — reusing it."
  SERVER_PID=""
else
  echo "▸ Starting the local server (npm run server:dev)…"
  # Own process group so Ctrl-C can take the whole watch tree down, not just tsx.
  # Tee the server's own log to a file. Without this it goes to this terminal's stdout and is
  # gone the moment the wrapper exits — which left us unable to answer "did the request even
  # reach the server?", the one question that separates a client hang from a server hang.
  #
  # Next to the app log, dated, and appended — the same shape the Rust logger uses. It used to
  # live in $TMPDIR and be truncated on every start, which lost both ways: macOS clears that
  # directory on reboot, and the next run destroyed the previous one's evidence. The run that
  # measured 30 JWT mints against 35 authenticated calls is gone for exactly that reason, so the
  # fix it motivated cannot be checked against the thing it was diagnosed from.
  mkdir -p "$(dirname "$LOG")"
  SERVER_LOG="$(dirname "$LOG")/kairo-server.$(date +%Y-%m-%d).log"
  ln -sfn "$(basename "$SERVER_LOG")" "$(dirname "$LOG")/kairo-server-latest.log"
  npm run server:dev > >(tee -a "$SERVER_LOG") 2>&1 &
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
if [[ -n "${SERVER_LOG:-}" ]]; then
  echo "  Server log : tail -F ${SERVER_LOG}"
fi
echo ""

# Hold the terminal on the server so its output keeps streaming here.
if [[ -n "${SERVER_PID}" ]]; then
  wait "$SERVER_PID"
fi
