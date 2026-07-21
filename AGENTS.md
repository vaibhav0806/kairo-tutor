# Kairo Tutor — monorepo agent rules

Two packages in this repo:
- **root = the desktop app** (Tauri: `src-tauri/` Rust + `src/` React) — the rules below the
  "Desktop app rules" heading are the DESKTOP rules.
- **`server/` = the Fastify backend** (auth + AI proxy + billing) — see [`server/AGENTS.md`](./server/AGENTS.md).

`AGENTS.md` is the source of truth (Codex reads it natively); each `CLAUDE.md` is a one-line
`@AGENTS.md` stub so Claude Code loads the same rules.

## Open-source secret hygiene
The whole repo is public. `.env` (gitignored) holds ONLY API keys. NEVER commit secrets/tokens.
NEVER paste a live key into code, logs, tests, or committed config. Provider keys live in
`server/.env` (dev) / the Hetzner env (prod) — never in the desktop bundle.

## Dodo — TEST MODE ONLY
The agent operates Dodo in **test mode only**. Live keys live only on the Hetzner prod env, never
in the repo or on a dev machine.

## Commit discipline
Work on `main` (no branches unless the user says so). Commit each change as you go — small,
revertible commits, not one big batch. No unrelated refactors in a feature change. End every
commit message with:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## How to run things
- Desktop → `npm run app` (see "Run / build" below).
- Server → `npm run server:dev` (see [`server/AGENTS.md`](./server/AGENTS.md)).

---

# Desktop app rules (Tauri: Rust + React)

> **Source of truth:** product vision → [FEATURE.md](./FEATURE.md); implementation
> architecture, setup, provider choices, engineering rules → [README.md](./README.md).
> This file is the quick operating map + the **mandatory logging rules**. If this
> file conflicts with README/FEATURE on product/architecture facts, those win —
> update this file.

## What Kairo is

Mac-first, **screen-native AI tutor** for practical software labs. It listens to a
spoken question, looks at the current screen, and guides the user one step at a time
with voice + on-screen visual cues. Principle: **the AI points, the user acts.** The
app stays visually quiet until the user activates voice or on-screen guidance.

## Run / build (THE workflow — read this)

**Never run a dev server for real testing.** Always build and run the packaged
`.app` — that is the environment users get and the one where native permissions,
panels, and logging behave correctly.

**One command does it all** — quit the running app, rebuild, sign, verify the
signature, and relaunch:

```bash
npm run app             # quit → build+sign → verify signature → launch
npm run app -- --check  # same, but run typecheck + tests + cargo check first
```

Signing is automatic (`tauri.conf.json` → `bundle.macOS.signingIdentity =
"Kairo Tutor Local Dev"`); `npm run app` additionally verifies the signature so a
broken sign fails loudly, not at launch. It wraps (see `scripts/rebuild-run.sh`):

```bash
osascript -e 'quit app "Kairo Tutor"'                        # quit old instance
npm run tauri:build -- --bundles app                         # build + sign
codesign --verify --deep --strict "…/Kairo Tutor.app"        # verify sign
open "src-tauri/target/release/bundle/macos/Kairo Tutor.app" # launch
```

- App identifier: `com.kairo.tutor`. Product name: `Kairo Tutor`. Dev Vite port: `5273`.
- Signed with a stable self-signed cert (`Kairo Tutor Local Dev`) so macOS TCC grants
  (Screen Recording, Accessibility, Input Monitoring) persist across rebuilds.
- Secrets: the native process reads `OPENROUTER_*`, `KAIRO_*`, etc. from the process
  env first, then from `.env.local` / `.env` walking up from the executable and CWD.
  Change env → relaunch (no rebuild needed).

## Reading the logs

Every subsystem (Rust + all WebViews) logs to one persistent file:

```bash
tail -F ~/Library/Logs/Kairo/kairo-latest.log        # stable symlink to today's file
# or the dated file directly:
tail -F ~/Library/Logs/Kairo/kairo.$(date -u +%F).log
```

Control verbosity per run (read from env/.env, no rebuild). Our subsystems log
under `kairo::<subsystem>` targets, so:

- Default is `info,kairo=debug` — dependencies quiet at INFO, all Kairo steps at DEBUG.
- `KAIRO_LOG=kairo=trace` — max detail from our code (deps still quiet).
- `KAIRO_LOG=debug` — everything, including dependency internals (hyper/wry/reqwest).
- Per-subsystem: `KAIRO_LOG=info,kairo::vision=trace,kairo::mic=warn`.
- `KAIRO_LOG_STDERR=true` — also mirror to stderr (default off; useful when running in a terminal).
- `KAIRO_LOG_TRANSCRIPTS=true` — include full STT transcript text (default off → length only).

Design + rationale: [docs/superpowers/specs/2026-07-03-universal-logger-and-claude-md-design.md](./docs/superpowers/specs/2026-07-03-universal-logger-and-claude-md-design.md).

## Repo layout

```text
src/                         Frontend (React 19 + Vite). One entry (main.tsx) routes
                             by URL hash into four WebViews:
  main.tsx                   entry: installs global error logging, routes by #hash
  App.tsx                    main/setup window
  notch/                     the notch panel UI (voice PTT, typing, tutor loop)
  overlay/                   full-screen annotation + visual-target overlay
  cursor/                    companion pet cursor (own click-through panel, #/cursor)
  activation/                activation state machine
  core/                      orchestrator, runtimePlanner, tutorPlanner, skills, types, logger.ts
                             (provider proxying is the separate `server/` package, not src/)
  native/nativeBridge.ts     typed wrapper over Tauri `invoke` (+ browser fallbacks)
  config/env.ts              KAIRO_* public env parsing (zod)

src-tauri/src/               Native macOS (Rust). Split into focused modules:
  lib.rs                     Tauri setup, managed state, all #[tauri::command]s, run()
  klog.rs                    the universal non-blocking logger (see below)
  audio.rs                   cpal mic capture (push-to-talk), WAV encode
  input.rs                   CGEventTaps: PTT ⌥⌃ chord + scroll/click context reset
  capture.rs                 screen capture + display bounds
  grounding.rs               vision element-box detection (Anthropic / OpenRouter / Qwen)
  ocr.rs, color.rs           Set-of-Mark OCR fallback + color helpers
  tutor.rs                   run_tutor_turn + run_gate_turn (OpenRouter)
  speech.rs                  transcribe_audio (STT) + synthesize_speech (TTS)
  panels.rs                  NSPanel creation (notch/overlay/cursor) + mouse tracker
  permissions.rs, platform.rs, capture.rs, prompts.rs, env.rs, types.rs

tests/                       vitest unit tests (node env; no DOM libs installed)
docs/superpowers/            specs/ and plans/
scripts/smoke-providers.mjs  provider smoke test
```

Subsystems worth knowing: notch = **non-activating** NSPanel; the annotation overlay
must be a **can-become-key** NSPanel (a borderless window drops clicks); the companion
cursor lives in its own click-through panel. Shortcuts: ⌥⌃ = **hold to talk / tap to
type** (one universal key, driven by a single-owner PTT state-machine controller in
`input.rs`), pen = ⌥⇧P. (⌘⇧Space was removed — typing is a quick ⌥⌃ tap.)

## Providers & env

Provider selection defaults live in `src-tauri/src/constants.rs` (`AI_PROVIDER`,
`STT_PROVIDER`, `TTS_PROVIDER`, `GROUNDING_PROVIDER`); the same-named env vars still
override at runtime but you never need to set them. Grounding is swappable:
`anthropic` (Opus, default), `openrouter` (Qwen, cheaper), or `qwen` (direct
DashScope). No Sonnet for grounding.

## Configuration

Non-secret config is centralized — **`.env` holds ONLY API keys.**

- **Native** config lives in `src-tauri/src/constants.rs` (committed, shared):
  providers, models, base URLs, timeouts, tuning, toggles, logging flags. Edit that
  file, not env. To change a model or timeout, edit `constants.rs` and rebuild.
- **Frontend** config lives in the zod defaults in `src/config/env.ts` — provider
  *selection* + follow-along/wait tuning ONLY. Model names / base URLs / keys live
  solely in `constants.rs` (the desktop bundle never needs them). Keep the provider
  selection + follow/wait defaults in sync with `constants.rs`.
- **`.env`** (per-person, git-ignored) holds ONLY the API keys: `OPENROUTER_API_KEY`,
  `ANTHROPIC_API_KEY`, `SARVAM_API_KEY`, `ELEVENLABS_API_KEY`, `DASHSCOPE_API_KEY`
  (see `.env.example`). A fresh clone runs with just these five keys — no other env
  vars needed.
- The model/URL/provider constants stay env-overridable at runtime (default = the
  constant); timeouts, toggles, and logging flags are read directly from the constant.
- Transcript + answer logging is **always on** (`constants::LOG_TRANSCRIPTS = true`) —
  no env var. Set it to `false` in `constants.rs` to log lengths only.

## Logging is MANDATORY

Kairo has one universal, non-blocking logger. **Every change you make must log its
steps through it.** This is not optional — it is how we debug the packaged app.

**Rust** — use the `klog!` macro (never `println!`/`eprintln!`):

```rust
klog!(vision, info, count = boxes.len(), ms = elapsed, "detected element boxes");
klog!(mic, error, "failed to build mic stream: {err}");
let _t = crate::klog::timer("gate", "gate_turn"); // auto-logs `ms=` on drop
```

- First arg = **subsystem tag** (the log target): `mic` `audio` `ptt` `vision`
  `grounding` `gate` `tutor` `stt` `tts` `screen` `cursor` `overlay` `notch`
  `input` `activation` `app`. Add new ones as needed — keep them short + lowercase.
- Second arg = level: `error` `warn` `info` `debug` `trace`.
- **Fields first, message literal last** (tracing grammar): `klog!(sub, info, k = v, "msg")`.

**Frontend** — use `klog()` from `src/core/logger.ts` (never `console.*`):

```ts
import { klog } from '../core/logger';
klog('notch', 'info', 'ptt released', { ms: elapsed });
```

Lines are batched and flushed to the same file. Uncaught errors/rejections are
captured automatically (installed once in `main.tsx`).

**Rules for what you log:**

- Log every meaningful step, state transition, provider round-trip (with `ms=`), and
  **every error path**. Prefer structured `key = value` fields over prose.
- **Never log secrets or raw media.** No API keys/auth headers, no raw audio samples,
  no screenshot pixels/base64, no full transcripts. Log metadata only:
  `audio_bytes=48000`, `screenshot=1280x800 jpeg bytes=63210`, `transcript=len=214`.
  Use `crate::klog::transcript_field(&text)` (Rust) for transcripts.
- The logger is non-blocking by design; it drops lines under load rather than stall a
  hot thread. **Never** do blocking I/O or heavy formatting on the audio callback,
  event-tap runloop, or UI thread — just `klog!` and move on.

## Testing / verification

Before considering native or provider work done, run:

```bash
npm run typecheck
npm run test
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri:build -- --bundles app     # the real target
npm run smoke:providers                  # when touching providers
```

## Conventions

- **Keep cross-platform in mind.** macOS is the only shipping target today, but
  Windows is a planned future platform — gate macOS-only code behind `#[cfg(...)]`.
- Before UI work for any new macOS native capability: update `Info.plist`, add
  entitlements, document TCC reset/test notes, and verify the signed app with
  `codesign -d --entitlements :- "…/Kairo Tutor.app"`.
- Follow existing module boundaries. Don't do unrelated refactors in a feature change.
- Add tests in `tests/` (node env — no DOM libs; guard `window` usage).

### Random Rules and Stuff:

- When i say i wanna discuss, never make code changes. analyze the issue/spec that we wanna address, and then lets discuss things in detail. 
- Always explain things in a simple manner please, never complicate things. there is no need to complicate anything, we aren't working on rocket science here.

Command to kill kairo app, rebuild and relaunch:
```
osascript -e 'tell application "Kairo Tutor" to quit'; npm run tauri:build -- --bundles app && open "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
```
Use the above after every single change that requires it please, don't wait for the user to tell u to do this.
Notes:
- .env changes (provider keys, KAIRO_*) → no rebuild needed, just relaunch (env read at launch).
- Rust or frontend code changes → rebuild (command 1).
- First build after a cargo change is slow (~minutes); later ones are faster.
- Watch logs: tail -F ~/Library/Logs/Kairo/kairo-latest.log

Also - don't create branches unless i explicity tell u to, work on main branch only.

## Fresh onboarding test — reset script

To rehearse a TRUE first-run (see the OS permission prompts + the full 6-act onboarding from the
top), reset all TCC grants + the app's on-disk markers BEFORE launching. Run this, then rebuild +
launch:

```bash
osascript -e 'tell application "Kairo Tutor" to quit'; sleep 1
# TCC grants (re-prompted on next launch): screen recording, accessibility, mic, input monitoring
tccutil reset ScreenCapture com.kairo.tutor
tccutil reset Accessibility com.kairo.tutor
tccutil reset Microphone com.kairo.tutor
# Input Monitoring (ListenEvent) is keyed by the EXECUTABLE (`kairo-tutor`), NOT the bundle id — so
# a bundle-scoped `tccutil reset ListenEvent com.kairo.tutor` does NOT clear it and the grant sticks
# (Act 2's mic/keystroke primer then behaves like a returning user). Reset it for ALL apps to be sure
# it's actually cleared (dev machine — you may have to re-grant other apps' Input Monitoring once):
tccutil reset ListenEvent
# App state markers (all live in the app config dir):
CFG="$HOME/Library/Application Support/com.kairo.tutor"
rm -f "$CFG/onboarded" "$CFG/onboarding_step" "$CFG/user_name" "$CFG/accent" \
      "$CFG/screen_recording_granted" "$CFG/session.token"
```

Marker meanings (all under `$HOME/Library/Application Support/com.kairo.tutor/`):
- `onboarded` — first-run done marker (delete → onboarding shows again).
- `onboarding_step` — resume marker for the Screen-Recording quit+reopen (`act3` / a legacy step id).
- `user_name` — cached display name injected into prompts (§12).
- `accent` — chosen accent hex (delete → back to brand default `#7c3aed`).
- `screen_recording_granted` — "was ever granted" marker for the Sequoia reset heads-up.
- `session.token` — auth session (delete → signed out; needed to test the pre-sign-in / paywall path).

Notes:
- `tccutil` needs the app QUIT to take effect cleanly; quit first (the script does).
- To test the **paywall exemption** (pre-sign-in Act 4 turns), also set `KAIRO_USE_BACKEND_PROXY=1`
  in the repo-root `.env` and keep `session.token` deleted (signed out).
- The backend must be running for the full walk (`npm run server:dev`) — auth, `/v1/me`,
  onboarding chat/stt/tts all hit it.
