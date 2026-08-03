# Kairo Tutor

Kairo Tutor is a macOS, screen-native AI tutor for practical software labs. Hold
the global shortcut, ask a question, and Kairo can use the current screen to
explain the next step with voice, a highlight, and a companion cursor.

> The AI points. The user acts.

Kairo never clicks or types on the user's behalf. Product direction lives in
[FEATURE.md](./FEATURE.md); this README describes the current implementation.

## Platform status

- macOS 14.2 or newer is required. Windows is planned but is not implemented.
- The desktop app is React 19 inside Tauri v2, with native behavior in Rust.
- The backend is a Fastify service backed by PostgreSQL (Neon in Kairo-hosted environments). It
  owns authentication, provider credentials, usage metering, and billing.
- Google is currently the only sign-in provider.

Kairo captures screen and microphone data as part of its core function. Read
[PRIVACY.md](./PRIVACY.md) before running it against sensitive information.

## How it works

```text
macOS desktop app
  React WebViews         main/settings, onboarding, notch, overlay, cursor
  Rust/Tauri             global activation, audio, screen capture, panels
          |
          | authenticated HTTPS (localhost or api.meetkairo.xyz)
          v
Fastify backend
  Google auth, AI/speech proxy, usage, preferences, Dodo billing
          |
          +-- OpenRouter       question routing and text turns
          +-- OpenAI/Anthropic screenshot-aware tutoring and pointing
          +-- Sarvam           speech-to-text and text-to-speech
          +-- ElevenLabs       optional text-to-speech voices
```

The shipped app uses the backend proxy, so provider keys are not included in the
desktop bundle. A direct-provider path exists for local debugging only.

### Voice and screen behavior

- Hold `Option-Control` to record a spoken question; a quick tap opens text input.
- Audio is transcribed today. The hosted path sends the recording through the Kairo
  backend to Sarvam STT (`saaras:v3`, automatic language detection). The direct-key
  developer path also implements ElevenLabs STT, but the backend proxy does not use
  it.
- For a voice question, Kairo captures the main display locally after push-to-talk is
  released while transcription runs. A text gate then decides whether that frame is
  sent to a model; text-only questions discard it locally. Typed and annotation-led
  asks are screen-first. Transmitted frames are resized to at most 1280 px on the
  longest edge and normally encoded as JPEG.
- Capture is blocked for a conservative list of password managers, messaging, mail,
  wallet, banking, and photo apps. A frame is also discarded if the frontmost app
  changes while capture is in progress. This is a safeguard, not a guarantee that
  every sensitive window will be recognized.
- Normal production builds exclude Kairo's own notch, cursor, and guidance UI from
  capture. User-drawn pen marks remain included. Local/demo builds show Kairo's UI by
  default; `npm run dist` disables it.
- Responses are spoken using the user's server-side voice preference. Sarvam is the
  default; ElevenLabs can be enabled by the server operator.

## Prerequisites

- macOS 14.2+
- Xcode, or Xcode Command Line Tools (`xcode-select --install`)
- [Node.js 22](https://nodejs.org/) and npm
- The current stable [Rust toolchain](https://rustup.rs/)
- Docker, or a local PostgreSQL 17 instance, to run the backend test suite
- A Google OAuth web client and provider credentials only when running the development backend
- A Neon development branch is optional and used only by Kairo maintainers; contributors can use
  PostgreSQL 17 locally

Confirm the toolchain:

```bash
node --version
npm --version
rustc --version
cargo --version
xcode-select -p
```

## Install and verify

```bash
git clone https://github.com/vaibhav0806/kairo-tutor.git
cd kairo-tutor
npm ci
npm run typecheck
npm test
npm run typecheck -w @kairo/server
cargo check --manifest-path src-tauri/Cargo.toml
```

The root package is the desktop app; `server/` is an npm workspace containing the
backend. These checks need no live credentials. The full server suite additionally
uses an isolated loopback PostgreSQL database.

### Run the server tests

Start the dedicated PostgreSQL 17 test database:

```bash
# Re-runnable: starts the existing container, or creates it the first time.
docker start kairo-test-db 2>/dev/null || docker run --name kairo-test-db \
  -e POSTGRES_DB=kairo_test \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 127.0.0.1:5432:5432 \
  -d postgres:17-alpine
npm run server:test
```

The test harness runs migrations, injects deterministic fake auth/provider settings,
and deliberately ignores `server/.env`. It refuses remote database hosts and any
database name other than `kairo_test`, so tests cannot accidentally reach Neon or a
production database.

The test database owns port 5432 (the same port CI uses, so no configuration is
needed). The development database uses 5433, so the two never collide. If something
else already holds 5432, point the tests elsewhere — the database must still be named
`kairo_test`:

```bash
KAIRO_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5434/kairo_test \
  npm run server:test
```

This test database is separate from the Neon-backed development server described
below.

## Build the desktop app

Contributor builds should be unsigned and do not require Kairo's private local
signing identity:

```bash
npm run app:build:unsigned
open "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
```

macOS may warn about an unsigned locally built application. This command is for
development only and does not produce a distributable release.

Maintainers with the `Kairo Tutor Local Dev` identity can use the signed workflow:

```bash
npm run app             # build, sign, verify, and launch against hosted backend
npm run app:local       # same packaged workflow against localhost:8787
npm run app -- --check  # run checks before the signed build
```

Do not change the committed signing identity to make a contributor build work.
Release signing is intentionally separate because changing identities invalidates
existing macOS privacy grants.

### macOS permissions

The packaged app asks for these permissions during onboarding:

- **Microphone** — record push-to-talk questions.
- **Screen Recording** — capture the visible screen when a question needs context.
- **Accessibility** — observe global scroll/click activity so stale guidance can be
  cleared and follow-along steps can react to user actions.
- **Input Monitoring** — observe the global push-to-talk shortcut.

Grant them under **System Settings → Privacy & Security**. Unsigned builds can lose
grants when their code identity changes, so you may need to grant them again after a
rebuild. Do not grant these permissions to code you have not reviewed.

## Run the backend locally

Contributors can run the backend against a local PostgreSQL 17 database. Hosted and maintainer
Neon modes retain strict environment guards, and Dodo always stays in test mode locally.

1. Start a development database. It uses port **5433** so it can run alongside the
   test database on 5432 — you never have to stop one to use the other:

   ```bash
   docker start kairo-local-db 2>/dev/null || docker run --name kairo-local-db \
     -e POSTGRES_DB=kairo_local \
     -e POSTGRES_USER=postgres \
     -e POSTGRES_PASSWORD=postgres \
     -p 127.0.0.1:5433:5432 \
     -d postgres:17-alpine
   ```

   If you created `kairo-local-db` under the earlier instructions it is still bound to 5432, and
   `docker start` keeps that old mapping. Recreate it once, then run the command above:

   ```bash
   docker rm -f kairo-local-db
   ```

2. Copy the example configuration:

   ```bash
   cp server/.env.example server/.env
   ```

3. Configure the required values in `server/.env`:

   - Keep `KAIRO_DATABASE_TARGET=local-postgres` and the literal-loopback `DATABASE_URL` from the
     example. Query parameters, fragments, DNS hostnames, remote databases, and hosted/local mode
     mixtures are refused.
   - `BETTER_AUTH_SECRET`: generate one with `openssl rand -base64 32`.
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: a Google web OAuth client with
     `http://localhost:8787/api/auth/callback/google` as an authorized redirect URI.
   - Provider keys for the paths you want to exercise: OpenRouter, OpenAI or
     Anthropic, Sarvam, and optionally ElevenLabs.
   - Dodo test-mode values only when working on billing.

4. Apply migrations, invite your Google account, and start the server:

   ```bash
   npm run db:migrate
   npm run invite -- add you@example.com
   npm run server:dev
   ```

5. In another terminal, build the app against the local backend:

   ```bash
   KAIRO_BACKEND_TARGET=local npm run app:build:unsigned
   open "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
   ```

`npm run local` is the maintainer convenience command for starting the backend and a
signed packaged app together. It assumes the private local signing identity and is
therefore not the default contributor command.

Kairo maintainers may instead set `KAIRO_DATABASE_TARGET=neon` and use the pooled Neon `dev`
connection. That mode verifies Kairo's exact development endpoint; hosted mode separately verifies
the production endpoint. An arbitrary external Neon database will be rejected by design.

Non-secret desktop defaults live in `src-tauri/src/constants.rs`; server policy lives
in `server/src/config/`. Environment files are for secrets and are gitignored. Never
put provider keys in frontend `VITE_*` variables or commit them.

## External providers and data

The exact provider depends on server configuration and the tutoring path:

| Service | Content processed |
| --- | --- |
| Google OAuth | Sign-in request and Google account identity returned to the backend |
| OpenRouter | Typed/transcribed questions, recent dialogue, app/user context, prompts, and, on fallback vision paths, a resized screenshot |
| OpenAI or Anthropic | Typed/transcribed questions, recent dialogue, app/user context, prompts, and a resized screenshot for screen-aware guidance |
| Sarvam | Recorded audio for transcription; response text for speech synthesis |
| ElevenLabs | Response text for speech synthesis and voice-catalog requests when enabled |
| Dodo Payments | Account/billing identifiers and checkout/subscription information when billing is used |

The Kairo backend relays AI and speech content but does not intentionally persist
questions, transcripts, screenshots, audio, or model answers. It does store account,
session, onboarding, usage, preference, and billing records. See
[PRIVACY.md](./PRIVACY.md) for the full technical inventory and local log behavior.

## Common commands

```bash
# Desktop checks
npm run typecheck
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check

# Backend checks
npm run typecheck -w @kairo/server
npm run server:test  # requires the loopback kairo_test database described above
npm run build -w @kairo/server

# Development
npm run server:dev
npm run app:build:unsigned

# Provider smoke test (uses real credentials and may incur provider cost)
npm run smoke:providers
```

Browser-only `npm run dev` and `npm run tauri:dev` can be useful for narrow UI work,
but they do not reproduce packaged-app permissions, panel behavior, or signing. Test
native changes with a packaged `.app`.

Logs are written to `~/Library/Logs/Kairo/` and retained for up to seven daily files:

```bash
tail -F ~/Library/Logs/Kairo/kairo-latest.log
```

Question, transcript, and answer text is redacted to character counts by default.
Logs can still contain operational metadata and error details; inspect them before
sharing.

## Repository layout

```text
src/                     React frontend and the five WebView surfaces
  core/                  tutoring orchestration, planners, skills, logging
  notch/                 push-to-talk, text input, tutor loop, playback
  overlay/               annotations and visual targets
  cursor/                click-through companion cursor
  onboarding/            first-run flow
  native/                typed Tauri command wrapper
src-tauri/src/           Rust desktop implementation
  lib.rs                 Tauri setup and command registration
  audio.rs, input.rs     microphone capture and global activation
  capture.rs             screen capture and sensitive-app safeguards
  tutor.rs               gate and tutor provider requests
  speech.rs              speech provider requests
  panels.rs              native macOS panel behavior
  permissions.rs         macOS permission probes and prompts
server/src/              Fastify auth, proxy, usage, speech, and billing service
packages/shared/         shared contracts used by desktop and backend
skills/                  application-specific tutoring knowledge
tests/                   desktop Vitest suite
```

## Contributing and support

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. Use GitHub
Issues for reproducible bugs and feature proposals; see [SUPPORT.md](./SUPPORT.md) for
help channels. Report vulnerabilities privately as described in
[SECURITY.md](./SECURITY.md), not in a public issue.

## License

Kairo Tutor is open source under two licences, split by directory:

- **`server/`** — [GNU AGPL v3.0 or later](./server/LICENSE). Self-host it freely; if you run a
  modified version as a service for other people, publish your modifications.
- **Everything else** (the desktop app, shared packages, tests, scripts, docs) —
  [MIT](./LICENSE).

They are separate programs communicating over HTTP, so the AGPL binds whoever *runs* the backend
and does not reach the MIT desktop client or its users. [LICENSING.md](./LICENSING.md) explains the
split, what it means for contributors, and how to ask about a commercial licence for `server/`.

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for shipped third-party material and
[the asset-provenance ledger](./docs/asset-provenance.md) for known binary-asset evidence and
unresolved clearance work.
