# Kairo Onboarding Redesign + Modern Notch — Design & Implementation Spec

> **Status:** Locked for implementation (design decisions finalized 2026-07-21).
> **Owner note:** The codebase is being refactored in parallel by another agent. This is a
> DESIGN + IMPLEMENTATION spec to build against — not line-by-line code. File/command/data-flow
> references reflect the current architecture; adapt to the post-refactor layout where it moved.
> **No implementation should start until the parallel refactor settles and this spec is re-read.**

**Goal:** Replace the current "centered card wizard" onboarding with a differentiated, memorable,
**out-of-the-card** first-run where Kairo teaches itself by doing its real job on the user's real
screen — and modernize the notch alongside it. The steps stay; the *feel* changes completely.

**North-star frame:** The onboarding is not a wizard *about* Kairo. It is **Kairo giving the user
their first lesson, where the lesson happens to be "meet + set up Kairo."** The tutorial is the
product used on itself (Granola/Descript/Loom pattern), taken further than any competitor because
Kairo can genuinely point at the real screen.

---

## 1. Goals & Non-Goals

### Goals
- Get **out of the centered card** — onboarding happens on the real desktop, driven by the existing
  pet + overlay + notch surfaces.
- **Value before asks** — deliver the first "whoa" before sign-in and before the scary permissions.
- **Learn by doing** — the ⌥⌃ chord is the only way to advance the practice beats (no "Continue").
- **Real screen, no rig** — the point/circle demos run the actual product on the user's real screen.
- **Beat Clicky** on every axis (see §13).
- **Modernize the notch** (accent-threaded, Raycast tightness + Arc fluidity, state-morphing, NO glass).
- **Teach Kairo the user's name** (inject into the tutor/gate prompt's non-cached section).

### Non-Goals (explicitly deferred — see §15)
- Pick-your-voice (Sarvam/ElevenLabs selection).
- Naming / customizing the *pet* by name.
- A separate "what should I call you?" step (pull the name from Google instead).
- Liquid-Glass visual language for the notch.

---

## 2. Design Principles (locked)

1. **Magic before asks.** First "whoa" precedes sign-in and the scary TCC grants.
2. **The chord is the only Next** during practice beats. No clickable Continue on talk/point/circle.
3. **No rigged win.** Point/circle run the real pipeline on the real screen (we trust the product).
4. **The pet visibly hears you** — the real listening halo reacts to the user's voice (already built).
5. **Permission priming** — benefit-first, privacy-honest, one at a time, in Kairo's voice; never a
   cold OS dump.
6. **Two-mechanic ladder** — drill hold-to-talk first; introduce the circle-gesture later as the
   "power move." Never both at once.
7. **Peak-end** — engineer one unforgettable peak (the first real point on the user's screen) and a
   warm ending. **No separate anti-Clippy graduation** — the product already retreats when a turn
   ends, so that backoff is inherent.
8. **Compress + re-runnable** — few steps to the aha; a way to replay the intro (macOS permission
   prompts will interrupt the first run, incl. Sequoia's periodic Screen-Recording resets).
9. **Seed the mic** — never a blank "say something"; always 2-3 concrete suggested phrases.

---

## 3. The Coach-Surface Model (out of the card)

Killing the big card raises: *where do Kairo's words + the occasional control live?*

- **Kairo's spoken words → the real notch** (a caption). Onboarding pushes caption payloads into the
  actual notch panel (`show_notch` with a new coach/caption state — see §11). This uses Kairo's real
  home as the teleprompter, so by the end the user already knows where Kairo lives.
- **The pet** lives on the real desktop (existing cursor panel), reacting + pointing.
- **The overlay** draws on the real desktop (existing overlay panel) for boxes/pointing.
- **Two beats need more room than a caption** — the **color wheel** (Act 1) and **Google sign-in**
  (Act 5). These get a **temporary panel** that fades in, then out. Everything else is desktop +
  pet + notch caption.

**Architecture implication (biggest structural change):** the onboarding webview stops being a
480×660 card and becomes a **full-screen, transparent, mostly click-through orchestrator** that:
- renders **nothing** most of the time (the desktop shows through);
- renders the **temporary panel** only for color + sign-in (centered, small, fades in/out);
- drives the **notch caption**, the **pet**, and the **overlay** via existing native commands/events.

Recommended: caption in the **real notch panel**. Fallback if coupling is too costly during the
refactor: a slim notch-styled "pill" rendered by the onboarding window itself (same visual language).
Prefer the real notch.

Ambient: keep a subtle **desktop dim/vignette** during scripted beats (Act 1-3) so attention lands on
the pet/notch; lift the dim for the real-screen practice (Act 4) so the user sees their actual screen.
Optional low background music with a mute toggle (Clicky has this; nice-to-have, off by default).

---

## 3B. Shared Contracts (names every phase depends on — keep these EXACT)

New cross-cutting APIs/events/states introduced by Phase 0 and reused everywhere. Phase plans
must reference these by these exact names so they stay consistent.

- **Accent preference (native):**
  - `get_accent() -> string` (hex `#rrggbb`; returns the user's chosen accent or the brand default).
  - `set_accent(hex: string)` — persist (app config + account at sign-in).
  - Event `accent:changed { hex }` — app-global; pet/overlay/notch/onboarding recolor live.
  - Frontend helper (e.g. `src/core/accent.ts`): `getAccent()`, `onAccentChanged(cb)`, `applyAccent(hex)`.
  - **Interaction with `color.rs::vibrant_accent`:** today the box/pointer color is auto-picked
    per-target for contrast against the pixels. Decision: the **user accent is the base/default
    tint**; keep a contrast safety-adjust (or a subtle shift) only when the accent would be
    invisible against the target. Do NOT silently override the user's hue everywhere. Phase 0
    defines the exact blend rule; other phases just consume `getAccent()`.
- **Notch coach state:** `NotchPayload.state` gains `'coach'` (caption for onboarding). Onboarding
  pushes it via `show_notch({ state:'coach', title, detail, chip? })`. The modern notch renders it
  as a caption line + optional seeded-prompt chip.
- **Onboarding orchestrator window:** the onboarding webview becomes full-screen, transparent,
  click-through except the temp-panel region. Add native helpers as needed (e.g. reuse the existing
  onboarding window builder; add a click-through toggle if required).
- **Name-in-prompt:** tutor/gate turn input gains an optional `userName?: string`; `prompts.rs`
  appends `The user's name is {name}.` in the NON-cached section only. Frontend reads the name from
  `/v1/me` (or a cached value) and passes it per turn.
- **Onboarding demo paywall exemption:** onboarding practice turns MUST NOT be metered or blocked by
  the paywall (they run pre-sign-in, value-first). Add an explicit exemption flag on the onboarding
  turn path (e.g. `onboarding: true` on the gate/tutor input, or gate the credit check on
  `!ONBOARDING_PTT`). Verify against the backend-authoritative credit check.

## 4. The 6-Act Flow (shot-by-shot)

Legend per beat: **On-screen / Pet / Voice (draft copy) / Interaction / Permission / Transition /
Advance condition / Edge cases.**

Draft voice copy is written to be spoken (short, warm). Cache the static lines; synthesize
name/dynamic lines live.

### ACT 1 — Arrival + Color *(no permissions, ~20-30s, cinematic)*
The cold open. Emotional, unhurried.

**1a. The wake-up**
- **On-screen:** desktop dims to a soft vignette. The notch caption fades in.
- **Pet:** a signature **entrance** — the pet emerges/wakes (from the notch or center), a small
  "breathing to life" animation.
- **Voice:** *"Hey — I'm Kairo. I live up here, on your screen."* (pet gestures toward the notch).
- **Interaction:** none; auto-advances after the line.
- **Transition:** pet settles; caption clears.

**1b. Give me a color (authorship)**
- **On-screen:** a **temporary panel** with a full **color wheel** (any hue) + a live preview swatch.
- **Pet:** glows in the currently-selected hue in real time as the wheel moves.
- **Voice:** *"First — pick my color. This is me, from now on."*
- **Interaction:** drag the wheel → the pet's glow, the desktop vignette, the ambient gradient, the
  shadows, and the caption accent **all recolor live** (§5). A "That's the one" / confirm button.
- **Permission:** none.
- **Transition:** on confirm, a brief "coming alive" flourish in the chosen color (this is our answer
  to Clicky's "give me a home" — but it happens on the real desktop, themed to the user's color).
- **Advance:** user confirms a color.
- **Edge cases:** default color pre-selected so a fast user can just confirm.

### ACT 2 — "Can you hear me?" *(primes Mic + Input Monitoring; FIRST WOW)*
Collapses Clicky's two separate screens (mic-test + "how you talk to me") into one live beat, and
makes it real instead of bars-in-a-box.

**2a. Permission primer (Mic + Input Monitoring)**
- **On-screen:** notch caption.
- **Voice:** *"To hear you, I'll need your mic — and permission to notice when you hold two keys.
  Quick and painless."*
- **Interaction:** trigger the Mic prompt + Input Monitoring (`request_required_permissions` for mic;
  `ensure_input_monitoring_access` for the tap). If Input Monitoring needs the Settings pane, a small
  bridge line points the way.
- **Permission:** Microphone + Input Monitoring (both needed for PTT). Neither forces a relaunch.
- **Edge cases:** if already granted (returning user / prior grant), skip straight to 2b.

**2b. Say hi (the drill + first wow)**
- **On-screen:** caption shows the instruction + a **seeded prompt chip**: *"try: 'hey Kairo, what's
  up?'"*.
- **Pet:** the moment the user holds ⌥⌃, the **listening halo reacts live to their voice** (Rabbit-R1
  "ears perk up," but real). On release → thinking swirl.
- **Voice (instruction):** *"This is how you talk to me. Hold Option and Control together, say hi,
  then let go — I'm listening the whole time you hold them."*
- **Interaction:** **the chord is the only Next.** No Continue button. User holds ⌥⌃ + speaks →
  Kairo replies for real (dynamic chat → Sarvam), spoken aloud. Recording cues play (`playRecordingCue`).
- **Transition:** pet celebrates subtly on the first successful reply.
- **Advance:** one successful hold-talk-reply turn.
- **Edge cases:** a too-short tap → gentle nudge caption *"hold them a beat longer."* Empty transcript
  → *"didn't quite catch that — try again."* Never blocks; always retryable.

### ACT 3 — Earn the Eyes *(primes Screen Recording + Accessibility)*
Now they've felt the magic; they *want* the pointing. Trust + priming.

**3a. Trust beat + Screen Recording**
- **On-screen:** notch caption.
- **Voice (trust):** *"To point at things, I need to see your screen — but only when you hold ⌥⌃, and
  I never save it. I look, help, and forget."*
- **Interaction:** trigger Screen Recording (`request_required_permissions` / the CG request). Then a
  **bridge panel**: a small animated arrow/illustration showing *which* toggle to flip, deep-linked to
  the pane (`open_permission_settings('screenRecording')`).
- **Permission:** **Screen Recording — forces a macOS quit+reopen.** On relaunch, resume at this act
  (see §6, §10). NOTE: Kairo can't vision-point at this toggle yet (no permission), so this bridge is a
  **guided illustration/arrow**, not the real pet-points-via-vision.
- **Edge cases:** the quit+reopen is the biggest hazard — resume must land back here (not Act 1).

**3b. Accessibility — THE SIGNATURE MOVE (pet points at the real toggle)**
- **On-screen:** System Settings (Privacy → Accessibility) open; real desktop.
- **Pet:** now that Screen Recording is granted, **Kairo uses its own real pipeline to vision-detect
  the Accessibility toggle and fly the pet to point at it.** This is the moment no competitor can do —
  asking for permission *by demonstrating the exact thing the product does.* ("The AI points, you act.")
- **Voice:** *"One more — Accessibility. It's how I steer the little pointer to what I'm showing you.
  Here — flip this one."* (pet points at the toggle).
- **Interaction:** `open_permission_settings('accessibility')` → `capture_screen` → `run_tutor_turn`
  (or the grounding path) to locate the toggle → `cursor_point` + overlay highlight on it. User flips it.
- **Permission:** Accessibility (does NOT force relaunch).
- **Advance:** Accessibility granted (poll `get_permission_status`).
- **Edge cases:** if vision mis-locates the toggle, fall back to the guided-arrow bridge (as in 3a).

### ACT 4 — The Magic, on YOUR screen *(two-mechanic ladder; THE PEAK)*
Lift the dim; this is the user's real screen. No rig.

**4a. Point (mechanic 1 in the wild)**
- **On-screen:** the user's real desktop; caption + **seeded prompt** using an *always-present* target:
  *"Ask me to point at something — try: 'where's the wifi icon?'"* (menu-bar/dock targets exist on
  every screen, so it works even with no app open).
- **Pet:** flies across the real desktop and points at the real menu-bar item. **This is the peak** —
  mark it with a distinct, satisfying pet flourish + the arrival sound (`arrive` cue), used with weight.
- **Voice (instruction):** *"Now the fun part. Hold ⌥⌃ and ask me to point something out on your
  screen."*
- **Interaction:** chord-only-Next. Real gate → vision → overlay + pet-point + spoken answer.
- **Advance:** one successful point turn.

**4b. Circle (mechanic 2 — the power move)**
- **On-screen:** real desktop; caption + seeded prompt: *"Now circle anything with the cursor and ask
  what it is."*
- **Pet:** the live gesture trail draws as they circle; then Kairo describes what's circled.
- **Voice:** *"Here's my favorite. Hold ⌥⌃, circle anything on your screen, and ask about it."*
- **Interaction:** chord-only-Next. Gesture bypasses the gate (product behavior) → composited marks →
  vision. (Marks now bolder per the recent visibility fix.)
- **Advance:** one successful circle turn.
- **Edge cases:** if the model returns no box, gentle retry caption; the bolder composite (already
  shipped) should make this rare.

### ACT 5 — Housekeeping *(deferred asks, light)*
They're hooked; now the boring-but-needed bits, fast.

**5a. Sign in**
- **On-screen:** **temporary panel** with the Google button.
- **Voice:** *"Almost done — let's save your setup. Sign in with Google."*
- **Interaction:** `start_google_auth` → browser → deep-link back → focus onboarding (already built).
  **Pull the user's name + email from the Google profile** (no separate name step). Persist name +
  chosen color to the account (`saveOnboarding`, extended with the color).
- **Edge cases:** the return-to-Kairo focus fix already handles the browser hand-off.

**5b. Where'd you hear about us**
- **On-screen:** small chip row in the temporary panel (existing `ONBOARDING_SOURCES`).
- **Voice:** *"Last thing — where'd you hear about me?"*
- **Interaction:** one tap. Save with the profile.

### ACT 6 — Warm ending *(the "end" half of peak-end)*
- **On-screen:** caption; desktop.
- **Pet:** a final warm beat, then it naturally settles/retreats toward the notch (no special
  graduation choreography — the product's normal post-turn retreat covers this).
- **Voice:** *"You're all set, {name}. Hold ⌥⌃ any time — I'll be right here."*
- **Interaction:** `finish_onboarding` (writes the onboarded marker, clears resume + PTT ownership,
  drops to Accessory). The product is now live.

---

## 5. Color Wheel + Dynamic Theming

- **Picker:** a full HSL/HSV color wheel (any hue), not a fixed palette (beats Clicky's fixed swatches).
  Include a lightness/saturation control or a sensible ring. Default hue pre-selected.
- **Live theming (Act 1 + persistent):** the chosen accent drives, in real time:
  - the pet's glow/core color,
  - the desktop vignette + ambient gradient in onboarding,
  - shadows + the caption accent,
  - the modern-notch accent (§11),
  - **the real product accent** — the pointer color and the highlight-box color (`--box-rgb` /
    `color.rs` currently derive these; thread the user's accent through instead).
- **Persistence:** store the accent as a **user preference** (a new setting) — written to the account
  at sign-in (Act 5) and cached natively (e.g. app config) so all four webviews read it at launch.
  Add a native `get_accent` / `set_accent` (or bundle into the existing config/prefs surface) + emit an
  `accent:changed` event so live recolor works across panels.
- **Accessibility:** clamp against unreadable/low-contrast picks (enforce a min contrast for text on the
  accent, or only accent glows/strokes, not text backgrounds).

---

## 6. Permission Priming (detailed)

**Dependency chain (why the two-moment split):**
- Talk (Act 2) needs **Microphone + Input Monitoring** (the ⌥⌃ tap + mic capture).
- Point/Circle (Act 3-4) needs **Screen Recording + Accessibility**.

**Sequence:** greet + color (no perms) → Mic/Input-Monitoring primed at "say hi" → wow → Screen
Recording + Accessibility primed at "earn the eyes." Each primer: one-line *why* + benefit + honest
privacy line, then fire the OS prompt. One at a time; never batch-blast.

**The toggle-point nuance (important):**
- **Screen Recording** toggle → **guided illustration/arrow** bridge (Kairo has no screen permission
  yet, so it can't vision-point). Deep-link to the pane.
- **Accessibility** toggle → **real pet-points-via-vision** (Screen Recording now granted) — the
  signature move. If vision mis-locates, fall back to the guided arrow.

**Relaunch handling (Screen Recording forces quit+reopen):**
- Already built: `set_onboarding_step` / `get_onboarding_step` persist the furthest act; `restart_app`;
  resume-on-mount jumps back. Ensure the resume lands at **Act 3** (earn-the-eyes), re-checks
  `get_permission_status`, and continues (Screen granted → go to Accessibility; both granted → Act 4).
- Sequoia periodically **resets** Screen Recording (~30 days) + adds "Allow for One Session" — surface a
  friendly heads-up in-product later (not onboarding-blocking), so the OS nag doesn't read as "Kairo
  broke." (Note for the product, tracked here for awareness.)

**Copy (privacy-honest, in the pet's voice):**
- Mic: *"To hear you, I need your mic."*
- Input Monitoring: *"…and to notice when you hold Option and Control."*
- Screen Recording: *"To point at things I need to see your screen — only when you hold ⌥⌃, and I
  never save it. I look, help, and forget."*
- Accessibility: *"This lets me steer the little pointer to what I'm showing you — not to control your
  Mac."* (reframe away from the scary "control your computer" wording).

---

## 7. Two-Mechanic Ladder

- **Mechanic 1 = hold-to-talk** (Acts 2 + 4a). Drilled first, in isolation.
- **Mechanic 2 = the circle gesture** (Act 4b), introduced only after talk + point are solid, framed
  as the "power move." Never taught in the same breath as the chord.
- Reinforce the chord with a persistent "hold ⌥⌃" micro-hint near the pet for the early beats; it can
  fade after the first unaided success (nice-to-have).

---

## 8. Seeded Prompts (never a blank mic)

- **Talk (2b):** `"hey Kairo, what's up?"` (already present).
- **Point (4a):** use an **always-present** target so it works on any screen — the menu bar / dock /
  status icons: `"where's the wifi icon?"`, `"point at the battery"`, `"where's the Apple menu?"`.
  (Do NOT assume the user has an app open.)
- **Circle (4b):** `"circle any icon and ask what it is"`.
- Render as a small chip/subtitle in the caption. 2-3 options; rotate.

---

## 9. Peak-End (no graduation)

- **Peak:** Act 4a — the first time the pet crosses the *real* screen and points at the exact thing.
  Give it weight: a distinct pet flourish + the `arrive` sound, used sparingly so it stays special.
- **End:** Act 6 — a short warm, name-personalized sign-off; the pet settles toward the notch. No
  special "I'll go quiet" choreography (the product's normal post-turn retreat already does this).

---

## 10. Re-runnable + Resume

- **Resume across relaunch:** already built (step marker) — verify it survives the Screen-Recording
  quit+reopen and lands at Act 3.
- **Replay onboarding:** add a **menu-bar item** ("Replay intro") and/or a command that clears the
  onboarded marker + reopens the onboarding window (Raycast's "Show Onboarding"). Critical because
  permission prompts interrupt the first run.

---

## 11. Modern Notch Redesign

**Vibe:** **Raycast's tightness + Arc's fluidity.** **NOT Liquid Glass.** Threaded with the user's
accent color.

**Core idea — one living element that MORPHS between states** (not separate cards swapped in/out):
- States: `idle` · `listening` · `thinking` · `showing_step` / `answer` · `coach-caption` (new, for
  onboarding).
- Transitions are **spring-based morphs** — the capsule reshapes/resizes fluidly between states; text
  cross-fades; no hard cuts. (Arc fluidity.)
- **Tight, crisp layout + type** — refined spacing, a clear single status line, legible step text,
  no clutter. (Raycast tightness.)
- **Accent-threaded** — the user's chosen color is the accent (listening pulse, progress, highlights);
  neutral dark base (no glass), with soft depth + a refined shadow. Avoid heavy translucency/vibrancy.
- **State legibility:**
  - `idle` — calm, minimal, barely-there.
  - `listening` — an accent pulse tied to the live mic level (reuse `cursor:level`).
  - `thinking` — an accent shimmer/swirl.
  - `answer`/`showing_step` — clean text; the box/pointer are on the overlay, the notch stays the
    "voice."
  - `coach-caption` (onboarding) — same capsule showing Kairo's spoken line + optional seeded chip.
- **Smooth show/hide** — slides out of / into the physical notch cutout with a spring.
- **Micro-interactions** — subtle scale on state change, a gentle settle, accent glow on the peak.

**Implementation notes:**
- Redesign lives in the notch webview (`NotchApp` render layer + its CSS) + the payload/state model
  (`activationState.ts` payloads, `panels.rs` sizing via `notch_window_size`).
- Add the **`coach-caption` payload state** so onboarding can push captions via `show_notch`.
- Thread the accent via the `accent:changed` event / accent pref (§5).
- Keep the existing behavior/state-machine semantics; this is a **visual + transition** redesign, not a
  logic rewrite. Preserve the hit-rect/click-through model (`set_notch_hit_rect`).
- Respect `prefers-reduced-motion` (dampen morphs).

---

## 11B. Pet Cursor Refresh

The pet is the **star** of the new onboarding (character + pointer + status surface) and the third
surface alongside the notch + overlay. It must feel cohesive with the modern notch.

**Scope = visual + motion + personality refresh. NOT a behavior/logic rewrite.** Keep the existing
engine semantics (spring, fly-to-target, comet trail, listening halo, thinking swirl, speaking pulse,
drag-to-draw box) in `useCursorEngine.ts`; refresh the *look* and add a few expressive beats.

- **Accent-threaded.** Replace the hard-coded `#7c3aed` defaults (`cursorConstants.ts`
  `DEFAULT_TRAIL`, `DEFAULT_ARROW_FILL`, `RECORDING_FILL`, `CursorApp.tsx` gradient) with the user
  accent via `getAccent()` + live `accent:changed`. Recording/thinking/speaking FX derive from the
  accent (with sensible tints), not a fixed purple.
- **Motion cohesion (Raycast tightness + Arc fluidity).** Match the notch's spring/easing vocabulary
  so the pet and notch feel like one system. Refine the arrowhead/glyph + trail for a crisper,
  more characterful look.
- **New expressive beats (for onboarding, reusable in-product):**
  - **Signature entrance** (Act 1 wake-up) — the pet "comes to life" from the notch/center.
  - **Peak celebration** (Act 4a) — a distinct, delightful reaction on the first successful point.
  - Optional: a subtle idle "aliveness" so it never reads as a dead dot.
- **Status legibility** — keep the listening halo / thinking swirl / speaking pulse but re-skin them
  in the accent, tighter and more legible.
- **Respect `prefers-reduced-motion`** (dampen the springs/celebration).

**Implementation notes:** lives in `src/cursor/` (`CursorApp.tsx`, `useCursorEngine.ts`,
`cursorConstants.ts`, `spring.ts`). Add accent wiring + two new event-driven beats (e.g.
`cursor:entrance`, `cursor:celebrate`) that onboarding triggers. Ships independently of onboarding
(the accent + re-skin land first; the new beats are additive).

## 12. User's Name in the Prompt (non-cached)

- After onboarding, Kairo should know the user's name in the real product.
- **Source:** Google profile (Act 5) → persisted on the account → available to the app.
- **Injection point:** the **non-cached / dynamic** section of the tutor + gate prompts (bottom, with
  the per-turn context), **never the cached prefix** — so it doesn't bust prompt caching.
- **Data flow:** frontend (NotchApp) reads the name (from `/v1/me` or a cached local value) → passes it
  into `run_gate_turn` / `run_tutor_turn` input → `prompts.rs` appends a short line in the dynamic
  section, e.g. `The user's name is {name}.`
- Keep it short + optional (empty when unknown / signed out).

---

## 13. Beat-Clicky Checklist

| Axis | Clicky | Kairo (this spec) |
|---|---|---|
| Where it happens | Centered card over a stock wallpaper | The user's **real desktop** |
| Teaching the gesture | **Video of someone else's hands** + keycap diagrams | User **actually does it** on their screen |
| Advancing | A **"Continue" button** (escapable) | **The chord is the only Next** |
| First thing | **Sign-in** | **A "whoa"** (say-hi + point) before any ask |
| Character | Absent in the teaching (bars/keycaps) | **Live pet** narrates + points, is the status surface |
| Permissions | Requested as a step | **Primed in-voice; pet points at the real toggle** |
| Personalization | Choose color (in a card) | Color wheel + **live dynamic theming** on the real desktop |

---

## 14. Reuse Map (build on what exists)

- **Real pipeline:** `run_gate_turn`, `run_tutor_turn`, `capture_screen`, `transcribe_audio`,
  `synthesize_speech(_stream)`, `show_overlay`/`hide_overlay`, `cursor_point`/`cursor_release`.
- **Onboarding PTT ownership (already built):** `set_onboarding_ptt` + `ONBOARDING_PTT` +
  `onboarding:ptt` + `onboarding:audio` (notch stays inert during onboarding).
- **Demo turns (already built):** `demoController.ts` (`runTalkTurn`/`runPointTurn`/`runCircleTurn`) +
  reused pure modules (`streamingTts`, `targetRouting`, `VisualOverlay`, `coordinates`,
  `gestureSegmenter`, `compositeMarks`, `notchTutor`).
- **Sound cues (already shared):** `playRecordingCue` (`core/sound.ts`) + the `arrive` cue for the peak.
- **Permissions:** `get_permission_status`, `request_required_permissions`, `open_permission_settings`,
  `ensure_input_monitoring_access`, `restart_app`.
- **Resume:** `set_onboarding_step` / `get_onboarding_step`.
- **Auth:** `start_google_auth`, deep-link handler + focus fix, `saveOnboarding` (extend with color).
- **Notch (post-refactor):** `NotchApp.tsx` (~1500 lines, orchestration) + **`NotchCapsule.tsx`**
  (presentational — the redesign's main surface) + `NotchIcons.tsx`, `notchConstants.ts`,
  `useTTSPlayback.ts`, `useTurnHistory.ts`; payload model in `activation/activationState.ts`;
  `panels.rs` sizing (`notch_window_size`); AbortController-per-turn (not epoch).
- **Cursor (post-refactor):** `CursorApp.tsx` (thin) + **`useCursorEngine.ts`** (engine) +
  `cursorConstants.ts` + `spring.ts` + `geometry.ts`.
- **Paywall (NEW — must account for):** credits are checked on PTT release in `NotchApp.tsx` (plays
  bundled `upgrade.wav`); the AI proxy is backend-authoritative. Tutorial turns use a separate capped
  budget. **Onboarding demos must be exempt** (see §3B).
- **New pieces to add:** accent pref system (§3B), `'coach'` notch state, color-wheel panel, "Replay
  intro" entry point, name-in-prompt plumbing, the full-screen transparent onboarding orchestrator,
  the pet-cursor refresh (§11B), the two new cursor beats (`cursor:entrance`, `cursor:celebrate`).

---

## 15. Deferred Features (do NOT build now; note in code as TODO)

- **Pick-your-voice** (Sarvam voices now; ElevenLabs later on paid plans).
- **Pet naming / renaming.**
- **Separate "what should I call you?" step** (name comes from Google).
- **Liquid-Glass notch.**

---

## 16. Risks & Open Questions

1. **Full-screen transparent orchestrator window** is the biggest architectural change — must coexist
   with the pet/overlay/notch panels + stay click-through except the temp panel. Validate z-order +
   click-through carefully (this class of bug bit the annotation overlay before).
2. **Screen-Recording quit+reopen mid-onboarding** — the resume must be flawless; test it explicitly.
3. **Vision-pointing at the Accessibility toggle** — reliability depends on the model locating a small
   system toggle; keep the guided-arrow fallback wired.
4. **Paywall vs. value-before-sign-in (HIGH).** A backend-authoritative paywall now checks credits on
   PTT release + caps tutorial turns. The onboarding demos run pre-sign-in and MUST be exempt (§3B) —
   verify the exact path (native-direct vs. backend proxy) and add the exemption, or the first "whoa"
   turns into an upgrade wall. Test explicitly.
5. **Accent vs. `vibrant_accent` (MEDIUM).** The box/pointer color is auto-picked per-target today; the
   user accent must become the base without breaking contrast. Phase 0 owns the blend rule; enforce
   readable text on any chosen hue.
6. **Full-screen transparent orchestrator window** — z-order/click-through with the pet/overlay/notch
   panels (the class of bug that bit the annotation overlay). Validate carefully.
7. **Screen-Recording quit+reopen mid-onboarding** — resume must be flawless; test it.
8. **Vision-pointing at the Accessibility toggle** — keep the guided-arrow fallback wired.
9. **Background music** — off by default; confirm the user wants it at all (nice-to-have).

---

## 17. Phased Implementation Plan

Build in dependency order; each phase leaves the app runnable. Each phase gets its own bite-sized
implementation plan (`docs/superpowers/plans/2026-07-21-onboarding-phaseN-*.md`).

- **Phase 0 — Foundations & Shared Contracts:** accent preference system (§3B: native get/set +
  `accent:changed` + `src/core/accent.ts`), the `vibrant_accent` blend rule, the `'coach'` notch
  state, the full-screen transparent onboarding orchestrator shell, and the name-in-prompt plumbing
  (input field + `prompts.rs` non-cached append). Everything else depends on this.
- **Phase 1 — Modern notch:** state-morphing, accent-threaded, Raycast-tight/Arc-fluid redesign of
  `NotchCapsule.tsx` (visual + transitions only; preserve logic). Ships independently.
- **Phase 2 — Pet cursor refresh (§11B):** accent-thread `useCursorEngine`/`cursorConstants`, re-skin
  the FX + glyph/trail to match the notch, add `cursor:entrance` + `cursor:celebrate` beats. Ships
  independently.
- **Phase 3 — Coach surface + Acts 1-2:** notch-as-caption; Arrival + color wheel + live theming;
  "can you hear me" (Mic/Input-Monitoring primer + say-hi drill, chord-only-Next, first wow); pet
  entrance beat.
- **Phase 4 — Permissions (Act 3):** two-moment priming; Screen-Recording bridge + relaunch/resume;
  Accessibility with the real pet-points-via-vision (+ arrow fallback).
- **Phase 5 — The magic (Act 4):** point (peak + celebration beat) + circle on the real screen;
  seeded prompts; **onboarding paywall exemption** (§3B).
- **Phase 6 — Housekeeping + ending (Acts 5-6) + finalize name-in-prompt:** deferred sign-in (pull
  name + persist color) + source; warm ending; `finish_onboarding`; wire the name into live turns.
- **Phase 7 — Re-runnable + polish:** "Replay intro" entry point; reduced-motion; contrast clamps;
  music toggle (if kept); QA the Screen-Recording resume + Sequoia reset heads-up.

---

## 18. Cross-phase reconciliations (from the plan-consistency pass)

The 8 per-phase plans (`2026-07-21-onboarding-phaseN-*.md`) agree on the §3B contract names. Two
adjustments to note before executing:

1. **Pull the paywall/auth exemption FORWARD (build after Phase 0, before Phase 4).** Phase 5's
   investigation found the real blocker isn't the notch paywall (which never fires during onboarding —
   audio routes to `onboarding:audio`, notch inert) but that Act 3/4 vision turns proxy to the
   **authed** backend (`proxy.rs::authed_post` → `fetch_jwt`), so pre-sign-in they **401 (NoAuth)**.
   The fix — new unauth, IP-rate-limited `/v1/onboarding/{gate,vision,tts}` routes + a central
   `proxy_post_builder` reroute gated on `ONBOARDING_PTT` (Phase 5 Tasks 1-3) — is a **prerequisite for
   Phase 4's Accessibility vision-point** and every Act-4 turn. Build it as a foundation, not last.
   (Act 2's say-hi already uses the unauth `/v1/onboarding/chat` + native TTS, so it's fine.)
2. **Name-in-prompt — split ownership, append once.** Phase 0 owns the plumbing (`userName` field on the
   turn inputs + the `prompts.rs` non-cached append). Phase 6 owns the value (file-backed
   `get/set_user_name` cache + threading it live from `NotchApp`). Do the `prompts.rs` append ONCE
   (Phase 0); Phase 6 only supplies the value — don't double-append.

**Revised build order:** Phase 0 → **paywall exemption (Phase 5 Tasks 1-3)** → Phase 1 + Phase 2
(independent surface redesigns, any order) → Phase 3 → Phase 4 → Phase 5 (rest) → Phase 6 → Phase 7.

## Appendix — Research basis
Value-first / learn-by-doing / aha-in-60s / permission-priming / peak-end / endowed-progress — synthesized
from: the 200-flow study (designerup), Product School, NN/g AI onboarding, Superhuman's playbook (chord
drill / "piano lesson"), Granola/Descript/Loom (tutorial-is-the-product), Arc (cinematic + paint-your-theme),
Raycast (nail one shortcut + re-runnable), Wispr Flow (voice drill + mic test), Finch (authorship/IKEA
effect), Clippy post-mortems (quiet-until-needed), CleanShot (permission-as-ritual, pet-points-at-toggle),
Apple "Love at First Launch" (no demanding-landlord permission dumps), and the community consensus that a
signup wall before value gets the app closed instantly.
