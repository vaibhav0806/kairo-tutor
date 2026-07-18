# Hold-to-Point Gestures — Design

**Date:** 2026-07-18
**Branch:** `feat/hold-to-point-gestures`
**Status:** Design approved, ready for implementation plan.

## 1. Summary

Replace the shortcut-activated pen (⌥⇧P) with **hold-to-point**: while the user
holds ⌥⌃ to talk, moving the mouse to circle/underline/linger on things is
detected as pointing and sent to the fable model as translucent marks on the
screenshot. Kairo distinguishes a genuine pointing gesture from travel and rest,
shows the user a competitor-style mark that **fades in ~1s** (cosmetic only), and
sends the **full-strength** marks to fable at key-release. There is no tool to
activate — pointing is just part of asking.

## 2. Motivation / current state

- **Today:** the pen is a toggle (`⌥⇧P` → `pen:toggle` → `startAnnotation`),
  modal (the overlay panel swallows all mouse input while on), and marks persist
  until the user "moves on" (`context:changed`) or the notch idle-closes.
- **Competitor (Clicky):** pen is always live during the talk-hold — move the
  mouse and it draws — and the ink fades away in ~1s. Lower friction, cooler feel.
- **Goal:** make pointing effortless (no shortcut, no tool), keep it simple, and
  go one better than the competitor by only sending *intentional* gestures and
  letting the marks be hints the smart model interprets — not blunt persistent ink.

## 3. The model (what we build)

Hold ⌥⌃, talk, and move the mouse over what you're asking about. Kairo watches the
cursor (it does not hijack it), decides which motions are real pointing gestures,
draws a translucent mark that fades like the competitor's, and — at release —
composites the full-strength marks onto the screenshot sent to fable. Circle the
top-left, move to the top-right, circle again → fable sees **two** marks, **not**
the line the mouse took between them. `⌥⇧P` is removed.

## 4. Decisions locked

1. Pointing = **cursor gesture during the ⌥⌃ talk-hold**. Not a separate tool.
2. Gestures are captured **only while talking** (the confirmed hold window).
3. Discriminator = **directness** = `net displacement ÷ path length`.
   Low = gesture (keep); high = travel/drift (drop); no motion = rest (ignore).
4. The cursor stream is **segmented into bursts**; each burst is rendered, travel
   between bursts is dropped, multiple bursts are numbered in time order.
5. Fable receives **translucent gesture strokes** (confident = more opaque,
   borderline = fainter), no connecting line, composited on the release screenshot.
6. **Two layers.** A *cosmetic* layer the user sees (fades in ~1s, competitor look)
   and a *truth* layer (full-strength stroke coords kept until release). Fable
   always gets the truth layer at full strength.
7. **Way B cursor watching.** Kairo samples the global cursor position (~60 Hz) and
   never grabs mouse input; the render layer stays click-through, so the user's app
   keeps working normally.
8. Fable is prompted that marks are **hints, not truth** (the user may gesture near
   one thing while asking about another; trust the words on conflict).
9. `⌥⇧P` and its toggle/modal path are **removed**.
10. A **debug image dump** (off by default) saves the exact image sent to fable so
    we can eyeball coordinate alignment + translucency.

## 5. Architecture

### 5.1 Gesture window — when we listen

Sample gestures only during a **confirmed talk-hold**: from the PTT state machine's
`ptt:recording {active:true}` (promote, ~250 ms into the hold) to
`ptt:recording {active:false}` (release). A tap (<250 ms → typing) never enters
this window, so typing never produces gestures. Outside the hold, we do not look at
the mouse at all — this is what makes idle/reading/hand-talking motion invisible.

### 5.2 Cursor sampling — Way B, reuse the existing tracker

`spawn_mouse_tracker` (`src-tauri/src/panels.rs:304`) already polls the global
cursor at ~60 Hz via Tauri's `cursor_position` and emits `cursor:mouse {x, y}`
(physical px, global top-left) **only on actual movement** — an idle mouse costs
nothing and emits nothing. We reuse it; the gesture consumer subscribes to
`cursor:mouse` during the hold window. (Today the event is emitted to the cursor
webview for the pet; it needs to also reach the gesture consumer — see 8.)

### 5.3 Gesture detection — directness

Over a sliding window of the position stream (`WINDOW_MS`), compute:

- **path** = sum of step distances within the window (how much the cursor moved).
- **net** = straight-line distance from the window's first point to its last.
- **directness** = `net / path`.

Classify each window:

| Window | Test | Verdict |
|---|---|---|
| **Rest** | `path < MIN_PATH_PX` | ignore |
| **Gesture** | `directness < T_DIRECT` and `path ≥ MIN_PATH_PX` | keep |
| **Travel/drift** | `directness ≥ T_DIRECT` | drop |

Consecutive **gesture** windows join into one **burst**; a travel/rest window ends
the current burst. A burst is **confident** (more opaque) when it is sustained
(low directness held for ≥ `MIN_DWELL_MS`, or path well above the floor), otherwise
**borderline** (fainter).

Why directness (not spread): a **big circle** strays far from its centre (large
spread) but *returns to itself* (net ≈ 0) → low directness → correctly kept.
Straight A→B travel ends far from its start (net ≈ path) → high directness →
dropped. Scribbles/underlines go back and forth (net ≈ 0) → kept. Reading drift
moves in one direction (net ≈ path) → dropped.

### 5.4 Two layers

- **Cosmetic layer** — the overlay webview (`src/overlay/`), kept **click-through**
  (a ghost that shows marks but never eats input). Each burst is drawn as a
  translucent stroke that **fades out over `FADE_MS` (~1s)** shortly after it's
  drawn. This is purely what the user sees; it is **never captured**.
- **Truth layer** — the burst stroke coordinates, held in memory by the gesture
  controller for the **whole hold**, independent of the cosmetic fade. This is what
  gets composited and sent to fable.

This split is what lets the on-screen mark fade in ~1s (even mid-hold) while fable
still sees every mark full-strength at release.

### 5.5 Capture + composite — at release

The native ⌥⌃ path already captures the screen **at release**
(`processCapturedAudio` → `captureScreen()`, `src/notch/NotchApp.tsx:1918-1924`,
driven by the `ptt:audio` event which fires on key-release). So gestures made
during the hold are current when the shot is taken — no staleness, no re-capture.

- The base screenshot must be **clean** (no marks): **exclude the overlay panel
  from the capture** so neither live nor faded cosmetic marks leak in. (This
  changes the current behavior where the overlay is included in capture.)
- After capture, **composite the truth strokes in code** onto the base image
  (translucent polylines, numbered when there are multiple bursts), producing the
  exact image sent to fable.
- **Coordinate mapping:** `cursor:mouse` is physical px (global, top-left); the
  screenshot is downscaled JPEG. Truth strokes must be scaled physical-px →
  screenshot-px before compositing. This is the highest-risk correctness detail and
  is exactly what the debug image dump (5.7) verifies.

### 5.6 Fable prompt

Add to the tutor prompt (native `prompts.rs` / tutor turn):

> "The user can circle or point at things with the cursor while talking.
> Translucent marks on the screenshot show where they circled or lingered — treat
> them as **hints** to disambiguate the spoken question, not ground truth. The user
> may gesture near one thing while asking about another; when the words and the
> marks conflict, trust the words. Multiple numbered marks indicate multiple things
> the user is referring to, in that order."

### 5.7 Debug image dump

Behind a `constants.rs` flag (default **off**). When on: after each turn, save the
**exact composited image sent to fable** to a temp dir (e.g.
`~/Library/Logs/Kairo/gesture-debug/` or the OS temp dir), named by turn. At the
end of a test session (or on demand) `open` the folder/images so the translucency
and coordinate alignment can be eyeballed. Tune alpha/thresholds in `constants.rs`,
rebuild, look again.

## 6. End-to-end flow

1. User holds ⌥⌃. At ~250 ms the hold is confirmed → `ptt:recording {active:true}`.
   The gesture controller starts listening to `cursor:mouse`; the overlay is shown
   click-through.
2. User talks and moves the mouse. The controller runs directness detection,
   accumulates **truth** strokes, and tells the overlay to render each burst as a
   **cosmetic** stroke that fades in ~1s.
3. User releases ⌥⌃ → `ptt:recording {active:false}`; `ptt:audio` delivers the WAV.
4. `processCapturedAudio` captures a **clean** screenshot (overlay excluded) and
   transcribes in parallel.
5. The controller composites the truth strokes onto the screenshot; this image +
   transcript go to the tutor turn. (Debug dump saves the image if enabled.)
6. Fable answers using the marks as hints. Cosmetic marks have already faded.
7. New turn / `resetPreviousTurn` clears the truth strokes (turn-scoped).

## 7. Removals

- `KAIRO_PEN_SHORTCUT` registration + handler + `pen:toggle` emit (`lib.rs`).
- `pen:toggle` listener and the `startAnnotation('pen')` toggle path (`NotchApp`).
- The pen button in the notch UI (`NotchApp.tsx:2431`).
- The **modal** annotate mode — the overlay is now always click-through; the
  `mode: 'annotate'` (`set_ignore_cursor_events(false)`) path is no longer used for
  the user pen.
- The `context:changed` → annotation-clear watch (`armAnnotationWatch`) as it
  applies to the pen: gestures are turn-scoped and fade on their own, so "move on to
  clear" is obsolete. Verify nothing else depends on this before removing.

Reused (not removed): the overlay panel + its stroke/SVG rendering, the
`UserAnnotation` shape, and the notch↔overlay mirroring pattern.

## 8. Module boundaries

- **Native mouse tracker** (`panels.rs`, existing) — emits `cursor:mouse`. Change:
  make it reach the gesture consumer (emit app-wide or add the overlay/notch window
  as a recipient), not only the cursor webview.
- **Gesture controller** (new, e.g. `src/notch/gestureController.ts`) — owns the
  hold window, directness detection, the truth-stroke store, cosmetic render
  commands to the overlay, and compositing at release. The one place that sees both
  `ptt:recording` and `cursor:mouse`.
- **Overlay renderer** (`src/overlay/`) — dumb: draws the strokes it's told to and
  runs the fade animation. No detection logic.
- **Compositor** — draws truth strokes onto the base screenshot (frontend canvas or
  native image draw; decide in the plan).
- **Tutor prompt** (`prompts.rs`) — the hints paragraph.

## 9. Config (`constants.rs` + mirror in `src/config/env.ts` where needed)

- `GESTURE_WINDOW_MS` — sliding-window length for detection.
- `GESTURE_MIN_PATH_PX` — motion floor (below = rest).
- `GESTURE_DIRECTNESS_MAX` (`T_DIRECT`) — cutoff; below = gesture, at/above = travel.
- `GESTURE_MIN_DWELL_MS` — sustained gesture → confident.
- `GESTURE_FADE_MS` — cosmetic fade duration (~1000).
- `GESTURE_ALPHA_CONFIDENT`, `GESTURE_ALPHA_BORDERLINE` — mark translucency.
- `GESTURE_DEBUG_IMAGES` (bool, default false) + debug dir.

Start with sensible guesses; tune after the first build using the debug images.

## 10. Edge cases / error handling

- **Rest** — tracker emits nothing on an idle mouse, and any residual is below the
  path floor → never marked. (The false positive the user called out.)
- **Reading drift** — directional, `net ≈ path` → dropped.
- **Big object** — large circle returns on itself, `net ≈ 0` → kept.
- **Travel between targets** — high directness → dropped (no connecting line).
- **Screen changes mid-hold** — capture is at release, so the shot reflects the
  end-of-hold screen; strokes are aligned to that. Fine for static lab screens;
  a limitation if the screen moves a lot during the question.
- **Superseded / new turn** — `resetPreviousTurn` (epoch bump) clears truth strokes.
- **No gestures** — a normal voice turn with no marks; behavior unchanged.
- **Multi-display** — the tracker is global; ensure compositing maps to the captured
  display's space. (Capture is single-display today.)

## 11. Testing / verification

- **Unit** (`tests/`, node env): directness classifier against fixtures — rest,
  straight travel, small circle, **big circle**, underline/scribble, reading drift,
  circle→travel→circle (expect two bursts, no connector).
- **Manual:** build the packaged app, hold + circle one thing, then two things;
  enable `GESTURE_DEBUG_IMAGES` and confirm the saved image has marks in the right
  place (coordinate mapping) at the right translucency; tune `constants.rs`.
- `npm run typecheck` · `npm run test` · `cargo check` · `npm run tauri:build`.

## 12. Non-goals (keep it simple)

- No local UI-element detection or snapping — fable does all semantics.
- No gesture vocabulary (circle vs arrow vs tap) — every burst is just "the user
  pointed here."
- No mark-without-talking mode (there is no such case).
- No Set-of-Mark number picker.
- No persistent annotations across turns.

## 13. Open tuning (after first build)

Threshold values (`T_DIRECT`, `MIN_PATH_PX`, `WINDOW_MS`, `MIN_DWELL_MS`), the fade
curve/duration, mark alpha, and stroke styling. All live in `constants.rs` and are
tuned against the debug images.
