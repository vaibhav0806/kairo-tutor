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

## Maintainer workflow

Applies only if you hold the project signing identity. **Do not use
`app:build:unsigned` on a machine that has it.** macOS ties Screen Recording,
Accessibility, and Input Monitoring grants to the signing identity, so an unsigned
build reads as a different app and silently loses every grant — the app then looks
broken for reasons that have nothing to do with your change.

```bash
npm run app             # quit → build + sign → verify signature → launch (hosted backend)
npm run app:local       # same, pointed at http://localhost:8787
npm run app -- --check  # run typecheck + tests + cargo check first
npm run local           # server (watch) + the packaged app against it
```

Never test against a dev server. Always exercise the packaged `.app` — that is where
native permissions, panels, and logging actually behave like they do for a user.

Rehearse onboarding from the top with `npm run local -- --reset-input-monitoring`.
Plain `--reset` leaves Input Monitoring granted, which is not a true first run: the
Act 2 primer never fires and the flow behaves like a returning user's.

## Reading the logs

Every subsystem, Rust and WebView alike, writes to one file:

```bash
tail -F ~/Library/Logs/Kairo/kairo-latest.log
```

Verbosity comes from the environment and needs no rebuild: `KAIRO_LOG=kairo=trace`
for maximum detail from our code, `KAIRO_LOG=debug` to include dependencies, or a
per-subsystem filter such as `KAIRO_LOG=info,kairo::vision=trace`. Set
`KAIRO_LOG_STDERR=true` to mirror to stderr when running from a terminal.

Redaction is compile-time. `constants::LOG_TRANSCRIPTS` (transcript and answer text)
follows the backend target automatically: a build compiled for the LOCAL backend logs
the text, and any other build cannot. So `npm run app:local` and `npm run local` give
you full transcripts with no flag to set and no flag to forget, while `npm run app`
and every released DMG are compiled without it and have no path to the text at all.

`constants::LOG_PROVIDER_BODIES` (provider error bodies) is still a manual switch —
enable it locally while debugging, rebuild, and never ship it enabled.

## Commit discipline

Work on `main` unless asked otherwise. Commit each change as you finish it — small,
revertible commits rather than one batch at the end. Keep unrelated refactors out of
a feature or security change.

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

- Never log secrets, authorization data, PII, raw audio, or screenshot data — in any
  build, without exception.
- Window titles, transcripts, questions, answers, and raw provider bodies are never
  logged by a hosted or released build. A LOCAL-backend build may log transcript and
  answer text, because it is a developer's own machine talking to their own server
  about their own data; see the compile-time switches above.
- Log metadata such as byte counts, dimensions, duration, status, and text length.
- Full-text logging must remain impossible in distributable builds. Keep
  `constants::LOG_TRANSCRIPTS` keyed to the compile-time backend target rather than to a
  hand-edited boolean, so shipping it on is not a mistake anyone can make.
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
