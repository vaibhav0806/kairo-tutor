# Kairo Tutor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working foundation for a Mac-first screen-native AI tutor that can evolve into the Blender tutoring demo described in `FEATURE.md`.

**Architecture:** Start with a TypeScript/Vite desktop-shell prototype that can later be wrapped by Tauri native modules. Keep the OS integrations, AI orchestration, skill packs, and UI surface separated so each can mature independently. Milestone 1 uses mock providers and safe local env defaults while defining the real provider contract: OpenRouter for model routing and Sarvam for voice.

**Tech Stack:** TypeScript, React, Vite, Vitest, Tauri-ready project structure, file-based skill packs, env-driven provider configuration.

**Reference Notes:** Before implementing native Mac capture, overlays, global shortcuts, or provider proxying, read `docs/clicky-borrowing-notes.md`. Clicky is a reference for implementation patterns, not the architecture to copy wholesale.

---

## Milestones

### Milestone 1: Product Skeleton And Local Dev Foundation

**Outcome:** A developer can run the app locally, see the tutor shell, validate env configuration, and exercise a mock Blender tutoring loop.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `index.html`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `.env.local`
- Create: `src/main.tsx`
- Create: `src/App.tsx`
- Create: `src/styles.css`
- Create: `src/config/env.ts`
- Create: `src/core/skills.ts`
- Create: `src/core/mockTutor.ts`
- Create: `src/core/types.ts`
- Create: `src/server/providers/openRouter.ts`
- Create: `skills/blender/skill.md`
- Create: `skills/blender/ui_landmarks.json`
- Create: `skills/blender/workflows.yaml`
- Create: `skills/blender/troubleshooting.yaml`
- Create: `skills/blender/glossary.yaml`
- Create: `skills/blender/version_notes.md`
- Create: `skills/blender/safety_rules.yaml`
- Create: `tests/env.test.ts`
- Create: `tests/skills.test.ts`
- Create: `tests/mockTutor.test.ts`
- Create: `tests/openRouter.test.ts`

- [x] **Step 1: Create the package and test harness**

Set up Vite, React, Vitest, TypeScript, and safe env loading.

- [x] **Step 2: Write failing env tests**

Verify that mock mode works without vendor keys and real providers require the matching key.

- [x] **Step 3: Implement env parsing**

Add `loadKairoEnv` with validation for OpenAI, Sarvam, and ElevenLabs provider selection.

- [x] **Step 4: Write failing skill-pack tests**

Verify Blender skill pack metadata and landmarks can be loaded.

- [x] **Step 5: Implement skill-pack loading**

Add typed helpers for app detection and landmark lookup.

- [x] **Step 6: Write failing mock tutor tests**

Verify the first Blender animation query returns a one-step voice instruction and visual target.

- [x] **Step 7: Implement mock tutor planner**

Add a deterministic planner that chooses the Blender workflow when Blender is active.

- [x] **Step 8: Build the app shell**

Render the activation surface, env/provider status, mock screen context, tutor response, and visual target data.

- [x] **Step 9: Add provider wiring**

Add OpenRouter as the model provider and Sarvam as the voice provider in env validation, examples, and server-side client code. Do not expose API keys through Vite/browser env.

- [x] **Step 10: Verify milestone**

Run typecheck, tests, and production build.

### Milestone 2: Mac Native Capture And Permissions

**Outcome:** The app can request macOS permissions, detect active app/window metadata, and capture a screenshot when activated.

**Reference:** Read `docs/clicky-borrowing-notes.md` first, especially the sections on Mac native app shape, ScreenCaptureKit capture, global push-to-talk, and secure provider proxying.

**Scope:**
- [x] Add Tauri shell and native macOS command surface.
- [x] Add frontend native bridge with browser fallback.
- [x] Add active app/window metadata command.
- [x] Add first-pass screen/accessibility permission probes.
- [x] Add first-pass macOS screenshot capture command.
- [x] Implement global shortcut activation.
- [x] Add local microphone permission status through the WebView Permission API when available.
- [x] Return display bounds, scale factor, and screenshot metadata to the frontend.
- [x] Keep sensitive-app blocking local and visible.
- [x] Replace current macOS capture internals with ScreenCaptureKit.
- [x] Exclude Kairo windows from ScreenCaptureKit captures when macOS exposes them.

**Acceptance Criteria:**
- Pressing the shortcut opens the tutor surface.
- The app shows permission state clearly.
- A capture produces a screenshot object and active app metadata.
- Sensitive apps pause capture with a clear local message.

### Milestone 3: Overlay And Annotation Layer

**Outcome:** The AI can show where to look, and the user can point to what they mean.

**Reference:** Read `docs/clicky-borrowing-notes.md` first, especially the transparent overlay window and pointing protocol sections.

**Scope:**
- [x] Transparent always-on-top overlay window.
- [x] Highlight boxes, arrows, underlines, spotlight, and ghost cursor.
- [x] User annotation tools: circle, rectangle, highlight, underline, erase.
- [x] Coordinate normalization contract for screen regions.
- [x] Coordinate normalization for Retina scale and multiple displays.
- [x] Attach annotations to the next tutor request.
- [x] Render mock tutor targets as overlay elements on the screen preview.
- [x] Add interactive real-screen annotation mode from the captured notch flow.

**Acceptance Criteria:**
- Mock tutor targets render as overlays on the active display.
- User annotations are captured as typed region objects.
- Overlay coordinates remain stable after window resize and scale changes.
- Real-screen annotations can be drawn after shortcut capture and are attached to the next tutor request.

### Milestone 4: Real AI Orchestrator

**Outcome:** The app can turn screen state plus voice/text query into a short tutor step using real provider integrations.

**Reference:** Read `docs/clicky-borrowing-notes.md` first, especially the secure provider proxy and pointing protocol sections. Keep Kairo responses structured instead of copying Clicky's raw `[POINT:...]` text-tag protocol.

**Scope:**
- [x] Add activation state machine for `idle -> listening -> captured -> thinking -> showing_step`.
- [x] Replace boot-time mock Blender guidance with a real idle/background state.
- [x] Add a tutor turn orchestrator boundary that packages screenshot context, app metadata, annotations, skill-pack content, and response constraints for a planner adapter.
- [x] Keep `mock` as the default local provider through the orchestrator adapter.
- [x] Add provider adapters for STT, vision, tutor planning, and TTS.
- [x] Wire OpenAI-compatible vision/planning behind explicit env selection.
- [x] Wire Sarvam/ElevenLabs speech adapters behind explicit env selection.
- [x] Add provider confidence states and safety checks around real model responses.

**Acceptance Criteria:**
- Provider selection is controlled only by env.
- Missing provider keys fail fast with actionable errors.
- The model receives screenshot context, app metadata, annotations, and skill-pack content.
- The response contains one spoken instruction and at least one visual target.

### Milestone 5: Blender Guided Lesson MVP

**Outcome:** The demo lesson “make your first animation in Blender” works as a complete guided loop.

**Scope:**
- Implement the first workflow state machine from `skills/blender/workflows.yaml`.
- Add screen-state checks for cube selected, frame 1 active, keyframe menu, location keyframe inserted, playback.
- Add correction paths for common mistakes.
- Persist session step state locally.

**Acceptance Criteria:**
- The app guides a beginner through the first Blender animation flow.
- Each step has voice text, visual target, expected state, and correction behavior.
- The tutor waits for action, checks the next screen state, and proceeds or corrects.

### Milestone 6: Pilot Readiness

**Outcome:** The product can be tested in a real software-training lab with a small cohort.

**Scope:**
- Session history with user consent.
- Delete/pause/stop controls.
- Basic teacher dashboard for common stuck points and escalations.
- Hinglish response mode.
- Reliability instrumentation for latency, answer acceptance, and repeated failures.

**Acceptance Criteria:**
- Teachers can see aggregated stuck states without exposing unnecessary student data.
- Students can delete their sessions.
- Pilot metrics from `FEATURE.md` can be measured.

---

## Immediate Development Rule

Milestone 1 intentionally avoids real API calls and real secrets. `.env.local` uses mock providers so local development can run immediately. Real provider keys should be added only to local secret files or OS keychain-backed native config. The browser app must never receive `OPENROUTER_API_KEY` or `SARVAM_API_KEY`.

## Native Capability Rule

Stick with Tauri through the next milestone. Any new native capability must include matching `Info.plist` usage text, entitlements when needed, TCC reset/test notes, and `codesign --entitlements` verification before UI work is considered complete.
