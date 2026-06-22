# Kairo Tutor

Kairo Tutor is a Mac-first, screen-native AI tutor for students learning complex software. The product goal is simple: the AI should not just answer, it should show. A learner activates the tutor, asks a question, and the app uses screen context, software-specific skill packs, voice, and visual overlays to guide one step at a time.

The current repo is the first product skeleton. It includes a React/Vite app shell, a mock Blender tutoring loop, an env-driven provider contract, OpenRouter model routing, Sarvam voice configuration, and a seed Blender skill pack.

## Current Milestone

Milestone 1 is implemented:

- Local app shell
- Mock Blender screen and tutor response
- Env validation
- OpenRouter provider client
- Sarvam voice env setup
- Blender skill-pack seed
- Provider smoke test
- Unit tests, typecheck, and production build

See [plan.md](./plan.md) for the full milestone plan.

## Tech Stack

- TypeScript
- React
- Vite
- Vitest
- OpenRouter for model routing
- Sarvam for speech-to-text and text-to-speech

The desktop-native layer is not built yet. The plan is to wrap this with a Mac-first desktop shell later, likely Tauri plus native macOS modules for screen capture, global shortcuts, permissions, and overlays.

## Setup

Install dependencies:

```bash
npm install
```

Copy the example env if needed:

```bash
cp .env.example .env.local
```

For local UI development, mock mode is enough:

```env
KAIRO_AI_PROVIDER=mock
KAIRO_STT_PROVIDER=mock
KAIRO_TTS_PROVIDER=mock
```

For real provider testing, configure:

```env
KAIRO_AI_PROVIDER=openrouter
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=qwen/qwen3.6-flash

KAIRO_STT_PROVIDER=sarvam
KAIRO_TTS_PROVIDER=sarvam
SARVAM_API_KEY=...
SARVAM_STT_MODEL=saaras:v3
SARVAM_TTS_MODEL=bulbul:v3
SARVAM_TTS_LANGUAGE_CODE=en-IN
SARVAM_TTS_SPEAKER=shubh
```

Do not expose provider keys to browser env. Only `KAIRO_*` values are exposed to Vite.

## Run The App

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5173/
```

## Test Providers

Run a live OpenRouter chat request and a short Sarvam TTS request:

```bash
npm run smoke:providers
```

Expected shape:

```text
OpenRouter: ok (<model>)
OpenRouter response: Kairo provider smoke test passed.
Sarvam TTS: ok (bulbul:v3, en-IN, shubh)
Sarvam audio: tmp/sarvam-tts-smoke.wav
```

The command does not print API keys. The generated audio file is ignored by git.

## Verification

Run the full local verification set:

```bash
npm test
npm run typecheck
npm run build
npm audit --audit-level=moderate
```

## Project Structure

```text
src/
  App.tsx                         App shell and mock tutor UI
  config/env.ts                   Env parsing and provider validation
  core/
    mockTutor.ts                  Deterministic mock tutor planner
    skills.ts                     Seed skill-pack registry
    types.ts                      Shared product types
  server/providers/openRouter.ts  Server-side OpenRouter client

skills/blender/
  skill.md
  ui_landmarks.json
  workflows.yaml
  troubleshooting.yaml
  glossary.yaml
  version_notes.md
  safety_rules.yaml

scripts/
  smoke-providers.mjs             Live provider smoke test
```

## Product Direction

The first real demo should show:

> A student opens Blender, asks “Help me make my first animation,” and the AI guides them with voice, highlights, and a ghost cursor.

The MVP principle is:

> The AI points. The user acts.

Autonomous clicking is intentionally out of scope for the early product.
