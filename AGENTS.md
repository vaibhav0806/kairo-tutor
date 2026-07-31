# Kairo Tutor contributor instructions

This file is the shared, tool-neutral source of truth for work in this repository.
`CLAUDE.md` imports it. Backend-specific rules live in
[`server/AGENTS.md`](./server/AGENTS.md).

## Repository map

- `src/`: React 19 frontend. `main.tsx` routes the main/settings, onboarding, notch,
  overlay, and cursor WebViews.
- `src-tauri/`: Tauri v2 and Rust code for audio, screen capture, global input,
  native panels, provider calls, and application state.
- `server/`: Fastify backend for Google authentication, provider proxying, usage,
  preferences, and billing.
- `tests/`: desktop frontend and orchestration tests.
- `docs/`: product and engineering documentation.

Kairo is macOS-first. Keep portable code cross-platform where practical and guard
macOS-specific Rust with `#[cfg(target_os = "macos")]`.

## Contributor workflow

Requirements and local setup are documented in [`README.md`](./README.md). Use Node
22, the stable Rust toolchain, and Xcode or its Command Line Tools.

```bash
npm ci
npm run typecheck
npm test
cargo check --manifest-path src-tauri/Cargo.toml
npm run app:build:unsigned
open "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
```

Contributor builds are unsigned and may need macOS permissions granted again after
rebuilding. Do not change the committed signing configuration to make a local build
work. Build the local-backend variant with:

```bash
KAIRO_BACKEND_TARGET=local npm run app:build:unsigned
```

Do not commit `.env` files, credentials, tokens, raw provider payloads, or generated
build artifacts. Provider keys belong in `server/.env` for backend development; they
must never be embedded in the desktop bundle.

## Desktop architecture

- `src-tauri/src/lib.rs` owns Tauri setup, managed state, and command registration.
  Keep `main.rs` as the thin entry point.
- Register every new `#[tauri::command]` in `tauri::generate_handler!` and expose it
  through the typed wrapper in `src/native/nativeBridge.ts`.
- Tauri v2 capabilities live in `src-tauri/capabilities/`. Add only the permissions a
  feature needs.
- Keep frontend orchestration in `src/core/` and native/macOS behavior in focused
  Rust modules. Follow existing module boundaries instead of adding parallel paths.
- The notch is non-activating, while the interactive overlay must be able to become
  key. The cursor is a separate click-through panel.
- Backend selection is owned by native code. Do not introduce a second frontend
  backend URL setting.
- The shipped path proxies provider requests through `server/`. Direct provider
  access exists only for local debugging.

When adding a macOS capability, update the relevant Info.plist entries,
entitlements, and Tauri capability definitions together. Document any permission a
user will be asked to grant.

## Privacy and logging

Kairo handles microphone recordings, screenshots, transcripts, and model responses.
Read [`PRIVACY.md`](./PRIVACY.md) before changing capture or provider flows.

- Never log secrets, authorization data, PII, raw audio, screenshot data, window
  titles, transcripts, questions, answers, or raw provider bodies.
- Log metadata such as byte counts, dimensions, duration, status, and text length.
- Full-text logging must remain disabled in distributable builds
  (`src-tauri/src/constants.rs::LOG_TRANSCRIPTS`).
- Preserve the sensitive-application capture check and the frontmost-application
  recheck around screen capture.
- Minimize data sent to external providers and update `PRIVACY.md` when that data flow
  changes.

Rust uses the non-blocking `klog!` logger; frontend code uses `klog()` from
`src/core/logger.ts`. Do not add `println!`, `eprintln!`, or `console.*` logging.
Log meaningful state transitions, provider timings, and error paths without placing
blocking work on audio callbacks, event taps, or UI threads.

## Code and test conventions

- Read the surrounding implementation and match its style before editing.
- Prefer small, focused changes. Do not combine unrelated refactors with feature or
  security work.
- Add or update tests for behavior changes. Frontend tests run in a Node environment,
  so guard browser globals such as `window`.
- Use owned arguments for async Tauri commands and return serializable results and
  errors across the IPC boundary.
- Keep secrets and raw sensitive content out of fixtures and snapshots.
- Do not weaken authentication, webhook verification, database-target guards, CSP,
  capture protections, or Tauri capabilities to make a test pass.

Run the checks that match the changed area before declaring work complete:

```bash
npm run typecheck
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --manifest-path src-tauri/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run typecheck -w @kairo/server
npm run test -w @kairo/server
npm run build -w @kairo/server
```

The server test suite requires the loopback PostgreSQL 17 test database described in
the README. Provider smoke tests (`npm run smoke:providers`) require local credentials
and should run only when provider integrations change.
