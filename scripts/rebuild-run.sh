#!/usr/bin/env bash
#
# The dev loop in one shot: quit → rebuild (+sign) → verify signature → relaunch
# the packaged .app. NEVER a dev server — native panels, TCC permissions, and the
# logger only behave correctly in the signed bundle (see CLAUDE.md).
#
#   npm run app            # quit, build+sign, verify, launch
#   npm run app -- --check # also run typecheck + tests + cargo check first
#
# Signing is automatic: tauri.conf.json → bundle.macOS.signingIdentity
# ("Kairo Tutor Local Dev"). This script additionally VERIFIES the signature so a
# broken sign fails loudly instead of at launch. The stable self-signed cert keeps
# macOS TCC grants (Screen Recording, Accessibility, Input Monitoring) across
# rebuilds, so relaunching in place needs no re-granting.

set -euo pipefail

APP_NAME="Kairo Tutor"
APP_PATH="src-tauri/target/release/bundle/macos/${APP_NAME}.app"
LOG="$HOME/Library/Logs/Kairo/kairo-latest.log"

# Always operate from the repo root (parent of scripts/).
cd "$(dirname "$0")/.."

# --- optional pre-flight checks ---------------------------------------------
if [[ "${1:-}" == "--check" ]]; then
  echo "▸ Pre-flight: typecheck + tests + cargo check…"
  npm run typecheck
  npm run test
  cargo check --manifest-path src-tauri/Cargo.toml
fi

# --- 1. quit any running instance (clean reinstall) --------------------------
echo "▸ Quitting any running ${APP_NAME}…"
osascript -e "quit app \"${APP_NAME}\"" 2>/dev/null || true
# Force-kill fallback uses the BINARY name (kairo-tutor), not the product name.
pkill -x kairo-tutor 2>/dev/null || true
sleep 1

# --- 2. build + sign ---------------------------------------------------------
echo "▸ Building + signing the .app…"
npm run tauri:build -- --bundles app

# --- 3. verify the signature (fail loud if signing broke) --------------------
echo "▸ Verifying code signature…"
codesign --verify --deep --strict --verbose=2 "${APP_PATH}"
echo "▸ Entitlements:"
codesign -d --entitlements :- "${APP_PATH}" 2>/dev/null || true

# --- 4. install to /Applications, then relaunch ------------------------------
#
# Install rather than launch in place, because macOS reopens an app by BUNDLE ID, not by path.
# Granting Screen Recording force-quits and reopens Kairo, and LaunchServices resolves
# com.kairo.tutor to whatever copy it knows about — which, if a released build was ever installed,
# is /Applications. The dev loop would then build one binary and the relaunch would silently run
# another: onboarding appeared to ignore fixes that were never actually running after the restart.
#
# Keeping exactly one copy, where a real install lives, makes the relaunch deterministic.
INSTALL_PATH="/Applications/${APP_NAME}.app"
echo "▸ Installing to ${INSTALL_PATH}…"
rm -rf "${INSTALL_PATH}"
ditto "${APP_PATH}" "${INSTALL_PATH}"

echo "▸ Launching ${APP_NAME}…"
open "${INSTALL_PATH}"

echo "✓ Done. Rebuilt, signed, verified, installed, launched."
echo "  App : ${INSTALL_PATH}"
echo "  Logs: tail -F ${LOG}"
