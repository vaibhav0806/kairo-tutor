#!/usr/bin/env bash
#
# Cut an alpha release: build the DMG + updater artifact, sign both, write the
# updater manifest, and (optionally) publish everything to Cloudflare R2.
#
#   npm run release                # build + sign + write dist/release/, no upload
#   npm run release -- --publish   # …then upload to R2
#   npm run release -- --universal # Apple silicon + Intel in one artifact (slower build)
#
# Two DIFFERENT signatures are involved and they are unrelated:
#   1. Apple codesigning — the local self-signed "Kairo Tutor Local Dev" cert. It is
#      what macOS ties TCC grants to, so every release MUST be signed with the same
#      identity or users silently lose Screen Recording / Accessibility on update.
#      It is NOT trusted by Gatekeeper, which is why first-time installers run xattr.
#   2. Updater minisign — an Ed25519 keypair we own, used to sign the update archive.
#      Independent of Apple; this is what makes unnotarized self-updates safe.
#
# The minisign PRIVATE key never lives in this repo. Generate it once:
#   npm run updater:keygen
# then paste the printed public key into src-tauri/tauri.conf.json → plugins.updater.pubkey
# and export these before releasing (from your password manager):
#   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/kairo-updater.key)"
#   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="…"
#
# LOSING THE PRIVATE KEY IS UNRECOVERABLE: every already-installed app verifies against
# the embedded public key, so a new keypair cannot update them. They would all have to
# reinstall by hand. Back it up before the first public build.

set -euo pipefail

APP_NAME="Kairo Tutor"
OUT_DIR="dist/release"
R2_BUCKET="${KAIRO_R2_BUCKET:-kairo-downloads}"
# Public base for UPDATER artifacts only (Cloudflare R2 custom domain). The DMG is deliberately
# NOT published here — see below.
DOWNLOAD_BASE="${KAIRO_DOWNLOAD_BASE:-https://dl.meetkairo.xyz}"
# The DMG ships to the API box instead, where an email-gated route serves it.
RELEASE_HOST="${KAIRO_RELEASE_HOST:-era@178.105.44.3}"
RELEASE_SSH_KEY="${KAIRO_RELEASE_SSH_KEY:-$HOME/.ssh/id_ed25519_2}"
RELEASE_DIR="${KAIRO_RELEASE_DIR:-/srv/kairo-releases}"

cd "$(dirname "$0")/.."

PUBLISH=false
UNIVERSAL=false
for arg in "$@"; do
  case "${arg}" in
    --publish) PUBLISH=true ;;
    --universal) UNIVERSAL=true ;;
    *) echo "✗ Unknown flag: ${arg} (expected --publish and/or --universal)" >&2; exit 1 ;;
  esac
done

# A universal binary carries both an arm64 and an x86_64 slice; macOS runs the native one on each
# machine, so a single artifact serves Apple silicon and Intel with no Rosetta and no perf cost.
# It roughly doubles build time, hence opt-in. Note: this makes the app *launch* on Intel — it is
# not a substitute for actually testing there.
BUILD_TARGET_ARGS=()
BUNDLE_ROOT="src-tauri/target/release/bundle"
if [[ "${UNIVERSAL}" == true ]]; then
  if ! rustup target list --installed | grep -q '^x86_64-apple-darwin$'; then
    echo "✗ The x86_64-apple-darwin Rust target is missing (needed for a universal build)." >&2
    echo "  Install it with:  rustup target add x86_64-apple-darwin" >&2
    exit 1
  fi
  BUILD_TARGET_ARGS=(--target universal-apple-darwin)
  BUNDLE_ROOT="src-tauri/target/universal-apple-darwin/release/bundle"
fi

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
PUBKEY="$(node -p "require('./src-tauri/tauri.conf.json').plugins.updater.pubkey || ''")"

# --- 0. refuse to ship an unverifiable build --------------------------------
if [[ -z "${PUBKEY}" ]]; then
  cat >&2 <<'MSG'
✗ plugins.updater.pubkey is empty in src-tauri/tauri.conf.json.

  Shipping without it produces a build that can never self-update — and once users
  have it installed, the only fix is asking every one of them to reinstall by hand.

  Run:  npm run updater:keygen
  then paste the printed public key into tauri.conf.json and re-run this script.
MSG
  exit 1
fi

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "✗ TAURI_SIGNING_PRIVATE_KEY is not set — the updater archive would ship unsigned." >&2
  echo "  export TAURI_SIGNING_PRIVATE_KEY=\"\$(cat ~/.tauri/kairo-updater.key)\"" >&2
  exit 1
fi

echo "▸ Releasing ${APP_NAME} v${VERSION}"

# --- 1. pre-flight ----------------------------------------------------------
echo "▸ Pre-flight: typecheck + tests + cargo check…"
npm run typecheck
npm run test
cargo check --manifest-path src-tauri/Cargo.toml

osascript -e "quit app \"${APP_NAME}\"" 2>/dev/null || true
pkill -x kairo-tutor 2>/dev/null || true
sleep 1

# --- 2. build ---------------------------------------------------------------
# Keep Kairo's own UI out of user captures + the tutor's screenshot (same flag as `npm run dist`).
export KAIRO_SHOW_IN_CAPTURE=false
echo "▸ Building app + dmg (updater artifacts on)…"
npm run tauri:build -- "${BUILD_TARGET_ARGS[@]}" --bundles app,dmg

# --- 3. collect artifacts ---------------------------------------------------
DMG_FILE="$(ls -t "${BUNDLE_ROOT}"/dmg/*.dmg 2>/dev/null | head -1 || true)"
UPDATER_ARCHIVE="$(ls -t "${BUNDLE_ROOT}"/macos/*.app.tar.gz 2>/dev/null | head -1 || true)"
UPDATER_SIG="${UPDATER_ARCHIVE}.sig"

for artifact in "${DMG_FILE}" "${UPDATER_ARCHIVE}" "${UPDATER_SIG}"; do
  if [[ -z "${artifact}" || ! -f "${artifact}" ]]; then
    echo "✗ Missing build artifact: ${artifact:-<none produced>}" >&2
    echo "  Expected a .dmg, a .app.tar.gz and its .sig (createUpdaterArtifacts must be true)." >&2
    exit 1
  fi
done

echo "▸ Verifying the DMG signature…"
codesign --verify --strict --verbose=2 "${DMG_FILE}"

# --- 4. stage + write the updater manifest ----------------------------------
rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"

DMG_NAME="Kairo-Tutor-${VERSION}.dmg"
ARCHIVE_NAME="Kairo-Tutor-${VERSION}.app.tar.gz"
cp "${DMG_FILE}" "${OUT_DIR}/${DMG_NAME}"
cp "${UPDATER_ARCHIVE}" "${OUT_DIR}/${ARCHIVE_NAME}"

# A universal build serves both architectures from ONE archive (both slices are inside), so it
# lists darwin-x86_64 as well. An arm64-only build must NOT list x86_64: an Intel user would
# download an app that cannot run.
SIGNATURE="$(cat "${UPDATER_SIG}")" \
VERSION="${VERSION}" \
UNIVERSAL="${UNIVERSAL}" \
ARCHIVE_URL="${DOWNLOAD_BASE}/updater/${ARCHIVE_NAME}" \
node -e '
  const platform = {
    signature: process.env.SIGNATURE.trim(),
    url: process.env.ARCHIVE_URL,
  };
  const platforms = { "darwin-aarch64": platform };
  if (process.env.UNIVERSAL === "true") platforms["darwin-x86_64"] = platform;
  const manifest = {
    version: process.env.VERSION,
    notes: "See https://meetkairo.xyz/download",
    pub_date: new Date().toISOString(),
    platforms,
  };
  require("node:fs").writeFileSync("dist/release/latest.json", JSON.stringify(manifest, null, 2) + "\n");
'

echo "✓ Staged in ${OUT_DIR}:"
ls -lh "${OUT_DIR}"

# --- 5. publish -------------------------------------------------------------
if [[ "${PUBLISH}" != true ]]; then
  echo "▸ Dry run — nothing uploaded. Re-run with --publish to ship."
  exit 0
fi

# The DMG goes to the API box, NOT to public R2: the download is gated on an invited email, and a
# public object URL would hand the build to anyone who has the link. Updater artifacts DO stay
# public — they are fetched by already-installed apps, so gating them would only break updates for
# people who are already in.
echo "▸ Shipping the DMG to ${RELEASE_HOST}:${RELEASE_DIR}…"
ssh -i "${RELEASE_SSH_KEY}" "${RELEASE_HOST}" "sudo mkdir -p '${RELEASE_DIR}' && sudo chown \$(id -un):\$(id -gn) '${RELEASE_DIR}'"
scp -i "${RELEASE_SSH_KEY}" "${OUT_DIR}/${DMG_NAME}" "${RELEASE_HOST}:${RELEASE_DIR}/${DMG_NAME}"
# Atomic swap of the stable name the download route serves, so a request mid-upload never gets a
# half-written file.
ssh -i "${RELEASE_SSH_KEY}" "${RELEASE_HOST}" \
  "cp '${RELEASE_DIR}/${DMG_NAME}' '${RELEASE_DIR}/.latest.tmp' && mv '${RELEASE_DIR}/.latest.tmp' '${RELEASE_DIR}/Kairo-Tutor-latest.dmg'"

echo "▸ Uploading updater artifacts to R2 bucket ${R2_BUCKET}…"
npx --yes wrangler r2 object put "${R2_BUCKET}/updater/${ARCHIVE_NAME}" --file "${OUT_DIR}/${ARCHIVE_NAME}" --remote
# latest.json LAST: until it lands, the new archive is simply unreferenced. Uploading it
# first would point every installed app at an archive that may not have finished uploading.
npx --yes wrangler r2 object put "${R2_BUCKET}/updater/latest.json" --file "${OUT_DIR}/latest.json" --remote

echo "✓ Published v${VERSION}"
echo "  Download: https://meetkairo.xyz/download (email-gated; the DMG has no public URL)"
echo "  Manifest: ${DOWNLOAD_BASE}/updater/latest.json"
