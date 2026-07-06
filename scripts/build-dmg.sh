#!/usr/bin/env bash
#
# Production DMG build for real users.
#
#   npm run dist
#
# Forces KAIRO_SHOW_IN_CAPTURE=false so the shipped app keeps Kairo's OWN UI (notch,
# pet cursor, guidance box) OUT of users' screenshots/recordings AND out of the
# tutor's own screenshot (so the AI's view stays clean). The user's pen marks are
# UNAFFECTED — panels.rs always includes them via the mode-based `shows_user_marks`
# rule. build.rs declares rerun-if-env-changed on this var, so the value is baked in
# correctly even right after a demo build that had it true.
#
# Output: src-tauri/target/release/bundle/dmg/*.dmg
#
# NOTE: the .app inside is signed with the local self-signed cert
# ("Kairo Tutor Local Dev"). That is fine for your own machines, but EXTERNAL users
# will hit Gatekeeper ("unidentified developer"). For public distribution, sign with
# a Developer ID identity and notarize — set APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID
# (Tauri notarizes automatically when they're present) and switch the signingIdentity
# in tauri.conf.json to your "Developer ID Application" cert.

set -euo pipefail

APP_NAME="Kairo Tutor"
DMG_DIR="src-tauri/target/release/bundle/dmg"

# Always operate from the repo root (parent of scripts/).
cd "$(dirname "$0")/.."

# Production-safe capture flag, baked in at compile time.
export KAIRO_SHOW_IN_CAPTURE=false

# --- 1. quit any running instance -------------------------------------------
echo "▸ Quitting any running ${APP_NAME}…"
osascript -e "quit app \"${APP_NAME}\"" 2>/dev/null || true
pkill -x kairo-tutor 2>/dev/null || true
sleep 1

# --- 2. pre-flight: fail before a long build if anything's broken -----------
echo "▸ Pre-flight: typecheck + tests + cargo check…"
npm run typecheck
npm run test
cargo check --manifest-path src-tauri/Cargo.toml

# --- 3. build + sign the DMG (SHOW_IN_CAPTURE=false) -------------------------
echo "▸ Building the production DMG (SHOW_IN_CAPTURE=false)…"
npm run tauri:build -- --bundles dmg

# --- 4. locate + verify the signed DMG --------------------------------------
# NOTE: Tauri deletes the staged .app once it's packaged into the DMG, so we verify
# the DMG's own signature (the .app inside was signed during bundling, seen above).
DMG_FILE="$(ls -t "${DMG_DIR}"/*.dmg 2>/dev/null | head -1 || true)"
if [[ -z "${DMG_FILE}" ]]; then
  echo "✗ No .dmg was produced in ${DMG_DIR}" >&2
  exit 1
fi

echo "▸ Verifying the DMG signature…"
codesign --verify --strict --verbose=2 "${DMG_FILE}"

# --- 5. report the artifact -------------------------------------------------
echo "✓ Production DMG built + signed: ${DMG_FILE}"
echo "  SHOW_IN_CAPTURE baked as FALSE — Kairo's UI stays out of users' captures + the AI's screenshot."
echo "  (.app inside signed with the local dev cert; for external users, notarize with a Developer ID — see header.)"
