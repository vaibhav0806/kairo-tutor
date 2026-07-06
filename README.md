# Kairo Tutor

Kairo Tutor is a Mac-first, screen-native AI tutor for practical software labs. It helps students learn complex tools by listening to their question, understanding the current screen, and guiding them one step at a time with voice and visual cues.

The product principle is:

> The AI points. The user acts.

## Source Of Truth

This repo has two primary source-of-truth files:

- [FEATURE.md](./FEATURE.md): product vision, target users, MVP scope, roadmap, UX principles, safety principles, and success metrics.
- [README.md](./README.md): current implementation architecture, setup, commands, provider choices, and engineering rules.

Supporting files such as [plan.md](./plan.md) and [docs/clicky-borrowing-notes.md](./docs/clicky-borrowing-notes.md) are useful working documents, but if they conflict with `FEATURE.md` or `README.md`, update the supporting document. Product direction belongs in `FEATURE.md`; implementation truth belongs here.

## Current Architecture

The current implementation has three layers:

```text
React/Vite frontend
  - Tutor shell UI
  - Mock Blender tutoring loop
  - Native bridge with browser-safe fallback

Tauri desktop shell
  - macOS app wrapper
  - Rust command surface
  - Active app metadata
  - First-pass permission status
  - ScreenCaptureKit screen capture

Provider utilities
  - OpenRouter chat client
  - OpenAI-compatible tutor planner adapter
  - Sarvam STT/TTS adapter
  - ElevenLabs STT/TTS adapter
  - Env-selected provider adapter factory
  - Local provider smoke test
```

There is no separate deployed backend yet.

The current `src/server/` folder is not a running backend service. It contains server-side/provider-safe code that should not be shipped as browser-only logic. The current provider smoke test runs locally from Node.

The likely production backend shape is a small proxy service, probably Cloudflare Worker or similar, that stores provider secrets and exposes narrow routes for:

- OpenRouter chat/vision planning
- Sarvam speech-to-text
- Sarvam text-to-speech
- ElevenLabs speech-to-text
- ElevenLabs text-to-speech

Until that backend exists, do not put provider secrets into browser-exposed env variables. Real provider adapters live under [src/server/providers](./src/server/providers) and are designed to be called from a server-side or native-secret context, then passed into the existing tutor orchestrator.

## Product Scope

The first product wedge is:

> AI lab assistant for creative software institutes.

The first strong demo is:

> A student opens Blender, asks “Help me make my first animation,” and the tutor guides them with voice, highlights, and a ghost cursor.

Early scope:

- Mac-first desktop app
- Global activation
- Voice input and output
- Screen capture
- Active app detection
- Visual overlay guidance
- User annotation
- Blender skill pack
- Step-by-step guided lesson loop

Out of early scope:

- Autonomous clicking
- Full LMS
- Course marketplace
- Ten-tool support
- Enterprise compliance stack
- Windows before the Mac product loop works

## Tech Stack

- TypeScript
- React
- Vite
- Vitest
- Tauri v2
- Rust
- OpenRouter for model routing
- Sarvam for speech-to-text and text-to-speech

## Providers

Model routing:

```env
KAIRO_AI_PROVIDER=openrouter
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=qwen/qwen3.6-flash
OPENROUTER_VISION_MODEL=google/gemini-2.5-flash
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_REQUEST_TIMEOUT_MS=30000
```

Voice:

```env
KAIRO_STT_PROVIDER=sarvam
KAIRO_TTS_PROVIDER=sarvam
SARVAM_API_KEY=...
SARVAM_STT_MODEL=saaras:v3
SARVAM_STT_MODE=transcribe
SARVAM_TTS_MODEL=bulbul:v3
SARVAM_TTS_LANGUAGE_CODE=en-IN
SARVAM_TTS_SPEAKER=shubh
```

Alternative ElevenLabs speech:

```env
KAIRO_STT_PROVIDER=elevenlabs
KAIRO_TTS_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=...
ELEVENLABS_STT_MODEL=scribe_v1
ELEVENLABS_TTS_MODEL=eleven_multilingual_v2
ELEVENLABS_VOICE_ID=...
```

Local UI development can use mock providers:

```env
KAIRO_AI_PROVIDER=mock
KAIRO_STT_PROVIDER=mock
KAIRO_TTS_PROVIDER=mock
```

Only `KAIRO_*` values should be exposed to the browser bundle. Provider keys must stay in local env files, native secure storage, or a backend/proxy.

## Setup

```bash
npm install
cp .env.example .env.local
```

Edit `.env.local` with local provider values when needed. `.env.local` is ignored by git.

When running the packaged macOS app with `open src-tauri/target/release/bundle/macos/Kairo\ Tutor.app`,
the native process does not rely on shell-inherited provider secrets. It reads `OPENROUTER_*` and
`KAIRO_AI_PROVIDER` from the process environment first, then from `.env.local` or `.env` found while
walking up from the app executable and current directory. If the provider is misconfigured, the UI must
show a provider error instead of falling back to mock tutor guidance.

Voice permissions are wired, but live speech-to-text is not yet part of the desktop question flow. Use
the notch text prompt or Ask action for provider-backed tutor turns until STT is implemented.

### Visual pointing & demo flag

The tutor points at on-screen elements via Claude's Computer Use API (`ANTHROPIC_API_KEY`,
`ANTHROPIC_COMPUTER_USE_MODEL`); without a key it falls back to OCR text grounding. By default **all Kairo
UI — the notch, your pen annotations, and the AI pointer — is hidden from screenshots and screen
recordings**, so captures of your screen stay clean (you still see everything live; only screen capture is
affected). To record a demo where you *want* Kairo visible, set `KAIRO_SHOW_IN_CAPTURE=true` in
`.env`/`.env.local` and relaunch (no rebuild needed). Note: while hidden, the tutor's own screenshot also
can't see your pen annotations.

## Commands

Run browser dev shell:

```bash
npm run dev
```

Run desktop dev shell:

```bash
npm run tauri:dev
```

Build frontend:

```bash
npm run build
```

Build, sign, verify, and (re)launch the macOS app — one command:

```bash
npm run app             # quit running app → build+sign → verify signature → launch
npm run app -- --check  # same, but run typecheck + tests + cargo check first
```

Or just build the bundle (signs automatically via `tauri.conf.json`):

```bash
npm run tauri:build -- --bundles app
```

Test providers:

```bash
npm run smoke:providers
```

The OpenRouter smoke test includes a tiny image payload because Kairo sends screenshots to the tutor
model. A text-only OpenRouter check is not enough for this app.

Verify repo:

```bash
npm test
npm run typecheck
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri:build -- --bundles app
npm audit --audit-level=moderate
```

## Current Native Commands

The frontend calls native functionality through [src/native/nativeBridge.ts](./src/native/nativeBridge.ts). Browser mode returns safe fallback values.

Tauri commands:

- `get_active_app`: returns frontmost macOS app name, bundle id, and front window title when available.
- `get_permission_status`: returns screen/accessibility permission probes and microphone state where the WebView permission API is available.
- `capture_screen`: blocks sensitive apps locally, captures a PNG through ScreenCaptureKit, excludes Kairo windows when macOS exposes them, and returns base64 image metadata plus display bounds/scale.
- `show_overlay`: positions the hidden transparent overlay window over the active display, sends typed visual targets, and shows it.
- `update_overlay`: refreshes visual targets without focusing the overlay window.
- `hide_overlay`: hides the native overlay window.
- `show_notch`: shows the compact notch assistant window.
- `get_current_notch_payload`: returns the latest notch payload for newly created notch windows.
- `hide_notch`: hides the notch assistant window.
- `run_tutor_turn`: calls the configured OpenRouter model from the native process using private `OPENROUTER_*` env values, then returns raw planner content to the WebView safety parser.

Pending native work:

- Customizable shortcut settings
- Multi-display overlay routing

## Project Structure

```text
src/
  App.tsx
  config/env.ts
  core/
  native/nativeBridge.ts
  overlay/
  server/providers/openRouter.ts

src-tauri/
  src/lib.rs
  src/main.rs
  tauri.conf.json
  capabilities/
  icons/

skills/blender/
  skill.md
  ui_landmarks.json
  workflows.yaml
  troubleshooting.yaml
  glossary.yaml
  version_notes.md
  safety_rules.yaml

scripts/
  smoke-providers.mjs
```

## Engineering Rules

- Keep `FEATURE.md` product-facing and durable.
- Keep this README current when architecture, setup, commands, providers, or native capabilities change.
- Keep secrets out of git and out of browser-exposed env.
- Prefer narrow, testable modules over a single large app manager.
- Use Clicky as a native Mac reference, not as the architecture to copy wholesale.
- Preserve the learning principle: the tutor guides and points; the learner acts.
- Stick with Tauri through the next milestone unless a verified WebKit/WKWebView blocker appears.
- Before UI work for any new macOS native capability, update `Info.plist`, add required entitlements, document TCC reset/test notes, and verify the signed app with `codesign -d --entitlements :- path/to/Kairo\ Tutor.app`.
- Keep the macOS interaction model close to Hey Clicky: the app should stay visually quiet/invisible until the user activates tutoring, voice, or on-screen guidance.

## Native Capability Notes

### Transparent Overlay Window

- Tauri config: `src-tauri/tauri.conf.json` defines an `overlay` window with `create: false`, `transparent`, `decorations: false`, `alwaysOnTop`, `skipTaskbar`, `focus: false`, `focusable: false`, and `visibleOnAllWorkspaces`.
- Lifecycle: `src-tauri/src/lib.rs` lazily creates the overlay only when a visual-guidance payload exists, which prevents an invisible foreground window from appearing on launch.
- Runtime hardening: `src-tauri/src/lib.rs` reapplies always-on-top, non-focusable, skip-taskbar, no-shadow, and `set_ignore_cursor_events(true)` so the overlay is click-through.
- macOS transparent WebViews require `app.macOSPrivateApi: true` and the Rust dependency feature `tauri = { features = ["macos-private-api"] }`.
- TCC/Info.plist: no new TCC prompt is required for drawing a transparent always-on-top overlay. Existing screen/accessibility/microphone prompts remain unchanged.
- Entitlements: no new entitlement is required for the overlay. The signed app should still report the existing microphone entitlement:

```bash
codesign -d --entitlements :- "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
```

- Verification used for this capability: `npm test -- --run`, `npm run build`, `cargo check`, `cargo test`, `npm exec tauri info`, `npm run tauri:build`, and `git diff --check`.

One command to quit Kairo, rebuild + sign, verify the signature, and relaunch:
```bash
npm run app
```
This wraps `scripts/rebuild-run.sh`, equivalent to:
```bash
osascript -e 'quit app "Kairo Tutor"'; npm run tauri:build -- --bundles app \
  && codesign --verify --deep --strict "src-tauri/target/release/bundle/macos/Kairo Tutor.app" \
  && open "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
```

Change I'm making for pull request
