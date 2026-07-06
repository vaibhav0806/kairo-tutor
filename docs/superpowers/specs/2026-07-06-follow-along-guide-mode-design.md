# Follow-Along Guide Mode (Design)

Date: 2026-07-06
Branch: `main` (per project rule — no feature branch)
Status: design — awaiting review before implementation plan

## Goal

Add a **third tutor path**: a hands-on, real-time guide that walks the user
through *doing* a multi-action task (e.g. "teach me to open my first PR"), one
step at a time, **reacting to what the user actually does on screen** and only
producing the next step *after* the user completes the current one.

Contrast with the two paths that exist today (both are the *same* single
screenshot → single Fable call → `{ mode, steps:[…] }`, then fired on an audio
timer with a 700ms gap; the user is a passive listener):

- **`single`** — one step, a direct answer.
- **`steps`** — a several-step walkthrough, all pre-planned from one screenshot,
  narrated back-to-back with no waiting.

The new path is a **closed, reactive loop with the user inside it**. Nothing is
pre-planned. Fable emits **one step at a time**; the user acts; we re-read the
screen; Fable emits the next step. It is an **ambient guide layered on the normal
open chat** — never a modal wizard. The user is free at every moment to click
something else, ask an unrelated question, wander to another window, or stop. We
never force completion.

## Core principle

> **We point, the user acts — and we follow them, not the other way around.**
> The guide is passive. If the user does something that isn't the step we asked
> for, we do nothing (we don't chase, re-plan, or nag). We just keep the goal
> alive and pick up whenever they act or talk.

## Why this shape

- **Re-screenshot every iteration** is what makes real-time guidance possible —
  and is the source of every hard problem (staleness, loading screens). We accept
  **one vision call per completed action** (already agreed as the fundamental
  cost).
- **Model decides the mode** — when the user asks to *do* something hands-on,
  Fable picks follow-along; when they ask to *understand/orient* a screen, it uses
  the existing `steps` path; a quick ask stays `single`.
- **Reuses what we already have**: the epoch/supersede pattern, the input tap
  (already fires on clicks — we just start reading coordinates), the app/title
  poll, `recentContext` threading, and `capture.rs` downscaling.

## The loop / lifecycle

```
  user asks ("teach me to make a PR")  ── voice
       │
       │  gate (existing): speaks entry filler "sure, let's do it"
       │                    + flags mode = follow_along
       ▼
  capture reference frame  R
       │
       ▼
  Fable follow-along call  (goal + history=[] + R)
       │   → { say, box?, expect, wait, status }
       ▼
  draw pointer (if box) + speak `say`;  arm click gate on box;  store R
       │
       ▼
  ┌── WAIT ──────────────────────────────────────────────────────────┐
  │  advancement is dual-source, never forced:                        │
  │                                                                    │
  │  (A) user clicks INSIDE the box                                    │
  │        └─ AND current screen still matches R  (screen-match guard) │
  │              ├─ match → VALID: ack + advance   ───────────────►    │
  │              └─ mismatch → do nothing (they moved; stale coord)    │
  │                                                                    │
  │  (B) user hits PTT and talks (anything)                            │
  │        └─ normal chat turn, followAlong context injected           │
  │           (goal + history + current step) → stays active           │
  │                                                                    │
  │  (C) app / window switch / scroll / tab-change (poll + tap)        │
  │        └─ fade pointer (stale now) + soft "I'll wait for you to     │
  │           head back…"; on return/rematch, re-show or re-orient      │
  │                                                                    │
  │  (D) 30s idle, no action/voice                                     │
  │        └─ fade pointer; goal goes dormant in recentContext         │
  │                                                                    │
  │  anything else that does NOT change the screen → ignore, keep      │
  │  pointer.  anything that DOES change the screen → FADE pointer     │
  │  (don't show a lying hint), keep step alive, do NOT re-plan.       │
  └────────────────────────────────────────────────────────────────────┘
       │  (A) VALID click
       ▼
  ack  (Gemini, text-only, generic — see "Ack" below) speaks immediately
       │
       │  in parallel:
       ▼
  settle sequence:  wait(`wait` floor) → settle-diff loop (cap) → stable frame S
       │
       ▼
  Fable follow-along call  (goal + history + S)
       │   → append completed step to history
       │   → status = "done"?  → celebrate, deactivate
       ▼
  draw next pointer (draw-time screen-match vs S) + speak;  R := S
       │
       └────────────────────────────── back to WAIT ────────────────────
```

## The one reusable primitive: "are these two frames the same screen?"

A cheap, **internal, no-model** image compare — **must be fast AND accurate**
(explicit requirement). Use a **perceptual hash (pHash, DCT-based)** computed
**natively in Rust** (the `image` crate is already a dep for capture downscaling):

- **Fast:** the hash is a 64-bit value; comparison is one XOR + popcount (Hamming
  distance) — *nanoseconds*. Not a heavy per-pixel diff.
- **Accurate:** pHash keys on low-frequency structure, so it's *robust to trivial
  changes* (cursor blink, clock tick, tiny UI element) yet *catches structural
  change* (scroll, page load, navigation). This is why plain 32×32 average-diff is
  rejected — it's both noisier and less discriminating than DCT pHash.
- **Pixels never leave Rust** — we return/compare hashes, never raw frames (also
  satisfies the "never log/ship raw pixels" rule).

> **The cost is the capture, not the hash.** Each frame comes from the
> `screencapture` CLI (~100–200ms, shells out). The settle loop captures
> repeatedly, so *capture* is the weight — the pHash is free. Mitigations in the
> plan: cap iterations (below), and consider an in-process capture (ScreenCaptureKit
> / `CGDisplayCreateImage`) if the CLI cadence proves too slow — noted as an
> optional perf follow-up, not v1-blocking.

Used in **three** places, with two Hamming-distance thresholds:

1. **Settle detection** (post-action) — *sensitive* threshold `SETTLE_DIFF_THRESHOLD`:
   "has the screen stopped moving / finished loading?" Two consecutive stable
   frames → settled.
2. **Click validation** (at an in-box click) — *tolerant* threshold
   `SAMESCREEN_THRESHOLD`: "is the screen at click-time still the reference frame
   R?" A scroll/navigation is a large change → mismatch → ignore the click. A
   blinking cursor / clock tick is small → still the same screen. This is the
   guard against "scrolled away, clicked the same coordinate."
3. **Draw validation** (before showing Fable's next pointer) — *tolerant*
   threshold: "does the screen still match the frame S that Fable planned from?"
   If not, hold the step but don't draw a stale pointer; show when it matches
   again (no new Fable call — we still have the step).

## Component: settle-diff loop (the "capture when the screen stops moving" fix)

The problem: right after a click (e.g. "merge PR"), the screen is *loading*. A
screenshot taken then shows a half-rendered button; the competitor sends that to
their model and looks dumb. The `wait` enum gives a **floor**, but a fixed timer
is a guess (network is 500ms or 5s). The settle-diff loop is the **adaptive top**:

```
1. wait the `wait` floor  (see enum below)
2. capture frame A
3. wait SETTLE_POLL_MS (~300ms)
4. capture frame B
5. frames the same? (sensitive threshold)
     • no  → A := B; if iterations < SETTLE_MAX_ITERATIONS → go to 3
     • yes → settled: send this frame to Fable
6. iteration cap hit → send whatever we have (permanent animation / spinner case)
```

Only **one** clean, settled frame ever reaches Fable. `SETTLE_MAX_ITERATIONS`
bounds it so a page with a permanent moving element (video, endless spinner)
can't loop forever — recommend **10 (~3s ceiling)** on top of the `wait` floor
(worst case ≈ 2.5s network floor + 3s settle ≈ 5.5s; below the "feels broken"
line). Tunable in `constants.rs`.

## Component: the `wait` enum

Fable emits a bucket (models categorize well, guess ms badly). Mapped to floors
in `constants.rs`:

| enum          | floor    | example action                         |
|---------------|----------|----------------------------------------|
| `instant`     | ~75ms    | focus a field, toggle a checkbox       |
| `ui-settle`   | ~400ms   | a menu or panel opens                  |
| `page-load`   | ~1500ms  | open a file, switch a tab              |
| `network`     | ~2500ms  | merge PR, submit a form (round-trip)   |

These are *floors only*; the settle-diff loop absorbs anything slower. Together
they beat "screenshot instantly" on both the fast and the slow-network case.

## Component: geometry click gate + screen-match guard

- The native input tap **already fires** on `LeftMouseDown` etc. but discards the
  event (`_event`). New: while follow-along is active, read `event.location()`,
  convert to display points, and emit `input:click { x, y }` to the frontend.
  (Still Accessibility grant only — no new permission.)
- Frontend gate: is the click inside the current `box`, padded by
  `CLICK_PAD` (tolerance for imperfect boxes)?
  - **No** → do nothing (user is exploring / misclicked). Passive.
  - **Yes** → run the **screen-match guard** (primitive #2): capture now, diff vs
    R.
    - **match** → VALID click → ack + advance.
    - **mismatch** → do nothing (they scrolled/navigated and happened to click the
      same coordinate; the step is not actually done).
- **Wrong-but-in-box click** (our box was slightly off, click did nothing): the
  screen won't materially change, so `S ≈ R`, and the next Fable call sees the
  same screen and simply re-issues/adjusts. Self-corrects one step later, for
  free. Acceptable for v1 (no model-judge).

## Component: passive staleness handling (no chase)

There is **no auto re-plan** in v1. When the screen materially changes and it
wasn't the completing click (scroll, tab change, window/app switch, or any pHash
mismatch vs R):

- **Fade the pointer out** (don't show a hint that now points at the wrong
  content — it's stale the instant the screen moves). Reuses the existing
  `context:changed → hideOverlay` behavior; a soft opacity fade, not a hard cut.
- **Keep** the step + goal in state. Do **not** call Fable.
- When the screen matches R again (they scrolled back), fade the pointer back in —
  no new call, we still hold the step. The click-time screen-match guard is the
  correctness backstop regardless of whether the pointer is currently shown.

This honors "don't force / don't chase," and because a cancelled Fable call is
billed anyway (see below), there is **no cancellation logic** — instead the
draw-time screen-match check (primitive #3) prevents drawing a stale next-pointer.

> **Departure from the earlier discussion, flagged for review:** we dropped the
> "auto re-orient on any screen change" idea and its two guards (cancel-if-young,
> re-plan-cap). With a passive guide there is nothing to re-plan and nothing to
> cancel, so v1 has exactly one capped loop (settle-diff) and one match primitive.
> The only active behavior on a screen change is *hiding* a now-wrong pointer,
> which is strictly better than showing it and is what the app already does. If
> you'd rather keep explicit re-orient + guards, say so at review.

### Cancelling a Fable call does not refund credits

Anthropic billing: *"you will be charged if your client disconnects or times out
in the middle of an API call that was on track to be successful."* Our Fable
vision call is a direct Anthropic call (`anthropic_vision_chat`), so an aborted
call is billed like it completed. Therefore cost discipline lives **before we
fire** (settle-diff means we fire once, on a stable frame), not at cancel time —
and we simply don't cancel.
Source: https://support.claude.com/en/articles/8114526-how-will-i-be-billed

## Component: the two-model split (ack + next step) — mostly already exists

The two-model pattern **already ships**: the phase-1 **gate** (`run_gate_turn`,
Gemini `flash-lite` via OpenRouter, `reasoning effort=none`, **text-only — it
never sees the screen**) produces a short spoken `voiceText` filler while the
expensive vision model (`claude-fable-5`) plans. The vision prompt is even told
the filler was already spoken (`spokenIntro`) so it doesn't re-greet. The gate
prompt already forbids screen claims (3–6 word fillers like *"Sure, let me find
that."*). So our ack requirements are met by existing infra — we extend it, not
rebuild it.

After a VALID click, latency to the next instruction is real (settle floor +
settle-diff + Fable ≈ several seconds). We cover it with the same idea:

- **Per-action ack** — a cheap **text-only** call (same flash-lite/OpenRouter path
  as the gate, reusing the prewarmed pooled client), triggered by the completed
  click, given the just-completed step's instruction.
  - **Hard constraint (already the gate's rule):** the ack **must not claim any
    on-screen result.** It acknowledges the *action*, never the *outcome* — Fable,
    seeing the new screen, is the only one who asserts reality. Avoids "nice, it's
    open! …oh wait, my bad, it's not." Allowed (AI-generated): *"Okay, I see you
    clicked what I pointed to — let me take you to the next step."* Not allowed:
    *"Great, the editor is open now."*
  - **Playback:** speak it via `createStreamingClip(bridge, text, timeout)` (the
    streaming-TTS primitive) on a **dedicated follow-along clip slot + epoch** —
    NOT `speakFiller`, which is wired to the per-turn filler-queue (`fillerDoneRef`)
    and would collide.
- **Next-step model** — Fable, **vision**: goal + history + settled frame S →
  `{ say, box?, expect, wait, status }`.
- Net cost per action: **one vision call (Fable) + one tiny text call (ack)**. Ack
  speaks first; Fable's instruction follows; the cursor "thinking" fx (already
  exists) covers the gap after the ack.
- **Entry ack** ("sure, let's do it") = the **existing gate `voiceText` filler**,
  no new code for the entry beat. The only new entry work is the gate flagging
  `mode: follow_along`. Note the gate only runs for **voice** asks with no
  annotations — which is exactly how follow-along is entered (spoken "walk me
  through…"), so the entry ack comes for free.

## Model contract

### Follow-along step (emitted by Fable, per iteration)

```json
{
  "say":    "click the file you want to edit",
  "box":    [x1, y1, x2, y2],
  "expect": "click" | "observe",
  "wait":   "instant" | "ui-settle" | "page-load" | "network",
  "status": "guiding" | "done"
}
```

- `box` — normalized `[x1,y1,x2,y2]` fractions 0..1 (same convention as the
  existing single-call path), `null` for pure narration.
- `expect: "click"` — geometry-gated; requires a `box`.
- `expect: "observe"` — pure narration, no target; **auto-flows** into the next
  Fable call after speaking (nothing to wait for). `scroll`/`type` are **not** in
  v1 — a scroll that matters just changes the screen, and typing needs no gate for
  v1 (Input Monitoring exists but we don't need keystroke detection yet).
- `status: "done"` — goal reached → celebrate + deactivate.
- The call always receives **goal + a short history of completed steps** so each
  screenshot is not context-free.

### Gate / mode selection

The gate (or first tutor call) classifies intent and emits the mode:
`follow_along` (hands-on "walk me through doing X") vs the existing `single` /
`steps` (explain / orient). Entry filler stays in the gate `voiceText`.

### Ack prompt

Small dedicated system prompt for the Gemini ack: given the just-completed step's
instruction, produce a short, warm, forward-looking line that **acknowledges the
action and bridges to the next step, with zero claims about screen state.**

## `followAlong` runtime state (frontend, notch)

```
followAlong = {
  active:      bool,
  goal:        string,                         // set once from the user's ask
  history:     string[],                        // completed step instructions
  currentStep: { say, box, expect, wait } | null,
  referenceFrame: <downscaled frame R>,         // for the match primitive
}
```

Threaded into the gate + Fable prompts on **every** turn while active (via the
existing `recentContext` mechanism) so voice turns stay goal-aware.

## Constants (new, in `constants.rs` / frontend config)

| name                     | value (start) | meaning                                   |
|--------------------------|---------------|-------------------------------------------|
| `WAIT_INSTANT_MS`        | 75            | `instant` floor                           |
| `WAIT_UI_SETTLE_MS`      | 400           | `ui-settle` floor                         |
| `WAIT_PAGE_LOAD_MS`      | 1500          | `page-load` floor                         |
| `WAIT_NETWORK_MS`        | 2500          | `network` floor                           |
| `SETTLE_POLL_MS`         | 300           | gap between settle captures               |
| `SETTLE_MAX_ITERATIONS`  | 10            | settle-diff loop cap (~3s ceiling)        |
| `SETTLE_DIFF_THRESHOLD`  | tune          | sensitive: "screen still moving?"         |
| `SAMESCREEN_THRESHOLD`   | tune          | tolerant: "same screen as reference?"     |
| `CLICK_PAD`              | tune (pt)     | click tolerance around the box            |
| `POINTER_IDLE_FADE_MS`   | 30000         | fade a waiting pointer after 30s          |

## What's new to build (scope, honest)

**Native (Rust):**
- Emit `input:click { x, y }` from the input tap (read `event.location()`,
  convert points; armed only while follow-along active).
- The frame-match primitive (downscale + diff / pHash) near `capture.rs`, exposed
  to the frontend (or run natively and expose a "same?" verdict).
- The settle-diff loop (can live native or be driven from the frontend using the
  primitive + `capture_screen`).

**Frontend (React, notch):**
- A **reactive** follow-along controller — sibling to `playSteps`, but
  event-driven (click gate / voice / poll), not timer-driven. Owns `followAlong`
  state, the wait/settle sequence, ack→Fable ordering, and pointer draw/hide.
- The geometry click gate + screen-match guard wiring.
- Inject `followAlong` context into gate + Fable calls.

**Prompts:**
- Follow-along Fable system prompt (goal + history → step schema + `status`).
- Gate follow-along intent detection + `mode: follow_along`.
- The constrained ack prompt.

## Interactions with recent changes (verified 2026-07-06)

The plan must respect these already-shipped behaviors:

- **`SHOW_IN_CAPTURE` (capture poisoning).** Compile-time const, **default `true`
  in dev** (`npm run app`) → Kairo's own UI (notch, pet cursor, animated guidance
  box) is *in the tutor's screenshots*; the prod DMG forces it `false` (clean).
  The overlay's 650ms box-draw/ink animation, if present in diffed frames, reads as
  "screen still moving." **Mitigations:** (1) at a valid click, **hide the old
  overlay + release the cursor before the settle captures** so those frames are
  clean; (2) pHash's tolerant threshold absorbs the small, static notch; (3) test
  follow-along with `KAIRO_SHOW_IN_CAPTURE=false` (prod-equivalent) for match
  accuracy — and the Fable follow-along capture should be UI-clean regardless so
  Fable never boxes our own UI.
- **Streaming TTS** (`createStreamingClip(bridge, text, timeout)` in
  `src/notch/streamingTts.ts`) is the "speak now" primitive for both the ack and
  each follow-along step. There is a **single current-clip slot** (`answerAudioRef`)
  + `playbackEpochRef`; give the follow-along ack/step **its own slot/epoch** so
  they don't fight. Streaming is Sarvam-only; other providers fall back to buffered
  (still speaks).
- **Cursor auto-hide** (`applyVisibility`, `CursorApp.tsx`) only fires when the pet
  is `mode='shadow' & fx='none'`. Keep the follow-along pointer in `pointing`/`drag`
  (or set an fx) while awaiting a click → auto-hide won't interfere.
- **Voice turn mid-follow-along.** `submitQuery` at turn-start already calls
  `stopAnswerPlayback()` (bumps `playbackEpochRef`), `cursorRelease()`, and
  `hideOverlay()` — so a PTT turn naturally drops the follow-along pointer. Design
  rule: **`followAlong` state lives outside the per-turn visual teardown.** The
  voice turn is follow-along-aware (goal + history injected), answers normally, and
  the pointer rebuilds afterward if guidance continues. Nothing "breaks" from the
  user being "in the loop" — waiting-for-click and voice turns are independent.
- **Gate routing.** The gate (and thus the free entry ack) runs only for **voice**
  asks with no annotations — which is how follow-along is entered. Typed/annotated
  asks skip the gate.

## Optional visual (from `competitor_notes.txt`, not v1-blocking)

Clicky uses **circles for click-targets** and **boxes for "look at this."** Our
schema already distinguishes `expect: "click"` vs `"observe"`, so a natural
enhancement: render a **circle** for `expect:click` steps and keep the **box** for
`observe`. Nice-to-have; core v1 keeps the existing box/pointer render.

## Non-goals / v1 limits

- **Multi-monitor** — main display only (matches current capture).
- **Model-as-judge** — never; advancement is geometry + screen-match only.
- **Keystroke / typing detection** — deferred (grant exists, need not used).
- **Precise scroll gating** — no `scroll` expect type; screen-change is enough.
- **Live AX-element re-anchoring** (the "north-star" that keeps a pointer glued to
  content as you scroll) — explicitly out; pixel coords + match primitive is the
  v1.
- **Auto re-plan / chasing the user** — explicitly out (passive guide).

## Testing / verification notes

- Real packaged `.app` only (per project rule) — the geometry gate, taps, and
  panels need the signed build.
- Log every step through `klog!` under new/existing subsystems (candidate tags:
  `follow` for the loop, plus existing `input`, `vision`, `tutor`, `overlay`).
  Log: mode selection, each emitted step (`expect`, `wait`, `status`), click gate
  verdicts (in-box? screen-match?), settle iterations + outcome, ack vs next-step
  timing, pause/resume, fade, and every error path. Never log raw frames — log
  `bytes=`, `WxH`, diff score, iteration counts.
- Manual happy path: GitHub "create a PR" flow end to end (open file → edit →
  commit → PR → merge), checking the settle-diff catches the merge-button load and
  the ack never lies about screen state.
- Manual unhappy paths: scroll then click same coordinate (must NOT advance);
  wander to another app mid-think (must pause + resume); do a totally different
  thing (must do nothing); go idle 30s (pointer fades, goal survives a follow-up).
```
