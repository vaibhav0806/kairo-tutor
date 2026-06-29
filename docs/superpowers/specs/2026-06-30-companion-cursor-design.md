# Companion Cursor + Notch UX — Design

Date: 2026-06-30
Status: Approved (brainstorm)

## Goal

Three UX upgrades, driven by parity with competitor "Clicky":

1. **Glyph** — replace the mac-pointer-shaped SVG with a clean Clicky-style filled arrowhead. Keep the purple gradient.
2. **Companion cursor** — a persistent pointer that shadows the real macOS cursor like a pet (even when other apps are focused), then flies to AI targets and glides back.
3. **Notch text-on-TTS** — reveal the answer body only when speech playback starts, not before. (Word-highlight is explicitly out of scope.)

Hard constraint: **smooth, no lag**. Always-on 60–120 Hz follow, GPU-composited motion, zero React re-renders per frame.

## Decisions (locked)

- After pointing: **glide back to the mouse** and resume shadow.
- Visibility: **always while Kairo runs**, including when other apps are focused.
- Target mark: **arrow only, points from a gap** — no ring/dot. Rests at the object's bottom-left, tip aimed at its corner with a small standoff.
- Follow feel: **loose trailing (pet-like)** spring lag.

## Architecture

### New dedicated cursor window

A third Tauri window/panel `cursor` (alongside `notch`, `overlay`), hash-routed `index.html#/cursor`.

- Always-on, full main-display, **click-through** (`set_ignore_cursor_events(true)` permanently — never catches input).
- Non-activating NSPanel, `can_join_all_spaces` + `full_screen_auxiliary` + `stationary`, level **1002** (above notch/overlay; click-through so z-order is purely visual).
- **Capture-excluded** (`NSWindowSharingNone`) unless `KAIRO_SHOW_IN_CAPTURE`, same as notch/overlay. This keeps the pet out of AI grounding screenshots so Claude never sees two cursors.
- Isolated from the existing `overlay` panel so the annotation/pen lifecycle (which must become key) is untouched.

`tauri_panel!` allows only one macro block; add `CursorPanel` inside the existing block. Add `CursorState { panel, window }` and pre-create at `setup()`, then `panel.show()` once and leave shown.

### Mouse tracking (Rust)

A `std::thread` polling loop, started at setup:

- Read `CGEvent::new(CGEventSource::new(...))?.location()` → mouse in **global top-left points** (thread-safe, no Accessibility permission).
- Emit `cursor:mouse { x, y }` to the cursor window only when moved > ~0.4px; sleep ~8ms (≈120 Hz cap). Idle = cheap read + compare, no emit.

### Cursor renderer (React, imperative)

`CursorApp` (`src/cursor/CursorApp.tsx`) renders one absolutely-positioned arrow. A single `requestAnimationFrame` spring loop owns motion:

- State held in refs (`current`, `target`, `mode`); **never `setState` for position** → no React reconciliation per frame. Each frame writes `el.style.transform = translate3d(localX, localY, 0)`.
- `localX/Y = global - displayOrigin` (origin from `get_display_bounds` at mount).
- Modes are just *what the target is* + spring tightness:
  - **SHADOW**: target = latest mouse + below-left offset; loose spring (low stiffness) → trailing lag.
  - **POINTING**: target = object bottom-left corner + standoff gap; springier (slight overshoot) → accel/decel + rubber-band settle.
  - Return = switch back to SHADOW; the spring naturally glides from the target to the live mouse. No separate RETURNING state needed.

### Glyph

Single fixed arrowhead pointing **up-right** (tip at top-right). This one orientation serves both modes:

- SHADOW: pet sits down-left of the real cursor, tip aims up-right back at it (looks like it follows).
- POINTING: pet sits down-left of the object, tip aims up-right at the object's bottom-left corner.

No per-target rotation. Purple gradient `#c79bff → #7c3aed`, soft white edge, outer glow. Edge-adaptive flip (`scaleX(-1)` + mirrored offset) when the object hugs the left/top edge so the arrow stays on-screen.

### Pointing geometry

- Aim point = element bottom-left corner `(region.left, region.bottom)` in local px (region ÷ scaleFactor − origin, reusing existing coordinate math).
- Tip rests at `aim + (−GAP, +GAP)` so the object stays clear up-right of the tip. `GAP` ~ 8px, tunable.
- One companion can't be two places: **v1 points at the primary (first) target only.** Multi-target sequencing is out of scope; logged, not silently dropped.

### Commands & wiring

New Tauri commands + bridge methods:

- `cursor_point({ screenRegion, displayBounds })` → emit `cursor:point`; JS converts + enters POINTING.
- `cursor_release()` → emit `cursor:release`; JS → SHADOW (glide back).

Integration in `notchTutor.ts`: when `response.visualTargets` has a pointer, call `cursor_point` with the primary target instead of routing it to `showOverlay`. Non-pointer target kinds still go to the overlay. The overlay's `pointer` branch becomes unused for the companion (left in place, harmless, or removed in cleanup).

Dismiss: `NotchApp.playAnswerAudio` currently schedules `hideOverlay` after TTS+grace. Add `cursor_release` on the same dismiss path (and on new-turn supersede).

### Notch text-on-TTS

`NotchApp.submitQuery` currently `setPayload(answer)` then `playAnswerAudio` — text shows before audio. Change: keep title/state immediate but reveal the **detail body** on `audio.onplay`. Implementation: hold the answer's `detail` and only commit it to render state from the `onplay` handler (fallback: reveal anyway if synth/playback fails, so a silent answer is never invisible).

## Coordinate reference

- Claude `screenRegion`: full-res screen **pixels**.
- Overlay/local points: `region.x / scaleFactor − displayBounds.x` (existing).
- `CGEvent` mouse: global top-left **points** already (no flip needed).
- displayBounds: points + `scaleFactor`, from `main_display_bounds()`.
- v1 covers the **main display** only; mouse on a secondary display parks the pet off-window. Noted, not silently handled.

## Performance plan

- Mouse emit coalesced + capped ≈120 Hz, only-on-move.
- rAF spring: one `transform` write/frame, refs not state, `will-change: transform`.
- Cursor window DOM = one arrow; no list, no React updates during motion.

## Out of scope

- Word-by-word highlight (Sarvam returns no timestamps).
- Multi-display follow, multi-target sequencing.

## Files

- `src-tauri/tauri.conf.json` — add `cursor` window.
- `src-tauri/src/lib.rs` — `CursorPanel`, `CursorState`, `ensure_cursor_panel`, mouse-poll thread, `cursor_point`/`cursor_release`, setup show, capture-exclude.
- `src/cursor/CursorApp.tsx` (new) + spring/geometry helpers.
- `src/main.tsx` — `#/cursor` route.
- `src/native/nativeBridge.ts` — `cursorPoint`/`cursorRelease`.
- `src/notch/notchTutor.ts` — route pointer → cursor.
- `src/notch/NotchApp.tsx` — text-on-play; `cursor_release` on dismiss.
- `src/styles.css` — cursor glyph + glow.
</content>
</invoke>
