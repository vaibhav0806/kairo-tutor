#!/usr/bin/env bash
#
# Generate the updater's minisign keypair — ONCE, on the machine that cuts releases.
#
#   npm run updater:keygen
#
# This key is the root of trust for every self-update. It is NOT Apple codesigning and
# needs no Apple account: installed apps verify each update archive against the public
# key baked into their bundle.
#
# READ BEFORE RUNNING:
#   - You will be prompted for a password. Use one, and store BOTH the password and the
#     key file in your password manager immediately.
#   - The private key must never be committed, pasted into chat, or logged.
#   - If it is lost, every already-installed app becomes un-updatable — the public key is
#     baked into their bundle, so a new keypair cannot reach them. They would each have to
#     download and reinstall by hand. Back it up before the first public release.

set -euo pipefail

cd "$(dirname "$0")/.."

KEY_PATH="${KAIRO_UPDATER_KEY_PATH:-$HOME/.tauri/kairo-updater.key}"

if [[ -f "${KEY_PATH}" ]]; then
  echo "✗ A key already exists at ${KEY_PATH}" >&2
  echo "  Refusing to overwrite it — that would orphan every installed app." >&2
  echo "  Its public key is:" >&2
  cat "${KEY_PATH}.pub" >&2
  exit 1
fi

mkdir -p "$(dirname "${KEY_PATH}")"

echo "▸ Generating the updater keypair at ${KEY_PATH}"
echo "  (you'll be asked for a password — use one, and save it now)"
npx --yes @tauri-apps/cli signer generate -w "${KEY_PATH}"

cat <<MSG

✓ Keypair generated.

  Next steps:
    1. Copy the PUBLIC key below into src-tauri/tauri.conf.json → plugins.updater.pubkey
    2. Save ${KEY_PATH} and its password in your password manager
    3. Before each release:
         export TAURI_SIGNING_PRIVATE_KEY="\$(cat ${KEY_PATH})"
         export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="…"

  Public key (safe to commit):
MSG
cat "${KEY_PATH}.pub"
